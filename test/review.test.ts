import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { openRuntime, runSkillManage } from "../src/actions.ts";
import { DEFAULT_CONFIG, loadConfig } from "../src/config.ts";
import { reviewTask } from "../src/prompts.ts";
import { runReviewLoop } from "../src/review-loop.ts";
import { runBackgroundReview } from "../src/run-review.ts";
import { decideReview } from "../src/scheduler.ts";
import { appendFrozenMemory, LearningSession } from "../src/session-state.ts";
import { redactSecrets } from "../src/redact.ts";
import { renderTranscript } from "../src/transcript.ts";
import type { ReviewCompletion, ReviewModel } from "../src/types.ts";
import { selectReviewModel } from "../extensions/pi-model.ts";
import { skillMarkdown, tempPaths } from "./helpers.ts";
import { writeAtomic } from "../src/lock.ts";

test("nudges match the Hermes cadence and corrections pull a skill review forward", () => {
  const config = DEFAULT_CONFIG;
  assert.equal(decideReview(config, { userTurns: 9, toolCalls: 2, correction: false }), null);
  assert.equal(decideReview(config, { userTurns: 10, toolCalls: 2, correction: false }), "memory");
  assert.equal(decideReview(config, { userTurns: 3, toolCalls: 10, correction: false }), "skills");
  assert.equal(decideReview(config, { userTurns: 10, toolCalls: 10, correction: false }), "combined");
  assert.equal(decideReview(config, { userTurns: 1, toolCalls: 0, correction: true }), "skills");
  assert.equal(decideReview(config, { userTurns: 1, toolCalls: 0, correction: false }), null);
});

test("a new user turn cancels the previous review and the memory snapshot is frozen", () => {
  const session = new LearningSession();
  session.reset("MEMORY (0/2200 chars)\n(empty)");
  session.beginTurn("记住：回复用中文");
  assert.equal(session.decide(DEFAULT_CONFIG), "skills");
  const signal = session.startReview();
  const restarted = session.startReview();
  assert.equal(signal.aborted, true);
  assert.equal(restarted.aborted, false);
  session.beginTurn("继续");
  assert.equal(restarted.aborted, true);
  const prompt = appendFrozenMemory("You are Pi.", session.frozen() ?? "");
  assert.equal(appendFrozenMemory(prompt, "changed"), prompt);
  assert.match(prompt, /MEMORY/);
});

test("transcript digest redacts secrets and keeps the recent turns", () => {
  const text = redactSecrets("token sk-abc1234567890 and password=hunter2secret");
  assert.equal(text.includes("sk-abc1234567890"), false);
  assert.match(text, /redacted/);
  const lines = Array.from({ length: 20 }, (_, index) => ({ role: "user", text: `turn ${index} secret sk-abc1234567890` }));
  const rendered = renderTranscript(lines, { digest: true, maxChars: 50_000, keepRecent: 2 });
  assert.match(rendered, /Earlier conversation digest/);
  assert.match(rendered, /turn 19/);
  assert.equal(rendered.includes("sk-abc1234567890"), false);
});

test("background review patches a curator skill and saves a user preference", async () => {
  const paths = tempPaths();
  const runtime = openRuntime(paths, DEFAULT_CONFIG);
  const created = runSkillManage(runtime, "review", {
    action: "create",
    name: "deploy-web",
    content: skillMarkdown("deploy-web", "Deploy the web service"),
  });
  assert.equal(created.isError, false);
  const reviewRuntime = openRuntime(paths, DEFAULT_CONFIG);
  let step = 0;
  const model: ReviewModel = {
    async complete(): Promise<ReviewCompletion> {
      step += 1;
      if (step === 1) return call("skill_view", { name: "deploy-web" });
      if (step === 2) {
        return call("skill_manage", {
          action: "patch",
          name: "deploy-web",
          old_string: "carefully",
          new_string: "with a rollback step",
        });
      }
      if (step === 3) return call("memory", { action: "add", target: "user", content: "回复用中文，只要结论。" });
      return { content: [{ type: "text", text: "Nothing to save." }], inputTokens: 4, outputTokens: 2 };
    },
  };
  const report = await runBackgroundReview({
    runtime: reviewRuntime,
    model,
    messages: [
      { role: "user", content: "部署失败后你要先回滚，别写长解释。回复用中文。" },
      { role: "assistant", content: [{ type: "text", text: "好，先回滚。" }] },
    ],
    kind: "combined",
    digest: false,
  });
  assert.equal(report.status, "saved");
  assert.equal(report.actions.length, 2);
  const body = fs.readFileSync(path.join(paths.skillsDir, "deploy-web", "SKILL.md"), "utf8");
  assert.match(body, /rollback step/);
  assert.deepEqual(reviewRuntime.memory.readEntries("user"), ["回复用中文，只要结论。"]);
});

test("the review loop denies tools outside the memory and skill whitelist", async () => {
  let denial = "";
  const report = await runReviewLoop({
    model: {
      async complete(input): Promise<ReviewCompletion> {
        const last = input.messages.at(-1);
        if (last?.role === "toolResult" && typeof last.content === "string") denial = last.content;
        return call("bash", { command: "rm -rf /" });
      },
    },
    tools: [],
    system: "review",
    transcript: "USER: hi",
    task: "review",
    maxIterations: 2,
    maxInputTokens: 100,
  });
  assert.equal(report.status, "budget");
  assert.equal(report.actions.length, 0);
  assert.match(denial, /denied non-whitelisted tool: bash/);
});

test("review prompts keep the class-level and read-before-write rules", () => {
  const task = reviewTask("combined", "- deploy-web [curator]: Deploy");
  assert.match(task, /Nothing to save/);
  assert.match(task, /deploy-web/);
});

test("config from disk overrides only the fields it sets", () => {
  const paths = tempPaths();
  writeAtomic(paths.configPath, JSON.stringify({ memory: { nudgeInterval: 4 }, review: { replay: "digest" } }));
  const config = loadConfig(paths.configPath);
  assert.equal(config.memory.nudgeInterval, 4);
  assert.equal(config.review.replay, "digest");
  assert.equal(config.skills.nudgeToolIterations, DEFAULT_CONFIG.skills.nudgeToolIterations);
});

test("selectReviewModel keeps the session model unless an auxiliary model is configured", () => {
  const current = { api: "openai-completions", provider: "openai", id: "session" };
  const registry = {
    get: (provider: string, id: string) => (provider === "openai" && id === "cheap" ? { ...current, id } : undefined),
  };
  assert.equal(selectReviewModel(registry, current, null, null)?.id, "session");
  assert.equal(selectReviewModel(registry, current, "openai", "cheap")?.id, "cheap");
  assert.equal(selectReviewModel(registry, current, "openai", "missing"), undefined);
});

function call(name: string, args: Record<string, unknown>): ReviewCompletion {
  return {
    content: [{ type: "toolCall", id: `call_${name}`, name, arguments: args }],
    inputTokens: 20,
    outputTokens: 8,
  };
}
