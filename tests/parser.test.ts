import { describe, expect, test } from "bun:test";
import personalFixture from "../fixtures/rate-limits-personal.json" with { type: "json" };
import workFixture from "../fixtures/rate-limits-work.json" with { type: "json" };
import {
  chooseProfile,
  isBusinessPlan,
  parseRateLimits,
} from "../src/codex/rate-limits-parser.ts";

describe("rate-limit parser", () => {
  test("normalizes synthetic weekly response", () => {
    const parsed = parseRateLimits(
      personalFixture,
      new Date("2026-09-27T00:00:00Z"),
    );
    expect(parsed.personal?.usedPercent.toString()).toBe("40");
    expect(parsed.personal?.windowDurationSeconds).toBe(604800);
    expect(chooseProfile(parsed, "auto").active).toBe("personal");
  });
  test("keeps Business credits as Decimal strings and chooses work", () => {
    const parsed = parseRateLimits(
      workFixture,
      new Date("2026-10-04T00:00:00Z"),
    );
    expect(parsed.work?.limitCredits.toString()).toBe("1000");
    expect(parsed.work?.usedCredits.toString()).toBe("420.5");
    expect(parsed.work?.remainingPercent?.toString()).toBe("58");
    expect(chooseProfile(parsed, "auto").active).toBe("work");
  });
  test("falls back to a valid rateLimitsByLimitId entry", () => {
    const parsed = parseRateLimits({
      result: {
        rateLimits: { primary: null, secondary: null },
        rateLimitsByLimitId: {
          codex: {
            limitId: "codex",
            planType: "enterprise",
            credits: { unlimited: false },
            individualLimit: {
              limit: "1000",
              used: "420.5",
              remainingPercent: 58,
              resetsAt: 1790812800,
            },
          },
        },
      },
    });
    expect(parsed.work?.planType).toBe("enterprise");
    expect(parsed.work?.usedCredits.toString()).toBe("420.5");
  });
  test("rejects a five-hour window as weekly", () => {
    expect(() =>
      parseRateLimits({
        result: {
          rateLimits: {
            secondary: {
              usedPercent: 40,
              windowDurationMins: 300,
              resetsAt: 1790812800,
            },
          },
        },
      }),
    ).toThrow();
  });
  test("manual profile selection wins or reports missing data", () => {
    const parsed = parseRateLimits(workFixture);
    expect(chooseProfile(parsed, "personal").active).toBeUndefined();
    expect(chooseProfile(parsed, "work").active).toBe("work");
  });

  test("normalizes scalar identifiers and handles invalid candidates", () => {
    const parsed = parseRateLimits({
      result: {
        rateLimits: {
          planType: 7,
          limitId: 42,
          individualLimit: {
            limit: "100",
            used: "5",
            resetsAt: 1790812800,
          },
        },
      },
    });
    expect(parsed.planType).toBe("7");
    expect(parsed.work?.limitId).toBe("42");
    expect(isBusinessPlan(undefined)).toBe(false);
    expect(isBusinessPlan("Personal")).toBe(false);

    expect(() =>
      parseRateLimits({
        result: {
          rateLimits: {
            individualLimit: {
              limit: {},
              used: "5",
              resetsAt: 1790812800,
            },
          },
        },
      }),
    ).toThrow();
    expect(() =>
      parseRateLimits({
        result: {
          rateLimits: {
            secondary: {
              usedPercent: 5,
              windowDurationMins: 10080,
              resetsAt: 1e20,
            },
          },
        },
      }),
    ).toThrow();
  });

  test("reports explicit profile reasons when the parsed shape is absent", () => {
    const parsed = {
      source: "synthetic",
      rawShape: "app_server" as const,
    };
    expect(chooseProfile(parsed, "auto")).toEqual({
      active: undefined,
      reason: "neither supported quota shape was available",
    });
    expect(chooseProfile(parsed, "personal").reason).toContain(
      "no weekly window",
    );
    expect(chooseProfile(parsed, "work").reason).toContain(
      "no valid individualLimit",
    );
  });

  test("uses work data in auto mode when plan metadata is unavailable", () => {
    const parsed = parseRateLimits(workFixture);
    const withoutPlan = { ...parsed };
    delete withoutPlan.planType;
    expect(chooseProfile(withoutPlan, "auto")).toEqual({
      active: "work",
      reason:
        "auto selected the valid individualLimit; no reliable weekly-only profile was preferred",
    });
  });
});
