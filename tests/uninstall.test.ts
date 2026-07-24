import { afterEach, describe, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { main } from "../src/cli.ts";
import {
  purgeData,
  uninstallHomebrewFormula,
  uninstallSelf,
} from "../src/platform/uninstall.ts";
import type { Paths } from "../src/config/config.ts";
import { withTestIsolation } from "./test-isolation.ts";

let root: string | undefined;

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe("standalone uninstall", () => {
  test("removes the executable and the cug symlink", async () => {
    root = await mkdtemp(join(tmpdir(), "cug-uninstall-"));
    const executable = join(root, "codex-usage-guard");
    const alias = join(root, "cug");
    await writeFile(executable, "standalone binary");
    await chmod(executable, 0o755);
    await symlink("codex-usage-guard", alias);

    const result = await uninstallSelf({
      executablePath: executable,
      invokedPath: alias,
    });

    expect(result.homebrew).toBe(false);
    expect(result.executable).toBe(executable);
    expect(result.aliases).toEqual([alias]);
    expect(await Bun.file(executable).exists()).toBe(false);
    expect(await Bun.file(alias).exists()).toBe(false);
  });

  test("does not remove a Homebrew-managed executable", async () => {
    root = await mkdtemp(join(tmpdir(), "cug-uninstall-brew-"));
    const executable = join(
      root,
      "homebrew",
      "Cellar",
      "codex-usage-guard",
      "0.2.2",
      "bin",
      "codex-usage-guard",
    );
    const alias = join(dirname(executable), "cug");
    await mkdir(dirname(executable), { recursive: true });
    await Bun.write(executable, "homebrew binary");
    await symlink("codex-usage-guard", alias);

    const result = await uninstallSelf({ executablePath: executable });

    expect(result.homebrew).toBe(true);
    expect(await Bun.file(executable).exists()).toBe(true);
    expect(await Bun.file(alias).exists()).toBe(true);
  });

  test("invokes Homebrew to remove the formula", async () => {
    root = await mkdtemp(join(tmpdir(), "cug-uninstall-brew-command-"));
    const command = join(root, "brew");
    const marker = join(root, "arguments");
    await Bun.write(
      command,
      `#!/usr/bin/env bun
await Bun.write(${JSON.stringify(marker)}, process.argv.slice(2).join(" "));
`,
    );
    await chmod(command, 0o700);

    await expect(uninstallHomebrewFormula(command)).resolves.toEqual({
      command,
      removed: true,
    });
    expect(await Bun.file(marker).text()).toBe(
      "uninstall --formula codex-usage-guard",
    );
  });

  test("CLI removes the hook before delegating a Homebrew uninstall", () =>
    withTestIsolation(
      [
        "PATH",
        "CODEX_USAGE_GUARD_HOOKS_PATH",
        "CODEX_USAGE_GUARD_BREW_COMMAND",
      ],
      async () => {
        root = await mkdtemp(join(tmpdir(), "cug-cli-uninstall-brew-"));
        const executable = join(
          root,
          "Cellar",
          "codex-usage-guard",
          "0.2.2",
          "bin",
          "codex-usage-guard",
        );
        const brew = join(root, "brew");
        const marker = join(root, "brew-arguments");
        const hooks = join(root, "hooks.json");
        await mkdir(dirname(executable), { recursive: true });
        await Bun.write(executable, "homebrew binary");
        await Bun.write(
          brew,
          `#!/usr/bin/env bun
await Bun.write(${JSON.stringify(marker)}, process.argv.slice(2).join(" "));
`,
        );
        await chmod(executable, 0o755);
        await chmod(brew, 0o700);

        const originalExecPath = process.execPath;
        const originalArgv0 = process.argv0;
        try {
          Object.defineProperty(process, "execPath", {
            configurable: true,
            value: executable,
          });
          process.argv0 = join(root, "cug");
          process.env.PATH = `${root}:${process.env.PATH ?? ""}`;
          process.env.CODEX_USAGE_GUARD_HOOKS_PATH = hooks;
          process.env.CODEX_USAGE_GUARD_BREW_COMMAND = brew;

          expect(await main(["uninstall"])).toBe(0);
          expect(await Bun.file(marker).text()).toBe(
            "uninstall --formula codex-usage-guard",
          );
          expect(await Bun.file(executable).exists()).toBe(true);
        } finally {
          Object.defineProperty(process, "execPath", {
            configurable: true,
            value: originalExecPath,
          });
          process.argv0 = originalArgv0;
        }
      },
    ));

  test("reports an unavailable or failed Homebrew command", async () => {
    await expect(uninstallHomebrewFormula("")).resolves.toEqual({
      removed: false,
    });

    root = await mkdtemp(join(tmpdir(), "cug-uninstall-brew-failure-"));
    const command = join(root, "brew");
    await Bun.write(command, "#!/usr/bin/env bun\nprocess.exit(7);\n");
    await chmod(command, 0o700);

    await expect(uninstallHomebrewFormula(command)).rejects.toThrow(
      "exit code 7",
    );
  });

  test("purges only the application's files and directories", async () => {
    root = await mkdtemp(join(tmpdir(), "cug-purge-"));
    const paths: Paths = {
      config: join(root, "settings.ini"),
      state: join(root, "usage.db"),
      cache: join(root, "cache-dir"),
      logs: join(root, "logs-dir"),
      codexHome: join(root, "codex"),
    };
    await writeFile(paths.config, "config");
    await writeFile(paths.state, "state");
    await writeFile(`${paths.state}-wal`, "wal");
    await writeFile(`${paths.state}-shm`, "shm");
    await mkdir(paths.cache, { recursive: true });
    await mkdir(paths.logs, { recursive: true });
    await Bun.write(join(paths.cache, "cache.json"), "cache");
    await Bun.write(join(paths.logs, "guard.log"), "log");
    await writeFile(join(root, "keep.txt"), "keep");

    const removed = await purgeData(paths);

    expect(removed).toContain(paths.config);
    expect(removed).toContain(paths.state);
    expect(await Bun.file(paths.config).exists()).toBe(false);
    expect(await Bun.file(paths.state).exists()).toBe(false);
    expect(await Bun.file(`${paths.state}-wal`).exists()).toBe(false);
    expect(await Bun.file(`${paths.state}-shm`).exists()).toBe(false);
    expect(await Bun.file(paths.cache).exists()).toBe(false);
    expect(await Bun.file(paths.logs).exists()).toBe(false);
    expect(await Bun.file(join(root, "keep.txt")).exists()).toBe(true);
  });
});
