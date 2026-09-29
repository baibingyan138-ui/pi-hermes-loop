import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { resolveLoopPaths } from "../src/paths.ts";
import { searchSessions } from "../src/session-search.ts";
import { tempPaths } from "./helpers.ts";

test("paths follow Pi's own config and session directories", () => {
  const paths = resolveLoopPaths({
    PI_CODING_AGENT_DIR: "/tmp/custom-pi",
    PI_CODING_AGENT_SESSION_DIR: "/tmp/custom-sessions",
  });
  assert.equal(paths.agentDir, "/tmp/custom-pi");
  assert.equal(paths.skillsDir, "/tmp/custom-pi/skills");
  assert.equal(paths.sessionsDir, "/tmp/custom-sessions");
  assert.equal(paths.memoryDir, "/tmp/custom-pi/hermes-loop/memories");
});

test("session search prefers the current project and redacts secrets", () => {
  const paths = tempPaths();
  const project = path.join(paths.sessionsDir, "--repo--");
  const other = path.join(paths.sessionsDir, "--other--");
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(other, { recursive: true });
  fs.writeFileSync(
    path.join(project, "2026-01-01_a.jsonl"),
    [
      JSON.stringify({ type: "session", version: 3, cwd: "/work/repo", timestamp: "2026-01-01T00:00:00.000Z" }),
      JSON.stringify({
        type: "message",
        message: { role: "user", content: "The deploy script lives in scripts/release.sh. token sk-abc1234567890" },
      }),
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(other, "2026-01-02_b.jsonl"),
    [
      JSON.stringify({ type: "session", version: 3, cwd: "/work/other", timestamp: "2026-01-02T00:00:00.000Z" }),
      JSON.stringify({
        type: "message",
        message: { role: "user", content: "Unrelated notes about deploy script in another repo." },
      }),
    ].join("\n"),
  );
  const projectHits = searchSessions({
    sessionsDir: paths.sessionsDir,
    query: "deploy script",
    cwd: "/work/repo",
    scope: "project",
  });
  assert.equal(projectHits.length, 1);
  assert.equal(projectHits[0].cwd, "/work/repo");
  assert.equal(projectHits[0].snippet.includes("sk-abc1234567890"), false);
  const allHits = searchSessions({
    sessionsDir: paths.sessionsDir,
    query: "deploy script",
    cwd: "/work/repo",
    scope: "all",
  });
  assert.equal(allHits.length, 2);
  assert.equal(allHits[0].cwd, "/work/repo");
});
