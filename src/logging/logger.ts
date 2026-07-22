import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  renameSync,
  statSync,
} from "node:fs";
import { join } from "node:path";

/** Runtime-only, structured logger. It accepts safe fields explicitly; it is
 * intentionally not a generic logger so prompts and auth material cannot be
 * accidentally recorded. */
export class SafeLogger {
  private readonly file: string | undefined;
  constructor(directory: string) {
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      chmodSync(directory, 0o700);
      this.file = join(directory, "guard.log");
    } catch {
      this.file = undefined;
    }
  }
  write(
    event: string,
    fields: Record<string, string | number | boolean | undefined>,
  ): void {
    if (!this.file) return;
    try {
      try {
        if (statSync(this.file).size > 1024 * 1024)
          renameSync(this.file, `${this.file}.1`);
      } catch {
        /* file does not exist */
      }
      const safe = Object.fromEntries(
        Object.entries(fields).filter(([, value]) => value !== undefined),
      );
      try {
        chmodSync(this.file, 0o600);
      } catch {
        /* file may not exist yet */
      }
      appendFileSync(
        this.file,
        `${JSON.stringify({ at: new Date().toISOString(), event, ...safe })}\n`,
        { mode: 0o600 },
      );
    } catch {
      /* logging must never affect the hook decision */
    }
  }
}
