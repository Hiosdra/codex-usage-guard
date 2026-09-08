import { Decimal } from "../domain/decimal.ts";
import {
  addUtcCalendarMonths,
  workdayMidnightsInUtcDateRange,
} from "../domain/time.ts";
import type {
  OverrideState,
  PacingStrategy,
  WorkCreditsSnapshot,
  WorkdayPacingResult,
} from "../domain/types.ts";

export interface WorkdayPacingInput {
  snapshot: WorkCreditsSnapshot;
  override: OverrideState;
  now: Date;
  timezone: string;
  workdays?: number[];
  baseLeadWorkdays: number;
  warningAfterWorkdaysAhead: number;
  warningDuringUnlock?: boolean;
  epochId: string;
}

export class MonthlyAiCreditsWorkdaysStrategy implements PacingStrategy<
  WorkdayPacingInput,
  WorkdayPacingResult
> {
  evaluate(input: WorkdayPacingInput): WorkdayPacingResult {
    const { snapshot, override } = input;
    const workdays = input.workdays ?? [1, 2, 3, 4, 5];
    // The quota period is defined by UTC calendar dates. Releases happen at
    // local midnight, so release instants can cross the UTC period boundary.
    // Only a normal month boundary includes a partial first workday; an
    // inferred mid-month reset retains the strict partial-day behavior.
    const includePartialStartDate =
      addUtcCalendarMonths(snapshot.resetsAt, -1).getTime() ===
      snapshot.periodStart.getTime();
    const allReleases = workdayMidnightsInUtcDateRange(
      snapshot.periodStart,
      snapshot.resetsAt,
      input.timezone,
      workdays,
      includePartialStartDate,
    );
    const startedReleases = allReleases.filter(
      (release) => release.getTime() <= input.now.getTime(),
    );
    const totalWorkdays = allReleases.length;
    const startedWorkdays = startedReleases.length;
    const base = {
      decision: "allow" as const,
      profile: "work" as const,
      strategy: "monthly_ai_credits_workdays" as const,
      source: snapshot.source,
      epochId: input.epochId,
      unlockedUntilReset: override.unlockedUntilReset,
      serverLimitReached: snapshot.serverLimitReached,
      ...(snapshot.planType ? { planType: snapshot.planType } : {}),
      limitId: snapshot.limitId,
    };
    if (snapshot.unlimited)
      return {
        ...base,
        limitCredits: snapshot.limitCredits,
        usedCredits: snapshot.usedCredits,
        ...(snapshot.remainingPercent
          ? { remainingPercent: snapshot.remainingPercent }
          : {}),
        scheduledCredits: Decimal.zero(),
        aheadCredits: Decimal.zero(),
        aheadWorkdays: Decimal.zero(),
        totalWorkdays,
        startedWorkdays,
        dailyBudget: Decimal.zero(),
        baseLeadWorkdays: input.baseLeadWorkdays,
        temporaryExtensionWorkdays: override.temporaryExtensionWorkdays,
        effectiveLeadWorkdays:
          input.baseLeadWorkdays + override.temporaryExtensionWorkdays,
        periodStart: snapshot.periodStart,
        periodEnd: snapshot.resetsAt,
        unlimited: true,
      };
    if (totalWorkdays === 0)
      throw new Error("The business quota period contains no workdays");
    const dailyBudget = snapshot.limitCredits.div(totalWorkdays);
    const scheduledCredits = snapshot.limitCredits
      .times(startedWorkdays)
      .div(totalWorkdays);
    const quotaUsageToDatePercent = scheduledCredits.isZero()
      ? undefined
      : snapshot.usedCredits.times(100).div(scheduledCredits);
    const aheadCredits = snapshot.usedCredits.minus(scheduledCredits);
    const aheadWorkdays = aheadCredits.div(dailyBudget);
    const effectiveLeadWorkdays =
      input.baseLeadWorkdays + override.temporaryExtensionWorkdays;
    const result: WorkdayPacingResult = {
      ...base,
      limitCredits: snapshot.limitCredits,
      usedCredits: snapshot.usedCredits,
      ...(snapshot.remainingPercent
        ? { remainingPercent: snapshot.remainingPercent }
        : {}),
      scheduledCredits,
      ...(quotaUsageToDatePercent !== undefined
        ? { quotaUsageToDatePercent }
        : {}),
      aheadCredits,
      aheadWorkdays,
      totalWorkdays,
      startedWorkdays,
      dailyBudget,
      baseLeadWorkdays: input.baseLeadWorkdays,
      temporaryExtensionWorkdays: override.temporaryExtensionWorkdays,
      effectiveLeadWorkdays,
      periodStart: snapshot.periodStart,
      periodEnd: snapshot.resetsAt,
      unlimited: false,
    };
    if (
      snapshot.serverLimitReached ||
      snapshot.usedCredits.greaterThanOrEqual(snapshot.limitCredits) ||
      (snapshot.remainingPercent?.lessThanOrEqual?.(0) ?? false)
    ) {
      result.decision = "block";
      result.reason =
        "Codex reported that the server-side AI Credits limit has been reached.";
      return result;
    }
    if (
      aheadWorkdays.greaterThan(input.warningAfterWorkdaysAhead) &&
      (!override.unlockedUntilReset || input.warningDuringUnlock !== false)
    ) {
      result.decision = "warn";
      result.reason = "AI Credits usage is ahead of the workday schedule.";
    }
    if (
      aheadWorkdays.greaterThanOrEqual(effectiveLeadWorkdays) &&
      !override.unlockedUntilReset
    ) {
      result.decision = "block";
      result.reason =
        "AI Credits usage is at or beyond the configured allowed workday lead.";
      const firstCandidate = allReleases.findIndex(
        (release) =>
          release.getTime() > input.now.getTime() &&
          release.getTime() >= snapshot.periodStart.getTime(),
      );
      for (
        let candidateIndex = firstCandidate;
        candidateIndex >= 0;
        candidateIndex += 1
      ) {
        const candidate = allReleases[candidateIndex]!;
        const scheduledAtCandidate = snapshot.limitCredits
          .times(candidateIndex + 1)
          .div(totalWorkdays);
        const allowedAtCandidate = scheduledAtCandidate.plus(
          dailyBudget.times(effectiveLeadWorkdays),
        );
        if (snapshot.usedCredits.lessThan(allowedAtCandidate)) {
          result.nextBudgetRelease = candidate;
          result.estimatedUnlock = candidate;
          break;
        }
      }
      if (!result.estimatedUnlock) result.estimatedUnlock = snapshot.resetsAt;
    }
    return result;
  }
}
