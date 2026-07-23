import { describe, expect, test } from "bun:test";
import { defaultConfig } from "../src/config/config.ts";
import { Decimal } from "../src/domain/decimal.ts";
import {
  statusText,
  resultJson,
  warningMessage,
  blockMessage,
} from "../src/display/display.ts";
import { MonthlyAiCreditsWorkdaysStrategy } from "../src/strategies/monthly-workdays-credits.ts";
import { WeeklyPercentagePacingStrategy } from "../src/strategies/weekly-percentage.ts";
import type { EvaluationEnvelope } from "../src/app/guard.ts";
import type {
  OverrideState,
  WeeklyLimitSnapshot,
  WorkCreditsSnapshot,
} from "../src/domain/types.ts";

const override = (
  profile: "personal" | "work",
  strategy: "weekly_percentage_pacing" | "monthly_ai_credits_workdays",
): OverrideState => ({
  profile,
  strategy,
  epochId: "display-epoch",
  temporaryExtensionSeconds: 0,
  temporaryExtensionWorkdays: 0,
  unlockedUntilReset: false,
  updatedAt: new Date(0),
});

function weeklyResult() {
  const start = new Date("2026-09-25T12:00:00Z");
  const snapshot: WeeklyLimitSnapshot = {
    profile: "personal",
    strategy: "weekly_percentage_pacing",
    usedPercent: new Decimal("40"),
    windowDurationSeconds: 604800,
    windowStart: start,
    resetsAt: new Date("2026-10-02T12:00:00Z"),
    observedAt: new Date("2026-09-27T12:00:00Z"),
    planType: "pro",
    limitId: "secondary",
    serverLimitReached: false,
    source: "fixture",
  };
  return new WeeklyPercentagePacingStrategy().evaluate({
    snapshot,
    override: override("personal", "weekly_percentage_pacing"),
    now: new Date("2026-09-27T12:00:00Z"),
    baseLeadSeconds: 86400,
    warningAfterSeconds: 0,
    epochId: "display-epoch",
  });
}

function workResult() {
  const snapshot: WorkCreditsSnapshot = {
    profile: "work",
    strategy: "monthly_ai_credits_workdays",
    limitId: "codex",
    planType: "business",
    limitCredits: new Decimal("1000"),
    usedCredits: new Decimal("420.5"),
    remainingPercent: new Decimal("58"),
    resetsAt: new Date("2026-11-01T00:00:00Z"),
    periodStart: new Date("2026-09-30T22:00:00Z"),
    observedAt: new Date("2026-10-07T12:00:00Z"),
    serverLimitReached: false,
    unlimited: false,
    source: "fixture",
  };
  return new MonthlyAiCreditsWorkdaysStrategy().evaluate({
    snapshot,
    override: override("work", "monthly_ai_credits_workdays"),
    now: new Date("2026-10-07T12:00:00Z"),
    timezone: "Europe/Warsaw",
    baseLeadWorkdays: 1,
    warningAfterWorkdaysAhead: 0,
    epochId: "display-epoch",
  });
}

describe("display", () => {
  test("renders personal and work JSON and warning messages", () => {
    const personal = weeklyResult();
    const work = workResult();
    expect(resultJson(personal)).toMatchObject({
      profile: "personal",
      usedPercent: "40",
      planType: "pro",
    });
    expect(resultJson(work)).toMatchObject({
      profile: "work",
      limitCredits: "1000",
      usedCredits: "420.5",
      remainingCredits: "579.5",
      remainingPercent: "58",
    });
    expect(warningMessage(personal, defaultConfig())).toContain(
      "Codex weekly usage warning",
    );
    expect(warningMessage(personal, defaultConfig())).toContain(
      "- Weekly usage:",
    );
    expect(warningMessage(work, defaultConfig())).toContain(
      "AI Credits usage warning",
    );
    expect(warningMessage(work, defaultConfig())).toContain(
      "- Monthly credit limit:",
    );
  });

  test("renders block and status branches", () => {
    const config = defaultConfig();
    const personal = weeklyResult();
    personal.decision = "block";
    personal.serverLimitReached = false;
    personal.estimatedUnlock = new Date("2026-09-30T12:00:00Z");
    expect(blockMessage(personal, config)).toContain("Estimated unlock");
    config.display.showUnlockTime = false;
    expect(blockMessage(personal, config)).toContain(
      "after the next quota reset",
    );
    personal.serverLimitReached = true;
    expect(blockMessage(personal, config)).toContain("server-side limit");

    const work = workResult();
    work.decision = "block";
    work.estimatedUnlock = new Date("2026-10-08T22:00:00Z");
    config.display.showUnlockTime = true;
    expect(blockMessage(work, config)).toContain("Estimated return");
    const workWithoutEstimate = workResult();
    workWithoutEstimate.decision = "block";
    delete workWithoutEstimate.estimatedUnlock;
    expect(blockMessage(workWithoutEstimate, config)).toContain(
      "Estimated return",
    );
    expect(
      statusText(
        {
          result: work,
          profile: "work",
          profileReason: "synthetic",
          dataSource: "fixture",
          stale: false,
          observedAt: work.periodStart,
        },
        config,
      ),
    ).toContain("Daily budget");
    config.display.showDailyBudget = false;
    expect(
      statusText(
        {
          result: work,
          profile: "work",
          profileReason: "synthetic",
          dataSource: "fixture",
          stale: false,
          observedAt: work.periodStart,
        },
        config,
      ),
    ).not.toContain("Daily budget");
    work.serverLimitReached = true;
    expect(blockMessage(work, config)).toContain("server-side limit");

    const personalStatus = statusText(
      {
        result: personal,
        profile: "personal",
        profileReason: "synthetic",
        dataSource: "fixture",
        stale: true,
        observedAt: personal.windowStart,
      },
      defaultConfig(),
    );
    expect(personalStatus).toContain("Active profile:           personal");
    expect(personalStatus).toContain("Decision:                 BLOCK");
    const missing: EvaluationEnvelope = {
      missing: {
        decision: "missing",
        reason: "synthetic missing",
        source: "none",
      },
      profile: undefined,
      profileReason: "synthetic missing",
      dataSource: "none",
      stale: false,
    };
    expect(statusText(missing, defaultConfig())).toContain("synthetic missing");
  });
});
