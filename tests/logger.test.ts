import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeLogger } from "../src/logging/logger.ts";

describe("safe logger", () => {
  test("writes structured safe fields and rotates large logs", async () => {
    const root = await mkdtemp(join(tmpdir(), "cug-logger-"));
    try {
      const logger = new SafeLogger(root);
      logger.write("decision", {
        profile: "personal",
        decision: "warn",
        omitted: undefined,
      });
      const file = join(root, "guard.log");
      expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({
        event: "decision",
        profile: "personal",
        decision: "warn",
      });
      expect((await stat(root)).mode & 0o777).toBe(0o700);
      expect((await stat(file)).mode & 0o777).toBe(0o600);

      logger.write("large", { payload: "x".repeat(1_050_000) });
      logger.write("after-rotation", { ok: true });
      expect((await stat(`${file}.1`)).size).toBeGreaterThan(1_000_000);
      expect(await readFile(file, "utf8")).toContain("after-rotation");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
