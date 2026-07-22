import { addUtcCalendarMonths } from "../domain/time.ts";
import { Decimal } from "../domain/decimal.ts";
import type { Config, Paths } from "../config/config.ts";
import { StateStore } from "../persistence/sqlite.ts";
import {
  CodexAppServerClient,
  AppServerError,
} from "../codex/app-server-client.ts";
import {
  chooseProfile,
  parseRateLimits,
  type ParsedRateLimits,
} from "../codex/rate-limits-parser.ts";
import { readLatestSessionRateLimits } from "../codex/session-files-fallback.ts";
import type {
  Decision,
  Profile,
  PacingResult,
  QuotaSnapshot,
  WeeklyLimitSnapshot,
  WorkCreditsSnapshot,
} from "../domain/types.ts";
import { MonthlyAiCreditsWorkdaysStrategy } from "../strategies/monthly-workdays-credits.ts";
import { WeeklyPercentagePacingStrategy } from "../strategies/weekly-percentage.ts";
import { SafeLogger } from "../logging/logger.ts";

export interface EvaluationEnvelope {
  result?: PacingResult;
  missing?: { decision: Decision; reason: string; source: string };
  profile: Profile | undefined;
  profileReason: string;
  dataSource?: string;
  stale: boolean;
  observedAt?: Date;
  failure?: "integration";
}

interface FreshData {
  raw: unknown;
  parsed: ParsedRateLimits;
  source: string;
  observedAt: Date;
  stale: boolean;
}

function iso(value: Date): string {
  return value.toISOString();
}
function payloadSnapshot(snapshot: QuotaSnapshot): Record<string, unknown> {
  if (snapshot.profile === "personal")
    return {
      ...snapshot,
      usedPercent: snapshot.usedPercent.toString(),
      windowStart: iso(snapshot.windowStart),
      resetsAt: iso(snapshot.resetsAt),
      observedAt: iso(snapshot.observedAt),
    };
  return {
    ...snapshot,
    limitCredits: snapshot.limitCredits.toString(),
    usedCredits: snapshot.usedCredits.toString(),
    ...(snapshot.remainingPercent
      ? { remainingPercent: snapshot.remainingPercent.toString() }
      : {}),
    resetsAt: iso(snapshot.resetsAt),
    periodStart: iso(snapshot.periodStart),
    observedAt: iso(snapshot.observedAt),
  };
}
function snapshotFromPayload(payload: string): QuotaSnapshot | undefined {
  try {
    const value = JSON.parse(payload) as Record<string, unknown>;
    if (value.profile === "personal")
      return {
        ...value,
        usedPercent: new Decimal(String(value.usedPercent)),
        windowStart: new Date(String(value.windowStart)),
        resetsAt: new Date(String(value.resetsAt)),
        observedAt: new Date(String(value.observedAt)),
      } as unknown as WeeklyLimitSnapshot;
    if (value.profile === "work")
      return {
        ...value,
        limitCredits: new Decimal(String(value.limitCredits)),
        usedCredits: new Decimal(String(value.usedCredits)),
        ...(value.remainingPercent
          ? { remainingPercent: new Decimal(String(value.remainingPercent)) }
          : {}),
        resetsAt: new Date(String(value.resetsAt)),
        periodStart: new Date(String(value.periodStart)),
        observedAt: new Date(String(value.observedAt)),
      } as unknown as WorkCreditsSnapshot;
  } catch {
    /* old/corrupt rows are ignored */
  }
  return undefined;
}

export class UsageGuard {
  private readonly weekly = new WeeklyPercentagePacingStrategy();
  private readonly workdays = new MonthlyAiCreditsWorkdaysStrategy();
  private readonly logger: SafeLogger;
  private dataFailure: "integration" | undefined;
  constructor(
    private readonly config: Config,
    private readonly paths: Paths,
    private readonly state: StateStore,
    private readonly appServer = new CodexAppServerClient({
      command: process.env.CODEX_USAGE_GUARD_CODEX_COMMAND ?? "codex",
      timeoutMs: config.data.appServerTimeoutSeconds * 1000,
    }),
    private readonly now = () => new Date(),
  ) {
    this.logger = new SafeLogger(paths.logs);
  }

  async evaluate(): Promise<EvaluationEnvelope> {
    const data = await this.loadData();
    if (!data)
      return this.missing(
        "No trustworthy Codex rate-limit data is available",
        "none",
        this.dataFailure,
      );
    const selection = chooseProfile(data.parsed, this.config.activeProfile);
    if (!selection.active) return this.missing(selection.reason, data.source);
    const selected =
      selection.active === "personal" ? data.parsed.personal : data.parsed.work;
    if (!selected) return this.missing(selection.reason, data.source);
    const previous = this.state.latestSnapshot(selection.active);
    let prepared = this.prepareSnapshot(selected);
    let early = this.inferEarlyReset(previous, prepared);
    if (
      early &&
      data.source === "codex_app_server" &&
      this.config.resetDetection.confirmationReads > 1
    ) {
      let confirmed = true;
      for (
        let read = 1;
        read < this.config.resetDetection.confirmationReads;
        read += 1
      ) {
        if (this.config.resetDetection.confirmationIntervalSeconds > 0)
          await new Promise((resolve) =>
            setTimeout(
              resolve,
              this.config.resetDetection.confirmationIntervalSeconds * 1000,
            ),
          );
        try {
          const fresh = parseRateLimits(
            await this.appServer.readRateLimits(),
            this.now(),
          );
          const candidate =
            selection.active === "personal" ? fresh.personal : fresh.work;
          if (!candidate || !this.inferEarlyReset(previous, candidate)) {
            confirmed = false;
            break;
          }
          prepared = this.prepareSnapshot(candidate);
        } catch {
          confirmed = false;
          break;
        }
      }
      early = confirmed;
    }
    if (early) {
      if (prepared.profile === "personal")
        prepared.windowStart = data.observedAt;
      else prepared.periodStart = data.observedAt;
    }
    const epochId = this.makeEpochId(
      prepared,
      early ? data.observedAt : undefined,
    );
    this.state.ensureEpoch({
      epochId,
      profile: prepared.profile,
      strategy: prepared.strategy,
      periodStart:
        prepared.profile === "personal"
          ? prepared.windowStart
          : prepared.periodStart,
      periodEnd: prepared.resetsAt,
      resetMethod: early
        ? "early_reset_inferred"
        : previous && previous.resetsAt !== iso(prepared.resetsAt)
          ? "server_reset"
          : "server_observed",
    });
    if (
      previous &&
      prepared.profile === "work" &&
      previous.limitValue &&
      previous.limitValue !== prepared.limitCredits.toString() &&
      previous.resetsAt === iso(prepared.resetsAt)
    )
      this.state.recordLimitChange(
        previous.limitValue,
        prepared.limitCredits.toString(),
        prepared.resetsAt,
      );
    if (early)
      this.state.recordReset(
        prepared.profile,
        prepared.profile === "personal"
          ? (previous?.usedPercent ?? undefined)
          : (previous?.usedValue ?? undefined),
        prepared.profile === "personal"
          ? prepared.usedPercent.toString()
          : prepared.usedCredits.toString(),
        prepared.resetsAt,
        "early_reset_inferred",
        {
          previous: previous?.payload ?? null,
          current: payloadSnapshot(prepared),
        },
      );
    this.state.insertSnapshot({
      profile: prepared.profile,
      strategy: prepared.strategy,
      epochId,
      resetsAt: iso(prepared.resetsAt),
      limitValue:
        prepared.profile === "work" ? prepared.limitCredits.toString() : null,
      usedValue:
        prepared.profile === "work" ? prepared.usedCredits.toString() : null,
      usedPercent:
        prepared.profile === "personal"
          ? prepared.usedPercent.toString()
          : null,
      observedAt: iso(data.observedAt),
      source: data.source,
      payload: JSON.stringify(payloadSnapshot(prepared)),
    });
    const override = this.state.getOverride(
      prepared.profile,
      prepared.strategy,
      epochId,
    );
    const configuredWorkdays = this.config.work.workdays
      .map(
        (day) =>
          ({ mon: 1, tue: 2, wed: 3, thu: 4, fri: 5 })[day.toLowerCase()],
      )
      .filter((day): day is number => day !== undefined);
    const result =
      prepared.profile === "personal"
        ? this.weekly.evaluate({
            snapshot: prepared,
            override,
            now: this.now(),
            baseLeadSeconds: this.config.personal.baseLeadSeconds,
            warningAfterSeconds: this.config.personal.warningAfterSeconds,
            warningDuringUnlock: this.config.overrides.warningDuringUnlock,
            epochId,
          })
        : this.workdays.evaluate({
            snapshot: prepared,
            override,
            now: this.now(),
            timezone: this.config.work.timezone,
            ...(configuredWorkdays.length
              ? { workdays: configuredWorkdays }
              : {}),
            baseLeadWorkdays: this.config.work.blockAfterWorkdaysAhead,
            warningAfterWorkdaysAhead:
              this.config.work.warningAfterWorkdaysAhead,
            warningDuringUnlock: this.config.overrides.warningDuringUnlock,
            epochId,
          });
    this.state.cachePut(
      `rate-limits:${result.profile}:${result.epochId}`,
      JSON.stringify(data.raw),
      data.observedAt,
      data.source,
    );
    this.logger.write("decision", {
      profile: result.profile,
      strategy: result.strategy,
      decision: result.decision,
      source: result.source,
      stale: data.stale,
      epoch: epochId,
    });
    return {
      result,
      profile: selection.active,
      profileReason: selection.reason,
      dataSource: data.source,
      stale: data.stale,
      observedAt: data.observedAt,
    };
  }

  private missing(
    reason: string,
    source: string,
    failure?: "integration",
  ): EvaluationEnvelope {
    const action = this.config.data.missingDataAction;
    const decision: Decision =
      action === "allow" ? "allow" : action === "block" ? "block" : "missing";
    return {
      missing: { decision, reason, source },
      profile: undefined,
      profileReason: reason,
      dataSource: source,
      stale: false,
      ...(failure ? { failure } : {}),
    };
  }

  private async loadData(): Promise<FreshData | undefined> {
    this.dataFailure = undefined;
    const key = "rate-limits";
    const cached = this.state.cacheGet(key);
    const now = this.now();
    if (
      cached &&
      (now.getTime() - cached.observedAt.getTime()) / 1000 <=
        this.config.data.cacheTtlSeconds
    ) {
      try {
        return {
          raw: JSON.parse(cached.payload),
          parsed: parseRateLimits(
            JSON.parse(cached.payload),
            cached.observedAt,
            cached.source,
          ),
          source: cached.source,
          observedAt: cached.observedAt,
          stale: false,
        };
      } catch {
        /* refresh corrupt cache */
      }
    }
    try {
      const raw = await this.appServer.readRateLimits();
      const observedAt = this.now();
      const parsed = parseRateLimits(raw, observedAt);
      this.state.cachePut(
        key,
        JSON.stringify(raw),
        observedAt,
        "codex_app_server",
      );
      return {
        raw,
        parsed,
        source: "codex_app_server",
        observedAt,
        stale: false,
      };
    } catch (error) {
      if (this.config.data.fallbackToSessionFiles) {
        const fallback = await readLatestSessionRateLimits(
          this.paths.codexHome,
        );
        if (fallback) {
          try {
            const parsed = parseRateLimits(
              fallback.raw,
              fallback.observedAt,
              fallback.source,
            );
            return {
              raw: fallback.raw,
              parsed,
              source: fallback.source,
              observedAt: fallback.observedAt,
              stale: true,
            };
          } catch {
            /* continue to stale cache */
          }
        }
      }
      if (
        cached &&
        (now.getTime() - cached.observedAt.getTime()) / 1000 <=
          this.config.data.maximumStaleAgeSeconds
      ) {
        try {
          const raw = JSON.parse(cached.payload);
          return {
            raw,
            parsed: parseRateLimits(
              raw,
              cached.observedAt,
              `${cached.source}:stale`,
            ),
            source: `${cached.source}:stale`,
            observedAt: cached.observedAt,
            stale: true,
          };
        } catch {
          /* missing data */
        }
      }
      if (error instanceof AppServerError) {
        this.dataFailure = "integration";
        return undefined;
      }
      this.dataFailure = "integration";
      return undefined;
    }
  }

  private prepareSnapshot(snapshot: QuotaSnapshot): QuotaSnapshot {
    const previous = this.state.latestSnapshot(snapshot.profile);
    if (snapshot.profile === "personal") {
      const result = {
        ...snapshot,
        windowStart: new Date(
          snapshot.resetsAt.getTime() - snapshot.windowDurationSeconds * 1000,
        ),
      };
      return result;
    }
    const previousSnapshot = previous
      ? snapshotFromPayload(previous.payload)
      : undefined;
    const periodStart =
      previous && previous.resetsAt < iso(snapshot.resetsAt)
        ? new Date(previous.resetsAt)
        : previousSnapshot?.profile === "work" &&
            previousSnapshot.resetsAt.getTime() === snapshot.resetsAt.getTime()
          ? previousSnapshot.periodStart
          : addUtcCalendarMonths(snapshot.resetsAt, -1);
    return { ...snapshot, periodStart };
  }

  private inferEarlyReset(
    previousRow: ReturnType<StateStore["latestSnapshot"]>,
    current: QuotaSnapshot,
  ): boolean {
    if (!previousRow || previousRow.resetsAt !== iso(current.resetsAt))
      return false;
    if (current.profile === "personal" && previousRow.usedPercent)
      return new Decimal(previousRow.usedPercent)
        .minus(current.usedPercent)
        .greaterThanOrEqual(
          this.config.resetDetection.weeklyUsedPercentDropThreshold,
        );
    if (current.profile === "work" && previousRow.usedValue)
      return new Decimal(previousRow.usedValue)
        .minus(current.usedCredits)
        .greaterThanOrEqual(
          this.config.resetDetection.businessUsedCreditsDropThreshold,
        );
    return false;
  }

  private makeEpochId(snapshot: QuotaSnapshot, observedStart?: Date): string {
    if (snapshot.profile === "personal")
      return [
        snapshot.profile,
        snapshot.limitId ?? "codex",
        snapshot.windowDurationSeconds,
        snapshot.windowStart.toISOString(),
        snapshot.resetsAt.toISOString(),
        observedStart?.toISOString() ?? "",
      ].join("|");
    return [
      snapshot.profile,
      snapshot.limitId,
      snapshot.planType ?? "",
      snapshot.periodStart.toISOString(),
      snapshot.resetsAt.toISOString(),
      observedStart?.toISOString() ?? "",
    ].join("|");
  }

  async extend(count: number): Promise<{
    override: ReturnType<StateStore["getOverride"]>;
    result?: PacingResult;
  }> {
    const envelope = await this.evaluate();
    if (!envelope.result)
      throw new Error(envelope.missing?.reason ?? "No usable quota data");
    const result = envelope.result;
    const override =
      result.profile === "personal"
        ? this.state.updateExtension(
            result.profile,
            result.strategy,
            result.epochId,
            count * this.config.personal.extensionStepSeconds,
            0,
          )
        : this.state.updateExtension(
            result.profile,
            result.strategy,
            result.epochId,
            0,
            count * this.config.work.extensionStepWorkdays,
          );
    return { override, result };
  }
  async unlock(): Promise<{
    override: ReturnType<StateStore["getOverride"]>;
    result?: PacingResult;
  }> {
    const envelope = await this.evaluate();
    if (!envelope.result)
      throw new Error(envelope.missing?.reason ?? "No usable quota data");
    const result = envelope.result;
    return {
      override: this.state.setUnlocked(
        result.profile,
        result.strategy,
        result.epochId,
        true,
      ),
      result,
    };
  }
}
