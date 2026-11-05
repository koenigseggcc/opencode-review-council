#!/usr/bin/env bash
# install.sh — install the review-council plugin into an OpenCode configuration directory.
#
# Usage:
#   scripts/install.sh [--link] [--force] [--dry-run] [--config-dir DIR]
#
# Options:
#   --link              Symlink the files into the config dir instead of copying them, so
#                       edits to this checkout apply directly (development workflow).
#   --force             Overwrite existing files without backing them up.
#   --dry-run           Print the actions without changing anything.
#   --config-dir DIR    OpenCode configuration directory.
#                       Default: ${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}
#   -h, --help          Show this help.
#
# Existing files are backed up under <config-dir>/.backups/ before being replaced.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

link=0
force=0
dry_run=0
config_dir="${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}"

usage() {
  sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --link) link=1 ;;
    --force) force=1 ;;
    --dry-run) dry_run=1 ;;
    --config-dir)
      shift
      if [ $# -eq 0 ]; then echo "install: --config-dir requires a value" >&2; exit 2; fi
      config_dir="$1"
      ;;
    --config-dir=*) config_dir="${1#--config-dir=}" ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "install: unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

config_dir="${config_dir/#\~/$HOME}"
if [ -z "$config_dir" ]; then
  echo "install: the config directory cannot be empty" >&2
  exit 2
fi

stamp="$(date +%Y%m%d-%H%M%S)"
backup_dir="$config_dir/.backups/opencode-review-council-$stamp"

FILES=(
  "plugins/council.ts"
  "commands/council.md"
  "commands/council_followup.md"
  "agents/council-reviewer.md"
  "agents/council-chair.md"
)

say() { printf '%s\n' "$*"; }

installed=0
skipped=0

for rel in "${FILES[@]}"; do
  src="$REPO_DIR/$rel"
  dst="$config_dir/$rel"
  if [ ! -f "$src" ]; then
    echo "install: missing source file $src" >&2
    exit 1
  fi

  if [ "$link" = 1 ] && [ -L "$dst" ] && [ "$(readlink "$dst")" = "$src" ]; then
    say "ok       $dst (already linked)"
    skipped=$((skipped + 1))
    continue
  fi
  if [ "$link" = 0 ] && [ ! -L "$dst" ] && [ -f "$dst" ] && cmp -s "$src" "$dst"; then
    say "ok       $dst (already up to date)"
    skipped=$((skipped + 1))
    continue
  fi

  if [ -e "$dst" ] || [ -L "$dst" ]; then
    if [ "$force" = 1 ]; then
      say "replace  $dst (--force, no backup)"
    elif [ -L "$dst" ]; then
      say "backup   $dst -> $backup_dir/$rel.link"
      if [ "$dry_run" = 0 ]; then
        mkdir -p "$(dirname "$backup_dir/$rel")"
        readlink "$dst" >"$backup_dir/$rel.link"
      fi
    else
      say "backup   $dst -> $backup_dir/$rel"
      if [ "$dry_run" = 0 ]; then
        mkdir -p "$(dirname "$backup_dir/$rel")"
        cp -p "$dst" "$backup_dir/$rel"
      fi
    fi
    if [ "$dry_run" = 0 ]; then rm -f "$dst"; fi
  fi

  if [ "$dry_run" = 0 ]; then mkdir -p "$(dirname "$dst")"; fi
  if [ "$link" = 1 ]; then
    say "link     $dst -> $src"
    if [ "$dry_run" = 0 ]; then ln -s "$src" "$dst"; fi
  else
    say "install  $src -> $dst"
    if [ "$dry_run" = 0 ]; then cp "$src" "$dst"; fi
  fi
  installed=$((installed + 1))
done

say ""
if [ "$dry_run" = 1 ]; then
  say "Dry run: $installed file(s) would be installed, $skipped already in place. Nothing was changed."
  exit 0
fi
say "Installed $installed file(s); $skipped already in place."
say "Config directory: $config_dir"
if [ "$installed" -gt 0 ] && [ "$force" = 0 ]; then
  say "Previous versions (if any) were backed up under: $backup_dir"
fi
say ""
say "OpenCode reloads configuration automatically; run /reload in the TUI to force it."
say "Try it with: /council    (or ask the agent to call the council tool)"
say "Tests: cd \"$REPO_DIR\" && npm ci --legacy-peer-deps && npm test"
