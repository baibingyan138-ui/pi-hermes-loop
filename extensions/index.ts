import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { approveAll, approvePending, denyAll, denyPending, describePending, describeStatus, openRuntime, runMemory, runSessionSearch, runSkillManage, runSkillView, runSkillsList, type LoopRuntime } from "../src/actions.ts";
import { ensureDefaultConfig, loadConfig } from "../src/config.ts";
import { appendReviewLog } from "../src/journal.ts";
import { resolveLoopPaths, type LoopPaths } from "../src/paths.ts";
import { runBackgroundReview } from "../src/run-review.ts";
import { appendFrozenMemory, LearningSession } from "../src/session-state.ts";
import {
  MEMORY_TOOL_DESCRIPTION,
  SESSION_SEARCH_DESCRIPTION,
  SKILL_MANAGE_DESCRIPTION,
  SKILL_VIEW_DESCRIPTION,
  SKILLS_LIST_DESCRIPTION,
} from "../src/tool-text.ts";
import type { ReviewKind, ToolOutcome } from "../src/types.ts";
import { piReviewModel, selectReviewModel } from "./pi-model.ts";

const paths: LoopPaths = resolveLoopPaths();
const session = new LearningSession();
let runtime = openRuntime(paths, loadConfig(paths.configPath));
let lastMessages: unknown[] = [];

const memoryParameters = Type.Object({
  action: Type.Optional(Type.String({ description: "add, replace, or remove. Omit when operations is set." })),
  target: Type.Optional(Type.String({ description: "memory (default) or user." })),
  content: Type.Optional(Type.String({ description: "Full entry text for add or replace." })),
  old_text: Type.Optional(Type.String({ description: "Unique substring identifying the entry to replace or remove." })),
  operations: Type.Optional(
    Type.Array(
      Type.Object({
        action: Type.String(),
        content: Type.Optional(Type.String()),
        old_text: Type.Optional(Type.String()),
      }),
      { description: "Atomic batch. The char limit is checked once, on the final result." },
    ),
  ),
});

const skillViewParameters = Type.Object({
  name: Type.String({ description: "Skill name." }),
  file_path: Type.Optional(Type.String({ description: "Omit to read SKILL.md. Otherwise a path under references/, templates/, scripts/, or assets/." })),
});

const skillManageParameters = Type.Object({
  action: Type.String({ description: "create, edit, patch, delete, write_file, or remove_file." }),
  name: Type.String({ description: "Skill name: lowercase letters, digits, and hyphens." }),
  content: Type.Optional(Type.String({ description: "Full SKILL.md, including frontmatter, for create or edit." })),
  category: Type.Optional(Type.String({ description: "Optional single directory under the skills folder." })),
  old_string: Type.Optional(Type.String({ description: "Exact text to replace for patch." })),
  new_string: Type.Optional(Type.String({ description: "Replacement text for patch. Empty string deletes the match." })),
  file_path: Type.Optional(Type.String({ description: "Support file for patch, write_file, or remove_file. Defaults to SKILL.md for patch." })),
  file_content: Type.Optional(Type.String({ description: "Full file body for write_file." })),
  replace_all: Type.Optional(Type.Boolean({ description: "Replace every occurrence of old_string." })),
});

const sessionSearchParameters = Type.Object({
  query: Type.String({ description: "Words or a short phrase from the earlier task." }),
  scope: Type.Optional(Type.String({ description: "project (default) or all." })),
  limit: Type.Optional(Type.Number({ description: "Maximum hits, 1 to 10." })),
});

const reviewToolSchemas = [
  { name: "memory", description: MEMORY_TOOL_DESCRIPTION, parameters: memoryParameters },
  { name: "skill_view", description: SKILL_VIEW_DESCRIPTION, parameters: skillViewParameters },
  { name: "skills_list", description: SKILLS_LIST_DESCRIPTION, parameters: Type.Object({}) },
  { name: "skill_manage", description: SKILL_MANAGE_DESCRIPTION, parameters: skillManageParameters },
];

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "memory",
    label: "Memory",
    description: MEMORY_TOOL_DESCRIPTION,
    parameters: memoryParameters,
    async execute(_id, params) {
      return toolResult(runMemory(runtime, "foreground", asRecord(params)));
    },
  });

  pi.registerTool({
    name: "skill_view",
    label: "Skill view",
    description: SKILL_VIEW_DESCRIPTION,
    parameters: skillViewParameters,
    async execute(_id, params) {
      return toolResult(runSkillView(runtime, asRecord(params)));
    },
  });

  pi.registerTool({
    name: "skills_list",
    label: "Skills",
    description: SKILLS_LIST_DESCRIPTION,
    parameters: Type.Object({}),
    async execute() {
      return toolResult(runSkillsList(runtime));
    },
  });

  pi.registerTool({
    name: "skill_manage",
    label: "Skill manage",
    description: SKILL_MANAGE_DESCRIPTION,
    parameters: skillManageParameters,
    async execute(_id, params) {
      return toolResult(runSkillManage(runtime, "foreground", asRecord(params)));
    },
  });

  pi.registerTool({
    name: "session_search",
    label: "Session search",
    description: SESSION_SEARCH_DESCRIPTION,
    parameters: sessionSearchParameters,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      return toolResult(runSessionSearch(runtime, asRecord(params), ctx.cwd, sessionFile(ctx)));
    },
  });

  pi.registerCommand("hermes", {
    description: "查看或确认自改进循环：记忆、技能、待审批写入",
    getArgumentCompletions: (prefix) => {
      const commands = ["status", "memory", "pending", "approve", "deny", "pin", "unpin", "adopt", "review", "help"];
      const [head, ...rest] = prefix.split(/\s+/);
      if (rest.length > 0 || prefix.endsWith(" ")) return null;
      return commands
        .filter((command) => command.startsWith(head))
        .map((command) => ({ label: command, value: command }));
    },
    handler: async (args, ctx) => {
      refresh();
      const text = await handleCommand(args, ctx);
      if (ctx.hasUI) ctx.ui.notify(text, "info");
    },
  });

  pi.on("session_start", () => {
    refresh();
    session.reset(runtime.config.memory.enabled ? runtime.memory.snapshotBlock() : null);
  });

  pi.on("session_shutdown", () => {
    session.cancelReview();
  });

  pi.on("before_agent_start", (event) => {
    session.beginTurn(event.prompt);
    const frozen = session.frozen();
    if (!runtime.config.enabled || !runtime.config.memory.enabled || !frozen) return;
    return { systemPrompt: appendFrozenMemory(event.systemPrompt, frozen) };
  });

  pi.on("tool_execution_end", () => {
    session.noteTool();
  });

  pi.on("agent_end", (event, ctx) => {
    lastMessages = event.messages;
    const kind = session.decide(runtime.config);
    if (!kind) return;
    const signal = session.startReview();
    void executeReview(ctx, kind, event.messages.slice(), signal, true);
  });
}

function refresh(): void {
  const config = ensureDefaultConfig(paths.configPath);
  runtime = openRuntime(paths, config, runtime.readMarks);
}

async function handleCommand(args: string, ctx: ExtensionContext): Promise<string> {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  const command = parts[0] ?? "status";
  const value = parts.slice(1).join(" ").trim();
  switch (command) {
    case "help":
      return [
        "/hermes status — 当前记忆、技能和复盘节奏",
        "/hermes memory — 查看 MEMORY 与 USER",
        "/hermes pending — 待确认的写入",
        "/hermes approve <id|all>",
        "/hermes deny <id|all>",
        "/hermes pin <skill> / unpin <skill>",
        "/hermes adopt <skill> — 允许后台复盘维护这个技能",
        "/hermes review — 立刻复盘当前会话",
      ].join("\n");
    case "status":
      return describeStatus(runtime);
    case "memory":
      return runtime.memory.snapshotBlock();
    case "pending":
      return describePending(runtime);
    case "approve":
      if (value === "all" || value === "") return value === "all" ? approveAll(runtime).text : describePending(runtime);
      return approvePending(runtime, value).text;
    case "deny":
      if (value === "all") return denyAll(runtime).text;
      if (!value) return describePending(runtime);
      return denyPending(runtime, value).text;
    case "pin":
    case "unpin":
      if (!value) return "用法：/hermes pin <skill>";
      return runtime.skills.pin(value, command === "pin").text;
    case "adopt":
      if (!value) return "用法：/hermes adopt <skill>";
      return runtime.skills.adopt(value).text;
    case "review":
      return triggerManualReview(ctx);
    default:
      return `未知子命令 ${command}。运行 /hermes help。`;
  }
}

async function triggerManualReview(ctx: ExtensionContext): Promise<string> {
  if (!runtime.config.memory.enabled && !runtime.config.skills.enabled) {
    return "记忆和技能学习都关着。编辑配置后重试。";
  }
  const kind: ReviewKind = runtime.config.memory.enabled && runtime.config.skills.enabled
    ? "combined"
    : runtime.config.memory.enabled
      ? "memory"
      : "skills";
  const signal = session.startReview();
  const report = await executeReview(ctx, kind, readMessages(ctx), signal, false);
  return summarize(report);
}

async function executeReview(
  ctx: ExtensionContext,
  kind: ReviewKind,
  messages: unknown[],
  signal: AbortSignal,
  announce: boolean,
): Promise<import("../src/types.ts").ReviewReport> {
  const config = loadConfig(paths.configPath);
  const reviewRuntime: LoopRuntime = openRuntime(paths, config);
  const registry = ctx.modelRegistry as Parameters<typeof selectReviewModel>[0];
  const current = ctx.model as Parameters<typeof selectReviewModel>[1];
  const configured = Boolean(config.review.provider && config.review.model);
  const model = selectReviewModel(registry, current, config.review.provider, config.review.model);
  if (!model) {
    const report = {
      status: "error" as const,
      actions: [] as string[],
      text: "",
      iterations: 0,
      inputTokens: 0,
      error: configured ? `找不到复盘模型 ${config.review.provider}/${config.review.model}` : "没有可用模型",
    };
    if (announce) note(ctx, report);
    return report;
  }
  const aux = Boolean(config.review.provider && config.review.model);
  const digest = config.review.replay === "digest" || (config.review.replay === "auto" && aux);
  try {
    const report = await runBackgroundReview({
      runtime: reviewRuntime,
      model: piReviewModel(registry, model, reviewToolSchemas),
      messages,
      kind,
      digest,
      signal,
    });
    if (announce && !signal.aborted) note(ctx, report);
    return report;
  } catch (error) {
    const report = {
      status: "error" as const,
      actions: [] as string[],
      text: "",
      iterations: 0,
      inputTokens: 0,
      error: error instanceof Error ? error.message : String(error),
    };
    if (announce && !signal.aborted) note(ctx, report);
    return report;
  }
}

function note(ctx: ExtensionContext, report: import("../src/types.ts").ReviewReport): void {
  try {
    appendReviewLog(paths.reviewLogPath, {
      status: report.status,
      actions: report.actions,
      iterations: report.iterations,
      inputTokens: report.inputTokens,
      error: report.error,
    });
  } catch {
    // The review already finished. A log failure must not surface as a session error.
  }
  if (!runtime.config.review.notify || !ctx.hasUI) return;
  const text = report.status === "saved"
    ? `自改进：${report.actions.join("；")}`
    : report.status === "error"
      ? `自改进复盘失败：${report.error ?? "未知错误"}`
      : "";
  if (!text) return;
  try {
    ctx.ui.notify(text, report.status === "error" ? "error" : "info");
  } catch {
    // Print mode and a closing TUI have no notification surface.
  }
}

function summarize(report: import("../src/types.ts").ReviewReport): string {
  if (report.status === "saved") return `复盘写入了：\n${report.actions.join("\n")}`;
  if (report.status === "empty") return "复盘结束，这次没有需要沉淀的内容。";
  if (report.status === "aborted") return "复盘已取消。";
  if (report.status === "budget") return "复盘达到轮数或 token 上限，已停止。";
  return `复盘失败：${report.error ?? "未知错误"}`;
}

function readMessages(ctx: ExtensionContext): unknown[] {
  const manager = ctx.sessionManager as unknown as {
    buildSessionContext?: () => { messages?: unknown[] };
    getBranch?: () => unknown[];
  };
  const built = manager.buildSessionContext?.();
  if (built && Array.isArray(built.messages) && built.messages.length > 0) return built.messages;
  const branch = manager.getBranch?.();
  if (Array.isArray(branch) && branch.length > 0) {
    return branch.map((entry) => {
      if (entry && typeof entry === "object" && "message" in entry) return (entry as { message: unknown }).message;
      return entry;
    });
  }
  return lastMessages;
}

function sessionFile(ctx: ExtensionContext): string | undefined {
  const manager = ctx.sessionManager as unknown as { getSessionFile?: () => string | undefined };
  return manager.getSessionFile?.();
}

function toolResult(outcome: ToolOutcome) {
  return {
    content: [{ type: "text" as const, text: outcome.text }],
    details: { action: outcome.action, stagedId: outcome.stagedId },
    isError: outcome.isError,
  };
}

function asRecord(params: unknown): Record<string, unknown> {
  if (params && typeof params === "object" && !Array.isArray(params)) return params as Record<string, unknown>;
  return {};
}
