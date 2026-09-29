import os from "node:os";
import path from "node:path";

export interface LoopPaths {
  agentDir: string;
  stateDir: string;
  memoryDir: string;
  skillsDir: string;
  sessionsDir: string;
  pendingDir: string;
  configPath: string;
  registryPath: string;
  reviewLogPath: string;
}

/** Resolve Pi's agent directory and the files this loop owns. */
export function resolveLoopPaths(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): LoopPaths {
  const agentDir =
    env.PI_HERMES_AGENT_DIR ||
    env.PI_CODING_AGENT_DIR ||
    env.PI_AGENT_DIR ||
    path.join(home, ".pi", "agent");
  const stateDir = path.join(agentDir, "hermes-loop");
  const sessionsDir =
    env.PI_SESSIONS_DIR || env.PI_CODING_AGENT_SESSION_DIR || path.join(agentDir, "sessions");
  return {
    agentDir,
    stateDir,
    memoryDir: path.join(stateDir, "memories"),
    skillsDir: path.join(agentDir, "skills"),
    sessionsDir,
    pendingDir: path.join(stateDir, "pending"),
    configPath: path.join(stateDir, "config.json"),
    registryPath: path.join(stateDir, "managed.json"),
    reviewLogPath: path.join(stateDir, "reviews.jsonl"),
  };
}
