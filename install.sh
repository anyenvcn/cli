#!/usr/bin/env sh
set -eu

BASE_URL="${ANYENV_CLI_BASE_URL:-https://api.anyenv.cn/api/v1/cli}"
VERSION="${ANYENV_VERSION:-latest}"

is_temporary_path() {
  target="$1"
  if [ -n "${TMPDIR:-}" ]; then
    case "$target" in
      "$TMPDIR"*) return 0 ;;
    esac
  fi
  case "$target" in
    /tmp/*|/private/tmp/*|/var/tmp/*|/private/var/tmp/*|/var/folders/*/T/*|/private/var/folders/*/T/*) return 0 ;;
  esac
  return 1
}

default_install_dir() {
  existing="$(command -v anyenv 2>/dev/null || true)"
  if [ -n "$existing" ]; then
    existing_dir="$(dirname "$existing")"
    if [ -w "$existing_dir" ] && ! is_temporary_path "$existing"; then
      printf '%s\n' "$existing_dir"
      return
    fi
  fi
  printf '%s\n' "$HOME/.local/bin"
}

INSTALL_DIR="${ANYENV_INSTALL_DIR:-$(default_install_dir)}"
PATH_PRECEDENCE_WARNING=0

OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"

case "$OS" in
  darwin) OS="darwin" ;;
  linux) OS="linux" ;;
  *) echo "Unsupported OS: $OS" >&2; exit 1 ;;
esac

case "$ARCH" in
  x86_64|amd64) ARCH="x64" ;;
  arm64|aarch64) ARCH="arm64" ;;
  *) echo "Unsupported architecture: $ARCH" >&2; exit 1 ;;
esac

ASSET="anyenv-${OS}-${ARCH}.tar.gz"
URL="${BASE_URL%/}/releases/${VERSION}/download/${ASSET}"
CHECKSUM_URL="${BASE_URL%/}/releases/${VERSION}/download/SHA256SUMS"
CLI_BASE="${BASE_URL%/}"
API_BASE="${CLI_BASE%/cli}"

TMP_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

curl_download() {
  url="$1"
  output="$2"
  if [ "${ANYENV_NO_PROGRESS:-}" = "1" ]; then
    curl -fsSL "$url" -o "$output"
  else
    curl -fL --progress-bar "$url" -o "$output"
  fi
}

echo "Downloading ${URL}"
curl_download "$URL" "$TMP_DIR/$ASSET"
echo "Downloading ${CHECKSUM_URL}"
curl_download "$CHECKSUM_URL" "$TMP_DIR/SHA256SUMS"
EXPECTED="$(awk -v asset="$ASSET" '$2 == asset { print $1; exit }' "$TMP_DIR/SHA256SUMS")"
if [ -z "$EXPECTED" ]; then
  echo "Checksum for $ASSET not found in SHA256SUMS" >&2
  exit 1
fi
if command -v sha256sum >/dev/null 2>&1; then
  ACTUAL="$(sha256sum "$TMP_DIR/$ASSET" | awk '{ print $1 }')"
elif command -v shasum >/dev/null 2>&1; then
  ACTUAL="$(shasum -a 256 "$TMP_DIR/$ASSET" | awk '{ print $1 }')"
elif command -v openssl >/dev/null 2>&1; then
  ACTUAL="$(openssl dgst -sha256 "$TMP_DIR/$ASSET" | awk '{ print $NF }')"
else
  echo "No SHA-256 tool found. Install sha256sum, shasum, or openssl." >&2
  exit 1
fi
if [ "$(printf '%s' "$ACTUAL" | tr '[:upper:]' '[:lower:]')" != "$(printf '%s' "$EXPECTED" | tr '[:upper:]' '[:lower:]')" ]; then
  echo "Checksum mismatch for $ASSET" >&2
  echo "Expected: $EXPECTED" >&2
  echo "Actual:   $ACTUAL" >&2
  exit 1
fi
tar -xzf "$TMP_DIR/$ASSET" -C "$TMP_DIR"
BIN="$(find "$TMP_DIR" -type f -name anyenv | head -n 1)"
if [ -z "$BIN" ]; then
  echo "AnyEnv CLI binary not found in archive" >&2
  exit 1
fi

mkdir -p "$INSTALL_DIR"
INSTALL_TARGET="$INSTALL_DIR/anyenv"
INSTALL_TMP="$INSTALL_TARGET.tmp.$$"
cp "$BIN" "$INSTALL_TMP"
chmod 755 "$INSTALL_TMP"
mv -f "$INSTALL_TMP" "$INSTALL_TARGET"

canonical_path() {
  target="$1"
  dir="$(dirname "$target")"
  base="$(basename "$target")"
  if [ -d "$dir" ]; then
    dir="$(cd "$dir" 2>/dev/null && pwd -P || printf '%s' "$dir")"
  fi
  printf '%s/%s\n' "$dir" "$base"
}

path_contains_install_dir() {
  case ":${PATH:-}:" in
    *":$INSTALL_DIR:"*) return 0 ;;
    *) return 1 ;;
  esac
}

profile_path_line() {
  if [ "$INSTALL_DIR" = "$HOME/.local/bin" ]; then
    printf '%s\n' 'export PATH="$HOME/.local/bin:$PATH"'
    return
  fi
  escaped="$(printf '%s' "$INSTALL_DIR" | sed "s/'/'\\\\''/g")"
  printf 'export PATH='\''%s'\'':"$PATH"\n' "$escaped"
}

fish_path_line() {
  escaped="$(printf '%s' "$INSTALL_DIR" | sed "s/\\\\/\\\\\\\\/g; s/\"/\\\\\"/g")"
  printf 'fish_add_path "%s"\n' "$escaped"
}

append_path_to_file() {
  target="$1"
  line="$2"
  [ -n "$target" ] || return 0
  mkdir -p "$(dirname "$target")"
  if [ -f "$target" ] && grep -q "AnyEnv PATH" "$target"; then
    return 0
  fi
  {
    printf '\n# >>> AnyEnv PATH >>>\n'
    printf '%s\n' "$line"
    printf '# <<< AnyEnv PATH <<<\n'
  } >> "$target"
  echo "Added $INSTALL_DIR to PATH in $target"
}

configure_path() {
  path_line="$(profile_path_line)"
  resolved_anyenv="$(command -v anyenv 2>/dev/null || true)"
  if [ -n "$resolved_anyenv" ] && [ "$(canonical_path "$resolved_anyenv")" = "$(canonical_path "$INSTALL_DIR/anyenv")" ]; then
    echo "AnyEnv CLI is already on PATH: $resolved_anyenv"
    return 0
  fi

  if path_contains_install_dir; then
    PATH_PRECEDENCE_WARNING=1
    echo "Installed AnyEnv CLI directory is on PATH, but another anyenv command appears earlier in this shell."
    [ -n "$resolved_anyenv" ] && echo "Active AnyEnv CLI: $resolved_anyenv"
    echo "Installed AnyEnv CLI: $INSTALL_DIR/anyenv"
    print_current_shell_fix
    return 0
  fi

  shell_name="$(basename "${SHELL:-}")"
  case "$shell_name" in
    zsh)
      append_path_to_file "$HOME/.zshrc" "$path_line"
      ;;
    bash)
      append_path_to_file "$HOME/.bashrc" "$path_line"
      if [ "${OS:-}" = "darwin" ]; then
        append_path_to_file "$HOME/.bash_profile" "$path_line"
      fi
      ;;
    fish)
      append_path_to_file "$HOME/.config/fish/config.fish" "$(fish_path_line)"
      ;;
    *)
      append_path_to_file "$HOME/.profile" "$path_line"
      ;;
  esac

  echo "Open a new terminal, or run this now:"
  echo "  $path_line"
}

print_current_shell_fix() {
  path_line="$(profile_path_line)"
  echo "Run this in your current shell to use the updated CLI now:"
  echo "  $path_line"
  echo "  hash -r 2>/dev/null || true"
  echo "  anyenv --version"
}

verify_active_anyenv() {
  installed_anyenv="$INSTALL_DIR/anyenv"
  installed_version="$("$installed_anyenv" --version 2>/dev/null || true)"
  resolved_anyenv="$(command -v anyenv 2>/dev/null || true)"
  installed_canonical="$(canonical_path "$installed_anyenv")"

  if [ -z "$resolved_anyenv" ]; then
    [ -n "$installed_version" ] && echo "Installed AnyEnv CLI version: $installed_version"
    echo "AnyEnv CLI is not available on PATH in this shell."
    print_current_shell_fix
    return 0
  fi

  resolved_canonical="$(canonical_path "$resolved_anyenv")"
  active_version="$(anyenv --version 2>/dev/null || true)"
  if [ "$resolved_canonical" != "$installed_canonical" ]; then
    if is_temporary_path "$resolved_anyenv"; then
      echo "Warning: your current shell resolves the anyenv command to a temporary path."
    else
      echo "Warning: the AnyEnv CLI on your PATH is not the one just installed."
    fi
    echo "Active AnyEnv CLI: $resolved_anyenv"
    [ -n "$active_version" ] && echo "Active AnyEnv CLI version: $active_version"
    echo "Installed AnyEnv CLI: $installed_anyenv"
    [ -n "$installed_version" ] && echo "Installed AnyEnv CLI version: $installed_version"
    if [ "${PATH_PRECEDENCE_WARNING:-0}" != "1" ]; then
      print_current_shell_fix
    fi
    return 0
  fi

  echo "Active AnyEnv CLI: $resolved_anyenv"
  [ -n "$active_version" ] && echo "Active AnyEnv CLI version: $active_version"
  echo "Run: anyenv --version"
}

configure_api_base() {
  if [ "${ANYENV_SKIP_CONFIG:-}" = "1" ] || [ "$API_BASE" = "$CLI_BASE" ]; then
    return 0
  fi
  config_file="${ANYENV_CONFIG:-$HOME/.anyenv/config.json}"
  config_dir="$(dirname "$config_file")"
  mkdir -p "$config_dir"
  chmod 700 "$config_dir" 2>/dev/null || true
  if [ ! -f "$config_file" ]; then
    umask 077
    {
      printf '{\n'
      printf '  "apiBase": "%s"\n' "$API_BASE"
      printf '}\n'
    } > "$config_file"
    chmod 600 "$config_file" 2>/dev/null || true
    echo "Configured AnyEnv API base: $API_BASE"
    return 0
  fi
  if command -v python3 >/dev/null 2>&1; then
    python3 - "$config_file" "$API_BASE" <<'PY'
import json
import os
import sys
from pathlib import Path

path = Path(sys.argv[1])
api_base = sys.argv[2].rstrip("/")
default_api = "https://api.anyenv.cn/api/v1"

try:
    data = json.loads(path.read_text(encoding="utf-8") or "{}")
except Exception:
    print(f"Existing AnyEnv config is not valid JSON; preserved: {path}")
    raise SystemExit(0)

stored_api = str(data.get("apiBase") or "").rstrip("/")
has_auth = bool(data.get("projectToken") or data.get("accessToken"))
if has_auth or (stored_api and stored_api != default_api):
    print(f"Existing AnyEnv config preserved: {path}")
    raise SystemExit(0)

data["apiBase"] = api_base
path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
try:
    os.chmod(path, 0o600)
except OSError:
    pass
print(f"Configured AnyEnv API base: {api_base}")
PY
  else
    echo "Existing AnyEnv config preserved: $config_file"
    echo "To use this API for login now: ANYENV_API_BASE=$API_BASE anyenv login"
  fi
}

echo "Installed AnyEnv CLI to $INSTALL_DIR/anyenv"
configure_api_base
echo "Config preserved. Updating AnyEnv does not require re-login; run anyenv login only for first-time setup, account switch, or environment switch."
configure_path
verify_active_anyenv
