import type { LoopConfig } from "./config.ts";
import type { ReviewKind } from "./types.ts";

export interface TurnSignals {
  userTurns: number;
  toolCalls: number;
  correction: boolean;
}

const CORRECTION_PATTERNS = [
  /remember this/i,
  /stop doing/i,
  /too verbose/i,
  /don'?t format/i,
  /i hate when you/i,
  /next time/i,
  /from now on/i,
  /不要再/,
  /别再/,
  /太啰嗦/,
  /太长了/,
  /记住/,
  /以后都/,
  /下次/,
  /不要这样/,
];

export function looksLikeCorrection(text: string): boolean {
  return CORRECTION_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Hermes cadence: memory every N user turns, skills after a heavy tool turn
 * or an explicit correction. A quiet turn schedules nothing.
 */
export function decideReview(config: LoopConfig, signals: TurnSignals): ReviewKind | null {
  if (!config.enabled || !config.review.enabled) return null;
  const memoryDue =
    config.memory.enabled &&
    signals.userTurns > 0 &&
    signals.userTurns % config.memory.nudgeInterval === 0;
  const skillsDue =
    config.skills.enabled &&
    (signals.toolCalls >= config.skills.nudgeToolIterations ||
      (config.skills.reviewOnCorrection && signals.correction));
  if (memoryDue && skillsDue) return "combined";
  if (memoryDue) return "memory";
  if (skillsDue) return "skills";
  return null;
}
