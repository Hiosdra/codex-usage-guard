import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main, run } from "../src/cli.ts";

let root: string | undefined;
const envNames = [
  "PATH",
  "CODEX_USAGE_GUARD_CONFIG",
  "CODEX_USAGE_GUARD_STATE",
  "CODEX_USAGE_GUARD_CACHE",
  "CODEX_USAGE_GUARD_LOG",
  "CODEX_USAGE_GUARD_CODEX_COMMAND",
  "CODEX_USAGE_GUARD_HOOKS_PATH",
  "CODEX_HOME",
];
const originalEnv = new Map(envNames.map((name) => [name, process.env[name]]));

afterEach(async () => {
  for (const name of envNames) {
    const value = originalEnv.get(name);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

async function setupCli(): Promise<{
  command: string;
  config: string;
  state: string;
  hooks: string;
}> {
  root = await mkdtemp(join(tmpdir(), "cug-cli-"));
  const bin = join(root, "bin");
  await mkdir(bin);
  const codex = join(bin, "codex");
  await Bun.write(
    codex,
    `#!/usr/bin/env bun
if (process.argv[2] === "--version") {
  console.log("codex fake 0.1");
  process.exit(0);
}
console.log(JSON.stringify({ id: 1, result: {} }));
console.log(JSON.stringify({ id: 2, result: { rateLimits: { secondary: {
    planType: "pro", usedPercent: 0, windowDurationMins: 10080, resetsAt: 1790812800,
} } } }));
`,
  );
  await chmod(codex, 0o700);
  const config = join(root, "config.toml");
  const state = join(root, "state.sqlite");
  const hooks = join(root, "hooks.json");
  process.env.PATH = `${bin}:${originalEnv.get("PATH") ?? ""}`;
  process.env.CODEX_USAGE_GUARD_CONFIG = config;
  process.env.CODEX_USAGE_GUARD_STATE = state;
  process.env.CODEX_USAGE_GUARD_CACHE = join(root, "cache");
  process.env.CODEX_USAGE_GUARD_LOG = join(root, "logs");
  process.env.CODEX_USAGE_GUARD_CODEX_COMMAND = codex;
  process.env.CODEX_USAGE_GUARD_HOOKS_PATH = hooks;
  process.env.CODEX_HOME = join(root, "codex");
  await Bun.write(
    config,
    `active_profile = "personal"
[data]
fallback_to_session_files = false
cache_ttl = "0s"
maximum_stale_age = "1h"
app_server_timeout = "1s"
[reset_detection]
confirmation_reads = 1
confirmation_interval = "0s"
`,
  );
  return { command: codex, config, state, hooks };
}

describe("CLI", () => {
  test("supports inspection, controls, hook installation, and diagnostics", async () => {
    const paths = await setupCli();
    expect(await main(["--help"])).toBe(0);
    expect(await main(["config-path"])).toBe(0);
    expect(await main(["state-path"])).toBe(0);

    expect(await main(["check", "--json"])).toBe(0);
    expect(await main(["check"])).toBe(0);
    const blockCommand = join(root!, "bin", "codex-block");
    await Bun.write(
      blockCommand,
      `#!/usr/bin/env bun
console.log(JSON.stringify({ id: 1, result: {} }));
console.log(JSON.stringify({ id: 2, result: { rateLimits: { secondary: {
  planType: "pro", usedPercent: 40, windowDurationMins: 10080, resetsAt: 1790812800,
} } } }));
`,
    );
    await chmod(blockCommand, 0o700);
    process.env.CODEX_USAGE_GUARD_CODEX_COMMAND = blockCommand;
    expect(await main(["check"])).toBe(20);
    process.env.CODEX_USAGE_GUARD_CODEX_COMMAND = paths.command;
    expect(await main(["status"])).toBe(0);
    expect(await main(["profile"])).toBe(0);
    expect(await main(["extend", "2"])).toBe(0);
    expect(await main(["unlock"])).toBe(0);
    expect(await main(["reset-overrides"])).toBe(0);
    expect(
      await main(
        ["hook"],
        JSON.stringify({ hook_event_name: "UserPromptSubmit" }),
      ),
    ).toBe(0);

    expect(await main(["install-hook"])).toBe(0);
    expect(await main(["install-hook"])).toBe(0);
    expect(await main(["doctor"])).toBe(0);
    process.env.CODEX_USAGE_GUARD_CODEX_COMMAND = join(root!, "missing-codex");
    expect(await main(["doctor"])).toBe(50);
    process.env.CODEX_USAGE_GUARD_CODEX_COMMAND = "";
    expect(await main(["doctor"])).toBe(50);
    const cacheFile = join(root!, "cache-file");
    await Bun.write(cacheFile, "not-a-directory");
    process.env.CODEX_USAGE_GUARD_CODEX_COMMAND = paths.command;
    process.env.CODEX_USAGE_GUARD_CACHE = cacheFile;
    expect(await main(["doctor"])).toBe(50);
    process.env.CODEX_USAGE_GUARD_CACHE = join(root!, "cache");
    const stateDirectory = join(root!, "state-directory");
    await mkdir(stateDirectory);
    process.env.CODEX_USAGE_GUARD_STATE = stateDirectory;
    expect(await main(["doctor"])).toBe(50);
    process.env.CODEX_USAGE_GUARD_STATE = paths.state;
    expect(await main(["uninstall-hook"])).toBe(0);

    await Bun.write(paths.config, 'active_profile = "work"\n');
    expect(await main(["profile"])).toBe(30);
    expect(await main(["profile", "auto"])).toBe(0);
    expect(await main(["profile", "personal"])).toBe(0);
  });

  test("returns integration and argument errors with useful exit codes", async () => {
    const paths = await setupCli();
    const missingCommand = join(root!, "bin", "codex-missing");
    await Bun.write(
      missingCommand,
      `#!/usr/bin/env bun
console.log(JSON.stringify({ id: 1, result: {} }));
console.log(JSON.stringify({ id: 2, result: {} }));
`,
    );
    await chmod(missingCommand, 0o700);
    process.env.CODEX_USAGE_GUARD_CODEX_COMMAND = missingCommand;
    await Bun.write(
      paths.config,
      `active_profile = "personal"
[data]
fallback_to_session_files = false
cache_ttl = "0s"
missing_data_action = "warn"
`,
    );
    expect(await main(["check", "--json"])).toBe(50);
    expect(await main(["status"])).toBe(50);
    expect(await run(["extend", "0"])).toBe(40);
    expect(await run(["unknown-command"])).toBe(40);
  });
});
