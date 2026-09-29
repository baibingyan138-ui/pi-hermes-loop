export type Origin = "foreground" | "review";

export type MemoryTarget = "memory" | "user";

export interface MemoryOperation {
  action: "add" | "replace" | "remove";
  content?: string;
  old_text?: string;
}

export interface ToolOutcome {
  text: string;
  isError: boolean;
  /** Short user-facing summary when a write actually landed or was staged. */
  action?: string;
  stagedId?: string;
}

export interface ReviewContentText {
  type: "text";
  text: string;
}

export interface ReviewContentToolCall {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type ReviewContent = ReviewContentText | ReviewContentToolCall;

export interface ReviewMessage {
  role: "user" | "assistant" | "toolResult";
  content: string | ReviewContent[];
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
}

export interface ReviewCompletion {
  content: ReviewContent[];
  inputTokens: number;
  outputTokens: number;
}

export interface ReviewModel {
  complete(input: {
    system: string;
    messages: ReviewMessage[];
    signal?: AbortSignal;
  }): Promise<ReviewCompletion>;
}

export interface ReviewTool {
  name: string;
  run(args: Record<string, unknown>): ToolOutcome;
}

export type ReviewStatus = "saved" | "empty" | "aborted" | "error" | "budget";

export interface ReviewReport {
  status: ReviewStatus;
  actions: string[];
  text: string;
  iterations: number;
  inputTokens: number;
  error?: string;
}

export type ReviewKind = "memory" | "skills" | "combined";
