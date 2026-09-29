import type { LoopConfig } from "./config.ts";
import { decideReview, looksLikeCorrection } from "./scheduler.ts";
import type { ReviewKind } from "./types.ts";

/** Per-session counters for the Hermes nudge cadence. Not written into the transcript. */
export class LearningSession {
  userTurns = 0;
  toolCallsThisRun = 0;
  correction = false;
  private frozenBlock: string | null = null;
  private abort: AbortController | null = null;

  reset(frozenBlock: string | null): void {
    this.userTurns = 0;
    this.toolCallsThisRun = 0;
    this.correction = false;
    this.frozenBlock = frozenBlock;
    this.cancelReview();
  }

  /** A new user turn cancels any in-flight background review. */
  beginTurn(prompt: string): void {
    this.cancelReview();
    this.userTurns += 1;
    this.toolCallsThisRun = 0;
    this.correction = looksLikeCorrection(prompt);
  }

  noteTool(): void {
    this.toolCallsThisRun += 1;
  }

  frozen(): string | null {
    return this.frozenBlock;
  }

  decide(config: LoopConfig): ReviewKind | null {
    return decideReview(config, {
      userTurns: this.userTurns,
      toolCalls: this.toolCallsThisRun,
      correction: this.correction,
    });
  }

  /** Aborts any review already running for this turn, then starts a new one. */
  startReview(): AbortSignal {
    this.cancelReview();
    this.abort = new AbortController();
    return this.abort.signal;
  }

  cancelReview(): void {
    this.abort?.abort();
    this.abort = null;
  }
}

const MEMORY_MARKER = "\n\n# Hermes loop memory\n";

/** Append the frozen snapshot without replacing Pi's system prompt. */
export function appendFrozenMemory(systemPrompt: string, frozen: string): string {
  if (systemPrompt.includes(MEMORY_MARKER)) return systemPrompt;
  return `${systemPrompt}${MEMORY_MARKER}${frozen}`;
}
