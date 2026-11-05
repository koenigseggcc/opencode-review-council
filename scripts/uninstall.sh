#!/usr/bin/env bash
# uninstall.sh — remove the review-council plugin from an OpenCode configuration directory.
#
# Usage:
#   scripts/uninstall.sh [--force] [--dry-run] [--config-dir DIR]
#
# Options:
#   --force             Remove files even when they were modified or are foreign symlinks.
#   --dry-run           Print the actions without changing anything.
#   --config-dir DIR    OpenCode configuration directory.
#                       Default: ${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}
#   -h, --help          Show this help.
#
# Only the files this repository installs are considered. Unmodified copies and symlinks
# into this checkout are removed; modified files are left alone unless --force is given.
# Backups created by install.sh are never deleted.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

force=0
dry_run=0
config_dir="${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}"

usage() {
  sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --force) force=1 ;;
    --dry-run) dry_run=1 ;;
    --config-dir)
      shift
      if [ $# -eq 0 ]; then echo "uninstall: --config-dir requires a value" >&2; exit 2; fi
      config_dir="$1"
      ;;
    --config-dir=*) config_dir="${1#--config-dir=}" ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "uninstall: unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

config_dir="${config_dir/#\~/$HOME}"
if [ -z "$config_dir" ]; then
  echo "uninstall: the config directory cannot be empty" >&2
  exit 2
fi

FILES=(
  "plugins/council.ts"
  "commands/council.md"
  "commands/council_followup.md"
  "agents/council-reviewer.md"
  "agents/council-chair.md"
)

say() { printf '%s\n' "$*"; }

removed=0
skipped=0

for rel in "${FILES[@]}"; do
  src="$REPO_DIR/$rel"
  dst="$config_dir/$rel"

  if [ ! -e "$dst" ] && [ ! -L "$dst" ]; then
    say "absent   $dst"
    continue
  fi

  if [ -L "$dst" ]; then
    target="$(readlink "$dst")"
    case "$target" in
      "$REPO_DIR"/*)
        say "remove   $dst (link to this checkout)"
        if [ "$dry_run" = 0 ]; then rm -f "$dst"; fi
        removed=$((removed + 1))
        ;;
      *)
        if [ "$force" = 1 ]; then
          say "remove   $dst (foreign link -> $target, --force)"
          if [ "$dry_run" = 0 ]; then rm -f "$dst"; fi
          removed=$((removed + 1))
        else
          say "skip     $dst (symlink to $target, not this checkout; use --force)"
          skipped=$((skipped + 1))
        fi
        ;;
    esac
    continue
  fi

  if cmp -s "$src" "$dst"; then
    say "remove   $dst (matches this repository)"
    if [ "$dry_run" = 0 ]; then rm -f "$dst"; fi
    removed=$((removed + 1))
  elif [ "$force" = 1 ]; then
    say "remove   $dst (modified, --force)"
    if [ "$dry_run" = 0 ]; then rm -f "$dst"; fi
    removed=$((removed + 1))
  else
    say "skip     $dst (modified since install; use --force to remove)"
    skipped=$((skipped + 1))
  fi
done

say ""
if [ "$dry_run" = 1 ]; then
  say "Dry run: $removed file(s) would be removed, $skipped skipped. Nothing was changed."
  exit 0
fi
say "Removed $removed file(s); $skipped skipped."
say "Config directory: $config_dir"
say "Backups under $config_dir/.backups/ were left untouched."
say "OpenCode reloads configuration automatically; run /reload in the TUI to force it."
