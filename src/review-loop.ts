import type { ReviewMessage, ReviewModel, ReviewReport, ReviewTool } from "./types.ts";

export interface ReviewLoopInput {
  model: ReviewModel;
  tools: ReviewTool[];
  system: string;
  transcript: string;
  task: string;
  maxIterations: number;
  maxInputTokens: number;
  signal?: AbortSignal;
}

export async function runReviewLoop(input: ReviewLoopInput): Promise<ReviewReport> {
  const tools = new Map(input.tools.map((tool) => [tool.name, tool]));
  const messages: ReviewMessage[] = [
    {
      role: "user",
      content: `${input.transcript || "(empty conversation)"}\n\n---\n\n${input.task}`,
    },
  ];
  const actions: string[] = [];
  let inputTokens = 0;
  let lastText = "";

  for (let iteration = 1; iteration <= input.maxIterations; iteration += 1) {
    if (input.signal?.aborted) {
      return { status: "aborted", actions, text: lastText, iterations: iteration - 1, inputTokens };
    }
    if (input.maxInputTokens > 0 && inputTokens >= input.maxInputTokens) {
      return { status: "budget", actions, text: lastText, iterations: iteration - 1, inputTokens };
    }
    let completion;
    try {
      completion = await input.model.complete({
        system: input.system,
        messages,
        signal: input.signal,
      });
    } catch (error) {
      if (input.signal?.aborted) {
        return { status: "aborted", actions, text: lastText, iterations: iteration - 1, inputTokens };
      }
      return {
        status: "error",
        actions,
        text: lastText,
        iterations: iteration - 1,
        inputTokens,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    inputTokens += completion.inputTokens;
    const text = completion.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();
    const toolCalls = completion.content.filter((block) => block.type === "toolCall");
    lastText = text || lastText;
    if (toolCalls.length === 0) {
      const saved = actions.length > 0;
      return {
        status: saved ? "saved" : "empty",
        actions,
        text: text || lastText,
        iterations: iteration,
        inputTokens,
      };
    }
    messages.push({ role: "assistant", content: completion.content });
    for (const call of toolCalls) {
      const outcome = executeReviewTool(tools, call.name, call.arguments);
      if (outcome.action) actions.push(outcome.action);
      messages.push({
        role: "toolResult",
        toolCallId: call.id,
        toolName: call.name,
        isError: outcome.isError,
        content: outcome.text,
      });
    }
  }

  return {
    status: actions.length > 0 ? "saved" : "budget",
    actions,
    text: lastText,
    iterations: input.maxIterations,
    inputTokens,
  };
}

function executeReviewTool(
  tools: Map<string, ReviewTool>,
  name: string,
  args: Record<string, unknown>,
): { text: string; isError: boolean; action?: string } {
  const tool = tools.get(name);
  if (!tool) {
    return {
      text: `Background review denied non-whitelisted tool: ${name}. Only memory, skill_view, skills_list, and skill_manage are allowed.`,
      isError: true,
    };
  }
  try {
    return tool.run(args);
  } catch (error) {
    return {
      text: error instanceof Error ? error.message : String(error),
      isError: true,
    };
  }
}
