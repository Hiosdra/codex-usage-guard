import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore } from "../src/persistence/sqlite.ts";

describe("SQLite state", () => {
  test("uses WAL, atomically accumulates extensions and rejects stale epochs", async () => {
    const root = await mkdtemp(join(tmpdir(), "cug-state-"));
    const state = new StateStore(join(root, "state.sqlite"));
    try {
      expect(
        state.db
          .query<{ journal_mode: string }, []>("PRAGMA journal_mode")
          .get()?.journal_mode,
      ).toBe("wal");
      state.ensureEpoch({
        epochId: "epoch-a",
        profile: "personal",
        strategy: "weekly_percentage_pacing",
        periodStart: new Date("2026-09-25T00:00:00Z"),
        periodEnd: new Date("2026-10-02T00:00:00Z"),
        resetMethod: "server_observed",
      });
      await Promise.all(
        Array.from({ length: 8 }, () =>
          Promise.resolve(
            state.updateExtension(
              "personal",
              "weekly_percentage_pacing",
              "epoch-a",
              3600,
              0,
            ),
          ),
        ),
      );
      expect(
        state.getOverride("personal", "weekly_percentage_pacing", "epoch-a")
          .temporaryExtensionSeconds,
      ).toBe(28800);
      state.ensureEpoch({
        epochId: "epoch-b",
        profile: "personal",
        strategy: "weekly_percentage_pacing",
        periodStart: new Date("2026-10-02T00:00:00Z"),
        periodEnd: new Date("2026-10-09T00:00:00Z"),
        resetMethod: "server_reset",
      });
      expect(
        state.getOverride("personal", "weekly_percentage_pacing", "epoch-b")
          .temporaryExtensionSeconds,
      ).toBe(0);
      expect(() =>
        state.updateExtension(
          "personal",
          "weekly_percentage_pacing",
          "epoch-a",
          3600,
          0,
        ),
      ).toThrow();
    } finally {
      state.db.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
