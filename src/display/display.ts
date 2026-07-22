import { durationLabel, formatLocal } from "../domain/time.ts";
import type { EvaluationEnvelope } from "../app/guard.ts";
import type {
  PacingResult,
  WorkdayPacingResult,
  WeeklyPacingResult,
} from "../domain/types.ts";
import type { Config } from "../config/config.ts";

function number(value: number, places = 2): string {
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: places,
    maximumFractionDigits: places,
  }).format(value);
}
function decimal(
  value: { toFixed(places: number): string },
  places: number,
): string {
  return value.toFixed(places);
}
function decisionLabel(decision: string): string {
  return decision.toUpperCase();
}

export function resultJson(result: PacingResult): Record<string, unknown> {
  if (result.profile === "personal")
    return {
      decision: result.decision,
      profile: result.profile,
      strategy: result.strategy,
      source: result.source,
      ...(result.planType ? { planType: result.planType } : {}),
      ...(result.limitId ? { limitId: result.limitId } : {}),
      usedPercent: result.usedPercent.toString(),
      scheduledPercent: result.scheduledPercent.toString(),
      aheadSeconds: result.aheadSeconds,
      baseLeadSeconds: result.baseLeadSeconds,
      temporaryExtensionSeconds: result.temporaryExtensionSeconds,
      effectiveLeadSeconds: result.effectiveLeadSeconds,
      unlockedUntilReset: result.unlockedUntilReset,
      periodEnd: result.periodEnd.toISOString(),
      ...(result.estimatedUnlock
        ? { estimatedUnlock: result.estimatedUnlock.toISOString() }
        : {}),
    };
  return {
    decision: result.decision,
    profile: result.profile,
    strategy: result.strategy,
    source: result.source,
    ...(result.planType ? { planType: result.planType } : {}),
    ...(result.limitId ? { limitId: result.limitId } : {}),
    limitCredits: result.limitCredits.toString(),
    usedCredits: result.usedCredits.toString(),
    remainingCredits: result.limitCredits.minus(result.usedCredits).toString(),
    ...(result.remainingPercent
      ? { remainingPercent: result.remainingPercent.toString() }
      : {}),
    scheduledCredits: result.scheduledCredits.toString(),
    aheadCredits: result.aheadCredits.toString(),
    aheadWorkdays: result.aheadWorkdays.toString(),
    totalWorkdays: result.totalWorkdays,
    startedWorkdays: result.startedWorkdays,
    dailyBudget: result.dailyBudget.toString(),
    baseLeadWorkdays: result.baseLeadWorkdays,
    temporaryExtensionWorkdays: result.temporaryExtensionWorkdays,
    effectiveLeadWorkdays: result.effectiveLeadWorkdays,
    unlockedUntilReset: result.unlockedUntilReset,
    periodEnd: result.periodEnd.toISOString(),
    ...(result.nextBudgetRelease
      ? { nextBudgetRelease: result.nextBudgetRelease.toISOString() }
      : {}),
    ...(result.estimatedUnlock
      ? { estimatedUnlock: result.estimatedUnlock.toISOString() }
      : {}),
    unlimited: result.unlimited,
  };
}

export function warningMessage(result: PacingResult, config: Config): string {
  if (result.profile === "personal")
    return `Codex weekly usage warning\n\nWeekly usage:          ${decimal(result.usedPercent, config.display.percentageDecimalPlaces)}%\nLinear schedule:       ${decimal(result.scheduledPercent, config.display.percentageDecimalPlaces)}%\nAhead of schedule:     ${durationLabel(result.aheadSeconds)}\nBlocking threshold:    ${durationLabel(result.effectiveLeadSeconds)}\n\nThe prompt was allowed.`;
  return `Codex AI Credits usage warning\n\nMonthly credit limit:  ${decimal(result.limitCredits, config.display.creditDecimalPlaces)}\nCredits used:          ${decimal(result.usedCredits, config.display.creditDecimalPlaces)}\nScheduled by now:      ${decimal(result.scheduledCredits, config.display.creditDecimalPlaces)}\nAhead of schedule:     ${decimal(result.aheadCredits, config.display.creditDecimalPlaces)} credits\nEquivalent lead:       ${decimal(result.aheadWorkdays, 2)} workday(s)\nBlocking threshold:    ${number(result.effectiveLeadWorkdays, 2)} workday(s)\n\nThe prompt was allowed.`;
}

export function blockMessage(result: PacingResult, config: Config): string {
  if (result.profile === "personal") {
    const unlock =
      config.display.showUnlockTime && result.estimatedUnlock
        ? `Estimated unlock:      ${formatLocal(result.estimatedUnlock, config.display.timezone)}`
        : "The prompt may pass after the next quota reset.";
    return `Codex weekly usage guard blocked this prompt\n\nWeekly usage:          ${decimal(result.usedPercent, config.display.percentageDecimalPlaces)}%\nLinear schedule:       ${decimal(result.scheduledPercent, config.display.percentageDecimalPlaces)}%\nAhead of schedule:     ${durationLabel(result.aheadSeconds)}\nAllowed lead:          ${durationLabel(result.effectiveLeadSeconds)}\n\n${result.serverLimitReached ? "The block comes from Codex's server-side limit." : unlock}\n\nTemporary extension:\n  codex-usage-guard extend\n\nDisable blocking until reset:\n  codex-usage-guard unlock`;
  }
  const unlock = config.display.showUnlockTime
    ? result.estimatedUnlock
      ? formatLocal(result.estimatedUnlock, config.display.timezone)
      : formatLocal(result.periodEnd, config.display.timezone)
    : "The prompt may pass after the next quota reset.";
  return `Codex AI Credits usage guard blocked this prompt\n\nMonthly credit limit:  ${decimal(result.limitCredits, config.display.creditDecimalPlaces)}\nCredits used:          ${decimal(result.usedCredits, config.display.creditDecimalPlaces)}\nScheduled by now:      ${decimal(result.scheduledCredits, config.display.creditDecimalPlaces)}\nAhead of schedule:     ${decimal(result.aheadCredits, config.display.creditDecimalPlaces)} credits\nEquivalent lead:       ${decimal(result.aheadWorkdays, 2)} workday(s)\nAllowed lead:          ${number(result.effectiveLeadWorkdays, 2)} workday(s)\n\n${result.serverLimitReached ? "The block comes from Codex's server-side limit." : `Estimated return below the blocking threshold:\n${unlock}`}\n\nTemporary extension:\n  codex-usage-guard extend\n\nDisable blocking until reset:\n  codex-usage-guard unlock`;
}

export function statusText(
  envelope: EvaluationEnvelope,
  config: Config,
  now = new Date(),
): string {
  const lines = [
    `Data source:              ${envelope.dataSource ?? "none"}`,
    `Plan:                     ${envelope.result?.planType ?? (envelope.result?.profile === "work" ? "Business/Enterprise" : envelope.result?.profile === "personal" ? "Plus/Pro" : "unknown")}`,
    `Active profile:           ${envelope.profile ?? "unknown"}`,
    `Profile selection:        ${envelope.profileReason}`,
    `Last successful read:     ${envelope.observedAt ? formatLocal(envelope.observedAt, config.display.timezone) : "n/a"}`,
    `Cache stale:              ${envelope.stale ? "yes" : "no"}`,
  ];
  if (envelope.missing) {
    lines.push(
      `Decision:                 ${decisionLabel(envelope.missing.decision)}`,
      `Blocking enabled:         ${config.data.missingDataAction === "block" ? "yes" : "no"}`,
      `Reason:                   ${envelope.missing.reason}`,
    );
    return lines.join("\n");
  }
  const result = envelope.result!;
  lines.push(
    `Strategy:                 ${result.strategy}`,
    `Quota epoch:              ${result.epochId}`,
    `Blocking enabled:         ${result.unlockedUntilReset ? "no (unlocked until reset)" : "yes"}`,
    `Server limit reached:     ${result.serverLimitReached ? "yes" : "no"}`,
  );
  if (result.profile === "personal") {
    lines.push(
      `Weekly usage:             ${decimal(result.usedPercent, config.display.percentageDecimalPlaces)}%`,
      `Window start:             ${formatLocal(result.windowStart, config.display.timezone)}`,
      `Last reset:               ${formatLocal(result.windowStart, config.display.timezone)}`,
      `Window end:               ${formatLocal(result.periodEnd, config.display.timezone)}`,
      `Time until reset:         ${durationLabel((result.periodEnd.getTime() - now.getTime()) / 1000)}`,
      `Linear schedule:          ${decimal(result.scheduledPercent, config.display.percentageDecimalPlaces)}%`,
      `Ahead of schedule:        ${durationLabel(result.aheadSeconds)}`,
      `Base allowed lead:        ${durationLabel(result.baseLeadSeconds)}`,
      `Temporary extension:      ${durationLabel(result.temporaryExtensionSeconds)}`,
      `Effective allowed lead:   ${durationLabel(result.effectiveLeadSeconds)}`,
    );
  } else {
    lines.push(
      `Monthly credit limit:     ${decimal(result.limitCredits, config.display.creditDecimalPlaces)}`,
      `Credits used:             ${decimal(result.usedCredits, config.display.creditDecimalPlaces)}`,
      `Credits remaining:        ${decimal(result.limitCredits.minus(result.usedCredits), config.display.creditDecimalPlaces)}`,
      ...(result.remainingPercent
        ? [
            `Remaining percent:        ${decimal(result.remainingPercent, config.display.percentageDecimalPlaces)}%`,
          ]
        : []),
      `Limit ID:                 ${result.limitId ?? "codex"}`,
      `Period start:             ${formatLocal(result.periodStart, config.display.timezone)}`,
      `Last reset:               ${formatLocal(result.periodStart, config.display.timezone)}`,
      `Period end:               ${formatLocal(result.periodEnd, config.display.timezone)}`,
      `Time until reset:         ${durationLabel((result.periodEnd.getTime() - now.getTime()) / 1000)}`,
      `Total workdays:           ${result.totalWorkdays}`,
      `Started workdays:         ${result.startedWorkdays}`,
      ...(config.display.showDailyBudget
        ? [
            `Daily budget:             ${decimal(result.dailyBudget, config.display.creditDecimalPlaces)}`,
          ]
        : []),
      `Scheduled by now:         ${decimal(result.scheduledCredits, config.display.creditDecimalPlaces)}`,
      `Ahead of schedule:        ${decimal(result.aheadCredits, config.display.creditDecimalPlaces)} credits`,
      `Equivalent lead:          ${decimal(result.aheadWorkdays, 2)} workday(s)`,
      `Base allowed lead:        ${number(result.baseLeadWorkdays, 2)} workday(s)`,
      `Temporary extension:      ${number(result.temporaryExtensionWorkdays, 2)} workday(s)`,
      `Effective allowed lead:   ${number(result.effectiveLeadWorkdays, 2)} workday(s)`,
      `Unlimited:                ${result.unlimited ? "yes" : "no"}`,
    );
  }
  lines.push(
    `Unlocked until reset:     ${result.unlockedUntilReset ? "yes" : "no"}`,
    `Decision:                 ${decisionLabel(result.decision)}`,
  );
  return lines.join("\n");
}
