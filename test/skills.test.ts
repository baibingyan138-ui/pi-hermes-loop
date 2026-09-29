import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { approvePending, openRuntime, runSkillManage, runSkillView } from "../src/actions.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { ReadMarks } from "../src/read-marks.ts";
import { SkillStore } from "../src/skill-store.ts";
import { skillMarkdown, tempPaths } from "./helpers.ts";

function skills() {
  const paths = tempPaths();
  const store = new SkillStore({
    skillsDir: paths.skillsDir,
    registryPath: paths.registryPath,
    readMarks: new ReadMarks(),
  });
  return { paths, store };
}

test("foreground create is user-owned and background review cannot patch it", () => {
  const { store } = skills();
  const created = store.mutate(
    { action: "create", name: "deploy-web", content: skillMarkdown("deploy-web", "Deploy the web service") },
    "foreground",
  );
  assert.equal(created.isError, false);
  assert.match(created.text, /user-owned/);
  store.view("deploy-web");
  const blocked = store.mutate(
    { action: "patch", name: "deploy-web", old_string: "carefully", new_string: "with a rollback" },
    "review",
  );
  assert.equal(blocked.isError, true);
  assert.match(blocked.text, /adopt/);
});

test("review create rejects a session-artifact name and enforces read-before-write", () => {
  const { store, paths } = skills();
  const artifact = store.mutate(
    { action: "create", name: "fix-504-today", content: skillMarkdown("fix-504-today", "Today's outage") },
    "review",
  );
  assert.equal(artifact.isError, true);
  const created = store.mutate(
    { action: "create", name: "deploy-web", content: skillMarkdown("deploy-web", "Deploy the web service") },
    "review",
  );
  assert.equal(created.isError, false);
  const unread = store.mutate(
    { action: "patch", name: "deploy-web", old_string: "carefully", new_string: "with a rollback" },
    "review",
  );
  assert.match(unread.text, /Read-before-write/);
  store.view("deploy-web");
  const patched = store.mutate(
    { action: "patch", name: "deploy-web", old_string: "carefully", new_string: "with a rollback" },
    "review",
  );
  assert.equal(patched.isError, false);
  const body = fs.readFileSync(path.join(paths.skillsDir, "deploy-web", "SKILL.md"), "utf8");
  assert.match(body, /rollback/);
});

test("support files stay inside the skill and new files do not need a prior read", () => {
  const { store, paths } = skills();
  store.mutate(
    { action: "create", name: "deploy-web", content: skillMarkdown("deploy-web", "Deploy the web service") },
    "review",
  );
  const escaped = store.mutate(
    { action: "write_file", name: "deploy-web", file_path: "references/../../secret.txt", file_content: "nope" },
    "foreground",
  );
  assert.equal(escaped.isError, true);
  const written = store.mutate(
    {
      action: "write_file",
      name: "deploy-web",
      file_path: "references/rollback.md",
      file_content: "Roll back by redeploying the previous image.",
    },
    "review",
  );
  assert.equal(written.isError, false);
  assert.equal(
    fs.existsSync(path.join(paths.skillsDir, "deploy-web", "references", "rollback.md")),
    true,
  );
  const overwrite = store.mutate(
    {
      action: "write_file",
      name: "deploy-web",
      file_path: "references/rollback.md",
      file_content: "changed",
    },
    "review",
  );
  assert.match(overwrite.text, /Read-before-write/);
});

test("pin blocks review writes until unpin, and adopt hands a user skill over", () => {
  const { store } = skills();
  store.mutate(
    { action: "create", name: "deploy-web", content: skillMarkdown("deploy-web", "Deploy the web service") },
    "review",
  );
  assert.match(store.pin("deploy-web", true).text, /Pinned/);
  store.view("deploy-web");
  const pinned = store.mutate(
    { action: "patch", name: "deploy-web", old_string: "carefully", new_string: "quietly" },
    "review",
  );
  assert.match(pinned.text, /pinned/);
  store.pin("deploy-web", false);
  const open = store.mutate(
    { action: "patch", name: "deploy-web", old_string: "carefully", new_string: "quietly" },
    "review",
  );
  assert.equal(open.isError, false);

  store.mutate(
    { action: "create", name: "review-pr", content: skillMarkdown("review-pr", "Review a pull request") },
    "foreground",
  );
  assert.match(store.adopt("review-pr").text, /Adopted/);
  store.view("review-pr");
  const adopted = store.mutate(
    { action: "patch", name: "review-pr", old_string: "carefully", new_string: "against the checklist" },
    "review",
  );
  assert.equal(adopted.isError, false);
});

test("skill write approval does not touch disk until approve", () => {
  const paths = tempPaths();
  const runtime = openRuntime(paths, {
    ...DEFAULT_CONFIG,
    skills: { ...DEFAULT_CONFIG.skills, writeApproval: true },
  });
  const staged = runSkillManage(runtime, "foreground", {
    action: "create",
    name: "deploy-web",
    content: skillMarkdown("deploy-web", "Deploy the web service"),
  });
  assert.equal(staged.isError, false);
  assert.equal(fs.existsSync(path.join(paths.skillsDir, "deploy-web", "SKILL.md")), false);
  const approved = approvePending(runtime, staged.stagedId ?? "");
  assert.equal(approved.isError, false);
  assert.equal(fs.existsSync(path.join(paths.skillsDir, "deploy-web", "SKILL.md")), true);
  const viewed = runSkillView(runtime, { name: "deploy-web" });
  assert.match(viewed.text, /Deploy the web service/);
});
