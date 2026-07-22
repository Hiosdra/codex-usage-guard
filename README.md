# codex-usage-guard

A local CLI and Codex `UserPromptSubmit` hook that paces usage against a
linear schedule. It supports two profiles:

[![CI](https://github.com/Hiosdra/codex-usage-guard/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/Hiosdra/codex-usage-guard/actions/workflows/ci.yml)

- Plus/Pro: a percentage limit in an approximately seven-day window;
- Business/Enterprise: a monthly AI Credits limit distributed across
  Monday-to-Friday workdays.

AI Credits are read from the Codex App Server. The guard does not estimate
credits from tokens, use an admin API, or copy runtime account data into the
repository.

## Quick start

Building requires Bun `1.3.14`. A compiled executable does not require Bun,
Node.js, npm, or Homebrew on the target machine.

```sh
bun install --frozen-lockfile
bun run lint
bun test
bun run test:coverage
bun run build
./dist/codex-usage-guard doctor
./dist/codex-usage-guard install-hook
```

After installation, trust the hook in Codex if the CLI lists it as new or
changed (for example, through `/hooks`). The installer edits only the global
`~/.codex/hooks.json`, creates a backup, and preserves other hooks.

## Installation and first use

The source installation is the same on macOS and Linux:

```sh
bun install --frozen-lockfile
bun run build
./dist/codex-usage-guard doctor
./dist/codex-usage-guard install-hook
```

Configuration is optional; safe defaults work without a config file. To start
from the documented example, copy it to the path reported by the CLI:

```sh
CONFIG="$(./dist/codex-usage-guard config-path)"
mkdir -p "$(dirname "$CONFIG")"
cp example-config.toml "$CONFIG"
```

Common commands:

```sh
./dist/codex-usage-guard status          # current pacing and data source
./dist/codex-usage-guard check           # allow/warn/block decision
./dist/codex-usage-guard check --json    # machine-readable result
./dist/codex-usage-guard profile         # detected plan and strategy
./dist/codex-usage-guard extend          # +24h or +1 workday
./dist/codex-usage-guard unlock          # disable blocking until reset
./dist/codex-usage-guard reset-overrides
```

On Linux, the `work` profile also supports Business/Enterprise. The hook may
need one-time approval in Codex through `/hooks`.

To remove only this application's hook entry:

```sh
./dist/codex-usage-guard uninstall-hook
```

The installer keeps its backup and does not delete the guard's state.

## Commands and exit codes

```text
codex-usage-guard status
codex-usage-guard check [--json]
codex-usage-guard extend [count]
codex-usage-guard unlock [--until-reset]
codex-usage-guard reset-overrides
codex-usage-guard install-hook
codex-usage-guard uninstall-hook
codex-usage-guard doctor
codex-usage-guard config-path
codex-usage-guard state-path
codex-usage-guard profile [auto|personal|work]
```

`check` exits with `0` for allow, `10` for warning, `20` for block, `30` for
missing trustworthy data, `40` for configuration errors, and `50` for Codex
integration errors. `extend 2` adds two profile-specific steps. `unlock`
disables blocking until the current quota reset while warnings remain enabled
by default.

## How pacing works

For Plus/Pro:

```text
window_start = resets_at - window_duration
elapsed = now - window_start
usage_position = used_percent / 100 × window_duration
ahead = usage_position - elapsed
```

Warnings start when `ahead > 0`; blocking starts at
`ahead >= 24h + extension`. The estimated unlock is
`window_start + usage_position - effective_lead`.

For Business/Enterprise:

```text
daily_budget = monthly_limit / total_workdays
scheduled_credits = monthly_limit × started_workdays / total_workdays
ahead_credits = used_credits - scheduled_credits
ahead_workdays = ahead_credits / daily_budget
```

The full daily budget becomes available at local midnight. Weekends do not add
budget, and public or company holidays are not modelled. On the first read,
the period start is one UTC calendar month before `resetsAt`; later reads use
the previously observed server reset. A limit change without a reset
recalculates the schedule without clearing usage or overrides.

## Automatic profile selection

The default is `active_profile = "auto"`. A valid `individualLimit` selects
the Business/Enterprise strategy, especially when `planType` identifies a
Business, Enterprise, or Team plan. Without it, a valid approximately
seven-day percentage window selects Plus/Pro. Use `profile personal` or
`profile work` to override the selection locally.

The `profile` command reports the detected plan, selected strategy, reason, and
data source.

## Configuration and files

Copy [example-config.toml](example-config.toml) when you need custom pacing,
freshness, or display settings. The important options are:

```toml
active_profile = "auto"

[personal]
base_lead = "24h"
warning_after = "0h"
extension_step = "24h"

[work]
timezone = "system"
workdays = ["mon", "tue", "wed", "thu", "fri"]
warning_after_workdays_ahead = 0
block_after_workdays_ahead = 1
extension_step_workdays = 1

[data]
cache_ttl = "60s"
maximum_stale_age = "15m"
app_server_timeout = "5s"
missing_data_action = "warn"
fallback_to_session_files = true
```

`missing_data_action` can be `allow`, `warn`, or `block`. The default is
`warn`. `warning_during_unlock` controls whether warnings continue during an
unlock override.

macOS stores configuration and state under:

```text
~/Library/Application Support/codex-usage-guard/config.toml
~/Library/Application Support/codex-usage-guard/state.sqlite
~/Library/Caches/codex-usage-guard/
~/Library/Logs/codex-usage-guard/
```

Linux uses XDG directories, falling back to `~/.config`, `~/.local/state`, and
`~/.cache`. Tests and isolated installations can set
`CODEX_USAGE_GUARD_CONFIG`, `CODEX_USAGE_GUARD_STATE`,
`CODEX_USAGE_GUARD_CACHE`, `CODEX_HOME`, and
`CODEX_USAGE_GUARD_HOOKS_PATH`. Advanced setups can set
`CODEX_USAGE_GUARD_CODEX_COMMAND` to an explicit Codex executable path.

SQLite uses WAL, a five-second busy timeout, transactional overrides, and
quota epochs. An override from an old epoch cannot overwrite a new epoch.

## Privacy

The guard does not log prompts, model responses, tokens, cookies, auth tokens,
emails, or full user-named paths. Runtime rate-limit data may exist in the
user's private cache and SQLite state, but all repository examples, fixtures,
tests, and documentation use synthetic values such as limit `1000`, usage
`420.5`, and remaining `58%`. Configuration, state, cache, and log directories
use private permissions where supported.

## Platforms and distribution

The shared code and the Business/Enterprise strategy support macOS arm64/x64
and Linux arm64/x64. The work strategy has no macOS-only dependency.

Build a standalone executable with:

```sh
bun build ./src/cli.ts --compile --outfile dist/codex-usage-guard
```

CI builds all four targets, runs tests and smoke checks, creates archives, and
generates SHA-256 files. Releases are not published automatically.

The full tested Codex integration contract is documented in
[docs/codex-integration.md](docs/codex-integration.md).

## Contributing and security

Please use the issue forms for reproducible bugs and focused feature requests.
Pull requests should include tests, documentation updates where relevant, and
confirmation that prompts, credentials, and private runtime data are not
included. See [SECURITY.md](SECURITY.md) for private vulnerability reporting.

## Limitations

- Rate-limit field availability depends on the current Codex backend.
- Workdays mean Monday through Friday; holidays are not detected.
- `rateLimitResetCredits` is retained diagnostically but never consumed.
- Codex may require trust approval for a new or changed hook definition.
- A hook is a useful guardrail, not an absolute boundary for every internal
  Codex execution path.
