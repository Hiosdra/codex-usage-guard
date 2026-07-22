import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import type {
  ActiveProfile,
  MissingDataAction,
  Profile,
} from "../domain/types.ts";
import { Decimal } from "../domain/decimal.ts";
import { validateTimeZone } from "../domain/time.ts";

export interface Config {
  activeProfile: ActiveProfile;
  personal: {
    strategy: "weekly_percentage_pacing";
    baseLeadSeconds: number;
    warningAfterSeconds: number;
    extensionStepSeconds: number;
  };
  work: {
    strategy: "monthly_ai_credits_workdays";
    timezone: string;
    workdays: string[];
    budgetRelease: "start_of_day";
    warningAfterWorkdaysAhead: number;
    blockAfterWorkdaysAhead: number;
    extensionStepWorkdays: number;
  };
  overrides: { resetOnQuotaReset: boolean; warningDuringUnlock: boolean };
  data: {
    source: "codex_app_server";
    fallbackToSessionFiles: boolean;
    cacheTtlSeconds: number;
    maximumStaleAgeSeconds: number;
    appServerTimeoutSeconds: number;
    missingDataAction: MissingDataAction;
  };
  resetDetection: {
    weeklyUsedPercentDropThreshold: Decimal;
    businessUsedCreditsDropThreshold: Decimal;
    confirmationReads: number;
    confirmationIntervalSeconds: number;
  };
  display: {
    timezone: string;
    creditDecimalPlaces: number;
    percentageDecimalPlaces: number;
    showUnlockTime: boolean;
    showDailyBudget: boolean;
  };
}

export interface Paths {
  config: string;
  state: string;
  cache: string;
  logs: string;
  codexHome: string;
}

function env(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}
function defaultRoot(): string {
  return join(homedir(), ".codex-usage-guard");
}

export function resolvePaths(platform = process.platform): Paths {
  const codexHome = env("CODEX_HOME") ?? join(homedir(), ".codex");
  if (env("CODEX_USAGE_GUARD_CONFIG") || env("CODEX_USAGE_GUARD_STATE")) {
    const root = defaultRoot();
    return {
      config: env("CODEX_USAGE_GUARD_CONFIG") ?? join(root, "config.toml"),
      state: env("CODEX_USAGE_GUARD_STATE") ?? join(root, "state.sqlite"),
      cache: env("CODEX_USAGE_GUARD_CACHE") ?? join(root, "cache"),
      logs: env("CODEX_USAGE_GUARD_LOG") ?? join(root, "logs"),
      codexHome,
    };
  }
  if (platform === "darwin") {
    const app = join(
      homedir(),
      "Library",
      "Application Support",
      "codex-usage-guard",
    );
    return {
      config: join(app, "config.toml"),
      state: join(app, "state.sqlite"),
      cache: join(homedir(), "Library", "Caches", "codex-usage-guard"),
      logs: join(homedir(), "Library", "Logs", "codex-usage-guard"),
      codexHome,
    };
  }
  const configRoot = env("XDG_CONFIG_HOME") ?? join(homedir(), ".config");
  const stateRoot = env("XDG_STATE_HOME") ?? join(homedir(), ".local", "state");
  const cacheRoot = env("XDG_CACHE_HOME") ?? join(homedir(), ".cache");
  return {
    config: join(configRoot, "codex-usage-guard", "config.toml"),
    state: join(stateRoot, "codex-usage-guard", "state.sqlite"),
    cache: join(cacheRoot, "codex-usage-guard"),
    logs: join(cacheRoot, "codex-usage-guard", "logs"),
    codexHome,
  };
}

function parseDuration(value: unknown, label: string): number {
  if (typeof value !== "string")
    throw new Error(`${label} must be a duration string`);
  const match = /^\s*(\d+(?:\.\d+)?)\s*(s|m|h|d)\s*$/i.exec(value);
  if (!match) throw new Error(`Invalid duration for ${label}: ${value}`);
  const amount = Number(match[1]);
  const factor =
    match[2]!.toLowerCase() === "s"
      ? 1
      : match[2]!.toLowerCase() === "m"
        ? 60
        : match[2]!.toLowerCase() === "h"
          ? 3600
          : 86400;
  return Math.round(amount * factor);
}

function parseTomlValue(value: string): unknown {
  const trimmed = value.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]"))
    return trimmed
      .slice(1, -1)
      .split(",")
      .map((item) => parseTomlValue(item))
      .filter((item) => item !== "");
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  )
    return trimmed.slice(1, -1);
  if (trimmed === "true" || trimmed === "false") return trimmed === "true";
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  return trimmed;
}

function parseToml(text: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  let section: Record<string, unknown> = root;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const sectionMatch = /^\[([^\]]+)\]$/.exec(line);
    if (sectionMatch) {
      const key = sectionMatch[1]!;
      section = (root[key] as Record<string, unknown> | undefined) ?? {};
      root[key] = section;
      continue;
    }
    const index = line.indexOf("=");
    if (index < 1) continue;
    section[line.slice(0, index).trim()] = parseTomlValue(
      line.slice(index + 1),
    );
  }
  return root;
}

function stringValue(
  root: Record<string, unknown>,
  section: string,
  key: string,
  fallback: string,
): string {
  const value = section
    ? (root[section] as Record<string, unknown> | undefined)?.[key]
    : root[key];
  return typeof value === "string" ? value : fallback;
}
function numberValue(
  root: Record<string, unknown>,
  section: string,
  key: string,
  fallback: number,
): number {
  const value = section
    ? (root[section] as Record<string, unknown> | undefined)?.[key]
    : root[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
function boolValue(
  root: Record<string, unknown>,
  section: string,
  key: string,
  fallback: boolean,
): boolean {
  const value = section
    ? (root[section] as Record<string, unknown> | undefined)?.[key]
    : root[key];
  return typeof value === "boolean" ? value : fallback;
}

export function defaultConfig(): Config {
  const systemZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  return {
    activeProfile: "auto",
    personal: {
      strategy: "weekly_percentage_pacing",
      baseLeadSeconds: 86400,
      warningAfterSeconds: 0,
      extensionStepSeconds: 86400,
    },
    work: {
      strategy: "monthly_ai_credits_workdays",
      timezone: systemZone,
      workdays: ["mon", "tue", "wed", "thu", "fri"],
      budgetRelease: "start_of_day",
      warningAfterWorkdaysAhead: 0,
      blockAfterWorkdaysAhead: 1,
      extensionStepWorkdays: 1,
    },
    overrides: { resetOnQuotaReset: true, warningDuringUnlock: true },
    data: {
      source: "codex_app_server",
      fallbackToSessionFiles: true,
      cacheTtlSeconds: 60,
      maximumStaleAgeSeconds: 900,
      appServerTimeoutSeconds: 5,
      missingDataAction: "warn",
    },
    resetDetection: {
      weeklyUsedPercentDropThreshold: new Decimal("1.0"),
      businessUsedCreditsDropThreshold: new Decimal("1.0"),
      confirmationReads: 2,
      confirmationIntervalSeconds: 2,
    },
    display: {
      timezone: systemZone,
      creditDecimalPlaces: 2,
      percentageDecimalPlaces: 1,
      showUnlockTime: true,
      showDailyBudget: true,
    },
  };
}

export function configFromToml(text: string): Config {
  const root = parseToml(text);
  const defaults = defaultConfig();
  const active = stringValue(
    root,
    "",
    "active_profile",
    defaults.activeProfile,
  );
  if (active !== "auto" && active !== "personal" && active !== "work")
    throw new Error(`Invalid active_profile: ${active}`);
  const personalBase = parseDuration(
    stringValue(root, "personal", "base_lead", "24h"),
    "personal.base_lead",
  );
  const warningAfter = parseDuration(
    stringValue(root, "personal", "warning_after", "0h"),
    "personal.warning_after",
  );
  const extension = parseDuration(
    stringValue(root, "personal", "extension_step", "24h"),
    "personal.extension_step",
  );
  const configuredZone = stringValue(root, "work", "timezone", "system");
  const timezone =
    configuredZone === "system" ? defaults.work.timezone : configuredZone;
  const displayConfiguredZone = stringValue(
    root,
    "display",
    "timezone",
    "system",
  );
  const displayTimezone =
    displayConfiguredZone === "system"
      ? defaults.display.timezone
      : displayConfiguredZone;
  if (!validateTimeZone(timezone) || !validateTimeZone(displayTimezone))
    throw new Error("Invalid timezone in configuration");
  const weekdays = (root.work as Record<string, unknown> | undefined)?.workdays;
  const workdays =
    Array.isArray(weekdays) &&
    weekdays.every((item) => typeof item === "string")
      ? (weekdays as string[])
      : defaults.work.workdays;
  const missing = stringValue(root, "data", "missing_data_action", "warn");
  if (missing !== "allow" && missing !== "warn" && missing !== "block")
    throw new Error(`Invalid data.missing_data_action: ${missing}`);
  return {
    activeProfile: active,
    personal: {
      strategy: "weekly_percentage_pacing",
      baseLeadSeconds: personalBase,
      warningAfterSeconds: warningAfter,
      extensionStepSeconds: extension,
    },
    work: {
      strategy: "monthly_ai_credits_workdays",
      timezone,
      workdays,
      budgetRelease: "start_of_day",
      warningAfterWorkdaysAhead: numberValue(
        root,
        "work",
        "warning_after_workdays_ahead",
        0,
      ),
      blockAfterWorkdaysAhead: numberValue(
        root,
        "work",
        "block_after_workdays_ahead",
        1,
      ),
      extensionStepWorkdays: numberValue(
        root,
        "work",
        "extension_step_workdays",
        1,
      ),
    },
    overrides: {
      resetOnQuotaReset: boolValue(
        root,
        "overrides",
        "reset_on_quota_reset",
        true,
      ),
      warningDuringUnlock: boolValue(
        root,
        "overrides",
        "warning_during_unlock",
        true,
      ),
    },
    data: {
      source: "codex_app_server",
      fallbackToSessionFiles: boolValue(
        root,
        "data",
        "fallback_to_session_files",
        true,
      ),
      cacheTtlSeconds: parseDuration(
        stringValue(root, "data", "cache_ttl", "60s"),
        "data.cache_ttl",
      ),
      maximumStaleAgeSeconds: parseDuration(
        stringValue(root, "data", "maximum_stale_age", "15m"),
        "data.maximum_stale_age",
      ),
      appServerTimeoutSeconds: parseDuration(
        stringValue(root, "data", "app_server_timeout", "5s"),
        "data.app_server_timeout",
      ),
      missingDataAction: missing,
    },
    resetDetection: {
      weeklyUsedPercentDropThreshold: new Decimal(
        stringValue(
          root,
          "reset_detection",
          "weekly_used_percent_drop_threshold",
          "1.0",
        ),
      ),
      businessUsedCreditsDropThreshold: new Decimal(
        stringValue(
          root,
          "reset_detection",
          "business_used_credits_drop_threshold",
          "1.0",
        ),
      ),
      confirmationReads: Math.max(
        1,
        Math.round(
          numberValue(root, "reset_detection", "confirmation_reads", 2),
        ),
      ),
      confirmationIntervalSeconds: parseDuration(
        stringValue(root, "reset_detection", "confirmation_interval", "2s"),
        "reset_detection.confirmation_interval",
      ),
    },
    display: {
      timezone: displayTimezone,
      creditDecimalPlaces: Math.max(
        0,
        Math.round(numberValue(root, "display", "credit_decimal_places", 2)),
      ),
      percentageDecimalPlaces: Math.max(
        0,
        Math.round(
          numberValue(root, "display", "percentage_decimal_places", 1),
        ),
      ),
      showUnlockTime: boolValue(root, "display", "show_unlock_time", true),
      showDailyBudget: boolValue(root, "display", "show_daily_budget", true),
    },
  };
}

export async function loadConfig(paths = resolvePaths()): Promise<Config> {
  try {
    const text = await readFile(paths.config, "utf8");
    try {
      await chmod(paths.config, 0o600);
    } catch {
      /* best effort on platforms without POSIX file modes */
    }
    return configFromToml(text);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return defaultConfig();
    throw error;
  }
}

export async function ensurePrivateDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  try {
    await chmod(path, 0o700);
  } catch {
    /* best effort on Windows */
  }
}
export async function ensureConfig(paths = resolvePaths()): Promise<void> {
  await ensurePrivateDir(dirname(paths.config));
  try {
    await readFile(paths.config);
  } catch {
    await writeFile(paths.config, 'active_profile = "auto"\n', {
      mode: 0o600,
    });
  }
  try {
    await chmod(paths.config, 0o600);
  } catch {
    /* best effort on platforms without POSIX file modes */
  }
}
export async function setActiveProfile(
  profile: ActiveProfile,
  paths = resolvePaths(),
): Promise<void> {
  if (profile !== "auto" && profile !== "personal" && profile !== "work")
    throw new Error("Profile must be auto, personal, or work");
  await ensurePrivateDir(dirname(paths.config));
  let text: string;
  try {
    text = await readFile(paths.config, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    text = `active_profile = "${profile}"\n`;
  }
  if (/^active_profile\s*=.*$/m.test(text))
    text = text.replace(
      /^active_profile\s*=.*$/m,
      `active_profile = "${profile}"`,
    );
  else text = `active_profile = "${profile}"\n${text}`;
  await writeFile(paths.config, text, { mode: 0o600 });
  try {
    await chmod(paths.config, 0o600);
  } catch {
    /* best effort */
  }
}
