import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveLoopPaths, type LoopPaths } from "../src/paths.ts";

export function tempPaths(): LoopPaths {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-loop-"));
  return resolveLoopPaths({ PI_HERMES_AGENT_DIR: agentDir });
}

export function skillMarkdown(name: string, description: string, body = "Do the task carefully."): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`;
}
