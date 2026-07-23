export interface AppServerClientOptions {
  command?: string;
  timeoutMs: number;
  spawnAppServer?: AppServerSpawn;
}

export type AppServerProcess = Pick<
  ReturnType<typeof Bun.spawn>,
  "stdin" | "stdout" | "kill"
>;

export type AppServerSpawn = (argv: string[]) => AppServerProcess;

export class AppServerError extends Error {
  constructor(
    message: string,
    public readonly kind: "timeout" | "spawn" | "protocol" | "remote",
  ) {
    super(message);
  }
}

function jsonLines(value: Uint8Array, buffer: string): [string[], string] {
  const text = buffer + new TextDecoder().decode(value);
  const parts = text.split(/\r?\n/);
  return [parts.slice(0, -1), parts.at(-1) ?? ""];
}

function responseForLine(line: string): Record<string, unknown> | undefined {
  if (!line.trim()) return undefined;
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    throw new AppServerError(
      "Codex app-server returned invalid JSON",
      "protocol",
    );
  }
  if (!message || typeof message !== "object")
    throw new AppServerError(
      "Codex app-server returned an invalid response",
      "protocol",
    );
  return message as Record<string, unknown>;
}

async function flushInput(input: {
  flush(): number | Promise<number>;
}): Promise<void> {
  try {
    await input.flush();
  } catch (error) {
    if (!/EPERM|EPIPE|closed/i.test(String(error))) throw error;
  }
}

export class CodexAppServerClient {
  constructor(private readonly options: AppServerClientOptions) {}

  async readRateLimits(): Promise<unknown> {
    const message = await this.request(2, [
      {
        id: 1,
        method: "initialize",
        params: {
          clientInfo: {
            name: "codex-usage-guard",
            title: "Codex Usage Guard",
            version: "0.1.0",
          },
          capabilities: {},
        },
      },
      { method: "initialized" },
      { id: 2, method: "account/rateLimits/read" },
    ]);
    return message;
  }

  async handshake(): Promise<void> {
    await this.request(1, [
      {
        id: 1,
        method: "initialize",
        params: {
          clientInfo: {
            name: "codex-usage-guard",
            title: "Codex Usage Guard",
            version: "0.1.0",
          },
          capabilities: {},
        },
      },
      { method: "initialized" },
    ]);
  }

  private async request(
    targetId: number,
    requests: Array<Record<string, unknown>>,
  ): Promise<Record<string, unknown>> {
    const command = this.options.command ?? "codex";
    let proc: AppServerProcess;
    try {
      proc = (
        this.options.spawnAppServer ??
        ((argv) =>
          Bun.spawn(argv, {
            stdin: "pipe",
            stdout: "pipe",
            stderr: "pipe",
          }))
      )([command, "app-server", "--stdio"]);
    } catch (error) {
      throw new AppServerError(
        `Could not start ${command} app-server: ${String(error)}`,
        "spawn",
      );
    }
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, this.options.timeoutMs);
    try {
      const output = proc.stdout;
      if (!output || typeof output === "number")
        throw new AppServerError(
          "Codex app-server did not expose stdio pipes",
          "spawn",
        );
      const input = proc.stdin;
      if (!input || typeof input === "number")
        throw new AppServerError(
          "Codex app-server did not expose a writable stdin pipe",
          "spawn",
        );
      input.write(`${JSON.stringify(requests[0])}\n`);
      await flushInput(input);
      let buffer = "";
      let sentAfterInitialize = false;
      const reader = output.getReader();
      while (true) {
        const read = await reader.read();
        if (read.done) break;
        const [lines, nextBuffer] = jsonLines(read.value, buffer);
        buffer = nextBuffer;
        for (const line of lines) {
          const message = responseForLine(line);
          if (!message) continue;
          if (message.id === 1 && message.error)
            throw new AppServerError(
              `Codex app-server rejected initialize: ${safeError(message.error)}`,
              "remote",
            );
          if (!sentAfterInitialize && message.id === 1) {
            for (const request of requests.slice(1))
              input.write(`${JSON.stringify(request)}\n`);
            await flushInput(input);
            sentAfterInitialize = true;
            if (targetId === 1) return message;
            continue;
          }
          if (message.id !== targetId) continue;
          if (message.error)
            throw new AppServerError(
              `Codex app-server rejected account/rateLimits/read: ${safeError(message.error)}`,
              "remote",
            );
          return message;
        }
      }
      if (buffer.trim()) {
        const message = responseForLine(buffer);
        if (message) {
          if (message.id === 1 && message.error)
            throw new AppServerError(
              `Codex app-server rejected initialize: ${safeError(message.error)}`,
              "remote",
            );
          if (!sentAfterInitialize && message.id === 1) {
            for (const request of requests.slice(1))
              input.write(`${JSON.stringify(request)}\n`);
            await flushInput(input);
            sentAfterInitialize = true;
            if (targetId === 1) return message;
          } else if (message.id === targetId) {
            if (message.error)
              throw new AppServerError(
                `Codex app-server rejected account/rateLimits/read: ${safeError(message.error)}`,
                "remote",
              );
            return message;
          }
        }
      }
      throw new AppServerError(
        timedOut
          ? `Codex app-server timed out after ${this.options.timeoutMs}ms`
          : `Codex app-server exited before returning response ${targetId}`,
        timedOut ? "timeout" : "protocol",
      );
    } catch (error) {
      if (error instanceof AppServerError) throw error;
      throw new AppServerError(
        `Codex app-server request failed: ${String(error)}`,
        "protocol",
      );
    } finally {
      clearTimeout(timeout);
      try {
        proc.kill();
      } catch {
        /* already exited */
      }
    }
  }
}

function safeError(error: unknown): string {
  if (!error || typeof error !== "object") return "unknown remote error";
  const record = error as Record<string, unknown>;
  return typeof record.message === "string"
    ? record.message
    : "unknown remote error";
}
