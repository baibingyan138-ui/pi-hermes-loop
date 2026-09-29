import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("the Pi extension factory registers the learning tools and injects frozen memory", async () => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-loop-ext-"));
  process.env.PI_HERMES_AGENT_DIR = agentDir;
  const { default: extension } = await import("../extensions/index.ts");
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<{ isError?: boolean; content: Array<{ text: string }> }> }> = [];
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  extension({
    registerTool(tool: { name: string; execute: (typeof tools)[number]["execute"] }) {
      tools.push(tool);
    },
    registerCommand() {},
    on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
      handlers.set(event, handler);
    },
  } as never);

  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    ["memory", "session_search", "skill_manage", "skill_view", "skills_list"],
  );

  const ctx = { cwd: "/work/repo", hasUI: false, ui: { notify() {} }, sessionManager: {}, modelRegistry: {}, model: undefined };
  await handlers.get("session_start")?.({}, ctx);
  const started = await handlers.get("before_agent_start")?.(
    { prompt: "记住：回复用中文", systemPrompt: "You are Pi." },
    ctx,
  );
  assert.match((started as { systemPrompt: string }).systemPrompt, /Hermes loop memory/);
  assert.match((started as { systemPrompt: string }).systemPrompt, /You are Pi\./);

  const memory = tools.find((tool) => tool.name === "memory");
  const saved = await memory?.execute("call", { action: "add", target: "user", content: "喜欢短回答。" });
  assert.equal(saved?.isError, false);
  assert.match(saved?.content[0]?.text ?? "", /Entry added/);
  assert.match(fs.readFileSync(path.join(agentDir, "hermes-loop", "memories", "USER.md"), "utf8"), /喜欢短回答/);
});
