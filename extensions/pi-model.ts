import type { ReviewCompletion, ReviewContent, ReviewMessage, ReviewModel } from "../src/types.ts";

interface PiModel {
  api: string;
  provider: string;
  id: string;
}

interface PiTool {
  name: string;
  description: string;
  parameters: unknown;
}

interface PiRegistry {
  complete?: (model: PiModel, context: unknown, options?: { signal?: AbortSignal }) => Promise<unknown>;
  getProvider?: (provider: string) => {
    streamSimple?: (model: PiModel, context: unknown, options?: { signal?: AbortSignal }) => AsyncIterable<unknown> & {
      result?: () => Promise<unknown>;
    };
  };
  get?: (provider: string, modelId: string) => PiModel | undefined;
  find?: (provider: string, modelId: string) => PiModel | undefined;
  getAll?: () => PiModel[];
}

/** Pick the session model, or the auxiliary model named in config. */
export function selectReviewModel(
  registry: PiRegistry,
  current: PiModel | undefined,
  provider: string | null,
  modelId: string | null,
): PiModel | undefined {
  if (!provider || !modelId) return current;
  return (
    registry.get?.(provider, modelId) ||
    registry.find?.(provider, modelId) ||
    registry.getAll?.().find((model) => model.provider === provider && model.id === modelId)
  );
}

export function piReviewModel(registry: PiRegistry, model: PiModel, tools: PiTool[]): ReviewModel {
  return {
    async complete(input): Promise<ReviewCompletion> {
      const context = {
        systemPrompt: input.system,
        messages: toPiMessages(input.messages, model),
        tools,
      };
      const assistant = await request(registry, model, context, input.signal);
      if (!assistant || typeof assistant !== "object") {
        throw new Error("Background review model returned an empty response.");
      }
      const record = assistant as Record<string, unknown>;
      if (record.stopReason === "error" || record.stopReason === "aborted") {
        throw new Error(typeof record.errorMessage === "string" ? record.errorMessage : `Review model stopped: ${String(record.stopReason)}`);
      }
      const content = parseContent(record.content);
      const usage = record.usage && typeof record.usage === "object" ? (record.usage as Record<string, unknown>) : {};
      const inputTokens = number(usage.input) + number(usage.cacheRead) + number(usage.cacheWrite);
      return {
        content,
        inputTokens,
        outputTokens: number(usage.output),
      };
    },
  };
}

async function request(
  registry: PiRegistry,
  model: PiModel,
  context: unknown,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  if (typeof registry.complete === "function") {
    return registry.complete(model, context, { signal });
  }
  const provider = registry.getProvider?.(model.provider);
  const stream = provider?.streamSimple?.(model, context, { signal });
  if (!stream) throw new Error("This Pi build cannot run a background review completion.");
  if (typeof stream.result === "function") return stream.result();
  let last: unknown;
  for await (const event of stream) {
    if (!event || typeof event !== "object") continue;
    const record = event as Record<string, unknown>;
    if (record.type === "error") {
      throw new Error(typeof record.error === "string" ? record.error : "Review model stream failed.");
    }
    if (record.message) last = record.message;
    else if (record.partial) last = record.partial;
    else if (record.error && typeof record.error === "object") last = record.error;
  }
  return last;
}

function toPiMessages(messages: ReviewMessage[], model: PiModel): unknown[] {
  return messages.map((message) => {
    if (message.role === "user") {
      return {
        role: "user",
        content: typeof message.content === "string" ? message.content : textOf(message.content),
        timestamp: Date.now(),
      };
    }
    if (message.role === "toolResult") {
      return {
        role: "toolResult",
        toolCallId: message.toolCallId,
        toolName: message.toolName,
        content: [{ type: "text", text: typeof message.content === "string" ? message.content : textOf(message.content) }],
        isError: message.isError === true,
        timestamp: Date.now(),
      };
    }
    return {
      role: "assistant",
      content: Array.isArray(message.content)
        ? message.content.map((block) =>
            block.type === "text"
              ? { type: "text", text: block.text }
              : { type: "toolCall", id: block.id, name: block.name, arguments: block.arguments },
          )
        : [{ type: "text", text: message.content }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      stopReason: "toolUse",
      timestamp: Date.now(),
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };
  });
}

function parseContent(content: unknown): ReviewContent[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return [];
  const blocks: ReviewContent[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const record = block as Record<string, unknown>;
    if (record.type === "text" && typeof record.text === "string") {
      blocks.push({ type: "text", text: record.text });
    } else if (record.type === "toolCall" && typeof record.name === "string") {
      const args = record.arguments;
      blocks.push({
        type: "toolCall",
        id: typeof record.id === "string" ? record.id : `call_${blocks.length}`,
        name: record.name,
        arguments: args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {},
      });
    }
  }
  return blocks;
}

function textOf(content: ReviewContent[]): string {
  return content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
