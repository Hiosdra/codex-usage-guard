import type { Decimal } from "./decimal.ts";

export interface PacingStrategy<TInput, TResult> {
  evaluate(input: TInput): TResult;
}

export type Profile = "personal" | "work";
export type ActiveProfile = Profile | "auto";
export type Decision = "allow" | "warn" | "block" | "missing" | "error";
export type MissingDataAction = "allow" | "warn" | "block";

export interface WeeklyLimitSnapshot {
  profile: "personal";
  strategy: "weekly_percentage_pacing";
  usedPercent: Decimal;
  windowDurationSeconds: number;
  windowStart: Date;
  resetsAt: Date;
  observedAt: Date;
  planType?: string;
  limitId?: string;
  serverLimitReached: boolean;
  source: string;
}

export interface WorkCreditsSnapshot {
  profile: "work";
  strategy: "monthly_ai_credits_workdays";
  limitId: string;
  planType?: string;
  limitCredits: Decimal;
  usedCredits: Decimal;
  remainingPercent?: Decimal;
  resetsAt: Date;
  periodStart: Date;
  observedAt: Date;
  serverLimitReached: boolean;
  unlimited: boolean;
  source: string;
}

export type QuotaSnapshot = WeeklyLimitSnapshot | WorkCreditsSnapshot;

export interface OverrideState {
  profile: Profile;
  strategy: QuotaSnapshot["strategy"];
  epochId: string;
  temporaryExtensionSeconds: number;
  temporaryExtensionWorkdays: number;
  unlockedUntilReset: boolean;
  updatedAt: Date;
}

export interface PacingBaseResult {
  decision: Decision;
  profile: Profile;
  strategy: QuotaSnapshot["strategy"];
  source: string;
  epochId: string;
  unlockedUntilReset: boolean;
  serverLimitReached: boolean;
  planType?: string;
  limitId?: string;
  reason?: string;
}

export interface WeeklyPacingResult extends PacingBaseResult {
  profile: "personal";
  strategy: "weekly_percentage_pacing";
  usedPercent: Decimal;
  scheduledPercent: Decimal;
  aheadSeconds: number;
  baseLeadSeconds: number;
  temporaryExtensionSeconds: number;
  effectiveLeadSeconds: number;
  windowStart: Date;
  periodEnd: Date;
  estimatedUnlock?: Date;
}

export interface WorkdayPacingResult extends PacingBaseResult {
  profile: "work";
  strategy: "monthly_ai_credits_workdays";
  limitCredits: Decimal;
  usedCredits: Decimal;
  remainingPercent?: Decimal;
  scheduledCredits: Decimal;
  aheadCredits: Decimal;
  aheadWorkdays: Decimal;
  totalWorkdays: number;
  startedWorkdays: number;
  dailyBudget: Decimal;
  baseLeadWorkdays: number;
  temporaryExtensionWorkdays: number;
  effectiveLeadWorkdays: number;
  periodStart: Date;
  periodEnd: Date;
  nextBudgetRelease?: Date;
  estimatedUnlock?: Date;
  unlimited: boolean;
}

export type PacingResult = WeeklyPacingResult | WorkdayPacingResult;

export interface ProfileSelection {
  active: Profile | undefined;
  configured: ActiveProfile;
  reason: string;
  personalAvailable: boolean;
  workAvailable: boolean;
  planType?: string;
}
