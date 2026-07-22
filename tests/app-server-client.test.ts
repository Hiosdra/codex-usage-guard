import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AppServerError,
  CodexAppServerClient,
} from "../src/codex/app-server-client.ts";
import type { AppServerProcess } from "../src/codex/app-server-client.ts";

let roots: string[] = [];

async function fakeCodex(mode: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "cug-app-server-"));
  roots.push(root);
  const path = join(root, "fake-codex");
  await writeFile(
    path,
    `#!/usr/bin/env bun
const mode = ${JSON.stringify(mode)};
if (mode === "delay") await Bun.sleep(200);
if (mode === "invalid") { console.log("not-json"); process.exit(0); }
if (mode === "empty") process.exit(0);
if (mode === "remote") {
  console.log(JSON.stringify({ id: 2, error: { message: "synthetic remote failure" } }));
  process.exit(0);
}
if (mode === "remote-unknown") {
  console.log(JSON.stringify({ id: 2, error: { code: -1 } }));
  process.exit(0);
}
if (mode === "no-newline") {
  process.stdout.write(JSON.stringify({ id: 1, result: {} }) + "\\n");
  process.stdout.write(JSON.stringify({ id: 2, result: { rateLimits: { secondary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: 1790812800 } } } }));
  process.exit(0);
}
console.log(JSON.stringify({ id: 1, result: {} }));
if (mode !== "handshake") console.log(JSON.stringify({ id: 2, result: { rateLimits: { secondary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: 1790812800 } } } }));
`,
    "utf8",
  );
  await chmod(path, 0o700);
  return path;
}

function sequentialFakeProcess(): AppServerProcess {
  const encoder = new TextEncoder();
  let stdoutController: ReadableStreamDefaultController<Uint8Array>;
  const stdout = new ReadableStream<Uint8Array>({
    start(controller) {
      stdoutController = controller;
    },
  });
  const stdin = {
    write(chunk: string): number {
      const request = JSON.parse(chunk) as { id: number };
      if (request.id === 1) {
        stdoutController.enqueue(encoder.encode('{"id":1,"result":{}}\n'));
      } else if (request.id === 2) {
        stdoutController.enqueue(
          encoder.encode(
            '{"id":2,"result":{"rateLimits":{"secondary":{"usedPercent":40,"windowDurationMins":10080,"resetsAt":1790812800}}}}\n',
          ),
        );
      }
      return chunk.length;
    },
    flush(): number {
      return 0;
    },
    end(): number {
      return 0;
    },
  };
  return { stdin, stdout, kill() {} } as AppServerProcess;
}

afterEach(async () => {
  await Promise.all(
    roots.map((root) => rm(root, { recursive: true, force: true })),
  );
  roots = [];
});

describe("Codex App Server client", () => {
  test("performs the handshake and reads rate limits", async () => {
    const command = await fakeCodex("normal");
    const client = new CodexAppServerClient({ command, timeoutMs: 1000 });
    await expect(client.handshake()).resolves.toBeUndefined();
    await expect(client.readRateLimits()).resolves.toMatchObject({ id: 2 });
  });

  test("classifies malformed, empty, remote, and timeout failures", async () => {
    const invalid = new CodexAppServerClient({
      command: await fakeCodex("invalid"),
      timeoutMs: 1000,
    });
    await expect(invalid.readRateLimits()).rejects.toMatchObject({
      kind: "protocol",
    });

    const empty = new CodexAppServerClient({
      command: await fakeCodex("empty"),
      timeoutMs: 1000,
    });
    await expect(empty.readRateLimits()).rejects.toMatchObject({
      kind: "protocol",
    });

    const remote = new CodexAppServerClient({
      command: await fakeCodex("remote"),
      timeoutMs: 1000,
    });
    await expect(remote.readRateLimits()).rejects.toMatchObject({
      kind: "remote",
    });

    const unknown = new CodexAppServerClient({
      command: await fakeCodex("remote-unknown"),
      timeoutMs: 1000,
    });
    await expect(unknown.readRateLimits()).rejects.toMatchObject({
      kind: "remote",
    });

    const timeout = new CodexAppServerClient({
      command: await fakeCodex("delay"),
      timeoutMs: 20,
    });
    await expect(timeout.readRateLimits()).rejects.toMatchObject({
      kind: "timeout",
    });

    const missing = new CodexAppServerClient({
      command: "/synthetic/not-found",
      timeoutMs: 20,
    });
    await expect(missing.readRateLimits()).rejects.toMatchObject({
      kind: "spawn",
    });
    expect(new AppServerError("synthetic", "protocol")).toBeInstanceOf(Error);
  });

  test("accepts a valid final JSONL response without a trailing newline", async () => {
    const client = new CodexAppServerClient({
      command: await fakeCodex("no-newline"),
      timeoutMs: 1000,
    });
    await expect(client.readRateLimits()).resolves.toMatchObject({ id: 2 });
  });

  test("sends post-initialize messages only after the handshake response", async () => {
    const client = new CodexAppServerClient({
      command: "synthetic-codex",
      timeoutMs: 1000,
      spawnAppServer: () => sequentialFakeProcess(),
    });
    await expect(client.readRateLimits()).resolves.toMatchObject({ id: 2 });
  });
});
