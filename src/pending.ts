import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { writeAtomic } from "./lock.ts";
import type { MemoryOperation, MemoryTarget, Origin } from "./types.ts";
import type { SkillAction } from "./skill-store.ts";

export interface PendingWrite {
  id: string;
  createdAt: string;
  origin: Origin;
  summary: string;
  mutation: PendingMutation;
}

export type PendingMutation =
  | { kind: "memory"; target: MemoryTarget; operations: MemoryOperation[] }
  | { kind: "skill"; request: SkillAction };

export class PendingStore {
  private readonly pendingDir: string;

  constructor(pendingDir: string) {
    this.pendingDir = pendingDir;
  }

  stage(input: Omit<PendingWrite, "id" | "createdAt">): PendingWrite {
    const record: PendingWrite = {
      id: `p_${randomBytes(4).toString("hex")}`,
      createdAt: new Date().toISOString(),
      ...input,
    };
    fs.mkdirSync(this.pendingDir, { recursive: true });
    writeAtomic(path.join(this.pendingDir, `${record.id}.json`), `${JSON.stringify(record, null, 2)}\n`);
    return record;
  }

  list(): PendingWrite[] {
    if (!fs.existsSync(this.pendingDir)) return [];
    return fs
      .readdirSync(this.pendingDir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => JSON.parse(fs.readFileSync(path.join(this.pendingDir, name), "utf8")) as PendingWrite)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  get(id: string): PendingWrite | null {
    const filePath = this.file(id);
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as PendingWrite;
  }

  discard(id: string): boolean {
    const filePath = this.file(id);
    if (!fs.existsSync(filePath)) return false;
    fs.unlinkSync(filePath);
    return true;
  }

  private file(id: string): string {
    if (!/^p_[a-f0-9]+$/.test(id)) return path.join(this.pendingDir, "__invalid__");
    return path.join(this.pendingDir, `${id}.json`);
  }
}
