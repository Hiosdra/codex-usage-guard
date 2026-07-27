import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import workFixture from "../fixtures/rate-limits-work.json" with { type: "json" };
import personalFixture from "../fixtures/rate-limits-personal.json" with { type: "json" };
import { UsageGuard } from "../src/app/guard.ts";
import {
  AppServerError,
  type CodexAppServerClient,
} from "../src/codex/app-server-client.ts";
import { defaultConfig, type Paths } from "../src/config/config.ts";
import { StateStore } from "../src/persistence/sqlite.ts";

let roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.map((root) => rm(root, { recursive: true, force: true })),
  );
  roots = [];
});

async function makePaths(): Promise<Paths> {
  const root = await mkdtemp(join(tmpdir(), "cug-guard-"));
  roots.push(root);
  return {
    config: join(root, "config.toml"),
    state: join(root, "state.sqlite"),
    cache: join(root, "cache"),
    logs: join(root, "logs"),
    codexHome: join(root, "codex"),
  };
}

function client(read: () => Promise<unknown>): CodexAppServerClient {
  return { readRateLimits: read } as unknown as CodexAppServerClient;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe("UsageGuard", () => {
  test("evaluates personal data, uses fresh cache, and applies overrides", async () => {
    const paths = await makePaths();
    const state = new StateStore(paths.state);
    let calls = 0;
    try {
      const config = defaultConfig();
      const now = new Date("2026-09-27T12:00:00Z");
      const guard = new UsageGuard(
        config,
        paths,
        state,
        client(async () => {
          calls += 1;
          return personalFixture;
        }),
        () => now,
      );
      const first = await guard.evaluate();
      expect(first.result?.profile).toBe("personal");
      expect(first.dataSource).toBe("codex_app_server");
      expect(first.stale).toBe(false);
      const second = await guard.evaluate();
      expect(second.result?.profile).toBe("personal");
      expect(calls).toBe(1);

      const extended = await guard.extend(2);
      expect(extended.override.temporaryExtensionSeconds).toBe(172800);
      const unlocked = await guard.unlock();
      expect(unlocked.override.unlockedUntilReset).toBe(true);
      expect(state.cacheGet("rate-limits")).toBeDefined();
    } finally {
      state.db.close();
    }
  });

  test("evaluates work data, records a limit change, and handles server reset", async () => {
    const paths = await makePaths();
    const state = new StateStore(paths.state);
    let current = clone(workFixture);
    let now = new Date("2026-10-04T12:00:00Z");
    try {
      const config = defaultConfig();
      config.data.cacheTtlSeconds = 1;
      config.resetDetection.confirmationReads = 1;
      const guard = new UsageGuard(
        config,
        paths,
        state,
        client(async () => current),
        () => now,
      );
      expect((await guard.evaluate()).result?.profile).toBe("work");
      await guard.extend(1);

      now = new Date(now.getTime() + 5000);
      current.result.rateLimits.individualLimit.limit = "1500";
      const changed = await guard.evaluate();
      expect(changed.result?.profile).toBe("work");
      expect(
        state.db
          .query("SELECT COUNT(*) AS count FROM limit_change_events")
          .get(),
      ).toEqual({ count: 1 });
      if (changed.result?.profile === "work") {
        expect(changed.result.limitCredits.toString()).toBe("1500");
      }

      now = new Date(now.getTime() + 5000);
      current.result.rateLimits.individualLimit.resetsAt = 1793404800;
      const reset = await guard.evaluate();
      expect(reset.result?.profile).toBe("work");
      if (reset.result?.profile === "work") {
        expect(reset.result.temporaryExtensionWorkdays).toBe(0);
      }
      expect(reset.result?.unlockedUntilReset).toBe(false);
    } finally {
      state.db.close();
    }
  });

  test("confirms an early personal reset and records the event", async () => {
    const paths = await makePaths();
    const state = new StateStore(paths.state);
    const high = clone(personalFixture);
    high.result.rateLimits.secondary.usedPercent = 80;
    const low = clone(personalFixture);
    low.result.rateLimits.secondary.usedPercent = 5;
    let current: unknown = high;
    let now = new Date("2026-09-27T12:00:00Z");
    try {
      const config = defaultConfig();
      config.data.cacheTtlSeconds = 1;
      config.resetDetection.confirmationReads = 2;
      config.resetDetection.confirmationIntervalSeconds = 0.001;
      const guard = new UsageGuard(
        config,
        paths,
        state,
        client(async () => current),
        () => now,
      );
      await guard.evaluate();
      await guard.extend(1);
      current = low;
      now = new Date(now.getTime() + 5000);
      const reset = await guard.evaluate();
      expect(reset.result?.profile).toBe("personal");
      if (reset.result?.profile === "personal") {
        expect(reset.result.temporaryExtensionSeconds).toBe(0);
      }
      expect(
        state.db.query("SELECT COUNT(*) AS count FROM reset_events").get(),
      ).toEqual({ count: 1 });
    } finally {
      state.db.close();
    }
  });

  test("adopts the rejecting read when a confirmation denies an early reset", async () => {
    const paths = await makePaths();
    const state = new StateStore(paths.state);
    // The last entry repeats, so the queue drives one read per call.
    let queue = ["420.5"];
    const current = clone(workFixture);
    let now = new Date("2026-09-21T09:00:00Z");
    try {
      const config = defaultConfig();
      config.work.timezone = "UTC";
      config.data.cacheTtlSeconds = 0;
      config.resetDetection.confirmationReads = 2;
      config.resetDetection.confirmationIntervalSeconds = 0.001;
      const guard = new UsageGuard(
        config,
        paths,
        state,
        client(async () => {
          current.result.rateLimits.individualLimit.used =
            queue.length > 1 ? queue.shift()! : queue[0]!;
          return clone(current);
        }),
        () => now,
      );
      await guard.evaluate();

      // The suspicious zero is denied by the confirmation read.
      now = new Date(now.getTime() + 60_000);
      queue = ["0", "430"];
      const denied = await guard.evaluate();
      if (denied.result?.profile === "work") {
        expect(denied.result.usedCredits.toString()).toBe("430");
        expect(denied.result.periodStart.toISOString()).toBe(
          "2026-09-01T00:00:00.000Z",
        );
      }
      // The denied reading must not be stored or recorded as a reset.
      expect(state.latestSnapshot("work")?.usedValue).toBe("430");
      expect(
        state.db.query("SELECT COUNT(*) AS count FROM reset_events").get(),
      ).toEqual({ count: 0 });
    } finally {
      state.db.close();
    }
  });

  test("reverts a spurious personal reset and restores the unlock", async () => {
    const paths = await makePaths();
    const state = new StateStore(paths.state);
    const current = clone(personalFixture);
    current.result.rateLimits.secondary.usedPercent = 80;
    let now = new Date("2026-09-21T09:00:00Z");
    try {
      const config = defaultConfig();
      config.data.cacheTtlSeconds = 0;
      config.resetDetection.confirmationReads = 1;
      const guard = new UsageGuard(
        config,
        paths,
        state,
        client(async () => current),
        () => now,
      );
      const before = await guard.evaluate();
      await guard.unlock();
      const epochId = before.result?.epochId;

      now = new Date(now.getTime() + 60_000);
      current.result.rateLimits.secondary.usedPercent = 5;
      const during = await guard.evaluate();
      expect(during.result?.unlockedUntilReset).toBe(false);
      expect(during.result?.epochId).not.toBe(epochId);

      now = new Date(now.getTime() + 3_600_000);
      current.result.rateLimits.secondary.usedPercent = 80;
      const after = await guard.evaluate();
      expect(after.result?.epochId).toBe(epochId);
      expect(after.result?.unlockedUntilReset).toBe(true);
      expect(
        state.db
          .query(
            "SELECT COUNT(*) AS count FROM reset_events WHERE method = 'early_reset_reverted'",
          )
          .get(),
      ).toEqual({ count: 1 });
    } finally {
      state.db.close();
    }
  });

  test("reverts a spurious work reset and restores the archived overrides", async () => {
    const paths = await makePaths();
    const state = new StateStore(paths.state);
    const current = clone(workFixture);
    let now = new Date("2026-09-21T09:00:00Z");
    try {
      const config = defaultConfig();
      config.work.timezone = "UTC";
      config.data.cacheTtlSeconds = 0;
      config.resetDetection.confirmationReads = 1;
      const guard = new UsageGuard(
        config,
        paths,
        state,
        client(async () => current),
        () => now,
      );
      const before = await guard.evaluate();
      await guard.unlock();
      await guard.extend(2);
      const periodStart =
        before.result?.profile === "work"
          ? before.result.periodStart.toISOString()
          : "";
      expect(periodStart).toBe("2026-09-01T00:00:00.000Z");

      // The backend briefly reports zero usage against an unchanged period.
      now = new Date(now.getTime() + 60_000);
      current.result.rateLimits.individualLimit.used = "0";
      const during = await guard.evaluate();
      expect(during.result?.unlockedUntilReset).toBe(false);
      if (during.result?.profile === "work")
        expect(during.result.periodStart.toISOString()).toBe(now.toISOString());

      // Usage comes back at its pre-reset level, so the reset was never real.
      now = new Date(now.getTime() + 3_600_000);
      current.result.rateLimits.individualLimit.used = "430";
      const after = await guard.evaluate();
      expect(after.result?.profile).toBe("work");
      if (after.result?.profile === "work") {
        expect(after.result.periodStart.toISOString()).toBe(periodStart);
        expect(after.result.totalWorkdays).toBe(22);
        expect(after.result.decision).toBe("allow");
        expect(after.result.temporaryExtensionWorkdays).toBe(2);
      }
      expect(after.result?.unlockedUntilReset).toBe(true);
      expect(
        state.db
          .query(
            "SELECT COUNT(*) AS count FROM reset_events WHERE method = 'early_reset_reverted'",
          )
          .get(),
      ).toEqual({ count: 1 });
      expect(
        state.db
          .query(
            "SELECT COUNT(*) AS count FROM reset_events WHERE method = 'early_reset_inferred' AND reverted_at IS NULL",
          )
          .get(),
      ).toEqual({ count: 0 });

      // A later observation must not revert a second time.
      now = new Date(now.getTime() + 60_000);
      const stable = await guard.evaluate();
      if (stable.result?.profile === "work")
        expect(stable.result.periodStart.toISOString()).toBe(periodStart);
      expect(
        state.db
          .query(
            "SELECT COUNT(*) AS count FROM reset_events WHERE method = 'early_reset_reverted'",
          )
          .get(),
      ).toEqual({ count: 1 });
    } finally {
      state.db.close();
    }
  });

  test("keeps a real early reset when usage stays below its pre-reset level", async () => {
    const paths = await makePaths();
    const state = new StateStore(paths.state);
    const current = clone(workFixture);
    let now = new Date("2026-09-21T09:00:00Z");
    try {
      const config = defaultConfig();
      config.work.timezone = "UTC";
      config.data.cacheTtlSeconds = 0;
      config.resetDetection.confirmationReads = 1;
      const guard = new UsageGuard(
        config,
        paths,
        state,
        client(async () => current),
        () => now,
      );
      await guard.evaluate();
      await guard.unlock();

      now = new Date(now.getTime() + 60_000);
      current.result.rateLimits.individualLimit.used = "0";
      await guard.evaluate();

      // Usage grows again but never reaches the pre-reset 420.5.
      now = new Date(now.getTime() + 3_600_000);
      current.result.rateLimits.individualLimit.used = "120";
      const after = await guard.evaluate();
      if (after.result?.profile === "work")
        expect(after.result.periodStart.toISOString()).toBe(
          "2026-09-21T09:01:00.000Z",
        );
      expect(after.result?.unlockedUntilReset).toBe(false);

      // Past the revert window the reset is final even if usage catches up.
      now = new Date(now.getTime() + 2 * 86_400_000);
      current.result.rateLimits.individualLimit.used = "500";
      const late = await guard.evaluate();
      if (late.result?.profile === "work")
        expect(late.result.periodStart.toISOString()).toBe(
          "2026-09-21T09:01:00.000Z",
        );
    } finally {
      state.db.close();
    }
  });

  test("uses fallback session data and stale cache when App Server fails", async () => {
    const paths = await makePaths();
    const state = new StateStore(paths.state);
    try {
      const sessions = join(paths.codexHome, "sessions", "2026");
      await mkdir(sessions, { recursive: true });
      await writeFile(
        join(sessions, "fallback.jsonl"),
        JSON.stringify({ rateLimits: personalFixture.result.rateLimits }) +
          "\n",
      );
      const config = defaultConfig();
      config.data.cacheTtlSeconds = 1;
      const failure = client(async () => {
        throw new Error("synthetic App Server failure");
      });
      const guard = new UsageGuard(
        config,
        paths,
        state,
        failure,
        () => new Date("2026-09-27T12:00:00Z"),
      );
      const fallback = await guard.evaluate();
      expect(fallback.dataSource).toBe("session_files");
      expect(fallback.stale).toBe(true);

      state.cachePut(
        "rate-limits",
        JSON.stringify(personalFixture),
        new Date("2026-09-27T12:00:00Z"),
        "fixture",
      );
      config.data.fallbackToSessionFiles = false;
      const stale = new UsageGuard(
        config,
        paths,
        state,
        failure,
        () => new Date("2026-09-27T12:00:05Z"),
      );
      const staleResult = await stale.evaluate();
      expect(staleResult.dataSource).toBe("fixture:stale");
      expect(staleResult.stale).toBe(true);
    } finally {
      state.db.close();
    }
  });

  test("maps missing-data actions and profile selection failures", async () => {
    for (const action of ["allow", "warn", "block"] as const) {
      const paths = await makePaths();
      const state = new StateStore(paths.state);
      try {
        const config = defaultConfig();
        config.data.missingDataAction = action;
        config.data.fallbackToSessionFiles = false;
        const guard = new UsageGuard(
          config,
          paths,
          state,
          client(async () => {
            throw new AppServerError("synthetic timeout", "timeout");
          }),
          () => new Date("2026-09-27T12:00:00Z"),
        );
        const result = await guard.evaluate();
        expect(result.missing?.decision).toBe(
          action === "allow"
            ? "allow"
            : action === "block"
              ? "block"
              : "missing",
        );
        expect(result.failure).toBe("integration");
      } finally {
        state.db.close();
      }
    }

    const pathsForSelection = await makePaths();
    const stateForSelection = new StateStore(pathsForSelection.state);
    try {
      const config = defaultConfig();
      config.activeProfile = "work";
      const guard = new UsageGuard(
        config,
        pathsForSelection,
        stateForSelection,
        client(async () => personalFixture),
        () => new Date("2026-09-27T12:00:00Z"),
      );
      const result = await guard.evaluate();
      expect(result.result).toBeUndefined();
      expect(result.missing?.reason).toContain("work");
    } finally {
      stateForSelection.db.close();
    }
  });

  test("rejects corrupt data and corrupt cache instead of trusting it", async () => {
    const paths = await makePaths();
    const state = new StateStore(paths.state);
    try {
      const config = defaultConfig();
      config.data.fallbackToSessionFiles = false;
      state.cachePut(
        "rate-limits",
        "not-json",
        new Date("2026-09-27T11:59:59Z"),
        "fixture",
      );
      let reads = 0;
      const guard = new UsageGuard(
        config,
        paths,
        state,
        client(async () => {
          reads += 1;
          return personalFixture;
        }),
        () => new Date("2026-09-27T12:00:00Z"),
      );
      expect((await guard.evaluate()).result?.profile).toBe("personal");
      expect(reads).toBe(1);

      const invalid = new UsageGuard(
        config,
        paths,
        state,
        client(async () => ({})),
        () => new Date("2026-09-27T12:20:00Z"),
      );
      const result = await invalid.evaluate();
      expect(result.failure).toBe("integration");
    } finally {
      state.db.close();
    }
  });

  test("reports errors from extend and unlock when no data is available", async () => {
    const paths = await makePaths();
    const state = new StateStore(paths.state);
    try {
      const config = defaultConfig();
      config.data.fallbackToSessionFiles = false;
      const guard = new UsageGuard(
        config,
        paths,
        state,
        client(async () => {
          throw new Error("no data");
        }),
        () => new Date("2026-09-27T12:00:00Z"),
      );
      await expect(guard.extend(1)).rejects.toThrow(
        "No trustworthy Codex rate-limit data",
      );
      await expect(guard.unlock()).rejects.toThrow(
        "No trustworthy Codex rate-limit data",
      );
    } finally {
      state.db.close();
    }
  });
});
