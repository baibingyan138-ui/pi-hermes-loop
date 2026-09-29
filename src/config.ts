import fs from "node:fs";
import { writeAtomic } from "./lock.ts";

export interface LoopConfig {
  enabled: boolean;
  memory: {
    enabled: boolean;
    /** Persist USER.md as well as MEMORY.md. */
    userProfile: boolean;
    memoryCharLimit: number;
    userCharLimit: number;
    writeApproval: boolean;
    /** Run a memory review every N user turns. */
    nudgeInterval: number;
  };
  skills: {
    enabled: boolean;
    writeApproval: boolean;
    /** Run a skill review when a turn uses at least this many tool calls. */
    nudgeToolIterations: number;
    /** Also review skills when the user corrects the agent, even below the tool threshold. */
    reviewOnCorrection: boolean;
  };
  review: {
    enabled: boolean;
    maxIterations: number;
    /** Stop before the review request that would pass this aggregate input-token count. 0 disables the cap. */
    maxInputTokens: number;
    /**
     * auto: full transcript on the session model, digest when an auxiliary model is set.
     * full: replay the transcript up to maxTranscriptChars.
     * digest: older turns become one line each.
     */
    replay: "auto" | "full" | "digest";
    maxTranscriptChars: number;
    /** Optional cheaper model. Leave null to use the session model. */
    provider: string | null;
    model: string | null;
    notify: boolean;
  };
  sessionSearch: {
    enabled: boolean;
    maxFiles: number;
    maxBytesPerFile: number;
  };
}

export const DEFAULT_CONFIG: LoopConfig = {
  enabled: true,
  memory: {
    enabled: true,
    userProfile: true,
    memoryCharLimit: 2200,
    userCharLimit: 1375,
    writeApproval: false,
    nudgeInterval: 10,
  },
  skills: {
    enabled: true,
    writeApproval: false,
    nudgeToolIterations: 10,
    reviewOnCorrection: true,
  },
  review: {
    enabled: true,
    maxIterations: 8,
    maxInputTokens: 600_000,
    replay: "auto",
    maxTranscriptChars: 120_000,
    provider: null,
    model: null,
    notify: true,
  },
  sessionSearch: {
    enabled: true,
    maxFiles: 40,
    maxBytesPerFile: 2_000_000,
  },
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergeConfig(base: LoopConfig, patch: unknown): LoopConfig {
  if (!isObject(patch)) return base;
  const memory = isObject(patch.memory) ? patch.memory : {};
  const skills = isObject(patch.skills) ? patch.skills : {};
  const review = isObject(patch.review) ? patch.review : {};
  const sessionSearch = isObject(patch.sessionSearch) ? patch.sessionSearch : {};
  const replay = review.replay;
  return {
    enabled: typeof patch.enabled === "boolean" ? patch.enabled : base.enabled,
    memory: {
      enabled: typeof memory.enabled === "boolean" ? memory.enabled : base.memory.enabled,
      userProfile: typeof memory.userProfile === "boolean" ? memory.userProfile : base.memory.userProfile,
      memoryCharLimit: numberOr(memory.memoryCharLimit, base.memory.memoryCharLimit),
      userCharLimit: numberOr(memory.userCharLimit, base.memory.userCharLimit),
      writeApproval: typeof memory.writeApproval === "boolean" ? memory.writeApproval : base.memory.writeApproval,
      nudgeInterval: Math.max(1, numberOr(memory.nudgeInterval, base.memory.nudgeInterval)),
    },
    skills: {
      enabled: typeof skills.enabled === "boolean" ? skills.enabled : base.skills.enabled,
      writeApproval: typeof skills.writeApproval === "boolean" ? skills.writeApproval : base.skills.writeApproval,
      nudgeToolIterations: Math.max(1, numberOr(skills.nudgeToolIterations, base.skills.nudgeToolIterations)),
      reviewOnCorrection:
        typeof skills.reviewOnCorrection === "boolean" ? skills.reviewOnCorrection : base.skills.reviewOnCorrection,
    },
    review: {
      enabled: typeof review.enabled === "boolean" ? review.enabled : base.review.enabled,
      maxIterations: Math.max(1, numberOr(review.maxIterations, base.review.maxIterations)),
      maxInputTokens: numberOr(review.maxInputTokens, base.review.maxInputTokens),
      replay: replay === "full" || replay === "digest" || replay === "auto" ? replay : base.review.replay,
      maxTranscriptChars: Math.max(2_000, numberOr(review.maxTranscriptChars, base.review.maxTranscriptChars)),
      provider: typeof review.provider === "string" && review.provider.trim() ? review.provider.trim() : null,
      model: typeof review.model === "string" && review.model.trim() ? review.model.trim() : null,
      notify: typeof review.notify === "boolean" ? review.notify : base.review.notify,
    },
    sessionSearch: {
      enabled: typeof sessionSearch.enabled === "boolean" ? sessionSearch.enabled : base.sessionSearch.enabled,
      maxFiles: Math.max(1, numberOr(sessionSearch.maxFiles, base.sessionSearch.maxFiles)),
      maxBytesPerFile: Math.max(10_000, numberOr(sessionSearch.maxBytesPerFile, base.sessionSearch.maxBytesPerFile)),
    },
  };
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function loadConfig(configPath: string): LoopConfig {
  try {
    const raw = fs.readFileSync(configPath, "utf8");
    return mergeConfig(DEFAULT_CONFIG, JSON.parse(raw) as unknown);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return structuredClone(DEFAULT_CONFIG);
    return structuredClone(DEFAULT_CONFIG);
  }
}

export function ensureDefaultConfig(configPath: string): LoopConfig {
  if (!fs.existsSync(configPath)) {
    writeAtomic(configPath, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`);
  }
  return loadConfig(configPath);
}
