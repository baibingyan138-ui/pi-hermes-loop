import { reviewTools, skillCatalog, type LoopRuntime } from "./actions.ts";
import { reviewSystemPrompt, reviewTask } from "./prompts.ts";
import { runReviewLoop } from "./review-loop.ts";
import { renderTranscript, messagesToLines } from "./transcript.ts";
import type { ReviewKind, ReviewModel, ReviewReport } from "./types.ts";

export async function runBackgroundReview(options: {
  runtime: LoopRuntime;
  model: ReviewModel;
  messages: unknown[];
  kind: ReviewKind;
  digest: boolean;
  signal?: AbortSignal;
}): Promise<ReviewReport> {
  const lines = messagesToLines(options.messages);
  const transcript = renderTranscript(lines, {
    digest: options.digest,
    maxChars: options.runtime.config.review.maxTranscriptChars,
  });
  return runReviewLoop({
    model: options.model,
    tools: reviewTools(options.runtime),
    system: reviewSystemPrompt(),
    transcript,
    task: reviewTask(options.kind, skillCatalog(options.runtime.skills)),
    maxIterations: options.runtime.config.review.maxIterations,
    maxInputTokens: options.runtime.config.review.maxInputTokens,
    signal: options.signal,
  });
}
