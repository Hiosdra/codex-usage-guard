import { Decimal } from "../domain/decimal.ts";
import { instantFromUnixSeconds } from "../domain/time.ts";
import type {
  WeeklyLimitSnapshot,
  WorkCreditsSnapshot,
} from "../domain/types.ts";

export interface ParsedRateLimits {
  personal?: WeeklyLimitSnapshot;
  work?: WorkCreditsSnapshot;
  planType?: string;
  source: string;
  rawShape: "app_server" | "session_file";
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}
function valueAt(object: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys)
    if (object[key] !== undefined && object[key] !== null) return object[key];
  return undefined;
}
function stringAt(
  object: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  const value = valueAt(object, ...keys);
  return typeof value === "string"
    ? value
    : value === undefined
      ? undefined
      : String(value);
}
function numberAt(
  object: Record<string, unknown>,
  ...keys: string[]
): number | undefined {
  const value = valueAt(object, ...keys);
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value))
    return Number(value);
  return undefined;
}
function decimalAt(
  object: Record<string, unknown>,
  ...keys: string[]
): Decimal | undefined {
  const value = valueAt(object, ...keys);
  if (value === undefined) return undefined;
  try {
    return new Decimal(
      typeof value === "string" || typeof value === "number"
        ? value
        : String(value),
    );
  } catch {
    return undefined;
  }
}
function validTimestamp(value: unknown): Date | undefined {
  const number =
    typeof value === "number" || typeof value === "string"
      ? Number(value)
      : NaN;
  if (!Number.isFinite(number)) return undefined;
  try {
    return instantFromUnixSeconds(number);
  } catch {
    return undefined;
  }
}

function findRateLimits(raw: unknown): Record<string, unknown> {
  const root = record(raw);
  const result = record(root.result);
  const direct = record(valueAt(result, "rateLimits", "rate_limits"));
  const byLimitId = record(
    valueAt(result, "rateLimitsByLimitId", "rate_limits_by_limit_id"),
  );
  const byLimitIdCandidates = Object.values(byLimitId).map(record);
  const hasSupportedShape = (value: Record<string, unknown>): boolean =>
    Object.keys(record(valueAt(value, "individualLimit", "individual_limit")))
      .length > 0 ||
    Object.keys(record(valueAt(value, "secondary", "secondary_limit"))).length >
      0 ||
    Object.keys(record(valueAt(value, "primary", "primary_limit"))).length > 0;
  if (Object.keys(direct).length && hasSupportedShape(direct)) return direct;
  const byLimitIdMatch = byLimitIdCandidates.find(hasSupportedShape);
  if (byLimitIdMatch) return byLimitIdMatch;
  if (Object.keys(direct).length) return direct;
  const rootDirect = record(valueAt(root, "rateLimits", "rate_limits"));
  if (Object.keys(rootDirect).length) return rootDirect;
  return result;
}

function serverReached(
  rate: Record<string, unknown>,
  individual?: { used: Decimal; limit: Decimal; remainingPercent?: Decimal },
): boolean {
  const reached = valueAt(rate, "spendControlReached", "spend_control_reached");
  if (reached === true) return true;
  if (
    individual &&
    (individual.used.greaterThanOrEqual(individual.limit) ||
      individual.remainingPercent?.lessThanOrEqual(0))
  )
    return true;
  const reachedType = valueAt(
    rate,
    "rateLimitReachedType",
    "rate_limit_reached_type",
  );
  return reachedType !== undefined && reachedType !== null;
}

function weeklyCandidate(
  rate: Record<string, unknown>,
  now: Date,
  source: string,
  planType?: string,
): WeeklyLimitSnapshot | undefined {
  const candidates = [
    record(valueAt(rate, "secondary", "secondary_limit")),
    record(valueAt(rate, "primary", "primary_limit")),
    record(rate.weekly),
    rate,
  ];
  for (const candidate of candidates) {
    const used = numberAt(candidate, "usedPercent", "used_percent");
    const minutes = numberAt(
      candidate,
      "windowDurationMins",
      "window_duration_mins",
      "windowMinutes",
      "window_minutes",
    );
    const reset = validTimestamp(valueAt(candidate, "resetsAt", "resets_at"));
    if (used === undefined || minutes === undefined || !reset) continue;
    const seconds = Math.round(minutes * 60);
    // Weekly windows may differ slightly by plan; reject short windows and
    // only accept candidates whose duration is recognisably multi-day.
    if (seconds < 3 * 86400 || seconds > 10 * 86400) continue;
    const windowStart = new Date(reset.getTime() - seconds * 1000);
    return {
      profile: "personal",
      strategy: "weekly_percentage_pacing",
      usedPercent: new Decimal(String(used)),
      windowDurationSeconds: seconds,
      windowStart,
      resetsAt: reset,
      observedAt: now,
      ...(planType ? { planType } : {}),
      ...(stringAt(rate, "limitId", "limit_id")
        ? { limitId: stringAt(rate, "limitId", "limit_id")! }
        : {}),
      serverLimitReached: serverReached(rate),
      source,
    };
  }
  return undefined;
}

function workCandidate(
  rate: Record<string, unknown>,
  now: Date,
  source: string,
  planType?: string,
): WorkCreditsSnapshot | undefined {
  const individual = record(
    valueAt(rate, "individualLimit", "individual_limit"),
  );
  const limit = decimalAt(individual, "limit");
  const used = decimalAt(individual, "used");
  const reset = validTimestamp(valueAt(individual, "resetsAt", "resets_at"));
  if (!limit || !used || !reset || limit.sign <= 0) return undefined;
  const remainingPercent = decimalAt(
    individual,
    "remainingPercent",
    "remaining_percent",
  );
  const credits = record(valueAt(rate, "credits"));
  const unlimited = valueAt(credits, "unlimited", "unlimited_credits") === true;
  const limitId = stringAt(rate, "limitId", "limit_id") ?? "codex";
  return {
    profile: "work",
    strategy: "monthly_ai_credits_workdays",
    limitId,
    ...(planType ? { planType } : {}),
    limitCredits: limit,
    usedCredits: used,
    ...(remainingPercent ? { remainingPercent } : {}),
    resetsAt: reset,
    periodStart: new Date(reset.getTime()),
    observedAt: now,
    serverLimitReached: serverReached(rate, {
      used,
      limit,
      ...(remainingPercent ? { remainingPercent } : {}),
    }),
    unlimited,
    source,
  };
}

export function parseRateLimits(
  raw: unknown,
  observedAt = new Date(),
  source = "codex_app_server",
): ParsedRateLimits {
  const rate = findRateLimits(raw);
  const planType = stringAt(rate, "planType", "plan_type");
  const personal = weeklyCandidate(rate, observedAt, source, planType);
  const work = workCandidate(rate, observedAt, source, planType);
  if (!personal && !work)
    throw new Error(
      "The rate-limit response contained neither a weekly window nor a valid individualLimit",
    );
  return {
    ...(personal ? { personal } : {}),
    ...(work ? { work } : {}),
    ...(planType ? { planType } : {}),
    source,
    rawShape: source === "session_files" ? "session_file" : "app_server",
  };
}

export function isBusinessPlan(planType: string | undefined): boolean {
  return (
    planType?.toLowerCase().includes("business") === true ||
    planType?.toLowerCase().includes("enterprise") === true ||
    planType?.toLowerCase().includes("team") === true
  );
}

export function chooseProfile(
  parsed: ParsedRateLimits,
  configured: "auto" | "personal" | "work",
): { active: "personal" | "work" | undefined; reason: string } {
  const personal = Boolean(parsed.personal);
  const work = Boolean(parsed.work);
  if (configured === "personal")
    return {
      active: personal ? "personal" : undefined,
      reason: personal
        ? "profile was explicitly set to personal"
        : "personal was explicitly selected but no weekly window was found",
    };
  if (configured === "work")
    return {
      active: work ? "work" : undefined,
      reason: work
        ? "profile was explicitly set to work"
        : "work was explicitly selected but no valid individualLimit was found",
    };
  if (work && isBusinessPlan(parsed.planType))
    return {
      active: "work",
      reason:
        "auto selected individualLimit because the plan identifies as Business/Enterprise/Team",
    };
  if (work)
    return {
      active: "work",
      reason:
        "auto selected the valid individualLimit; no reliable weekly-only profile was preferred",
    };
  if (personal)
    return {
      active: "personal",
      reason: "auto selected the approximately seven-day percentage window",
    };
  return {
    active: undefined,
    reason: "neither supported quota shape was available",
  };
}
