import fs from "node:fs";
import path from "node:path";
import { withFileLock, writeAtomic } from "./lock.ts";
import { scanContent } from "./security.ts";
import type { MemoryOperation, MemoryTarget, ToolOutcome } from "./types.ts";

export const ENTRY_DELIMITER = "\n§\n";

export interface MemoryStoreOptions {
  memoryDir: string;
  memoryCharLimit: number;
  userCharLimit: number;
  userProfile: boolean;
}

interface MutationResult {
  outcome: ToolOutcome;
  /** Present when the write was validated and should be persisted by the caller. */
  entries?: string[];
}

export class MemoryStore {
  private readonly options: MemoryStoreOptions;

  constructor(options: MemoryStoreOptions) {
    this.options = options;
  }

  filePath(target: MemoryTarget): string {
    return path.join(this.options.memoryDir, target === "user" ? "USER.md" : "MEMORY.md");
  }

  readEntries(target: MemoryTarget): string[] {
    return parseEntries(readFile(this.filePath(target)));
  }

  snapshotBlock(): string {
    const parts: string[] = [
      "Curated memory is a frozen snapshot for this session. The memory tool returns the live entries; do not expect this block to change until the next session.",
    ];
    parts.push(this.renderTarget("memory"));
    if (this.options.userProfile) parts.push(this.renderTarget("user"));
    return parts.join("\n\n");
  }

  apply(target: MemoryTarget, operations: MemoryOperation[], commit = true): ToolOutcome {
    if (target !== "memory" && target !== "user") {
      return fail("target must be 'memory' or 'user'.");
    }
    if (target === "user" && !this.options.userProfile) {
      return fail("User profile memory is disabled in hermes-loop config.");
    }
    if (operations.length === 0) return fail("No memory operations to apply.");

    const filePath = this.filePath(target);
    const lockPath = `${filePath}.lock`;
    try {
      return withFileLock(lockPath, () => {
        const raw = readFile(filePath);
        if (needsDriftGuard(operations) && hasDrift(raw)) {
          const bak = `${filePath}.bak-${Date.now()}`;
          if (raw) fs.copyFileSync(filePath, bak);
          return fail(
            `Refusing to rewrite ${path.basename(filePath)}: on-disk text would not round-trip through the memory tool. A snapshot was saved to ${bak}. Rewrite it as §-delimited entries, then retry.`,
          );
        }
        const current = parseEntries(raw);
        const planned = planOperations(current, operations, this.limit(target));
        if (!planned.entries) return planned.outcome;
        if (commit) writeAtomic(filePath, serializeEntries(planned.entries));
        return planned.outcome;
      });
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  }

  private limit(target: MemoryTarget): number {
    return target === "user" ? this.options.userCharLimit : this.options.memoryCharLimit;
  }

  private renderTarget(target: MemoryTarget): string {
    const entries = this.readEntries(target);
    const used = charCount(entries);
    const limit = this.limit(target);
    const heading = target === "user" ? "USER" : "MEMORY";
    if (entries.length === 0) {
      return `${heading} (${used}/${limit} chars)\n(empty)`;
    }
    return `${heading} (${used}/${limit} chars)\n${entries.map((entry) => `- ${entry}`).join("\n")}`;
  }
}

export function parseEntries(raw: string): string[] {
  if (!raw.trim()) return [];
  return raw
    .split(ENTRY_DELIMITER)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function serializeEntries(entries: string[]): string {
  if (entries.length === 0) return "";
  return `${entries.join(ENTRY_DELIMITER)}\n`;
}

export function charCount(entries: string[]): number {
  if (entries.length === 0) return 0;
  return entries.join(ENTRY_DELIMITER).length;
}

export function hasDrift(raw: string): boolean {
  if (!raw.trim()) return false;
  const entries = parseEntries(raw);
  if (new Set(entries).size !== entries.length) return true;
  return serializeEntries(entries).trim() !== raw.trim();
}

function needsDriftGuard(operations: MemoryOperation[]): boolean {
  return operations.some((operation) => operation.action !== "add");
}

function planOperations(entries: string[], operations: MemoryOperation[], limit: number): MutationResult {
  const working = [...entries];
  const notes: string[] = [];
  for (const operation of operations) {
    const step = applyOne(working, operation);
    if (step.error) {
      return {
        outcome: fail(`${step.error}\nCurrent entries:\n${renderEntries(working)}\nUsage: ${charCount(working)}/${limit}`),
      };
    }
    notes.push(step.note);
  }
  const total = charCount(working);
  if (total > limit) {
    return {
      outcome: fail(
        `Memory would be ${total}/${limit} chars. Shorten the new text or remove stale entries, then retry.\nCurrent entries:\n${renderEntries(entries)}\nUsage: ${charCount(entries)}/${limit}`,
      ),
    };
  }
  const usage = `${total}/${limit}`;
  return {
    entries: working,
    outcome: ok(`${notes.join(" ")} Usage: ${usage} chars.\nCurrent entries:\n${renderEntries(working)}`, notes.join("; ")),
  };
}

function applyOne(
  entries: string[],
  operation: MemoryOperation,
): { error?: string; note: string } {
  const content = operation.content?.trim() ?? "";
  const oldText = operation.old_text?.trim() ?? "";
  if (operation.action === "add") {
    if (!content) return { error: "Content cannot be empty.", note: "" };
    const scanned = scanContent(content);
    if (scanned) return { error: scanned, note: "" };
    if (entries.includes(content)) return { note: "Entry already exists." };
    entries.push(content);
    return { note: "Entry added." };
  }
  if (!oldText) return { error: "old_text cannot be empty.", note: "" };
  const matches = entries
    .map((entry, index) => ({ entry, index }))
    .filter((item) => item.entry.includes(oldText));
  if (matches.length === 0) {
    return { error: `No entry matched '${oldText}'.`, note: "" };
  }
  const unique = new Set(matches.map((item) => item.entry));
  if (matches.length > 1 && unique.size > 1) {
    return { error: `Multiple entries matched '${oldText}'. Be more specific.`, note: "" };
  }
  const index = matches[0].index;
  if (operation.action === "remove") {
    entries.splice(index, 1);
    return { note: "Entry removed." };
  }
  if (!content) return { error: "content cannot be empty. Use remove to delete an entry.", note: "" };
  const scanned = scanContent(content);
  if (scanned) return { error: scanned, note: "" };
  entries[index] = content;
  return { note: "Entry replaced." };
}

function renderEntries(entries: string[]): string {
  if (entries.length === 0) return "(empty)";
  return entries.map((entry) => `- ${entry}`).join("\n");
}

function readFile(filePath: string): string {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

function ok(text: string, action: string): ToolOutcome {
  return { text, isError: false, action };
}

function fail(text: string): ToolOutcome {
  return { text, isError: true };
}
