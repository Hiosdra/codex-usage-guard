import { describe, expect, test, afterEach } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hooksPath,
  installHook,
  installedHookCommand,
  hookIsInstalled,
  backupFile,
  uninstallHook,
} from "../src/platform/hook-install.ts";
import { withTestIsolation } from "./test-isolation.ts";

let root: string | undefined;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe("hook installation", () => {
  test("treats a missing backup source as having no backup", async () => {
    await expect(
      backupFile("/synthetic/missing-hooks.json", async () => {
        throw new Error("synthetic race");
      }),
    ).resolves.toBeUndefined();
  });

  test("preserves other hooks and is idempotent", () =>
    withTestIsolation(
      ["CODEX_USAGE_GUARD_HOOKS_PATH", "CODEX_USAGE_GUARD_HOOK_COMMAND"],
      async () => {
        root = await mkdtemp(join(tmpdir(), "cug-hook-"));
        process.env.CODEX_USAGE_GUARD_HOOKS_PATH = join(root, "hooks.json");
        process.env.CODEX_USAGE_GUARD_HOOK_COMMAND =
          "/synthetic/codex-usage-guard hook";
        await writeFile(
          hooksPath(),
          JSON.stringify({
            hooks: {
              UserPromptSubmit: [
                { hooks: [{ type: "command", command: "other-tool" }] },
              ],
              Stop: [],
            },
          }),
        );
        const first = await installHook();
        const second = await installHook();
        expect(first.changed).toBe(true);
        expect(second.changed).toBe(false);
        const value = JSON.parse(await readFile(hooksPath(), "utf8")) as {
          hooks: {
            UserPromptSubmit: Array<{ hooks: Array<{ command: string }> }>;
          };
        };
        expect(value.hooks.UserPromptSubmit[0]!.hooks[0]!.command).toBe(
          "other-tool",
        );
        expect(value.hooks.UserPromptSubmit).toHaveLength(2);
        const removed = await uninstallHook();
        expect(removed.changed).toBe(true);
        const after = JSON.parse(await readFile(hooksPath(), "utf8")) as {
          hooks: { UserPromptSubmit?: unknown[]; Stop?: unknown[] };
        };
        expect(after.hooks.UserPromptSubmit).toHaveLength(1);
        expect(after.hooks.Stop).toEqual([]);
      },
    ));

  test("handles first install, missing files, malformed JSON, and command quoting", () =>
    withTestIsolation(
      [
        "CODEX_USAGE_GUARD_HOOKS_PATH",
        "CODEX_USAGE_GUARD_HOOK_COMMAND",
        "CODEX_HOME",
      ],
      async () => {
        root = await mkdtemp(join(tmpdir(), "cug-hook-empty-"));
        process.env.CODEX_USAGE_GUARD_HOOKS_PATH = join(
          root,
          "nested",
          "hooks.json",
        );
        delete process.env.CODEX_USAGE_GUARD_HOOK_COMMAND;
        process.env.CODEX_HOME = join(root, "codex-home");
        expect(hooksPath()).toBe(join(root, "nested", "hooks.json"));
        const originalExecPath = process.execPath;
        const originalArgv = process.argv[1];
        try {
          Object.defineProperty(process, "execPath", {
            configurable: true,
            value: "/synthetic/bun",
          });
          process.argv[1] = "/synthetic/it's.ts";
          expect(installedHookCommand()).toContain("\\'");
          Object.defineProperty(process, "execPath", {
            configurable: true,
            value: "/synthetic/codex-usage-guard",
          });
          expect(installedHookCommand()).toContain("codex-usage-guard' hook");
          Object.defineProperty(process, "execPath", {
            configurable: true,
            value:
              "/opt/homebrew/Cellar/codex-usage-guard/0.2.0/bin/codex-usage-guard",
          });
          expect(installedHookCommand()).toContain(
            "'/opt/homebrew/bin/codex-usage-guard' hook",
          );
        } finally {
          Object.defineProperty(process, "execPath", {
            configurable: true,
            value: originalExecPath,
          });
          if (originalArgv === undefined) process.argv.splice(1, 1);
          else process.argv[1] = originalArgv;
        }

        const first = await installHook();
        expect(first.changed).toBe(true);
        expect(first.backup).toBeUndefined();
        expect(await hookIsInstalled()).toBe(true);
        expect((await uninstallHook()).changed).toBe(true);
        expect(await hookIsInstalled()).toBe(false);
        expect((await uninstallHook()).changed).toBe(false);

        await writeFile(hooksPath(), "not-json");
        await expect(installHook()).rejects.toThrow("Invalid Codex hooks JSON");
        expect(await hookIsInstalled()).toBe(false);
      },
    ));

  test("uses CODEX_HOME when no explicit hooks path is set", () =>
    withTestIsolation(
      [
        "CODEX_USAGE_GUARD_HOOKS_PATH",
        "CODEX_USAGE_GUARD_HOOK_COMMAND",
        "CODEX_HOME",
      ],
      async () => {
        root = await mkdtemp(join(tmpdir(), "cug-hook-home-"));
        delete process.env.CODEX_USAGE_GUARD_HOOKS_PATH;
        process.env.CODEX_HOME = join(root, "codex");
        process.env.CODEX_USAGE_GUARD_HOOK_COMMAND = "/synthetic/guard hook";
        expect(hooksPath()).toBe(join(root, "codex", "hooks.json"));
        expect((await uninstallHook()).changed).toBe(false);
      },
    ));
});
