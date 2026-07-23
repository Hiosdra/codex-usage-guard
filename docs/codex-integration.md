# Codex CLI integration

This integration was checked on 22 July 2026 against the locally available
`codex-cli 0.145.0`. The hook contract was compared with the official
[Codex Hooks documentation](https://developers.openai.com/codex/hooks), and the
App Server contract with the official
[`codex app-server` README](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md).

## Hook before a prompt

The event name is `UserPromptSubmit`. Codex discovers global hooks in places
including `~/.codex/hooks.json`. Higher-precedence layers do not replace lower
layers, so the installer appends one group and preserves existing entries. A
matcher is not used for this event.

The installer generates a configuration shaped like this:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "<synthetic executable path> hook",
            "timeout": 5,
            "statusMessage": "Checking Codex usage"
          }
        ]
      }
    ]
  }
}
```

The hook receives one JSON object on stdin. `UserPromptSubmit` includes
`hook_event_name`, `session_id`, `turn_id`, `cwd`, `model`,
`permission_mode`, and `prompt`. The adapter only validates the lifecycle
event and never logs or echoes the prompt.

An allow decision exits with code `0` and no stdout. A warning is returned as
JSON with `systemMessage`, which Codex surfaces in the UI or event stream:

```json
{ "systemMessage": "Codex weekly usage warning ..." }
```

To block only the current prompt, the adapter returns the documented shape:

```json
{ "decision": "block", "reason": "Codex Usage Guard blocked this prompt ..." }
```

This does not close the conversation or delete the prompt. The user can edit
and submit it again. Codex also supports exit code `2` with a reason on stderr,
but this project uses JSON for an explicit response shape.

The adapter does not use `additionalContext`: warnings are UI messages rather
than instructions for the model. Hooks are a guardrail and may not cover every
internal Codex execution path.

## App Server

`codex-cli 0.145.0` runs `codex app-server` as a JSONL process over stdio. It is
JSON-RPC 2.0 with the `jsonrpc: "2.0"` header omitted on the wire. The client
sends `initialize` first and waits for its response before sending the
`initialized` notification and the rate-limit request:

```json
{"id":1,"method":"initialize","params":{"clientInfo":{"name":"codex-usage-guard","title":"Codex Usage Guard","version":"0.1.0"},"capabilities":{}}}
{"method":"initialized"}
{"id":2,"method":"account/rateLimits/read"}
```

The response is selected by `id: 2`. A fresh read starts a separate process,
uses a five-second timeout, and terminates the process after the response.
Short-lived cache entries prevent a new process for every prompt.

Successful protocol communication still depends on Codex having usable local
account state and authentication. `doctor` checks those prerequisites and
reports integration failures explicitly; it does not silently treat missing
rate-limit data as a successful read.

The preferred source is `account/rateLimits/read`. The parser normalizes:

- `secondary` or snake_case equivalents with a three-to-ten-day window as the
  weekly personal profile;
- `individualLimit.limit`, `.used`, `.remainingPercent`, `.resetsAt`,
  `planType`, `limitId`, `spendControlReached`, and `credits.unlimited` as the
  Business/Enterprise profile;
- `rateLimitsByLimitId` when the direct rate-limit object is incomplete;
- `rateLimitResetCredits` into the raw diagnostic cache without consuming it.

All credit arithmetic uses the repository's exact decimal implementation.

Synthetic Business/Enterprise response:

```json
{
  "id": 2,
  "result": {
    "rateLimits": {
      "limitId": "codex",
      "planType": "business",
      "credits": { "hasCredits": true, "unlimited": false, "balance": null },
      "individualLimit": {
        "limit": "1000",
        "used": "420.5",
        "remainingPercent": 58,
        "resetsAt": 1790812800
      },
      "spendControlReached": false,
      "rateLimitReachedType": null
    },
    "rateLimitResetCredits": { "availableCount": 0, "credits": [] }
  }
}
```

Synthetic Plus/Pro response:

```json
{
  "id": 2,
  "result": {
    "rateLimits": {
      "secondary": {
        "usedPercent": 40,
        "windowDurationMins": 10080,
        "resetsAt": 1790812800
      }
    }
  }
}
```

If App Server access fails, the fallback searches only local Codex session
files under `$CODEX_HOME/sessions` for normalizable `rate_limits` or
`rateLimits` entries. Fallback data is marked stale and never replaces a
fresh App Server result.

## Profile selection and reset handling

In `auto`, a valid `individualLimit` selects `work`, especially when
`planType` identifies Business, Enterprise, or Team. Without it, a valid
approximately seven-day percentage window selects `personal`. Explicit
`personal` and `work` settings take precedence.

For a normal server reset, a newer `resetsAt` starts a new epoch. Business
periods use the previous server reset as their start; the first observation
subtracts one UTC calendar month rather than thirty fixed days. A sufficiently
large usage drop with the same server reset can be confirmed as
`early_reset_inferred`; the old server period end is retained while the local
epoch and overrides are reset.

## Known limitations

1. Rate-limit field names and availability depend on the current backend; the
   parser rejects incomplete responses instead of guessing.
2. The hook does not save or forward prompt text.
3. Codex may require trust approval for a new or changed hook definition.
4. Workdays are Monday through Friday; public and company holidays are not
   detected.
5. `rateLimitResetCredits` is diagnostic only and is never automatically
   consumed.
