import {
  copyFile,
  mkdir,
  readFile,
  writeFile,
  chmod,
  rename,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export function hooksPath(): string {
  return (
    process.env.CODEX_USAGE_GUARD_HOOKS_PATH ??
    join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "hooks.json")
  );
}
function quoteCommand(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
function stableExecutablePath(executable: string): string {
  const homebrewPath = executable.match(
    /^(.*)\/Cellar\/[^/]+\/[^/]+\/bin\/([^/]+)$/,
  );
  if (!homebrewPath) return executable;
  return join(homebrewPath[1]!, "bin", homebrewPath[2]!);
}
export function installedHookCommand(): string {
  const marker = " --managed-by=codex-usage-guard";
  if (process.env.CODEX_USAGE_GUARD_HOOK_COMMAND)
    return `${process.env.CODEX_USAGE_GUARD_HOOK_COMMAND}${marker}`;
  const executable = stableExecutablePath(process.execPath);
  const script = process.argv[1];
  if (
    executable.endsWith("/bun") ||
    executable.endsWith("/bunx") ||
    executable.endsWith("\\bun.exe")
  )
    return `${quoteCommand(executable)} ${quoteCommand(script ?? "codex-usage-guard")} hook${marker}`;
  return `${quoteCommand(executable)} hook${marker}`;
}

type HookHandler = {
  type: "command";
  command: string;
  timeout?: number;
  statusMessage?: string;
};
type HookGroup = {
  matcher?: string;
  hooks?: HookHandler[];
  [key: string]: unknown;
};
type HooksFile = {
  description?: string;
  hooks?: Record<string, HookGroup[]>;
  [key: string]: unknown;
};

async function readHooks(
  path: string,
): Promise<{ value: HooksFile; exists: boolean }> {
  try {
    return {
      value: JSON.parse(await readFile(path, "utf8")) as HooksFile,
      exists: true,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { value: { hooks: {} }, exists: false };
    throw new Error(`Invalid Codex hooks JSON at ${path}`);
  }
}
export async function backupFile(
  path: string,
  read = readFile,
): Promise<string | undefined> {
  try {
    await read(path);
  } catch {
    return undefined;
  }
  const backupPath = `${path}.bak.${Date.now()}`;
  await copyFile(path, backupPath);
  return backupPath;
}
async function atomicWrite(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(
    dirname(path),
    `.${path.split("/").at(-1) ?? "hooks"}.${process.pid}.tmp`,
  );
  await writeFile(temporary, text, { mode: 0o600 });
  await rename(temporary, path);
  try {
    await chmod(path, 0o600);
  } catch {
    /* best effort */
  }
}

export async function installHook(): Promise<{
  path: string;
  backup?: string;
  changed: boolean;
  command: string;
}> {
  const path = hooksPath();
  const { value, exists } = await readHooks(path);
  const command = installedHookCommand();
  const hooks = value.hooks ?? {};
  const groups = hooks.UserPromptSubmit ?? [];
  const already = groups.some((group) =>
    group.hooks?.some(
      (handler) =>
        handler.type === "command" &&
        (handler.command === command ||
          handler.command.includes("--managed-by=codex-usage-guard")),
    ),
  );
  if (already) return { path, changed: false, command };
  const backupPath = exists ? await backupFile(path) : undefined;
  const next: HooksFile = {
    ...value,
    hooks: {
      ...hooks,
      UserPromptSubmit: [
        ...groups,
        {
          hooks: [
            {
              type: "command",
              command,
              timeout: 5,
              statusMessage: "Checking Codex usage",
            },
          ],
        },
      ],
    },
  };
  await atomicWrite(path, `${JSON.stringify(next, null, 2)}\n`);
  return {
    path,
    ...(backupPath ? { backup: backupPath } : {}),
    changed: true,
    command,
  };
}

export async function uninstallHook(): Promise<{
  path: string;
  backup?: string;
  changed: boolean;
}> {
  const path = hooksPath();
  const { value, exists } = await readHooks(path);
  if (!exists) return { path, changed: false };
  const command = installedHookCommand();
  const groups = value.hooks?.UserPromptSubmit ?? [];
  let changed = false;
  const filtered = groups
    .map((group) => {
      const next: HookGroup = { ...group };
      if (group.hooks)
        next.hooks = group.hooks.filter((handler) => {
          const managed =
            handler.type === "command" &&
            (handler.command === command ||
              handler.command.includes("--managed-by=codex-usage-guard"));
          if (managed) changed = true;
          return !managed;
        });
      return next;
    })
    .filter((group) => (group.hooks?.length ?? 0) > 0);
  if (!changed) return { path, changed: false };
  const backupPath = await backupFile(path);
  const hooks = { ...(value.hooks ?? {}) };
  if (filtered.length) hooks.UserPromptSubmit = filtered;
  else delete hooks.UserPromptSubmit;
  const next: HooksFile = { ...value, hooks };
  await atomicWrite(path, `${JSON.stringify(next, null, 2)}\n`);
  return { path, ...(backupPath ? { backup: backupPath } : {}), changed: true };
}

export async function hookIsInstalled(): Promise<boolean> {
  try {
    const { value } = await readHooks(hooksPath());
    const command = installedHookCommand();
    return Boolean(
      value.hooks?.UserPromptSubmit?.some((group) =>
        group.hooks?.some(
          (handler) =>
            handler.type === "command" &&
            (handler.command === command ||
              handler.command.includes("--managed-by=codex-usage-guard")),
        ),
      ),
    );
  } catch {
    return false;
  }
}
