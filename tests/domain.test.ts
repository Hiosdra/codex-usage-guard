import { describe, expect, test } from "bun:test";
import { Decimal } from "../src/domain/decimal.ts";
import {
  addCivilDays,
  addUtcCalendarMonths,
  civilDateFromKey,
  civilDateKey,
  durationLabel,
  formatLocal,
  isWeekday,
  localMidnight,
  nextWorkdayMidnight,
  validateTimeZone,
  weekday,
  workdayMidnightsBetween,
} from "../src/domain/time.ts";
import { WeeklyPercentagePacingStrategy } from "../src/strategies/weekly-percentage.ts";
import { MonthlyAiCreditsWorkdaysStrategy } from "../src/strategies/monthly-workdays-credits.ts";
import type {
  OverrideState,
  WeeklyLimitSnapshot,
  WorkCreditsSnapshot,
} from "../src/domain/types.ts";

const noOverride = (
  profile: "personal" | "work",
  strategy: "weekly_percentage_pacing" | "monthly_ai_credits_workdays",
): OverrideState => ({
  profile,
  strategy,
  epochId: "synthetic-epoch",
  temporaryExtensionSeconds: 0,
  temporaryExtensionWorkdays: 0,
  unlockedUntilReset: false,
  updatedAt: new Date(0),
});
const weekly = (
  used: string,
  now: string,
  start = "2026-09-25T12:00:00Z",
): WeeklyLimitSnapshot => {
  const windowStart = new Date(start);
  const resetsAt = new Date(windowStart.getTime() + 7 * 86400 * 1000);
  return {
    profile: "personal",
    strategy: "weekly_percentage_pacing",
    usedPercent: new Decimal(used),
    windowDurationSeconds: 7 * 86400,
    windowStart,
    resetsAt,
    observedAt: new Date(now),
    serverLimitReached: false,
    source: "fixture",
  };
};
const work = (
  used: string,
  start = "2026-09-30T22:00:00Z",
  end = "2026-11-01T00:00:00Z",
): WorkCreditsSnapshot => ({
  profile: "work",
  strategy: "monthly_ai_credits_workdays",
  limitId: "codex",
  planType: "business",
  limitCredits: new Decimal("1000"),
  usedCredits: new Decimal(used),
  resetsAt: new Date(end),
  periodStart: new Date(start),
  observedAt: new Date("2026-10-07T12:00:00Z"),
  serverLimitReached: false,
  unlimited: false,
  source: "fixture",
});

describe("Decimal", () => {
  test("keeps credits as exact decimal strings", () => {
    expect(new Decimal("420.5").plus("0.25").toString()).toBe("420.75");
    expect(new Decimal("1").div(3).toFixed(6)).toBe("0.333333");
    expect(new Decimal("1000").times(8).div(20).toString()).toBe("400");
  });
  test("supports signs, comparisons, rounding, and validation", () => {
    const negative = new Decimal("-1.25");
    expect(negative.abs().toString()).toBe("1.25");
    expect(negative.isNegative()).toBe(true);
    expect(negative.isPositive()).toBe(false);
    expect(Decimal.zero().isZero()).toBe(true);
    expect(negative.lessThan(0)).toBe(true);
    expect(negative.compare("-1.25")).toBe(0);
    expect(new Decimal("1.005").toFixed(2)).toBe("1.01");
    expect(() => new Decimal("not-a-number")).toThrow();
    expect(() => new Decimal("1").div(Decimal.zero())).toThrow();
    expect(() => new Decimal("1").toFixed(-1)).toThrow();
  });
});

describe("weekly strategy", () => {
  const strategy = new WeeklyPercentagePacingStrategy();
  test("allows at or below schedule and warns when ahead", () => {
    expect(
      strategy.evaluate({
        snapshot: weekly("20", "2026-09-27T21:36:00Z"),
        override: noOverride("personal", "weekly_percentage_pacing"),
        now: new Date("2026-09-27T21:36:00Z"),
        baseLeadSeconds: 86400,
        warningAfterSeconds: 0,
        epochId: "synthetic",
      }).decision,
    ).toBe("allow");
    const warned = strategy.evaluate({
      snapshot: weekly("40", "2026-09-27T12:00:00Z"),
      override: noOverride("personal", "weekly_percentage_pacing"),
      now: new Date("2026-09-27T12:00:00Z"),
      baseLeadSeconds: 86400,
      warningAfterSeconds: 0,
      epochId: "synthetic",
    });
    expect(warned.decision).toBe("warn");
    expect(warned.aheadSeconds).toBe(69120);
  });
  test("blocks exactly at 24 hours and extension moves the threshold", () => {
    const snapshot = weekly(
      "35.7142857142857142857142857142857142857143",
      "2026-09-27T00:00:00Z",
    );
    const exact = strategy.evaluate({
      snapshot,
      override: noOverride("personal", "weekly_percentage_pacing"),
      now: new Date("2026-09-27T00:00:00Z"),
      baseLeadSeconds: 86400,
      warningAfterSeconds: 0,
      epochId: "synthetic",
    });
    expect(exact.decision).toBe("block");
    const extended = strategy.evaluate({
      snapshot,
      override: {
        ...noOverride("personal", "weekly_percentage_pacing"),
        temporaryExtensionSeconds: 86400,
      },
      now: new Date("2026-09-27T00:00:00Z"),
      baseLeadSeconds: 86400,
      warningAfterSeconds: 0,
      epochId: "synthetic",
    });
    expect(extended.decision).toBe("warn");
    const unlocked = strategy.evaluate({
      snapshot,
      override: {
        ...noOverride("personal", "weekly_percentage_pacing"),
        unlockedUntilReset: true,
      },
      now: new Date("2026-09-27T00:00:00Z"),
      baseLeadSeconds: 86400,
      warningAfterSeconds: 0,
      epochId: "synthetic",
    });
    expect(unlocked.decision).toBe("warn");
    expect(
      strategy.evaluate({
        snapshot,
        override: {
          ...noOverride("personal", "weekly_percentage_pacing"),
          unlockedUntilReset: true,
        },
        now: new Date("2026-09-27T00:00:00Z"),
        baseLeadSeconds: 86400,
        warningAfterSeconds: 0,
        warningDuringUnlock: false,
        epochId: "synthetic",
      }).decision,
    ).toBe("allow");
  });
  test("blocks when Codex reports the weekly server-side limit", () => {
    const result = strategy.evaluate({
      snapshot: {
        ...weekly("20", "2026-09-27T12:00:00Z"),
        serverLimitReached: true,
      },
      override: noOverride("personal", "weekly_percentage_pacing"),
      now: new Date("2026-09-27T12:00:00Z"),
      baseLeadSeconds: 86400,
      warningAfterSeconds: 0,
      epochId: "synthetic",
    });
    expect(result.decision).toBe("block");
    expect(result.reason).toContain("server-side");
  });
});

describe("monthly workday strategy", () => {
  const strategy = new MonthlyAiCreditsWorkdaysStrategy();
  test("allocates a full daily budget at local midnight", () => {
    const snapshot = work("100");
    const result = strategy.evaluate({
      snapshot,
      override: noOverride("work", "monthly_ai_credits_workdays"),
      now: new Date("2026-10-05T00:00:00Z"),
      timezone: "Europe/Warsaw",
      baseLeadWorkdays: 1,
      warningAfterWorkdaysAhead: 0,
      epochId: "synthetic",
    });
    expect(result.totalWorkdays).toBe(22);
    expect(result.startedWorkdays).toBe(3);
    expect(result.scheduledCredits.toString()).toBe(
      "136.3636363636363636363636363636363636363636",
    );
    expect(result.decision).toBe("allow");
  });
  test("weekend does not add budget", () => {
    const snapshot = work("100");
    const saturday = strategy.evaluate({
      snapshot,
      override: noOverride("work", "monthly_ai_credits_workdays"),
      now: new Date("2026-10-03T12:00:00Z"),
      timezone: "Europe/Warsaw",
      baseLeadWorkdays: 1,
      warningAfterWorkdaysAhead: 0,
      epochId: "synthetic",
    });
    const monday = strategy.evaluate({
      snapshot,
      override: noOverride("work", "monthly_ai_credits_workdays"),
      now: new Date("2026-10-05T00:00:00Z"),
      timezone: "Europe/Warsaw",
      baseLeadWorkdays: 1,
      warningAfterWorkdaysAhead: 0,
      epochId: "synthetic",
    });
    expect(saturday.startedWorkdays).toBe(2);
    expect(monday.startedWorkdays).toBe(3);
    expect(saturday.decision).toBe("warn");
  });
  test("blocks at one workday ahead and unlocks on the next release", () => {
    const result = strategy.evaluate({
      snapshot: work("200"),
      override: noOverride("work", "monthly_ai_credits_workdays"),
      now: new Date("2026-10-05T00:00:00Z"),
      timezone: "Europe/Warsaw",
      baseLeadWorkdays: 1,
      warningAfterWorkdaysAhead: 0,
      epochId: "synthetic",
    });
    expect(result.decision).toBe("block");
    expect(result.estimatedUnlock).toBeDefined();
    expect(result.estimatedUnlock!.getTime()).toBe(
      new Date("2026-10-06T00:00:00+02:00").getTime(),
    );
  });
  test("unlimited credits bypass local pacing", () => {
    const result = strategy.evaluate({
      snapshot: { ...work("9999"), unlimited: true },
      override: noOverride("work", "monthly_ai_credits_workdays"),
      now: new Date("2026-10-05T00:00:00Z"),
      timezone: "Europe/Warsaw",
      baseLeadWorkdays: 1,
      warningAfterWorkdaysAhead: 0,
      epochId: "synthetic",
    });
    expect(result.decision).toBe("allow");
    expect(result.unlimited).toBe(true);
  });
  test("blocks when Codex reports the server-side credit limit", () => {
    const result = strategy.evaluate({
      snapshot: { ...work("100"), serverLimitReached: true },
      override: noOverride("work", "monthly_ai_credits_workdays"),
      now: new Date("2026-10-05T00:00:00Z"),
      timezone: "Europe/Warsaw",
      baseLeadWorkdays: 1,
      warningAfterWorkdaysAhead: 0,
      epochId: "synthetic",
    });
    expect(result.decision).toBe("block");
    expect(result.reason).toContain("server-side");
  });
});

describe("calendar arithmetic", () => {
  test("subtracts calendar months in UTC and handles February", () => {
    expect(
      addUtcCalendarMonths(new Date("2027-03-01T00:00:00Z"), -1).toISOString(),
    ).toBe("2027-02-01T00:00:00.000Z");
    expect(
      addUtcCalendarMonths(new Date("2026-11-15T10:30:00Z"), -1).toISOString(),
    ).toBe("2026-10-15T10:30:00.000Z");
  });
  test("counts a period that starts after local midnight correctly", () => {
    const start = new Date("2026-10-01T10:00:00Z");
    const end = new Date("2026-11-01T00:00:00Z");
    expect(workdayMidnightsBetween(start, end, "Europe/Warsaw").length).toBe(
      21,
    );
    expect(
      localMidnight(
        { year: 2026, month: 10, day: 5 },
        "Europe/Warsaw",
      ).toISOString(),
    ).toBe("2026-10-04T22:00:00.000Z");
  });
  test("tracks both DST transitions at local midnight", () => {
    expect(
      localMidnight(
        { year: 2026, month: 3, day: 30 },
        "Europe/Warsaw",
      ).toISOString(),
    ).toBe("2026-03-29T22:00:00.000Z");
    expect(
      localMidnight(
        { year: 2026, month: 10, day: 26 },
        "Europe/Warsaw",
      ).toISOString(),
    ).toBe("2026-10-25T23:00:00.000Z");
  });
  test("supports civil date helpers and next workday boundaries", () => {
    const date = { year: 2026, month: 10, day: 5 };
    expect(civilDateKey(date)).toBe("2026-10-05");
    expect(civilDateFromKey("2026-10-05")).toEqual(date);
    expect(weekday(date)).toBe(1);
    expect(isWeekday(date)).toBe(true);
    expect(isWeekday({ year: 2026, month: 10, day: 4 })).toBe(false);
    expect(addCivilDays(date, 1)).toEqual({ year: 2026, month: 10, day: 6 });
    const next = nextWorkdayMidnight(
      new Date("2026-10-02T12:00:00Z"),
      new Date("2026-10-10T00:00:00Z"),
      "Europe/Warsaw",
    );
    expect(next?.toISOString()).toBe("2026-10-04T22:00:00.000Z");
    expect(
      nextWorkdayMidnight(
        new Date("2026-10-09T12:00:00Z"),
        new Date("2026-10-10T00:00:00Z"),
        "Europe/Warsaw",
      ),
    ).toBeUndefined();
    expect(
      nextWorkdayMidnight(
        new Date("2026-10-09T12:00:00Z"),
        new Date("2050-01-01T00:00:00Z"),
        "UTC",
        [],
      ),
    ).toBeUndefined();
    expect(
      formatLocal(new Date("2026-10-05T00:00:00Z"), "Europe/Warsaw"),
    ).toContain("5 Oct");
    expect(formatLocal(undefined, "Europe/Warsaw")).toBe("n/a");
    expect(durationLabel(0)).toBe("0m");
    expect(durationLabel(90061)).toBe("1d 1h 1m");
    expect(durationLabel(-61)).toBe("-1m");
    expect(validateTimeZone("Europe/Warsaw")).toBe(true);
    expect(validateTimeZone("Invalid/Zone")).toBe(false);
  });
});
