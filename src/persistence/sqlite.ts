import { Database } from "bun:sqlite";
import { dirname } from "node:path";
import { chmod } from "node:fs/promises";
import { chmodSync, mkdirSync } from "node:fs";
import type { OverrideState, Profile, QuotaSnapshot } from "../domain/types.ts";

export interface StoredSnapshot {
  id: number;
  profile: Profile;
  strategy: QuotaSnapshot["strategy"];
  epochId: string;
  resetsAt: string;
  limitValue: string | null;
  usedValue: string | null;
  usedPercent: string | null;
  observedAt: string;
  source: string;
  payload: string;
}
export interface CacheEntry {
  key: string;
  payload: string;
  observedAt: Date;
  source: string;
}

export class StateStore {
  readonly db: Database;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path);
    try {
      chmodSync(path, 0o600);
    } catch {
      /* best effort on platforms without POSIX file modes */
    }
    this.db.exec(
      "PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;",
    );
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY);`,
    );
    const version =
      this.db
        .query<{ version: number }, []>(
          "SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations",
        )
        .get()?.version ?? 0;
    if (version < 1) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS quota_epochs (epoch_id TEXT PRIMARY KEY, profile TEXT NOT NULL, strategy TEXT NOT NULL, period_start TEXT NOT NULL, period_end TEXT NOT NULL, reset_method TEXT NOT NULL, created_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS usage_snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT, profile TEXT NOT NULL, strategy TEXT NOT NULL, epoch_id TEXT NOT NULL, resets_at TEXT NOT NULL, limit_value TEXT, used_value TEXT, used_percent TEXT, observed_at TEXT NOT NULL, source TEXT NOT NULL, payload TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS usage_snapshots_profile_observed ON usage_snapshots(profile, observed_at DESC);
        CREATE TABLE IF NOT EXISTS overrides (profile TEXT NOT NULL, strategy TEXT NOT NULL, epoch_id TEXT NOT NULL, extension_seconds INTEGER NOT NULL DEFAULT 0, extension_workdays INTEGER NOT NULL DEFAULT 0, unlocked_until_reset INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, PRIMARY KEY(profile, strategy));
        CREATE TABLE IF NOT EXISTS reset_events (id INTEGER PRIMARY KEY AUTOINCREMENT, profile TEXT NOT NULL, previous_value TEXT, new_value TEXT, resets_at TEXT NOT NULL, observed_at TEXT NOT NULL, method TEXT NOT NULL, payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS limit_change_events (id INTEGER PRIMARY KEY AUTOINCREMENT, previous_limit TEXT NOT NULL, new_limit TEXT NOT NULL, resets_at TEXT NOT NULL, observed_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS cache_entries (key TEXT PRIMARY KEY, payload TEXT NOT NULL, observed_at TEXT NOT NULL, source TEXT NOT NULL);
        INSERT INTO schema_migrations(version) VALUES (1);
      `);
    }
  }

  async close(): Promise<void> {
    this.db.close();
  }
  async secureFile(): Promise<void> {
    try {
      await chmod(
        (this.db as unknown as { filename?: string }).filename ?? "",
        0o600,
      );
    } catch {
      /* best effort */
    }
  }

  latestSnapshot(profile?: Profile): StoredSnapshot | undefined {
    if (profile)
      return (
        this.db
          .query<StoredSnapshot, [string]>(
            "SELECT id, profile, strategy, epoch_id AS epochId, resets_at AS resetsAt, limit_value AS limitValue, used_value AS usedValue, used_percent AS usedPercent, observed_at AS observedAt, source, payload FROM usage_snapshots WHERE profile = ? ORDER BY observed_at DESC, id DESC LIMIT 1",
          )
          .get(profile) ?? undefined
      );
    return (
      this.db
        .query<StoredSnapshot, []>(
          "SELECT id, profile, strategy, epoch_id AS epochId, resets_at AS resetsAt, limit_value AS limitValue, used_value AS usedValue, used_percent AS usedPercent, observed_at AS observedAt, source, payload FROM usage_snapshots ORDER BY observed_at DESC, id DESC LIMIT 1",
        )
        .get() ?? undefined
    );
  }
  insertSnapshot(snapshot: Omit<StoredSnapshot, "id">): void {
    this.db
      .query(
        "INSERT INTO usage_snapshots(profile, strategy, epoch_id, resets_at, limit_value, used_value, used_percent, observed_at, source, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        snapshot.profile,
        snapshot.strategy,
        snapshot.epochId,
        snapshot.resetsAt,
        snapshot.limitValue,
        snapshot.usedValue,
        snapshot.usedPercent,
        snapshot.observedAt,
        snapshot.source,
        snapshot.payload,
      );
  }
  ensureEpoch(epoch: {
    epochId: string;
    profile: Profile;
    strategy: QuotaSnapshot["strategy"];
    periodStart: Date;
    periodEnd: Date;
    resetMethod: string;
  }): void {
    const tx = this.db.transaction(() => {
      this.db
        .query(
          "INSERT OR IGNORE INTO quota_epochs(epoch_id, profile, strategy, period_start, period_end, reset_method, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          epoch.epochId,
          epoch.profile,
          epoch.strategy,
          epoch.periodStart.toISOString(),
          epoch.periodEnd.toISOString(),
          epoch.resetMethod,
          new Date().toISOString(),
        );
      const current = this.db
        .query<{ epoch_id: string }, [string, string]>(
          "SELECT epoch_id FROM overrides WHERE profile = ? AND strategy = ?",
        )
        .get(epoch.profile, epoch.strategy);
      if (current && current.epoch_id !== epoch.epochId)
        this.db
          .query("DELETE FROM overrides WHERE profile = ? AND strategy = ?")
          .run(epoch.profile, epoch.strategy);
      this.db
        .query(
          "INSERT OR IGNORE INTO overrides(profile, strategy, epoch_id, updated_at) VALUES (?, ?, ?, ?)",
        )
        .run(
          epoch.profile,
          epoch.strategy,
          epoch.epochId,
          new Date().toISOString(),
        );
    });
    tx();
  }
  getOverride(
    profile: Profile,
    strategy: QuotaSnapshot["strategy"],
    epochId: string,
  ): OverrideState {
    const row = this.db
      .query<
        {
          epoch_id: string;
          extension_seconds: number;
          extension_workdays: number;
          unlocked_until_reset: number;
          updated_at: string;
        },
        [string, string]
      >(
        "SELECT epoch_id, extension_seconds, extension_workdays, unlocked_until_reset, updated_at FROM overrides WHERE profile = ? AND strategy = ?",
      )
      .get(profile, strategy);
    if (!row || row.epoch_id !== epochId)
      return {
        profile,
        strategy,
        epochId,
        temporaryExtensionSeconds: 0,
        temporaryExtensionWorkdays: 0,
        unlockedUntilReset: false,
        updatedAt: new Date(0),
      };
    return {
      profile,
      strategy,
      epochId,
      temporaryExtensionSeconds: row.extension_seconds,
      temporaryExtensionWorkdays: row.extension_workdays,
      unlockedUntilReset: row.unlocked_until_reset === 1,
      updatedAt: new Date(row.updated_at),
    };
  }
  updateExtension(
    profile: Profile,
    strategy: QuotaSnapshot["strategy"],
    epochId: string,
    seconds: number,
    workdays: number,
  ): OverrideState {
    const tx = this.db.transaction(() => {
      const current = this.db
        .query<{ epoch_id: string }, [string, string]>(
          "SELECT epoch_id FROM overrides WHERE profile = ? AND strategy = ?",
        )
        .get(profile, strategy);
      if (!current || current.epoch_id !== epochId)
        throw new Error(
          "Quota epoch changed while updating the override; retry the command",
        );
      this.db
        .query(
          "UPDATE overrides SET extension_seconds = extension_seconds + ?, extension_workdays = extension_workdays + ?, updated_at = ? WHERE profile = ? AND strategy = ? AND epoch_id = ?",
        )
        .run(
          seconds,
          workdays,
          new Date().toISOString(),
          profile,
          strategy,
          epochId,
        );
    });
    tx();
    return this.getOverride(profile, strategy, epochId);
  }
  setUnlocked(
    profile: Profile,
    strategy: QuotaSnapshot["strategy"],
    epochId: string,
    value: boolean,
  ): OverrideState {
    const changed = this.db
      .query(
        "UPDATE overrides SET unlocked_until_reset = ?, updated_at = ? WHERE profile = ? AND strategy = ? AND epoch_id = ?",
      )
      .run(value ? 1 : 0, new Date().toISOString(), profile, strategy, epochId);
    if (changed.changes !== 1)
      throw new Error(
        "Quota epoch changed while updating unlock state; retry the command",
      );
    return this.getOverride(profile, strategy, epochId);
  }
  resetOverrides(profile?: Profile): void {
    if (profile)
      this.db
        .query(
          "UPDATE overrides SET extension_seconds = 0, extension_workdays = 0, unlocked_until_reset = 0, updated_at = ? WHERE profile = ?",
        )
        .run(new Date().toISOString(), profile);
    else
      this.db
        .query(
          "UPDATE overrides SET extension_seconds = 0, extension_workdays = 0, unlocked_until_reset = 0, updated_at = ?",
        )
        .run(new Date().toISOString());
  }
  cacheGet(key: string): CacheEntry | undefined {
    const row = this.db
      .query<
        { key: string; payload: string; observed_at: string; source: string },
        [string]
      >(
        "SELECT key, payload, observed_at, source FROM cache_entries WHERE key = ?",
      )
      .get(key);
    return row
      ? {
          key: row.key,
          payload: row.payload,
          observedAt: new Date(row.observed_at),
          source: row.source,
        }
      : undefined;
  }
  cachePut(
    key: string,
    payload: string,
    observedAt: Date,
    source: string,
  ): void {
    this.db
      .query(
        "INSERT INTO cache_entries(key, payload, observed_at, source) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET payload = excluded.payload, observed_at = excluded.observed_at, source = excluded.source",
      )
      .run(key, payload, observedAt.toISOString(), source);
  }
  recordReset(
    profile: Profile,
    previousValue: string | undefined,
    newValue: string,
    resetsAt: Date,
    method: string,
    payload: unknown,
  ): void {
    this.db
      .query(
        "INSERT INTO reset_events(profile, previous_value, new_value, resets_at, observed_at, method, payload) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        profile,
        previousValue ?? null,
        newValue,
        resetsAt.toISOString(),
        new Date().toISOString(),
        method,
        JSON.stringify(payload),
      );
  }
  recordLimitChange(
    previousLimit: string,
    newLimit: string,
    resetsAt: Date,
  ): void {
    this.db
      .query(
        "INSERT INTO limit_change_events(previous_limit, new_limit, resets_at, observed_at) VALUES (?, ?, ?, ?)",
      )
      .run(
        previousLimit,
        newLimit,
        resetsAt.toISOString(),
        new Date().toISOString(),
      );
  }
}
