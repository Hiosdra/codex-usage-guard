import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLatestSessionRateLimits } from "../src/codex/session-files-fallback.ts";

describe("session-file fallback", () => {
  test("selects the newest normalizable session event", async () => {
    const root = await mkdtemp(join(tmpdir(), "cug-sessions-"));
    try {
      const oldDir = join(root, "sessions", "2026", "old");
      const newDir = join(root, "sessions", "2026", "new", "nested");
      await mkdir(oldDir, { recursive: true });
      await mkdir(newDir, { recursive: true });
      const oldFile = join(oldDir, "old.jsonl");
      const newFile = join(newDir, "new.jsonl");
      await writeFile(
        oldFile,
        "not-json\nrateLimits: malformed\n" +
          JSON.stringify({ rate_limits: { secondary: { usedPercent: 20 } } }) +
          "\n",
      );
      await writeFile(
        newFile,
        JSON.stringify({
          payload: { info: { rateLimits: { secondary: { usedPercent: 40 } } } },
        }) + "\n",
      );
      await writeFile(join(root, "sessions", "ignored.txt"), "rateLimits");
      await utimes(oldFile, new Date("2026-09-01"), new Date("2026-09-01"));
      await utimes(newFile, new Date("2026-10-01"), new Date("2026-10-01"));
      const result = await readLatestSessionRateLimits(root);
      expect(result?.source).toBe("session_files");
      expect(result?.file).toBe(newFile);
      expect(result?.raw).toEqual({
        rateLimits: { secondary: { usedPercent: 40 } },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("returns undefined for a missing or unsupported sessions directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "cug-sessions-empty-"));
    try {
      expect(
        await readLatestSessionRateLimits(join(root, "missing")),
      ).toBeUndefined();
      await mkdir(join(root, "sessions"), { recursive: true });
      await writeFile(
        join(root, "sessions", "unsupported.txt"),
        "no rate data",
      );
      expect(await readLatestSessionRateLimits(root)).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("skips files that disappear or cannot be read", async () => {
    const root = await mkdtemp(join(tmpdir(), "cug-sessions-errors-"));
    try {
      const sessions = join(root, "sessions");
      await mkdir(sessions, { recursive: true });
      const statFile = join(sessions, "stat.jsonl");
      const readFile = join(sessions, "read.jsonl");
      const invalidFile = join(sessions, "invalid.jsonl");
      await writeFile(statFile, JSON.stringify({ rateLimits: {} }));
      await writeFile(readFile, JSON.stringify({ rateLimits: {} }));
      await writeFile(invalidFile, "rateLimits: malformed\n");
      expect(
        await readLatestSessionRateLimits(root, {
          stat: async (file) => {
            if (file === statFile) throw new Error("synthetic stat race");
            return { mtimeMs: 2 };
          },
          readFile: async (file) => {
            if (file === readFile) throw new Error("synthetic read race");
            if (file === invalidFile) return "rateLimits: malformed\n";
            return "";
          },
        }),
      ).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
