import fs from "node:fs";
import path from "node:path";

const sleepBuf = new Int32Array(new SharedArrayBuffer(4));

function sleepMs(ms: number): void {
  Atomics.wait(sleepBuf, 0, 0, ms);
}

/** Exclusive lock so two Pi sessions cannot rewrite the same memory file. */
export function withFileLock<T>(lockPath: string, fn: () => T): T {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const started = Date.now();
  for (;;) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      try {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs > 5_000) fs.unlinkSync(lockPath);
      } catch {
        // The owner released the lock between stat and unlink.
      }
      if (Date.now() - started > 3_000) {
        throw new Error(`Timed out waiting for lock ${lockPath}`);
      }
      sleepMs(20);
    }
  }
  try {
    return fn();
  } finally {
    try {
      fs.unlinkSync(lockPath);
    } catch {
      // Already released.
    }
  }
}

export function writeAtomic(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, filePath);
}
