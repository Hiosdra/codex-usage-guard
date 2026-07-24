# codex-usage-guard

[![Latest release](https://img.shields.io/github/v/release/Hiosdra/codex-usage-guard?sort=semver)](https://github.com/Hiosdra/codex-usage-guard/releases)
[![CI](https://github.com/Hiosdra/codex-usage-guard/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/Hiosdra/codex-usage-guard/actions/workflows/ci.yml)

> Keep Codex useful throughout your quota window.

`codex-usage-guard` is a local Codex `UserPromptSubmit` hook that helps you
pace usage before the quota becomes a surprise. It turns current Codex rate
limit data into a clear `allow`, `warn`, or `block` decision before a prompt
is submitted.

It supports both personal and work accounts:

- Plus/Pro usage across an approximately seven-day window;
- Business/Enterprise monthly AI Credits distributed across workdays;
- automatic profile selection, with manual `personal` and `work` overrides.

The guard is local-first: it does not log prompts, responses, tokens, cookies,
or credentials. Runtime quota data stays in the user's local cache and state.

## Start using it

### 1. Install

The fastest path is a standalone release binary for macOS or Linux on arm64 or
x64:

```sh
curl -fsSL https://raw.githubusercontent.com/Hiosdra/codex-usage-guard/v0.2.2/install.sh | sh
```

Or build locally through the Homebrew Formula:

```sh
brew trust hiosdra/tap
brew tap Hiosdra/tap
brew install codex-usage-guard
```

The installation also provides the shorter `cug` command. With no arguments,
both command names show the help; use `status` to see the current status:

```sh
codex-usage-guard status
cug status
cug
cug --help
```

The source-build option is also available for contributors; see
[development](#development).

### 2. Check your setup

```sh
codex-usage-guard doctor
```

This checks the Codex executable, App Server connection, rate-limit data,
local storage, and hook configuration.

### 3. Turn on the guard

```sh
codex-usage-guard install-hook
```

If Codex asks you to trust a new or changed hook, review and approve it through
`/hooks`. The hook installer creates a backup and preserves your other hooks.
When using the Codex desktop app, accept the hook in
`Settings -> Coding -> Hooks`.

To remove a standalone release installation, run:

```sh
cug uninstall
```

This removes CUG's hook, the release binary, and its `cug` alias while keeping
local configuration and state. Add `--purge` to also remove CUG's configuration,
SQLite state, cache, and logs at their configured paths. Homebrew installations
should be removed with `cug uninstall` as well: it removes the hook and invokes
`brew uninstall codex-usage-guard`. Running `brew uninstall` directly does not
remove the hook.

## What it feels like

Before each prompt, the guard checks whether your usage is on schedule:

```text
ALLOW   prompt proceeds normally
WARN    prompt proceeds with a pacing warning
BLOCK   prompt pauses with a clear explanation and recovery options
```

See the current state at any time:

```sh
codex-usage-guard status
codex-usage-guard check
codex-usage-guard profile
```

When plans change, deadlines move, or you need a short exception:

```sh
codex-usage-guard extend       # add one profile-specific step
codex-usage-guard unlock       # stop blocking until the quota resets
codex-usage-guard reset-overrides
```

## Choose your installation path

| Path             | Best for                     | What it does                                            |
| ---------------- | ---------------------------- | ------------------------------------------------------- |
| Release binary   | Most users                   | Installs quickly without Bun, Node.js, npm, or Homebrew |
| Homebrew Formula | Homebrew users               | Builds the executable locally with Bun                  |
| From source      | Contributors and development | Gives you the full test and build workflow              |

Releases include standalone archives for macOS arm64/x64 and Linux arm64/x64,
plus a `SHA256SUMS` manifest.

## Configure only when you need to

Safe defaults work without a configuration file. When you want to tune pacing,
freshness, workdays, or missing-data behavior:

```sh
codex-usage-guard config-path
```

Then copy [example-config.toml](example-config.toml) to the reported path.
The complete option reference and behavior guide is in
[Usage and configuration](docs/usage-and-configuration.md).

## Documentation

- [Usage and configuration](docs/usage-and-configuration.md) — commands, profiles, pacing, configuration, files, and exit codes;
- [Codex integration contract](docs/codex-integration.md) — App Server, hook, fallback, and data-source details;
- [Example configuration](example-config.toml) — a commented starting point;
- [Deployment](DEPLOYMENT.md) — repeatable GitHub Release and Homebrew tap checklist;
- [Security policy](SECURITY.md) — vulnerability reporting and security scope.

## Development

Building requires Bun `1.3.14`:

```sh
bun install --frozen-lockfile
bun run lint
bun test
bun run test:coverage
bun run build
./dist/codex-usage-guard --help
```

Build a standalone executable directly with:

```sh
bun build ./src/cli.ts --compile --outfile dist/codex-usage-guard
```

The project is MIT-licensed. See [LICENSE](LICENSE).

## Platforms and limitations

The tested distribution targets are macOS arm64/x64 and Linux arm64/x64. The
work profile supports Business/Enterprise on both operating systems.

Rate-limit field availability depends on the current Codex backend. Workdays
mean Monday through Friday; public and company holidays are not modelled. A
hook is a useful guardrail, not an absolute boundary for every internal Codex
execution path.
