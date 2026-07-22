import { Decimal } from "../domain/decimal.ts";
import type {
  OverrideState,
  PacingStrategy,
  WeeklyLimitSnapshot,
  WeeklyPacingResult,
} from "../domain/types.ts";

export interface WeeklyPacingInput {
  snapshot: WeeklyLimitSnapshot;
  override: OverrideState;
  now: Date;
  baseLeadSeconds: number;
  warningAfterSeconds: number;
  warningDuringUnlock?: boolean;
  epochId: string;
}

export class WeeklyPercentagePacingStrategy implements PacingStrategy<
  WeeklyPacingInput,
  WeeklyPacingResult
> {
  evaluate(input: WeeklyPacingInput): WeeklyPacingResult {
    const { snapshot, override } = input;
    const elapsedSeconds = Math.max(
      0,
      Math.min(
        snapshot.windowDurationSeconds,
        (input.now.getTime() - snapshot.windowStart.getTime()) / 1000,
      ),
    );
    const elapsed = new Decimal(String(elapsedSeconds));
    const scheduledPercent = elapsed
      .div(snapshot.windowDurationSeconds)
      .times(100);
    const usagePositionSeconds = snapshot.usedPercent
      .div(100)
      .times(snapshot.windowDurationSeconds);
    const aheadSecondsDecimal = usagePositionSeconds.minus(elapsed);
    const effectiveLeadSeconds =
      input.baseLeadSeconds + override.temporaryExtensionSeconds;
    // Compare the un-divided quantities for decisions so an exact boundary
    // such as 24h cannot be moved by a repeating decimal approximation.
    const aheadComparison = snapshot.usedPercent
      .times(snapshot.windowDurationSeconds)
      .minus(elapsed.times(100));
    const warningThresholdComparison = new Decimal(
      input.warningAfterSeconds,
    ).times(100);
    const blockThresholdComparison = new Decimal(effectiveLeadSeconds).times(
      100,
    );
    const aheadSeconds = Number(aheadSecondsDecimal.toString());
    const periodEnd = snapshot.resetsAt;
    const result: WeeklyPacingResult = {
      decision: "allow",
      profile: "personal",
      strategy: "weekly_percentage_pacing",
      source: snapshot.source,
      epochId: input.epochId,
      unlockedUntilReset: override.unlockedUntilReset,
      serverLimitReached: snapshot.serverLimitReached,
      ...(snapshot.planType ? { planType: snapshot.planType } : {}),
      ...(snapshot.limitId ? { limitId: snapshot.limitId } : {}),
      usedPercent: snapshot.usedPercent,
      scheduledPercent,
      aheadSeconds,
      baseLeadSeconds: input.baseLeadSeconds,
      temporaryExtensionSeconds: override.temporaryExtensionSeconds,
      effectiveLeadSeconds,
      windowStart: snapshot.windowStart,
      periodEnd,
    };
    if (
      snapshot.serverLimitReached ||
      snapshot.usedPercent.greaterThanOrEqual(100)
    ) {
      result.decision = "block";
      result.reason =
        "Codex reported that the weekly server-side limit has been reached.";
      return result;
    }
    if (
      aheadComparison.greaterThan(warningThresholdComparison) &&
      (!override.unlockedUntilReset || input.warningDuringUnlock !== false)
    ) {
      result.decision = "warn";
      result.reason = "Weekly usage is ahead of the linear schedule.";
    }
    if (
      aheadComparison.greaterThanOrEqual(blockThresholdComparison) &&
      !override.unlockedUntilReset
    ) {
      result.decision = "block";
      result.reason =
        "Weekly usage is at or beyond the configured allowed lead.";
      const unlockAt = new Date(
        snapshot.windowStart.getTime() +
          Number(usagePositionSeconds.toString()) * 1000 -
          effectiveLeadSeconds * 1000,
      );
      if (
        unlockAt.getTime() > input.now.getTime() &&
        unlockAt.getTime() < periodEnd.getTime()
      )
        result.estimatedUnlock = unlockAt;
    }
    return result;
  }
}
