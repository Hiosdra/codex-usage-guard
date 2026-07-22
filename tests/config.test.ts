import { afterEach, describe, expect, test } from "bun:test";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  configFromToml,
  defaultConfig,
  ensureConfig,
  loadConfig,
  resolvePaths,
  setActiveProfile,
  type Paths,
} from "../src/config/config.ts";

let roots: string[] = [];
const envNames = [
  "CODEX_USAGE_GUARD_CONFIG",
  "CODEX_USAGE_GUARD_STATE",
  "CODEX_USAGE_GUARD_CACHE",
  "CODEX_USAGE_GUARD_LOG",
  "CODEX_HOME",
  "XDG_CONFIG_HOME",
  "XDG_STATE_HOME",
  "XDG_CACHE_HOME",
];
const originalEnv = new Map(envNames.map((name) => [name, process.env[name]]));

afterEach(async () => {
  for (const name of envNames) {
    const value = originalEnv.get(name);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await Promise.all(
    roots.map((root) => rm(root, { recursive: true, force: true })),
  );
  roots = [];
});

async function tempPaths(): Promise<Paths> {
  const root = await mkdtemp(join(tmpdir(), "cug-config-"));
  roots.push(root);
  return {
    config: join(root, "config.toml"),
    state: join(root, "state.sqlite"),
    cache: join(root, "cache"),
    logs: join(root, "logs"),
    codexHome: join(root, "codex"),
  };
}

describe("configuration", () => {
  test("parses the documented settings and resolves platform paths", () => {
    const config = configFromToml(`
active_profile = "work"
[personal]
base_lead = "12h"
warning_after = "30m"
extension_step = "2d"
[work]
timezone = "Europe/Warsaw"
workdays = ["mon", "wed"]
warning_after_workdays_ahead = 0.25
block_after_workdays_ahead = 2
extension_step_workdays = 3
[overrides]
reset_on_quota_reset = false
warning_during_unlock = false
[data]
fallback_to_session_files = false
cache_ttl = "2m"
maximum_stale_age = "1h"
app_server_timeout = "7s"
missing_data_action = "block"
[reset_detection]
weekly_used_percent_drop_threshold = "2.5"
business_used_credits_drop_threshold = "3.5"
confirmation_reads = 0
confirmation_interval = "0s"
[display]
timezone = "UTC"
credit_decimal_places = 4
percentage_decimal_places = 3
show_unlock_time = false
show_daily_budget = false
`);
    expect(config.activeProfile).toBe("work");
    expect(config.personal.baseLeadSeconds).toBe(43200);
    expect(config.personal.warningAfterSeconds).toBe(1800);
    expect(config.personal.extensionStepSeconds).toBe(172800);
    expect(config.work.workdays).toEqual(["mon", "wed"]);
    expect(config.work.warningAfterWorkdaysAhead).toBe(0.25);
    expect(config.work.blockAfterWorkdaysAhead).toBe(2);
    expect(config.overrides.warningDuringUnlock).toBe(false);
    expect(config.data.fallbackToSessionFiles).toBe(false);
    expect(config.data.cacheTtlSeconds).toBe(120);
    expect(config.data.maximumStaleAgeSeconds).toBe(3600);
    expect(config.data.appServerTimeoutSeconds).toBe(7);
    expect(config.data.missingDataAction).toBe("block");
    expect(config.resetDetection.confirmationReads).toBe(1);
    expect(config.display.showUnlockTime).toBe(false);
    expect(config.display.showDailyBudget).toBe(false);

    const defaults = defaultConfig();
    expect(defaults.activeProfile).toBe("auto");
    expect(resolvePaths("darwin").config).toContain(
      "Library/Application Support",
    );
    expect(resolvePaths("linux").config).toContain(".config");
  });

  test("uses environment overrides and rejects malformed configuration", () => {
    process.env.CODEX_USAGE_GUARD_CONFIG = "/synthetic/config.toml";
    process.env.CODEX_USAGE_GUARD_STATE = "/synthetic/state.sqlite";
    process.env.CODEX_USAGE_GUARD_CACHE = "/synthetic/cache";
    process.env.CODEX_USAGE_GUARD_LOG = "/synthetic/logs";
    process.env.CODEX_HOME = "/synthetic/codex";
    const paths = resolvePaths("linux");
    expect(paths).toEqual({
      config: "/synthetic/config.toml",
      state: "/synthetic/state.sqlite",
      cache: "/synthetic/cache",
      logs: "/synthetic/logs",
      codexHome: "/synthetic/codex",
    });
    expect(() => configFromToml('active_profile = "invalid"')).toThrow();
    expect(() => configFromToml('[personal]\nbase_lead = "bad"')).toThrow();
    expect(() => configFromToml('[work]\ntimezone = "Invalid/Zone"')).toThrow();
    expect(() =>
      configFromToml('[data]\nmissing_data_action = "bad"'),
    ).toThrow();
    expect(configFromToml("unrecognized = bare-value").activeProfile).toBe(
      "auto",
    );
  });

  test("loads, creates, and updates config files safely", async () => {
    const paths = await tempPaths();
    const missing = await loadConfig(paths);
    expect(missing.activeProfile).toBe("auto");
    await ensureConfig(paths);
    expect(await readFile(paths.config, "utf8")).toBe(
      'active_profile = "auto"\n',
    );
    const firstMode = (await stat(paths.config)).mode & 0o777;
    expect(firstMode).toBe(0o600);
    await chmod(paths.config, 0o644);
    await ensureConfig(paths);
    expect((await stat(paths.config)).mode & 0o777).toBe(0o600);

    await setActiveProfile("work", paths);
    expect(await readFile(paths.config, "utf8")).toContain(
      'active_profile = "work"',
    );
    await setActiveProfile("personal", paths);
    expect(await readFile(paths.config, "utf8")).toContain(
      'active_profile = "personal"',
    );
    const nestedConfig = join(dirname(paths.config), "nested", "config.toml");
    await setActiveProfile("auto", { ...paths, config: nestedConfig });
    expect(await readFile(nestedConfig, "utf8")).toBe(
      'active_profile = "auto"\n',
    );
    await expect(setActiveProfile("invalid" as never, paths)).rejects.toThrow();

    await chmod(paths.config, 0o600);
    await expect(loadConfig(paths)).resolves.toMatchObject({
      activeProfile: "personal",
    });
    await chmod(paths.config, 0o644);
    await loadConfig(paths);
    expect((await stat(paths.config)).mode & 0o777).toBe(0o600);
    await expect(
      loadConfig({ ...paths, config: `${paths.config}.missing` }),
    ).resolves.toMatchObject({ activeProfile: "auto" });
    await writeFile(paths.config, 'active_profile = "invalid"\n');
    await expect(loadConfig(paths)).rejects.toThrow();
  });
});
