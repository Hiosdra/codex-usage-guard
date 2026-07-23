# Deployment checklist

Use this checklist for every release. There are two repositories to update:

1. [`Hiosdra/codex-usage-guard`](https://github.com/Hiosdra/codex-usage-guard) — tag and GitHub Release;
2. [`Hiosdra/homebrew-tap`](https://github.com/Hiosdra/homebrew-tap) — Homebrew formula.

There is no npm package to publish. GitHub Release provides standalone binaries;
Homebrew builds the program from source with Bun.

## 1. Create the GitHub Release

In `codex-usage-guard`:

- [ ] Bump `package.json` to `X.Y.Z`.
- [ ] Update any pinned version in `README.md`.
- [ ] Run the local checks.
- [ ] Open a PR and merge it into `master` after CI passes.

```sh
bun install --frozen-lockfile
bun run lint
bun run test:coverage
```

After the PR is merged, create the tag from the updated `master`:

```sh
git switch master
git pull --ff-only origin master

release_version=0.3.0
test "$(bun -e 'const pkg = await Bun.file("package.json").json(); console.log(pkg.version)')" = "$release_version"

git tag -a "v$release_version" -m "codex-usage-guard v$release_version"
git push origin "v$release_version"
```

The tag starts `.github/workflows/release.yml`. It verifies the version,
runs CI, builds macOS/Linux arm64/x64 archives, and publishes the GitHub
Release with `SHA256SUMS`.

```sh
gh run list --workflow release.yml --limit 3
gh release view "v$release_version"
```

## 2. Update the Homebrew tap

Wait until the GitHub Release exists, then calculate the checksum of its source
archive:

```sh
release_version=0.3.0
curl -fL "https://github.com/Hiosdra/codex-usage-guard/archive/refs/tags/v$release_version.tar.gz" --output "/tmp/codex-usage-guard-v$release_version.tar.gz"
shasum -a 256 "/tmp/codex-usage-guard-v$release_version.tar.gz"
```

In `hiosdra/homebrew-tap`:

```sh
git clone git@github.com:Hiosdra/homebrew-tap.git
cd homebrew-tap
git switch -c "agent/release-$release_version" origin/master
```

Update `Formula/codex-usage-guard.rb`:

- [ ] Set `url` to the new `v$release_version` archive.
- [ ] Replace `sha256` with the checksum from the previous command.
- [ ] Keep the `cug` symlink:

```ruby
bin.install_symlink "codex-usage-guard" => "cug"
```

- [ ] Test both command names with `--help`.
- [ ] Check the diff and open a PR to `master`.

```sh
git diff --check
git add Formula/codex-usage-guard.rb
git commit -m "Update codex-usage-guard formula to $release_version"
git push --set-upstream origin "agent/release-$release_version"
gh pr create --base master --head "agent/release-$release_version" --title "Update codex-usage-guard formula to $release_version" --body "Update the Homebrew formula to v$release_version."
```

Merge the tap PR only after the `tap` / `audit` workflow passes.

## 3. Verify the published version

```sh
brew trust hiosdra/tap
brew update
brew install hiosdra/tap/codex-usage-guard

codex-usage-guard --help
cug --help
```

For an existing installation:

```sh
brew upgrade hiosdra/tap/codex-usage-guard
brew info hiosdra/tap/codex-usage-guard
```

## Important reminders

- Create the tag only after the main PR is merged.
- Do not move an existing tag to another commit. Fix the release and use a new
  tag instead.
- Calculate `sha256` from the exact GitHub archive referenced by the formula.
- The Homebrew formula builds from source and needs Bun; the GitHub Release
  archives are standalone.
