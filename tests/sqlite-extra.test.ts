import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore } from "../src/persistence/sqlite.ts";

/** The schema exactly as version 1 shipped it, to migrate forward from. */
function writeVersion1Database(path: string): void {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY);
    CREATE TABLE reset_events (id INTEGER PRIMARY KEY AUTOINCREMENT, profile TEXT NOT NULL, previous_value TEXT, new_value TEXT, resets_at TEXT NOT NULL, observed_at TEXT NOT NULL, method TEXT NOT NULL, payload TEXT NOT NULL);
    CREATE TABLE overrides (profile TEXT NOT NULL, strategy TEXT NOT NULL, epoch_id TEXT NOT NULL, extension_seconds INTEGER NOT NULL DEFAULT 0, extension_workdays INTEGER NOT NULL DEFAULT 0, unlocked_until_reset INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, PRIMARY KEY(profile, strategy));
    INSERT INTO reset_events(profile, previous_value, new_value, resets_at, observed_at, method, payload) VALUES ('work', '420.5', '0', '2026-10-01T00:00:00.000Z', '2026-09-21T09:01:00.000Z', 'early_reset_inferred', '{}');
    INSERT INTO schema_migrations(version) VALUES (1);
  `);
  db.close();
}

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

  test("archives overrides on an epoch change and restores them on revert", async () => {
    const root = await mkdtemp(join(tmpdir(), "cug-sqlite-revert-"));
    const store = new StateStore(join(root, "state.sqlite"));
    const epoch = (epochId: string) => ({
      epochId,
      profile: "work" as const,
      strategy: "monthly_ai_credits_workdays" as const,
      periodStart: new Date("2026-09-01T00:00:00Z"),
      periodEnd: new Date("2026-10-01T00:00:00Z"),
      resetMethod: "server_observed",
    });
    try {
      store.ensureEpoch(epoch("a"));
      store.setUnlocked("work", "monthly_ai_credits_workdays", "a", true);
      store.updateExtension("work", "monthly_ai_credits_workdays", "a", 0, 2);

      store.ensureEpoch(epoch("b"));
      expect(
        store.getOverride("work", "monthly_ai_credits_workdays", "b"),
      ).toMatchObject({
        unlockedUntilReset: false,
        temporaryExtensionWorkdays: 0,
      });

      store.ensureEpoch(epoch("a"));
      expect(
        store.restoreOverride("work", "monthly_ai_credits_workdays", "a"),
      ).toMatchObject({
        unlockedUntilReset: true,
        temporaryExtensionWorkdays: 2,
      });
      // The archive entry is consumed, so a second revert finds nothing.
      expect(
        store.restoreOverride("work", "monthly_ai_credits_workdays", "a"),
      ).toBeUndefined();
    } finally {
      store.db.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("finds and marks a revertable inferred reset", async () => {
    const root = await mkdtemp(join(tmpdir(), "cug-sqlite-events-"));
    const store = new StateStore(join(root, "state.sqlite"));
    const resetsAt = new Date("2026-10-01T00:00:00Z");
    try {
      store.recordReset("work", "420.5", "0", resetsAt, "server_reset", {});
      expect(
        store.revertableReset("work", resetsAt.toISOString()),
      ).toBeUndefined();

      store.recordReset(
        "work",
        "420.5",
        "0",
        resetsAt,
        "early_reset_inferred",
        {},
        new Date("2026-09-21T09:01:00Z"),
      );
      const event = store.revertableReset("work", resetsAt.toISOString());
      expect(event).toMatchObject({
        previousValue: "420.5",
        observedAt: "2026-09-21T09:01:00.000Z",
      });

      store.markResetReverted(event!.id, new Date("2026-09-21T10:01:00Z"));
      expect(
        store.revertableReset("work", resetsAt.toISOString()),
      ).toBeUndefined();
    } finally {
      store.db.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("migrates a version 1 database and stays replayable", async () => {
    const root = await mkdtemp(join(tmpdir(), "cug-sqlite-migrate-"));
    const path = join(root, "state.sqlite");
    try {
      writeVersion1Database(path);
      const store = new StateStore(path);
      expect(
        store.db
          .query("SELECT MAX(version) AS version FROM schema_migrations")
          .get(),
      ).toEqual({ version: 2 });
      // Existing rows survive and become visible through the new column.
      expect(
        store.revertableReset("work", "2026-10-01T00:00:00.000Z"),
      ).toMatchObject({ previousValue: "420.5" });
      store.db.close();

      // Reopening is a no-op rather than a second ALTER.
      const reopened = new StateStore(path);
      expect(
        reopened.db.query("SELECT COUNT(*) AS count FROM reset_events").get(),
      ).toEqual({ count: 1 });
      reopened.db.close();

      // A migration interrupted after the ALTER but before its version row
      // must still replay instead of failing every later open.
      const interrupted = new Database(path);
      interrupted.exec("DELETE FROM schema_migrations WHERE version = 2");
      interrupted.close();
      const replayed = new StateStore(path);
      expect(
        replayed.db
          .query("SELECT MAX(version) AS version FROM schema_migrations")
          .get(),
      ).toEqual({ version: 2 });
      replayed.db.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
