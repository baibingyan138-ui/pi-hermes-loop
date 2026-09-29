import { redactSecrets } from "./redact.ts";

export interface TranscriptLine {
  role: string;
  text: string;
}

export interface TranscriptOptions {
  digest: boolean;
  maxChars: number;
  /** How many recent lines stay verbatim when digesting or truncating. */
  keepRecent?: number;
}

/** Turn Pi session messages into the text the background review reads. */
export function messagesToLines(messages: unknown[]): TranscriptLine[] {
  const lines: TranscriptLine[] = [];
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const record = message as Record<string, unknown>;
    const role = typeof record.role === "string" ? record.role : "";
    if (!role || role === "system") continue;
    const text = extractText(record.content ?? record);
    if (!text.trim()) continue;
    const label = role === "toolResult" ? `tool:${typeof record.toolName === "string" ? record.toolName : "result"}` : role;
    lines.push({ role: label, text: redactSecrets(collapse(text)) });
  }
  return lines;
}

export function renderTranscript(lines: TranscriptLine[], options: TranscriptOptions): string {
  const keepRecent = options.keepRecent ?? 12;
  const rendered = lines.map((line) => `${line.role.toUpperCase()}: ${redactSecrets(line.text)}`);
  if (!options.digest && rendered.join("\n\n").length <= options.maxChars) {
    return rendered.join("\n\n");
  }
  const head = rendered.slice(0, Math.max(0, rendered.length - keepRecent));
  const tail = rendered.slice(-keepRecent);
  const digest = head
    .map((line) => line.slice(0, 200))
    .join("\n");
  const body = [
    digest
      ? `[Earlier conversation digest — older turns shortened. Recent turns follow verbatim.]\n${digest}`
      : "",
    tail.join("\n\n"),
  ]
    .filter(Boolean)
    .join("\n\n");
  if (body.length <= options.maxChars) return body;
  return body.slice(body.length - options.maxChars);
}

export function countToolCallsSinceLastUser(messages: unknown[]): number {
  let count = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || typeof message !== "object") continue;
    const record = message as Record<string, unknown>;
    if (record.role === "user") break;
    if (record.role === "toolResult") count += 1;
    if (record.role === "assistant" && Array.isArray(record.content)) {
      count += record.content.filter((block) => isRecord(block) && block.type === "toolCall").length;
    }
  }
  return count;
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === "string") return block;
        if (!isRecord(block)) return "";
        if (typeof block.text === "string") return block.text;
        if (block.type === "toolCall" && typeof block.name === "string") {
          return `[tool call ${block.name}]`;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (isRecord(content) && typeof content.text === "string") return content.text;
  return "";
}

function collapse(text: string): string {
  return text.replace(/\s+\n/g, "\n").trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
