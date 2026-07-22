import { loadConfig, resolvePaths } from "../config/config.ts";
import { StateStore } from "../persistence/sqlite.ts";
import { UsageGuard } from "../app/guard.ts";
import { blockMessage, warningMessage } from "../display/display.ts";

export interface HookPayload {
  hook_event_name?: string;
  prompt?: string;
  [key: string]: unknown;
}
export interface HookOutput {
  decision?: "block";
  reason?: string;
  systemMessage?: string;
}

export async function runHook(
  inputText: string,
): Promise<{ output?: HookOutput; exitCode: number }> {
  let payload: HookPayload;
  try {
    payload = JSON.parse(inputText || "{}") as HookPayload;
  } catch {
    return {
      output: {
        decision: "block",
        reason: "codex-usage-guard received malformed hook JSON",
      },
      exitCode: 0,
    };
  }
  // The prompt is deliberately not logged or echoed.  The guard only needs it
  // to be invoked at the correct lifecycle boundary.
  if (payload.hook_event_name && payload.hook_event_name !== "UserPromptSubmit")
    return { exitCode: 0 };
  const paths = resolvePaths();
  const config = await loadConfig(paths);
  const state = new StateStore(paths.state);
  try {
    const envelope = await new UsageGuard(config, paths, state).evaluate();
    if (envelope.missing) {
      if (envelope.missing.decision === "block")
        return {
          output: {
            decision: "block",
            reason: `Codex Usage Guard could not verify the quota: ${envelope.missing.reason}`,
          },
          exitCode: 0,
        };
      if (envelope.missing.decision === "missing")
        return {
          output: {
            systemMessage: `Codex Usage Guard could not verify the quota. The prompt was allowed.\n\nReason: ${envelope.missing.reason}`,
          },
          exitCode: 0,
        };
      return { exitCode: 0 };
    }
    const result = envelope.result!;
    if (result.decision === "block")
      return {
        output: { decision: "block", reason: blockMessage(result, config) },
        exitCode: 0,
      };
    if (result.decision === "warn")
      return {
        output: { systemMessage: warningMessage(result, config) },
        exitCode: 0,
      };
    return { exitCode: 0 };
  } finally {
    state.db.close();
  }
}
