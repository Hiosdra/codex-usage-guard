#!/bin/sh

set -eu

repo="${CODEX_USAGE_GUARD_REPO:-Hiosdra/codex-usage-guard}"
version="${CODEX_USAGE_GUARD_VERSION:-latest}"
prefix="${CODEX_USAGE_GUARD_INSTALL_DIR:-${HOME:-}/.local/bin}"

fail() {
  printf '%s\n' "codex-usage-guard installer: $*" >&2
  exit 1
}

command -v curl >/dev/null 2>&1 || fail "curl is required"
command -v tar >/dev/null 2>&1 || fail "tar is required"

os="$(uname -s)"
machine="$(uname -m)"

case "$os:$machine" in
  Darwin:arm64|Darwin:aarch64)
    target="darwin-arm64"
    ;;
  Darwin:x86_64|Darwin:amd64)
    target="darwin-x64"
    ;;
  Linux:arm64|Linux:aarch64)
    target="linux-arm64"
    ;;
  Linux:x86_64|Linux:amd64)
    target="linux-x64"
    ;;
  *)
    fail "unsupported platform: $os/$machine (supported: macOS and Linux on arm64 or x64)"
    ;;
esac

case "$version" in
  latest)
    latest_url="https://api.github.com/repos/$repo/releases/latest"
    version="$(curl -fsSL --proto '=https' --tlsv1.2 "$latest_url" \
      | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\(v[^"]*\)".*/\1/p' \
      | head -n 1)"
    [ -n "$version" ] || fail "could not determine the latest release"
    ;;
  v*)
    ;;
  *)
    version="v$version"
    ;;
esac

archive="codex-usage-guard-$target.tar.gz"
base_url="https://github.com/$repo/releases/download/$version"
temp_dir="$(mktemp -d 2>/dev/null || mktemp -d -t codex-usage-guard)"

cleanup() {
  rm -rf "$temp_dir"
}
trap cleanup EXIT INT TERM

curl -fsSL --proto '=https' --tlsv1.2 \
  "$base_url/$archive" -o "$temp_dir/$archive" \
  || fail "could not download $archive from $base_url"
curl -fsSL --proto '=https' --tlsv1.2 \
  "$base_url/SHA256SUMS" -o "$temp_dir/SHA256SUMS" \
  || fail "could not download SHA256SUMS from $base_url"

expected="$(awk -v file="$archive" '$2 == file { print $1; exit }' "$temp_dir/SHA256SUMS")"
[ -n "$expected" ] || fail "checksum for $archive is missing from SHA256SUMS"

if command -v sha256sum >/dev/null 2>&1; then
  actual="$(sha256sum "$temp_dir/$archive" | awk '{ print $1 }')"
elif command -v shasum >/dev/null 2>&1; then
  actual="$(shasum -a 256 "$temp_dir/$archive" | awk '{ print $1 }')"
else
  fail "sha256sum or shasum is required to verify the download"
fi

[ "$actual" = "$expected" ] || fail "checksum verification failed for $archive"

mkdir -p "$temp_dir/extracted"
tar -xzf "$temp_dir/$archive" -C "$temp_dir/extracted"
[ -f "$temp_dir/extracted/codex-usage-guard" ] \
  || fail "release archive does not contain codex-usage-guard"

mkdir -p "$prefix"
if command -v install >/dev/null 2>&1; then
  install -m 0755 "$temp_dir/extracted/codex-usage-guard" "$prefix/codex-usage-guard"
else
  cp "$temp_dir/extracted/codex-usage-guard" "$prefix/codex-usage-guard"
  chmod 0755 "$prefix/codex-usage-guard"
fi

printf '%s\n' "Installed codex-usage-guard $version for $target at $prefix/codex-usage-guard"
case ":${PATH:-}:" in
  *":$prefix:"*) ;;
  *) printf '%s\n' "Add $prefix to PATH to run: codex-usage-guard doctor" ;;
esac
printf '%s\n' "The Codex hook is unchanged. Run 'codex-usage-guard install-hook' when you are ready."
