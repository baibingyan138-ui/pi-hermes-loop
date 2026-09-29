/** Strip common secrets before a transcript is shown to the review model or search results. */
export function redactSecrets(text: string): string {
  return text
    .replace(/\bsk-[A-Za-z0-9_-]{10,}\b/g, "sk-[redacted]")
    .replace(/\bghp_[A-Za-z0-9]{10,}\b/g, "ghp_[redacted]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "AKIA[redacted]")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{10,}\b/g, "github_pat_[redacted]")
    .replace(
      /\b(api[_-]?key|access[_-]?token|secret|password|authorization)\b(\s*[:=]\s*|\s+)([^\s,;"']{6,})/gi,
      "$1=[redacted]",
    );
}
