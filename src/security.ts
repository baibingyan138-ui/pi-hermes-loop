const THREAT_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /ignore\s+(all\s+|any\s+|the\s+)?previous\s+instructions/i,
    reason: "instruction override",
  },
  {
    pattern: /disregard\s+(the\s+)?(system|previous|developer)/i,
    reason: "instruction override",
  },
  {
    pattern: /<\s*\/?\s*(system|hidden|instruction)\s*>/i,
    reason: "fake system tag",
  },
  {
    pattern: /you are now\s+(a|an|the)\b/i,
    reason: "role override",
  },
  {
    pattern: /\bBEGIN\s+(SYSTEM|PROMPT|HIDDEN)\b/,
    reason: "hidden prompt marker",
  },
  {
    pattern: /\bexfiltrat(e|ion)\b/i,
    reason: "exfiltration instruction",
  },
];

/** Reject memory and skill text that would persist a prompt injection. */
export function scanContent(content: string): string | null {
  for (const threat of THREAT_PATTERNS) {
    if (threat.pattern.test(content)) {
      return `Refused: content looks like a persisted ${threat.reason}. Rephrase it as a plain fact or procedure.`;
    }
  }
  return null;
}
