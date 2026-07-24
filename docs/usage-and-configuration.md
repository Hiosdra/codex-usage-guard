# Usage and configuration

This page contains the detailed reference for `codex-usage-guard`. For the
shortest path from installation to a working hook, start with the
[README](../README.md).

## Commands

```text
codex-usage-guard status
codex-usage-guard check [--json]
codex-usage-guard extend [count]
codex-usage-guard unlock [--until-reset]
codex-usage-guard reset-overrides
codex-usage-guard install-hook
codex-usage-guard uninstall-hook
codex-usage-guard uninstall [--purge]
codex-usage-guard doctor
codex-usage-guard config-path
codex-usage-guard state-path
codex-usage-guard profile [auto|personal|work]
```

`check` exits with:

| Code | Meaning                  |
| ---: | ------------------------ |
|  `0` | allow                    |
| `10` | warning                  |
| `20` | block                    |
| `30` | missing trustworthy data |
| `40` | configuration error      |
| `50` | Codex integration error  |

`extend 2` adds two profile-specific steps. `unlock` disables blocking until
the current quota reset while warnings remain enabled by default.

## Profiles and pacing

The default is `active_profile = "auto"`.

### Plus/Pro: personal profile

A valid approximately seven-day percentage window selects the personal
strategy. Usage is compared with a linear schedule across the quota window:

```text
window_start = resets_at - window_duration
elapsed = now - window_start
usage_position = used_percent / 100 × window_duration
ahead = usage_position - elapsed
```

Warnings start when `ahead > 0`. Blocking starts at `ahead >= 24h + extension`.
The estimated unlock time is based on the usage position and the effective
lead time.

### Business/Enterprise: work profile

A valid `individualLimit` selects the work strategy, especially when
`planType` identifies a Business, Enterprise, or Team plan. Monthly AI Credits
are distributed over Monday-to-Friday workdays:

```text
daily_budget = monthly_limit / total_workdays
scheduled_credits = monthly_limit × started_workdays / total_workdays
ahead_credits = used_credits - scheduled_credits
ahead_workdays = ahead_credits / daily_budget
```

The full daily budget becomes available at local midnight. Weekends do not add
budget, and public or company holidays are not modelled.

On the first read, the period starts one UTC calendar month before `resetsAt`.
Later reads use the previously observed server reset. A limit change without a
reset recalculates the schedule without clearing usage or overrides.

Use `profile personal` or `profile work` to override automatic selection
locally. The `profile` command reports the detected plan, selected strategy,
reason, and data source.

## Configuration

Configuration is optional. To start from the documented example:

```sh
CONFIG="$(codex-usage-guard config-path)"
mkdir -p "$(dirname "$CONFIG")"
cp example-config.toml "$CONFIG"
```

The main options are:

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

## Files and environment overrides

macOS stores configuration and state under:

```text
~/Library/Application Support/codex-usage-guard/config.toml
~/Library/Application Support/codex-usage-guard/state.sqlite
~/Library/Caches/codex-usage-guard/
~/Library/Logs/codex-usage-guard/
```

Linux uses XDG directories, falling back to `~/.config`, `~/.local/state`, and
`~/.cache`.

Tests and isolated installations can set:

```text
CODEX_USAGE_GUARD_CONFIG
CODEX_USAGE_GUARD_STATE
CODEX_USAGE_GUARD_CACHE
CODEX_HOME
CODEX_USAGE_GUARD_HOOKS_PATH
CODEX_USAGE_GUARD_BREW_COMMAND
```

Advanced setups can set `CODEX_USAGE_GUARD_CODEX_COMMAND` to an explicit Codex
executable path.

`CODEX_USAGE_GUARD_BREW_COMMAND` can point to `brew` when Homebrew is not
available through `PATH`.

SQLite uses WAL, a five-second busy timeout, transactional overrides, and
quota epochs. An override from an old epoch cannot overwrite a new epoch.

## Hook lifecycle

`install-hook` edits only the global `~/.codex/hooks.json`, creates a backup,
and preserves other hooks. `uninstall-hook` removes only this application's
entry. `uninstall` removes that hook and the standalone release binary plus
the `cug` alias. It keeps application data by default; `uninstall --purge`
also removes the configuration, SQLite state, cache, and logs at their
configured paths. The installer keeps its hook backup.

For Homebrew installations, prefer `cug uninstall`; it removes the hook and
then invokes `brew uninstall codex-usage-guard`. Running `brew uninstall`
directly removes the formula but does not remove the hook.

Codex may require one-time approval for a new or changed hook through
`/hooks`.
