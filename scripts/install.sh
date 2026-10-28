#!/bin/sh
# hud — terminal install: fetch the bundled CLI, verify it, put `hud` on PATH.
#
#   curl -fsSL https://raw.githubusercontent.com/CodeKnight314/hud/main/scripts/install.sh | sh
#
# Options (environment):
#   HUD_VERSION=0.3.0        install that release instead of the latest
#   HUD_HOME=~/.hud          install root (app/ + bin/hud)
#   HUD_REPO=owner/name      source repository
#   HUD_ASSET_DIR=/path      install from local assets instead of GitHub (testing/offline)
#   HUD_NO_PATH_EDIT=1       do not touch PATH or your shell rc; only print the line to add
set -eu

REPO="${HUD_REPO:-CodeKnight314/hud}"
HUD_HOME=${HUD_HOME:-"$HOME/.hud"}
VERSION=${HUD_VERSION:-}
NODE=$(command -v node 2>/dev/null || true)
TMP=$(mktemp -d "${TMPDIR:-/tmp}/hud-install.XXXXXX")
trap 'rm -rf "$TMP"' EXIT

say() { printf '%s\n' "$*" 2>/dev/null || true; }
die() { printf 'hud install: %s\n' "$*" >&2; exit 1; }

[ -n "$NODE" ] || { echo "hud needs Node.js 18 or newer: https://nodejs.org" >&2; exit 1; }
major=$("$NODE" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
[ "$major" -ge 18 ] 2>/dev/null || die "node $("$NODE" -v 2>/dev/null) is too old; hud needs 18+"

if [ -z "$VERSION" ]; then
  [ -n "${HUD_ASSET_DIR:-}" ] || {
    VERSION=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
      | grep -m1 '"tag_name"' | sed -E 's/.*"v?([0-9]+\.[0-9]+\.[0-9]+)".*/\1/')
    [ -n "$VERSION" ] || die "could not find the latest release of $REPO"
  }
fi

TARBALL=""
if [ -n "${HUD_ASSET_DIR:-}" ]; then
  TARBALL=$(find "$HUD_ASSET_DIR" -maxdepth 1 -name 'hud-*.tar.gz' | sort | tail -1)
  [ -n "$TARBALL" ] || die "no hud-*.tar.gz in $HUD_ASSET_DIR"
  VERSION=$(basename "$TARBALL" | sed -E 's/^hud-([0-9]+\.[0-9]+\.[0-9]+)\.tar\.gz$/\1/')
  cp "$TARBALL" "$HUD_ASSET_DIR/SHA256SUMS" "$TMP/"
else
  [ -n "$VERSION" ] || die "set HUD_VERSION (for example HUD_VERSION=0.3.0)"
  NAME="hud-$VERSION.tar.gz"
  BASE="https://github.com/$REPO/releases/download/v$VERSION"
  curl -fsSL "$BASE/$NAME" -o "$TMP/$NAME" || die "could not download $BASE/$NAME"
  curl -fsSL "$BASE/SHA256SUMS" -o "$TMP/SHA256SUMS" || die "could not download SHA256SUMS for v$VERSION"
fi

NAME="hud-$VERSION.tar.gz"
EXPECTED=$(grep -E "^[0-9a-f]{64}[[:space:]]+\*?$NAME\$" "$TMP/SHA256SUMS" | awk '{print $1}' | head -1)
[ -n "$EXPECTED" ] || die "SHA256SUMS does not list $NAME"
if command -v sha256sum >/dev/null 2>&1; then
  ACTUAL=$(sha256sum "$TMP/$NAME" | awk '{print $1}')
else
  ACTUAL=$(shasum -a 256 "$TMP/$NAME" | awk '{print $1}')
fi
[ "$ACTUAL" = "$EXPECTED" ] || die "$NAME does not match SHA256SUMS (expected $EXPECTED, got $ACTUAL)"

mkdir -p "$HUD_HOME/app.new" "$HUD_HOME/bin"
tar -xzf "$TMP/$NAME" -C "$HUD_HOME/app.new"
[ -f "$HUD_HOME/app.new/hud.mjs" ] && [ -d "$HUD_HOME/app.new/web" ] || die "the download is not a hud CLI bundle"

rm -rf "$HUD_HOME/app.old"
[ -d "$HUD_HOME/app" ] && mv "$HUD_HOME/app" "$HUD_HOME/app.old"
mv "$HUD_HOME/app.new" "$HUD_HOME/app"
rm -rf "$HUD_HOME/app.old"

cat > "$HUD_HOME/bin/hud" <<LAUNCHER
#!/bin/sh
exec "$NODE" "$HUD_HOME/app/hud.mjs" "\$@"
LAUNCHER
chmod 755 "$HUD_HOME/bin/hud"

# Make `hud` work as typed: link into a PATH directory we can write, else add a marked block to the
# login shell rc. Nothing is edited with HUD_NO_PATH_EDIT=1.
ensure_on_path() {
  case ":$PATH:" in *":$HUD_HOME/bin:"*) return 0 ;; esac
  [ -n "${HUD_NO_PATH_EDIT:-}" ] && return 1

  for dir in "$HOME/.local/bin" "$HOME/bin"; do
    case ":$PATH:" in
      *":$dir:"*)
        if [ -d "$dir" ] && [ -w "$dir" ] && ln -sf "$HUD_HOME/bin/hud" "$dir/hud" 2>/dev/null; then
          say "linked $dir/hud"
          return 0
        fi
        ;;
    esac
  done
  case ":$PATH:" in
    *":/usr/local/bin:"*)
      if [ -w /usr/local/bin ] && ln -sf "$HUD_HOME/bin/hud" /usr/local/bin/hud 2>/dev/null; then
        say "linked /usr/local/bin/hud"
        return 0
      fi
      ;;
  esac

  case "$(basename "${SHELL:-sh}")" in
    zsh) rc="$HOME/.zshrc" ;;
    bash)
      if [ "$(uname -s)" = Darwin ] && [ -f "$HOME/.bash_profile" ]; then rc="$HOME/.bash_profile"
      else rc="$HOME/.bashrc"; fi
      ;;
    *) rc="$HOME/.profile" ;;
  esac
  mkdir -p "$(dirname "$rc")"
  if grep -qF "$HUD_HOME/bin" "$rc" 2>/dev/null; then
    say "$rc already puts $HUD_HOME/bin on PATH"
  else
    printf '\n# hud: put the hud CLI on PATH\ncase ":$PATH:" in *":%s/bin:"*) ;; *) export PATH="%s/bin:$PATH" ;; esac\n' "$HUD_HOME" "$HUD_HOME" >> "$rc" || return 1
    say "added $HUD_HOME/bin to PATH in $rc"
  fi
  return 0
}

say "hud $VERSION installed at $HUD_HOME"
say "  hud                 start the server and open the board in your browser"
say "  hud status          server pid, port, data dir"
say "  hud update          install the next release"
say "  hud mcp install     register hud with Claude Code, Codex and OpenCode"
say ""
if ensure_on_path; then
  case ":$PATH:" in
    *":$HUD_HOME/bin:"*) say "run it now: hud" ;;
    *) say "open a new terminal, then run: hud (or right now: . \"$rc\" && hud)" ;;
  esac
else
  say "hud is not on PATH yet. Add it with:"
  say "  export PATH=\"$HUD_HOME/bin:\$PATH\""
  say "or run it by path now: $HUD_HOME/bin/hud"
fi
