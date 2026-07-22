import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHook } from "../src/codex/hook-adapter.ts";

let root: string | undefined;
const originalEnv = new Map(
  [
    "PATH",
    "CODEX_USAGE_GUARD_CONFIG",
    "CODEX_USAGE_GUARD_STATE",
    "CODEX_USAGE_GUARD_CACHE",
    "CODEX_USAGE_GUARD_LOG",
    "CODEX_USAGE_GUARD_CODEX_COMMAND",
    "CODEX_HOME",
  ].map((name) => [name, process.env[name]]),
);

afterEach(async () => {
  for (const [name, value] of originalEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe("hook adapter", () => {
  test("ignores unrelated hook events without touching quota data", async () => {
    const result = await runHook(
      JSON.stringify({ hook_event_name: "SessionStart", prompt: "synthetic" }),
    );
    expect(result).toEqual({ exitCode: 0 });
  });

  test("returns a block response for malformed hook JSON", async () => {
    const result = await runHook("not-json");
    expect(result.exitCode).toBe(0);
    expect(result.output?.decision).toBe("block");
    expect(result.output?.reason).toContain("malformed hook JSON");
  });

  test("maps allow, warning, block, and missing-data hook decisions", async () => {
    root = await mkdtemp(join(tmpdir(), "cug-hook-adapter-"));
    const bin = join(root, "bin");
    await mkdir(bin);
    const writeCodex = async (
      name: string,
      response: string,
    ): Promise<string> => {
      const path = join(bin, name);
      await Bun.write(
        path,
        `#!/usr/bin/env bun
console.log(JSON.stringify({ id: 1, result: {} }));
console.log(${JSON.stringify(response)});
`,
      );
      await chmod(path, 0o700);
      return path;
    };
    const commandFor = async (mode: "allow" | "warn" | "block" | "missing") =>
      writeCodex(
        `codex-${mode}`,
        mode === "missing"
          ? JSON.stringify({ id: 2, result: {} })
          : JSON.stringify({
              id: 2,
              result: {
                rateLimits: {
                  secondary: {
                    usedPercent:
                      mode === "block" ? 40 : mode === "warn" ? 1 : 0,
                    windowDurationMins: 10080,
                    resetsAt: 1790812800,
                  },
                },
              },
            }),
      );
    const originalPath = process.env.PATH ?? "";
    process.env.PATH = `${bin}:${originalPath}`;
    process.env.CODEX_USAGE_GUARD_CONFIG = join(root, "config.toml");
    process.env.CODEX_USAGE_GUARD_STATE = join(root, "state.sqlite");
    process.env.CODEX_USAGE_GUARD_CACHE = join(root, "cache");
    process.env.CODEX_USAGE_GUARD_LOG = join(root, "logs");
    process.env.CODEX_HOME = join(root, "codex");
    process.env.CODEX_USAGE_GUARD_CODEX_COMMAND = join(bin, "codex");
    await Bun.write(
      process.env.CODEX_USAGE_GUARD_CONFIG,
      `active_profile = "personal"
[data]
fallback_to_session_files = false
cache_ttl = "0s"
[reset_detection]
confirmation_reads = 1
confirmation_interval = "0s"
`,
    );

    process.env.CODEX_USAGE_GUARD_CODEX_COMMAND = await commandFor("allow");
    process.env.CODEX_USAGE_GUARD_STATE = join(root, "state-allow.sqlite");
    expect(
      await runHook(JSON.stringify({ hook_event_name: "UserPromptSubmit" })),
    ).toEqual({
      exitCode: 0,
    });
    process.env.CODEX_USAGE_GUARD_CODEX_COMMAND = await commandFor("warn");
    process.env.CODEX_USAGE_GUARD_STATE = join(root, "state-warn.sqlite");
    expect((await runHook("{}")).output?.systemMessage).toContain(
      "weekly usage warning",
    );
    process.env.CODEX_USAGE_GUARD_CODEX_COMMAND = await commandFor("block");
    process.env.CODEX_USAGE_GUARD_STATE = join(root, "state-block.sqlite");
    expect((await runHook("{}")).output?.decision).toBe("block");

    process.env.CODEX_USAGE_GUARD_CODEX_COMMAND = await commandFor("missing");
    for (const action of ["allow", "warn", "block"] as const) {
      process.env.CODEX_USAGE_GUARD_STATE = join(
        root,
        `state-missing-${action}.sqlite`,
      );
      await Bun.write(
        process.env.CODEX_USAGE_GUARD_CONFIG,
        `active_profile = "personal"
[data]
fallback_to_session_files = false
cache_ttl = "0s"
missing_data_action = "${action}"
`,
      );
      const result = await runHook("{}");
      if (action === "block") expect(result.output?.decision).toBe("block");
      else if (action === "warn")
        expect(result.output?.systemMessage).toContain("could not verify");
      else expect(result.output).toBeUndefined();
    }
  });
});
