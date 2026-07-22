import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore } from "../src/persistence/sqlite.ts";

describe("SQLite repositories", () => {
  test("stores snapshots, cache entries, resets, and limit changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "cug-sqlite-extra-"));
    const store = new StateStore(join(root, "state.sqlite"));
    try {
      const periodStart = new Date("2026-09-25T00:00:00Z");
      const periodEnd = new Date("2026-10-02T00:00:00Z");
      store.ensureEpoch({
        epochId: "epoch-a",
        profile: "personal",
        strategy: "weekly_percentage_pacing",
        periodStart,
        periodEnd,
        resetMethod: "server_observed",
      });
      store.ensureEpoch({
        epochId: "epoch-a",
        profile: "personal",
        strategy: "weekly_percentage_pacing",
        periodStart,
        periodEnd,
        resetMethod: "server_observed",
      });
      expect(
        store.getOverride("personal", "weekly_percentage_pacing", "epoch-a")
          .unlockedUntilReset,
      ).toBe(false);
      expect(store.latestSnapshot("personal")).toBeUndefined();

      store.insertSnapshot({
        profile: "personal",
        strategy: "weekly_percentage_pacing",
        epochId: "epoch-a",
        resetsAt: periodEnd.toISOString(),
        limitValue: null,
        usedValue: null,
        usedPercent: "40",
        observedAt: "2026-09-27T00:00:00.000Z",
        source: "fixture",
        payload: JSON.stringify({ profile: "personal", usedPercent: "40" }),
      });
      expect(store.latestSnapshot("personal")?.usedPercent).toBe("40");
      expect(store.latestSnapshot()?.profile).toBe("personal");

      const enabled = store.setUnlocked(
        "personal",
        "weekly_percentage_pacing",
        "epoch-a",
        true,
      );
      expect(enabled.unlockedUntilReset).toBe(true);
      store.updateExtension(
        "personal",
        "weekly_percentage_pacing",
        "epoch-a",
        3600,
        0,
      );
      expect(
        store.getOverride("personal", "weekly_percentage_pacing", "epoch-a")
          .temporaryExtensionSeconds,
      ).toBe(3600);

      store.cachePut(
        "rate-limits",
        JSON.stringify({ synthetic: true }),
        new Date("2026-09-27T00:00:00Z"),
        "fixture",
      );
      expect(store.cacheGet("rate-limits")).toMatchObject({
        source: "fixture",
      });
      expect(store.cacheGet("missing")).toBeUndefined();
      store.recordReset(
        "personal",
        "80",
        "5",
        periodEnd,
        "early_reset_inferred",
        { synthetic: true },
      );
      store.recordLimitChange("1000", "1500", periodEnd);
      expect(
        store.db.query("SELECT COUNT(*) AS count FROM reset_events").get(),
      ).toEqual({ count: 1 });
      expect(
        store.db
          .query("SELECT COUNT(*) AS count FROM limit_change_events")
          .get(),
      ).toEqual({ count: 1 });

      store.resetOverrides("personal");
      expect(
        store.getOverride("personal", "weekly_percentage_pacing", "epoch-a"),
      ).toMatchObject({
        temporaryExtensionSeconds: 0,
        unlockedUntilReset: false,
      });
      store.setUnlocked(
        "personal",
        "weekly_percentage_pacing",
        "epoch-a",
        true,
      );
      store.resetOverrides();
      expect(
        store.getOverride("personal", "weekly_percentage_pacing", "epoch-a")
          .unlockedUntilReset,
      ).toBe(false);
      await store.secureFile();
    } finally {
      await store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects stale unlock updates after the epoch changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "cug-sqlite-stale-"));
    const store = new StateStore(join(root, "state.sqlite"));
    try {
      store.ensureEpoch({
        epochId: "a",
        profile: "work",
        strategy: "monthly_ai_credits_workdays",
        periodStart: new Date("2026-09-01T00:00:00Z"),
        periodEnd: new Date("2026-10-01T00:00:00Z"),
        resetMethod: "server_observed",
      });
      store.ensureEpoch({
        epochId: "b",
        profile: "work",
        strategy: "monthly_ai_credits_workdays",
        periodStart: new Date("2026-10-01T00:00:00Z"),
        periodEnd: new Date("2026-11-01T00:00:00Z"),
        resetMethod: "server_reset",
      });
      expect(() =>
        store.setUnlocked("work", "monthly_ai_credits_workdays", "a", true),
      ).toThrow();
    } finally {
      store.db.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
