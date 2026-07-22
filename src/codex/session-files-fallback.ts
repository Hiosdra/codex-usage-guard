import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export interface SessionFallbackResult {
  raw: unknown;
  observedAt: Date;
  source: "session_files";
  file: string;
}

export interface SessionFallbackDependencies {
  stat?: (file: string) => Promise<{ mtimeMs: number }>;
  readFile?: (file: string) => Promise<string>;
}

async function filesUnder(root: string, depth: number): Promise<string[]> {
  if (depth < 0) return [];
  try {
    const entries = await readdir(root, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      const path = join(root, entry.name);
      if (entry.isDirectory())
        files.push(...(await filesUnder(path, depth - 1)));
      else if (entry.isFile() && /\.(jsonl?|ndjson)$/i.test(entry.name))
        files.push(path);
    }
    return files;
  } catch {
    return [];
  }
}

export async function readLatestSessionRateLimits(
  codexHome: string,
  dependencies: SessionFallbackDependencies = {},
): Promise<SessionFallbackResult | undefined> {
  const files = await filesUnder(join(codexHome, "sessions"), 4);
  const statFile =
    dependencies.stat ?? ((file: string) => Bun.file(file).stat());
  const readSessionFile =
    dependencies.readFile ?? ((file: string) => readFile(file, "utf8"));
  let best: SessionFallbackResult | undefined;
  for (const file of files) {
    let stat: { mtimeMs: number } | undefined;
    try {
      stat = await statFile(file);
    } catch {
      continue;
    }
    if (!stat || (best && stat.mtimeMs <= best.observedAt.getTime())) continue;
    let text: string;
    try {
      text = await readSessionFile(file);
    } catch {
      continue;
    }
    const lines = text.split(/\r?\n/).reverse();
    for (const line of lines) {
      if (!/rate[_-]?limits?|used[_-]?percent|window[_-]?minutes/i.test(line))
        continue;
      try {
        const raw = JSON.parse(line) as Record<string, unknown>;
        const payload = raw.payload as Record<string, unknown> | undefined;
        const info = payload?.info as Record<string, unknown> | undefined;
        const candidate =
          raw.rate_limits ??
          raw.rateLimits ??
          payload?.rate_limits ??
          payload?.rateLimits ??
          info?.rate_limits ??
          info?.rateLimits;
        if (candidate) {
          best = {
            raw: { rateLimits: candidate },
            observedAt: new Date(stat.mtimeMs),
            source: "session_files",
            file,
          };
          break;
        }
      } catch {
        /* not every transcript line is JSON */
      }
    }
  }
  return best;
}
