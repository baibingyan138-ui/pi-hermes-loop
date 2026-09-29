import fs from "node:fs";
import path from "node:path";
import { redactSecrets } from "./redact.ts";

export interface SessionSearchOptions {
  sessionsDir: string;
  query: string;
  limit?: number;
  scope?: "project" | "all";
  cwd?: string;
  excludeFile?: string;
  maxFiles?: number;
  maxBytesPerFile?: number;
}

export interface SessionHit {
  file: string;
  cwd: string;
  score: number;
  snippet: string;
  timestamp: string;
}

export function searchSessions(options: SessionSearchOptions): SessionHit[] {
  const terms = tokenize(options.query);
  if (terms.length === 0) return [];
  const limit = options.limit ?? 5;
  const maxFiles = options.maxFiles ?? 40;
  const maxBytes = options.maxBytesPerFile ?? 2_000_000;
  const files = listSessionFiles(options.sessionsDir).slice(0, maxFiles);
  const hits: SessionHit[] = [];
  for (const file of files) {
    if (options.excludeFile && path.resolve(file) === path.resolve(options.excludeFile)) continue;
    const raw = readBounded(file, maxBytes);
    const header = parseHeader(raw);
    if (options.scope !== "all" && options.cwd && header.cwd && path.resolve(header.cwd) !== path.resolve(options.cwd)) {
      continue;
    }
    const text = redactSecrets(extractSearchText(raw));
    const score = scoreText(text, terms) + (header.cwd && options.cwd && path.resolve(header.cwd) === path.resolve(options.cwd) ? 1 : 0);
    if (score <= 0) continue;
    hits.push({
      file,
      cwd: header.cwd,
      score,
      snippet: snippetAround(text, terms),
      timestamp: header.timestamp,
    });
  }
  return hits.sort((a, b) => b.score - a.score || b.timestamp.localeCompare(a.timestamp)).slice(0, limit);
}

function listSessionFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const files: string[] = [];
  const walk = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(full);
    }
  };
  walk(root);
  return files
    .map((file) => ({ file, mtime: fs.statSync(file).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .map((item) => item.file);
}

function readBounded(file: string, maxBytes: number): string {
  const stat = fs.statSync(file);
  const fd = fs.openSync(file, "r");
  try {
    if (stat.size <= maxBytes) {
      const buffer = Buffer.alloc(stat.size);
      fs.readSync(fd, buffer, 0, stat.size, 0);
      return buffer.toString("utf8");
    }
    const half = Math.floor(maxBytes / 2);
    const head = Buffer.alloc(half);
    const tail = Buffer.alloc(half);
    fs.readSync(fd, head, 0, half, 0);
    fs.readSync(fd, tail, 0, half, Math.max(0, stat.size - half));
    return `${head.toString("utf8")}\n${tail.toString("utf8")}`;
  } finally {
    fs.closeSync(fd);
  }
}

function parseHeader(raw: string): { cwd: string; timestamp: string } {
  const line = raw.split("\n").find((item) => item.trim().startsWith("{"));
  if (!line) return { cwd: "", timestamp: "" };
  try {
    const parsed = JSON.parse(line) as { type?: string; cwd?: string; timestamp?: string };
    if (parsed.type !== "session") return { cwd: "", timestamp: "" };
    return { cwd: parsed.cwd ?? "", timestamp: parsed.timestamp ?? "" };
  } catch {
    return { cwd: "", timestamp: "" };
  }
}

function extractSearchText(raw: string): string {
  const chunks: string[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const entry = parsed as Record<string, unknown>;
    if (entry.type === "compaction" && typeof entry.summary === "string") {
      chunks.push(entry.summary);
      continue;
    }
    if (entry.type !== "message" && entry.type !== "custom_message") continue;
    const message = entry.type === "message" && entry.message && typeof entry.message === "object"
      ? (entry.message as Record<string, unknown>)
      : entry;
    const role = typeof message.role === "string" ? message.role : entry.type;
    if (role === "system") continue;
    const text = contentText(message.content);
    if (text.trim()) chunks.push(`${role}: ${text}`);
  }
  return chunks.join("\n");
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      const record = block as Record<string, unknown>;
      return typeof record.text === "string" ? record.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

function tokenize(query: string): string[] {
  return [...new Set(query.toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter((term) => term.length >= 2))];
}

function scoreText(text: string, terms: string[]): number {
  const haystack = text.toLowerCase();
  let score = 0;
  for (const term of terms) {
    const hits = haystack.split(term).length - 1;
    if (hits > 0) score += 1 + Math.min(hits, 5) * 0.2;
  }
  return score;
}

function snippetAround(text: string, terms: string[]): string {
  const lower = text.toLowerCase();
  let index = -1;
  for (const term of terms) {
    index = lower.indexOf(term);
    if (index !== -1) break;
  }
  if (index === -1) return text.slice(0, 240);
  const start = Math.max(0, index - 80);
  const excerpt = text.slice(start, start + 280).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${excerpt}`;
}
