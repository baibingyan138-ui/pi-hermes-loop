import fs from "node:fs";
import { writeAtomic } from "./lock.ts";

const MAX_LOG_BYTES = 1_000_000;
const KEEP_LINES = 200;

export function appendReviewLog(filePath: string, record: Record<string, unknown>): void {
  const line = `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`;
  let existing = "";
  try {
    existing = fs.readFileSync(filePath, "utf8");
  } catch {
    existing = "";
  }
  let next = existing + line;
  if (Buffer.byteLength(next) > MAX_LOG_BYTES) {
    const lines = next.trim().split("\n").slice(-KEEP_LINES);
    next = `${lines.join("\n")}\n`;
  }
  writeAtomic(filePath, next);
}
