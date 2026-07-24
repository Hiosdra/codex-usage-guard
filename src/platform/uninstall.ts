import { lstat, realpath, rm, unlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { Paths } from "../config/config.ts";

const EXECUTABLE_NAMES = new Set(["codex-usage-guard", "cug"]);

export type UninstallSelfOptions = {
  executablePath?: string;
  invokedPath?: string;
};

export type UninstallSelfResult = {
  executable?: string;
  aliases: string[];
  homebrew: boolean;
};

export type HomebrewUninstallResult =
  | {
      command: string;
      removed: true;
    }
  | {
      command?: never;
      removed: false;
    };

function absolutePath(path: string): string {
  return resolve(path);
}

function isSupportedExecutable(path: string): boolean {
  return EXECUTABLE_NAMES.has(basename(path));
}

function isHomebrewPath(path: string): boolean {
  return /(?:^|[\\/])Cellar(?:[\\/])/.test(path);
}

function brewCommand(): string | undefined {
  const configured = process.env.CODEX_USAGE_GUARD_BREW_COMMAND;
  return configured && configured.length > 0
    ? configured
    : (Bun.which("brew") ?? undefined);
}

async function existingExecutable(path: string): Promise<string | undefined> {
  const candidate = absolutePath(path);
  if (!isSupportedExecutable(candidate)) return undefined;
  try {
    const realPath = await realpath(candidate);
    const stat = await lstat(realPath);
    if (!stat.isFile() || !isSupportedExecutable(basename(realPath)))
      return undefined;
    return realPath;
  } catch {
    return undefined;
  }
}

async function pointsTo(path: string, target: string): Promise<boolean> {
  try {
    const stat = await lstat(path);
    return stat.isSymbolicLink() && (await realpath(path)) === target;
  } catch {
    return false;
  }
}

async function removeLink(path: string): Promise<boolean> {
  try {
    const stat = await lstat(path);
    if (!stat.isSymbolicLink()) return false;
    await unlink(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/**
 * Remove the standalone executable that is currently running and its cug
 * symlink. Unlinking an open executable is supported on the macOS/Linux
 * targets; the current process can finish printing its result afterwards.
 */
export async function uninstallSelf(
  options: UninstallSelfOptions = {},
): Promise<UninstallSelfResult> {
  const candidates = [options.executablePath, options.invokedPath].filter(
    (value): value is string => Boolean(value),
  );
  let executable: string | undefined;
  for (const candidate of candidates) {
    executable = await existingExecutable(candidate);
    if (executable) break;
  }
  if (!executable) return { aliases: [], homebrew: false };

  if (isHomebrewPath(executable))
    return {
      executable,
      aliases: [],
      homebrew: true,
    };

  const aliasCandidates = new Set<string>();
  for (const candidate of candidates) {
    const path = absolutePath(candidate);
    if (path !== executable && (await pointsTo(path, executable)))
      aliasCandidates.add(path);
  }
  for (const name of EXECUTABLE_NAMES) {
    const path = join(dirname(executable), name);
    if (path !== executable && (await pointsTo(path, executable)))
      aliasCandidates.add(path);
  }

  await unlink(executable);
  const aliases: string[] = [];
  for (const alias of aliasCandidates)
    if (await removeLink(alias)) aliases.push(alias);
  return { executable, aliases, homebrew: false };
}

export async function uninstallHomebrewFormula(
  command = brewCommand(),
): Promise<HomebrewUninstallResult> {
  if (!command) return { removed: false };
  const child = Bun.spawn(
    [command, "uninstall", "--formula", "codex-usage-guard"],
    {
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  const exitCode = await child.exited;
  if (exitCode !== 0)
    throw new Error(
      `brew uninstall codex-usage-guard failed with exit code ${exitCode}`,
    );
  return { command, removed: true };
}

async function removeFile(path: string): Promise<boolean> {
  try {
    const stat = await lstat(path);
    if (stat.isDirectory()) return false;
    await rm(path, { force: true });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function removeDirectory(path: string): Promise<boolean> {
  try {
    const stat = await lstat(path);
    if (!stat.isDirectory()) return removeFile(path);
    await rm(path, { force: true, recursive: true });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function safePurgePath(
  path: string,
  protectedSubtrees: readonly string[] = [],
): string | undefined {
  const candidate = absolutePath(path);
  const protectedRoots = new Set([
    resolve("/"),
    resolve(homedir()),
    resolve(dirname(homedir())),
    resolve(tmpdir()),
    resolve(process.cwd()),
  ]);
  if (
    protectedRoots.has(candidate) ||
    protectedSubtrees.some(
      (root) => candidate === root || candidate.startsWith(`${root}${sep}`),
    )
  )
    return undefined;
  return candidate;
}

export async function purgeData(paths: Paths): Promise<string[]> {
  const removed: string[] = [];
  const protectedSubtrees = [absolutePath(paths.codexHome)];
  const files = [
    safePurgePath(paths.config, protectedSubtrees),
    safePurgePath(paths.state, protectedSubtrees),
    safePurgePath(paths.state + "-wal", protectedSubtrees),
    safePurgePath(paths.state + "-shm", protectedSubtrees),
    safePurgePath(paths.state + "-journal", protectedSubtrees),
  ];
  for (const path of files)
    if (path && (await removeFile(path))) removed.push(path);

  const directories = [
    safePurgePath(paths.logs, protectedSubtrees),
    safePurgePath(paths.cache, protectedSubtrees),
  ];
  const seen = new Set<string>();
  for (const path of directories)
    if (path && !seen.has(path)) {
      seen.add(path);
      if (await removeDirectory(path)) removed.push(path);
    }
  return removed;
}
