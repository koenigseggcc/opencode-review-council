#!/usr/bin/env bash
# scan-secrets.sh — scan the repository for credentials and personal paths before publishing.
#
# Usage: scripts/scan-secrets.sh
# Exits non-zero when a potential secret or personal path is found.

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

PATTERNS=(
  '-----BEGIN [A-Z ]*PRIVATE KEY-----'
  'AKIA[0-9A-Z]{16}'
  'ASIA[0-9A-Z]{16}'
  'ghp_[A-Za-z0-9]{20,}'
  'gho_[A-Za-z0-9]{20,}'
  'github_pat_[A-Za-z0-9_]{20,}'
  'xox[baprs]-[A-Za-z0-9-]{10,}'
  'sk-[A-Za-z0-9_-]{20,}'
  'AIza[0-9A-Za-z_-]{30,}'
  'eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.'
  'Bearer [A-Za-z0-9._-]{20,}'
  'mongodb(\+srv)?://[^ 	"]*:[^ @"]*@'
  "(password|passwd|secret|api[_-]?key|access[_-]?token|client[_-]?secret)[\"']?[[:space:]]*[:=][[:space:]]*[\"'][^\"']{8,}"
  '/Users/[A-Za-z0-9._-]+'
  '/home/[A-Za-z0-9._-]+'
)

# Placeholder names that are fine to keep in documentation examples.
PLACEHOLDERS='(/Users/(you|user|example)|/home/(me|user|example))'

status=0
for pattern in "${PATTERNS[@]}"; do
  hits="$(grep -RInE --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=.backups -- "$pattern" . 2>/dev/null || true)"
  hits="$(printf '%s\n' "$hits" | grep -Ev "$PLACEHOLDERS" || true)"
  if [ -n "$hits" ]; then
    printf 'potential match: %s\n' "$pattern"
    printf '%s\n' "$hits" | sed 's/^/  /'
    printf '\n'
    status=1
  fi
done

if [ "$status" = 0 ]; then
  printf 'scan-secrets: clean\n'
else
  printf 'scan-secrets: review the matches above before publishing\n' >&2
fi
exit "$status"
