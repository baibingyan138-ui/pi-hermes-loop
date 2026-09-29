import { loadConfig, type LoopConfig } from "./config.ts";
import { MemoryStore } from "./memory-store.ts";
import { PendingStore, type PendingWrite } from "./pending.ts";
import type { LoopPaths } from "./paths.ts";
import { ReadMarks } from "./read-marks.ts";
import { searchSessions } from "./session-search.ts";
import { SkillStore, type SkillAction } from "./skill-store.ts";
import type { MemoryOperation, MemoryTarget, Origin, ReviewTool, ToolOutcome } from "./types.ts";

export interface LoopRuntime {
  paths: LoopPaths;
  config: LoopConfig;
  memory: MemoryStore;
  skills: SkillStore;
  pending: PendingStore;
  readMarks: ReadMarks;
}

export function openRuntime(paths: LoopPaths, config: LoopConfig = loadConfig(paths.configPath), readMarks = new ReadMarks()): LoopRuntime {
  return {
    paths,
    config,
    readMarks,
    memory: new MemoryStore({
      memoryDir: paths.memoryDir,
      memoryCharLimit: config.memory.memoryCharLimit,
      userCharLimit: config.memory.userCharLimit,
      userProfile: config.memory.userProfile,
    }),
    skills: new SkillStore({
      skillsDir: paths.skillsDir,
      registryPath: paths.registryPath,
      readMarks,
    }),
    pending: new PendingStore(paths.pendingDir),
  };
}

export function skillCatalog(skills: SkillStore): string {
  const listed = skills.list();
  if (listed.length === 0) return "(no skills in ~/.pi/agent/skills)";
  return listed
    .map((skill) => {
      const kind = skill.pinned ? "pinned" : skill.managed ? "curator" : "user";
      return `- ${skill.name} [${kind}]: ${skill.description}`;
    })
    .join("\n");
}

export function runMemory(runtime: LoopRuntime, origin: Origin, raw: Record<string, unknown>): ToolOutcome {
  if (!runtime.config.memory.enabled) return fail("Curated memory is disabled in hermes-loop config.");
  const parsed = parseMemoryArgs(raw);
  if ("error" in parsed) return fail(parsed.error);
  if (parsed.target === "user" && !runtime.config.memory.userProfile) {
    return fail("User profile memory is disabled in hermes-loop config.");
  }
  const preview = runtime.memory.apply(parsed.target, parsed.operations, false);
  if (preview.isError || !isMaterial(preview.action)) return preview;
  if (runtime.config.memory.writeApproval) {
    return stage(runtime, origin, preview, {
      kind: "memory",
      target: parsed.target,
      operations: parsed.operations,
    });
  }
  return runtime.memory.apply(parsed.target, parsed.operations, true);
}

export function runSkillView(runtime: LoopRuntime, raw: Record<string, unknown>): ToolOutcome {
  const name = stringField(raw, "name");
  if (!name) return fail("name is required.");
  const filePath = stringField(raw, "file_path");
  return runtime.skills.view(name, filePath);
}

export function runSkillsList(runtime: LoopRuntime): ToolOutcome {
  return { text: skillCatalog(runtime.skills), isError: false };
}

export function runSkillManage(runtime: LoopRuntime, origin: Origin, raw: Record<string, unknown>): ToolOutcome {
  if (!runtime.config.skills.enabled) return fail("Skill learning is disabled in hermes-loop config.");
  const request = parseSkillAction(raw);
  if ("error" in request) return fail(request.error);
  const preview = runtime.skills.mutate(request, origin, false, false);
  if (preview.isError) return preview;
  if (runtime.config.skills.writeApproval) {
    return stage(runtime, origin, preview, { kind: "skill", request });
  }
  return runtime.skills.mutate(request, origin, false, true);
}

export function runSessionSearch(
  runtime: LoopRuntime,
  raw: Record<string, unknown>,
  cwd: string,
  excludeFile?: string,
): ToolOutcome {
  if (!runtime.config.sessionSearch.enabled) return fail("Session search is disabled in hermes-loop config.");
  const query = stringField(raw, "query");
  if (!query) return fail("query is required.");
  const scope = raw.scope === "all" ? "all" : "project";
  const limit = typeof raw.limit === "number" ? Math.min(10, Math.max(1, raw.limit)) : 5;
  const hits = searchSessions({
    sessionsDir: runtime.paths.sessionsDir,
    query,
    limit,
    scope,
    cwd,
    excludeFile,
    maxFiles: runtime.config.sessionSearch.maxFiles,
    maxBytesPerFile: runtime.config.sessionSearch.maxBytesPerFile,
  });
  if (hits.length === 0) return { text: `No past Pi sessions matched "${query}".`, isError: false };
  const text = hits
    .map((hit, index) => `${index + 1}. ${hit.cwd || "(unknown cwd)"} score=${hit.score.toFixed(1)}\n${hit.snippet}\n${hit.file}`)
    .join("\n\n");
  return { text, isError: false };
}

export function reviewTools(runtime: LoopRuntime): ReviewTool[] {
  return [
    { name: "memory", run: (args) => runMemory(runtime, "review", args) },
    { name: "skill_view", run: (args) => runSkillView(runtime, args) },
    { name: "skills_list", run: () => runSkillsList(runtime) },
    { name: "skill_manage", run: (args) => runSkillManage(runtime, "review", args) },
  ];
}

export function approvePending(runtime: LoopRuntime, id: string): ToolOutcome {
  const item = runtime.pending.get(id);
  if (!item) return fail(`没有待确认的写入 ${id}。`);
  const outcome = commitPending(runtime, item);
  if (!outcome.isError) runtime.pending.discard(id);
  return outcome.isError ? outcome : { ...outcome, text: `已写入 ${id}。\n${outcome.text}` };
}

export function denyPending(runtime: LoopRuntime, id: string): ToolOutcome {
  if (!runtime.pending.discard(id)) return fail(`没有待确认的写入 ${id}。`);
  return { text: `已丢弃 ${id}。`, isError: false, action: `denied ${id}` };
}

export function approveAll(runtime: LoopRuntime): ToolOutcome {
  const items = runtime.pending.list();
  if (items.length === 0) return { text: "没有待确认的写入。", isError: false };
  const lines: string[] = [];
  for (const item of items) {
    const outcome = commitPending(runtime, item);
    if (outcome.isError) {
      lines.push(`${item.id}: 失败 — ${outcome.text.split("\n")[0]}`);
      continue;
    }
    runtime.pending.discard(item.id);
    lines.push(`${item.id}: ${item.summary}`);
  }
  return { text: lines.join("\n"), isError: false, action: `approved ${items.length}` };
}

export function denyAll(runtime: LoopRuntime): ToolOutcome {
  const items = runtime.pending.list();
  for (const item of items) runtime.pending.discard(item.id);
  return { text: items.length === 0 ? "没有待确认的写入。" : `已丢弃 ${items.length} 条待确认写入。`, isError: false };
}

export function describePending(runtime: LoopRuntime): string {
  const items = runtime.pending.list();
  if (items.length === 0) return "没有待确认的写入。";
  return items
    .map((item) => `${item.id}  ${item.origin}  ${item.summary}\n  ${item.createdAt}`)
    .join("\n");
}

export function describeStatus(runtime: LoopRuntime): string {
  const memory = runtime.memory.readEntries("memory");
  const user = runtime.config.memory.userProfile ? runtime.memory.readEntries("user") : [];
  const skills = runtime.skills.list();
  const curator = skills.filter((skill) => skill.managed).length;
  return [
    `自改进循环：${runtime.config.enabled && runtime.config.review.enabled ? "开" : "关"}`,
    `记忆：MEMORY ${memory.length} 条，USER ${runtime.config.memory.userProfile ? user.length : "关"} 条`,
    `技能：${skills.length} 个可见，其中 ${curator} 个由后台复盘维护`,
    `待确认写入：${runtime.pending.list().length}`,
    `复盘节奏：每 ${runtime.config.memory.nudgeInterval} 轮用户消息检查记忆；单轮工具调用 ≥ ${runtime.config.skills.nudgeToolIterations} 或出现纠正时检查技能`,
    `配置：${runtime.paths.configPath}`,
    `记忆目录：${runtime.paths.memoryDir}`,
    `技能目录：${runtime.paths.skillsDir}`,
  ].join("\n");
}

function commitPending(runtime: LoopRuntime, item: PendingWrite): ToolOutcome {
  if (item.mutation.kind === "memory") {
    return runtime.memory.apply(item.mutation.target, item.mutation.operations, true);
  }
  return runtime.skills.mutate(item.mutation.request, item.origin, true, true);
}

function stage(runtime: LoopRuntime, origin: Origin, preview: ToolOutcome, mutation: PendingWrite["mutation"]): ToolOutcome {
  const record = runtime.pending.stage({
    origin,
    summary: preview.action || "write",
    mutation,
  });
  return {
    text: `${preview.text}\n\n这次写入已暂存为 ${record.id}，还没有落盘。在 Pi 里运行 /hermes approve ${record.id}，或 /hermes deny ${record.id}。`,
    isError: false,
    action: `staged ${record.id}: ${preview.action}`,
    stagedId: record.id,
  };
}

function parseMemoryArgs(
  raw: Record<string, unknown>,
): { target: MemoryTarget; operations: MemoryOperation[] } | { error: string } {
  const target = raw.target === "user" ? "user" : raw.target === "memory" || raw.target == null ? "memory" : null;
  if (!target) return { error: "target must be 'memory' or 'user'." };
  if (Array.isArray(raw.operations)) {
    const operations: MemoryOperation[] = [];
    for (const item of raw.operations) {
      if (!item || typeof item !== "object") return { error: "Each memory operation must be an object." };
      const record = item as Record<string, unknown>;
      const action = record.action;
      if (action !== "add" && action !== "replace" && action !== "remove") {
        return { error: "Memory action must be add, replace, or remove." };
      }
      operations.push({
        action,
        content: typeof record.content === "string" ? record.content : undefined,
        old_text: typeof record.old_text === "string" ? record.old_text : undefined,
      });
    }
    if (operations.length === 0) return { error: "operations cannot be empty." };
    return { target, operations };
  }
  const action = raw.action;
  if (action !== "add" && action !== "replace" && action !== "remove") {
    return { error: "action must be add, replace, or remove." };
  }
  return {
    target,
    operations: [
      {
        action,
        content: typeof raw.content === "string" ? raw.content : undefined,
        old_text: typeof raw.old_text === "string" ? raw.old_text : undefined,
      },
    ],
  };
}

function parseSkillAction(raw: Record<string, unknown>): SkillAction | { error: string } {
  const name = stringField(raw, "name");
  if (!name) return { error: "name is required." };
  const action = raw.action;
  if (action === "create") {
    const content = stringField(raw, "content");
    if (!content) return { error: "content is required for create." };
    return { action, name, content, category: stringField(raw, "category") };
  }
  if (action === "edit") {
    const content = stringField(raw, "content");
    if (!content) return { error: "content is required for edit." };
    return { action, name, content };
  }
  if (action === "patch") {
    const oldString = stringField(raw, "old_string");
    if (!oldString) return { error: "old_string is required for patch." };
    if (typeof raw.new_string !== "string") return { error: "new_string is required for patch." };
    return {
      action,
      name,
      old_string: oldString,
      new_string: raw.new_string,
      file_path: stringField(raw, "file_path"),
      replace_all: raw.replace_all === true,
    };
  }
  if (action === "delete") return { action, name };
  if (action === "write_file") {
    const filePath = stringField(raw, "file_path");
    if (!filePath) return { error: "file_path is required for write_file." };
    if (typeof raw.file_content !== "string") return { error: "file_content is required for write_file." };
    return { action, name, file_path: filePath, file_content: raw.file_content };
  }
  if (action === "remove_file") {
    const filePath = stringField(raw, "file_path");
    if (!filePath) return { error: "file_path is required for remove_file." };
    return { action, name, file_path: filePath };
  }
  return { error: "action must be create, edit, patch, delete, write_file, or remove_file." };
}

function isMaterial(action: string | undefined): boolean {
  if (!action) return false;
  return /\b(added|replaced|removed|created|edited|patched|deleted|updated)\b/i.test(action);
}

function stringField(raw: Record<string, unknown>, key: string): string | undefined {
  const value = raw[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function fail(text: string): ToolOutcome {
  return { text, isError: true };
}
