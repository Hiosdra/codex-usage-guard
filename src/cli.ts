#!/usr/bin/env bun
import { access, constants, mkdir } from "node:fs/promises";
import { loadConfig, resolvePaths, setActiveProfile } from "./config/config.ts";
import { StateStore } from "./persistence/sqlite.ts";
import { UsageGuard } from "./app/guard.ts";
import { blockMessage, resultJson, statusText } from "./display/display.ts";
import { runHook } from "./codex/hook-adapter.ts";
import { CodexAppServerClient } from "./codex/app-server-client.ts";
import { chooseProfile, parseRateLimits } from "./codex/rate-limits-parser.ts";
import {
  hookIsInstalled,
  hooksPath,
  installHook,
  uninstallHook,
} from "./platform/hook-install.ts";
import type { ActiveProfile, Decision } from "./domain/types.ts";

const EXIT = {
  allow: 0,
  warn: 10,
  block: 20,
  missing: 30,
  error: 40,
  integration: 50,
} as const;

function help(): string {
  return `codex-usage-guard — local Codex quota pacing\n\nUsage:\n  codex-usage-guard status\n  codex-usage-guard check [--json]\n  codex-usage-guard extend [count]\n  codex-usage-guard unlock [--until-reset]\n  codex-usage-guard reset-overrides\n  codex-usage-guard install-hook\n  codex-usage-guard uninstall-hook\n  codex-usage-guard doctor\n  codex-usage-guard config-path\n  codex-usage-guard state-path\n  codex-usage-guard profile [auto|personal|work]\n\nThe hidden 'hook' command is invoked by Codex's UserPromptSubmit hook.`;
}
async function withGuard<T>(
  fn: (
    guard: UsageGuard,
    paths: ReturnType<typeof resolvePaths>,
    config: Awaited<ReturnType<typeof loadConfig>>,
    state: StateStore,
  ) => Promise<T>,
): Promise<T> {
  const paths = resolvePaths();
  const config = await loadConfig(paths);
  const state = new StateStore(paths.state);
  try {
    return await fn(new UsageGuard(config, paths, state), paths, config, state);
  } finally {
    state.db.close();
  }
}
function decisionExit(decision: Decision): number {
  return EXIT[decision];
}
async function runCheck(json: boolean): Promise<number> {
  return withGuard(async (guard, _paths, config) => {
    const envelope = await guard.evaluate();
    if (json) {
      if (envelope.result)
        console.log(
          JSON.stringify({
            ...resultJson(envelope.result),
            profileReason: envelope.profileReason,
            stale: envelope.stale,
            observedAt: envelope.observedAt?.toISOString(),
          }),
        );
      else
        console.log(
          JSON.stringify({
            decision: envelope.missing?.decision ?? "missing",
            profile: envelope.profile ?? null,
            strategy: null,
            reason: envelope.missing?.reason ?? envelope.profileReason,
            source: envelope.dataSource ?? "none",
            stale: envelope.stale,
          }),
        );
    } else if (envelope.result) {
      const message =
        envelope.result.decision === "block"
          ? blockMessage(envelope.result, config)
          : statusText(envelope, config);
      console.log(message);
    } else console.error(statusText(envelope, config));
    if (!envelope.result)
      return envelope.failure ? EXIT.integration : EXIT.missing;
    return decisionExit(envelope.result.decision);
  });
}

async function doctor(): Promise<number> {
  const paths = resolvePaths();
  const config = await loadConfig(paths);
  const checks: Array<[string, boolean, string]> = [];
  const codexPath =
    process.env.CODEX_USAGE_GUARD_CODEX_COMMAND ?? Bun.which("codex");
  checks.push(["codex in PATH", Boolean(codexPath), codexPath ?? "not found"]);
  if (codexPath) {
    try {
      const proc = Bun.spawn([codexPath, "--version"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const version = await new Response(proc.stdout).text();
      checks.push(["Codex version", true, version.trim()]);
    } catch (error) {
      checks.push(["Codex version", false, String(error)]);
    }
    const appServer = new CodexAppServerClient({
      command: codexPath,
      timeoutMs: config.data.appServerTimeoutSeconds * 1000,
    });
    try {
      await appServer.handshake();
      checks.push(["App Server handshake", true, "ok"]);
    } catch (error) {
      checks.push(["App Server handshake", false, String(error)]);
    }
    try {
      const parsed = parseRateLimits(await appServer.readRateLimits());
      const selected = chooseProfile(parsed, config.activeProfile);
      checks.push(["account/rateLimits/read", true, "validated"]);
      checks.push([
        "Profile detection",
        Boolean(selected.active),
        selected.reason,
      ]);
    } catch (error) {
      checks.push(["account/rateLimits/read", false, String(error)]);
      checks.push(["Profile detection", false, "rate-limit data unavailable"]);
    }
  } else {
    checks.push(["App Server handshake", false, "codex is unavailable"]);
    checks.push(["account/rateLimits/read", false, "codex is unavailable"]);
    checks.push(["Profile detection", false, "rate-limit data unavailable"]);
  }
  try {
    await mkdir(paths.cache, { recursive: true });
    await access(paths.cache, constants.W_OK);
    checks.push(["Cache writable", true, paths.cache]);
  } catch {
    checks.push(["Cache writable", false, paths.cache]);
  }
  try {
    const state = new StateStore(paths.state);
    const journal = state.db
      .query<{ journal_mode: string }, []>("PRAGMA journal_mode")
      .get()?.journal_mode;
    state.db.close();
    checks.push(["SQLite + WAL", journal === "wal", journal ?? "unknown"]);
  } catch (error) {
    checks.push(["SQLite + WAL", false, String(error)]);
  }
  checks.push([
    "Timezone",
    true,
    `${config.work.timezone} / ${config.display.timezone}`,
  ]);
  checks.push(["Hook installed", await hookIsInstalled(), hooksPath()]);
  for (const [name, ok, details] of checks)
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}: ${details}`);
  return checks.every((item) => item[1]) ? 0 : 50;
}

export async function main(
  args: string[],
  hookInput?: string,
): Promise<number> {
  const command = args[0] ?? "status";
  if (command === "--help" || command === "-h" || command === "help") {
    console.log(help());
    return 0;
  }
  if (command === "hook") {
    const result = await runHook(hookInput ?? (await Bun.stdin.text()));
    if (result.output) console.log(JSON.stringify(result.output));
    return result.exitCode;
  }
  if (command === "config-path") {
    console.log(resolvePaths().config);
    return 0;
  }
  if (command === "state-path") {
    console.log(resolvePaths().state);
    return 0;
  }
  if (command === "install-hook") {
    const result = await installHook();
    if (!(await hookIsInstalled()))
      throw new Error("Hook installation validation failed");
    console.log(
      `${result.changed ? "Installed" : "Already installed"}: ${result.path}`,
    );
    if (result.backup) console.log(`Backup: ${result.backup}`);
    console.log(`Command: ${result.command}`);
    return 0;
  }
  if (command === "uninstall-hook") {
    const result = await uninstallHook();
    console.log(
      `${result.changed ? "Removed" : "Not installed"}: ${result.path}`,
    );
    if (result.backup) console.log(`Backup: ${result.backup}`);
    return 0;
  }
  if (command === "doctor") return doctor();
  if (command === "profile") {
    const selected = args[1];
    if (selected) {
      if (selected !== "auto" && selected !== "personal" && selected !== "work")
        throw new Error("profile must be auto, personal, or work");
      await setActiveProfile(selected as ActiveProfile);
      console.log(`active_profile = ${selected}`);
      return 0;
    }
    return withGuard(async (guard) => {
      const envelope = await guard.evaluate();
      console.log(
        `Detected plan:             ${envelope.result?.planType ?? (envelope.result?.profile === "work" ? "Business/Enterprise" : envelope.result?.profile === "personal" ? "Plus/Pro" : "unknown")}`,
      );
      console.log(
        `Selected strategy:         ${envelope.result?.strategy ?? "none"}`,
      );
      console.log(`Reason:                    ${envelope.profileReason}`);
      console.log(
        `Source:                    ${envelope.dataSource ?? "none"}`,
      );
      return envelope.result ? 0 : 30;
    });
  }
  if (command === "reset-overrides") {
    const paths = resolvePaths();
    const state = new StateStore(paths.state);
    try {
      state.resetOverrides();
      console.log("Temporary extensions and unlock overrides were reset.");
      return 0;
    } finally {
      state.db.close();
    }
  }
  if (command === "check") return runCheck(args.includes("--json"));
  if (command === "status")
    return withGuard(async (guard, _paths, config) => {
      const envelope = await guard.evaluate();
      console.log(statusText(envelope, config));
      return envelope.result
        ? decisionExit(envelope.result.decision)
        : envelope.failure
          ? EXIT.integration
          : EXIT.missing;
    });
  if (command === "extend") {
    const count = args[1] ? Number(args[1]) : 1;
    if (!Number.isInteger(count) || count < 1)
      throw new Error("extend count must be a positive integer");
    return withGuard(async (guard) => {
      const result = await guard.extend(count);
      console.log(
        `Added ${result.result?.profile === "work" ? `${count} workday(s)` : `${count * 24}h`} to the allowed lead.`,
      );
      console.log(
        `Effective override: ${result.override.temporaryExtensionSeconds ? `${result.override.temporaryExtensionSeconds / 3600}h` : `${result.override.temporaryExtensionWorkdays} workday(s)`}`,
      );
      return 0;
    });
  }
  if (command === "unlock")
    return withGuard(async (guard) => {
      const result = await guard.unlock();
      console.log(
        `Blocking disabled until quota reset for ${result.override.profile} (${result.override.strategy}). Warnings remain enabled.`,
      );
      return 0;
    });
  throw new Error(`Unknown command: ${command}\n\n${help()}`);
}

export async function run(args: string[]): Promise<number> {
  try {
    return await main(args);
  } catch (error) {
    console.error(
      `codex-usage-guard: ${error instanceof Error ? error.message : String(error)}`,
    );
    return error instanceof Error &&
      /Codex app-server|account\/rateLimits/.test(error.message)
      ? EXIT.integration
      : EXIT.error;
  }
}

if (import.meta.main) process.exitCode = await run(process.argv.slice(2));
