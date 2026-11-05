# opencode-review-council

A three-model code-review council plugin for [OpenCode](https://opencode.ai) V2.

The council tool convenes three independent reviewers, each in its own throwaway git
worktree with the change applied. They can run tests and cross-reference other
repositories, then return structured findings. A chair model merges the three reviews
into a report with a consensus matrix (unanimous / majority / single-reviewer findings)
and a prioritized action list. Give the council further feedback after a report and it
re-runs all three reviewers on the same target.

## Requirements

- OpenCode V2 with the `@opencode/plugin` 2.2.5 plugin API (the host provides
  `@opencode/plugin` and `effect` at runtime).
- Node.js >= 22.6 for running the test suite (tests only).

## Install

```sh
git clone <your-fork-url> ~/code/opencode-review-council
~/code/opencode-review-council/scripts/install.sh
```

The installer copies the plugin, agents, and the `/council` command into your OpenCode
configuration directory (`~/.config/opencode` by default):

| repository | installed to |
|---|---|
| `plugins/council.ts` | `~/.config/opencode/plugins/council.ts` |
| `commands/council*.md` | `~/.config/opencode/commands/` |
| `agents/council-*.md` | `~/.config/opencode/agents/` |

Options:

```sh
scripts/install.sh --link        # symlink instead of copy (edits in this checkout apply live)
scripts/install.sh --dry-run     # show what would happen
scripts/install.sh --force       # overwrite without backing up
scripts/install.sh --config-dir /path/to/opencode-config
```

`OPENCODE_CONFIG_DIR` and `XDG_CONFIG_HOME` are respected. Files that already exist are
backed up under `<config-dir>/.backups/opencode-review-council-<timestamp>/` before being
replaced. OpenCode reloads configuration automatically; run `/reload` in the TUI to
force a reload.

Then create your council model configuration (see [Configuration](#configuration)). The
installer never writes or overwrites it.

## Uninstall

```sh
~/code/opencode-review-council/scripts/uninstall.sh
```

The uninstaller removes only the files this repository installs. Symlinks into this
checkout and unmodified copies are removed; files you have edited are left in place
unless you pass `--force`. Backups are never deleted. It supports the same `--dry-run`
and `--config-dir` options.

## Usage

- `/council` — review the working-tree diff.
- `/council 1234` — review PR #1234.
- `/council main...HEAD` — review a branch or commit range.
- `/council src/` — review changes under a path.
- `/council -look for race conditions` — focus guidance for the reviewers.
- `/council_followup <feedback>` — give the council further feedback; it re-runs all three
  reviewers and the chair on the same target from this session.

A numeric request is treated as a PR number unless a file or directory with that name exists
in the repository; in that case the number is treated as a path.

Or call the `council` tool directly with `request`, `focus`, and `allowPr` inputs.
Reviewing a PR authored by someone else requires `allowPr: true`, because the PR's code
is fetched and run in a sandbox on your machine. For PRs, the head commit is fetched to a
run-private ref and the patch and every sandbox are derived from that same commit, so a
PR update cannot change the code under review mid-run.

After a report, send further feedback with `/council_followup` or the `council_followup`
tool. It re-runs the full council on the same target as the prior run in this session,
passing your feedback to every reviewer. If this session has no prior run, it asks you to
run `/council` first. Each follow-up creates fresh sessions and sandboxes, and records a
new run.

## Configuration

The plugin reads the reviewer and chair models from a local JSON file, by default
`~/.config/opencode/council.json`. The file is not part of this repository and is not
installed by `scripts/install.sh`; create it yourself:

```json
{
  "reviewers": [
    { "name": "alpha", "label": "Alpha", "code": "A", "model": "provider/model-a#variant" },
    { "name": "beta", "label": "Beta", "code": "B", "model": "provider/model-b#variant" },
    { "name": "gamma", "label": "Gamma", "code": "G", "model": "provider/model-c" }
  ],
  "chair": "provider/chair-model#variant"
}
```

- `name` is the stable reviewer identifier.
- `label` is the display name; it defaults to `name`.
- `code` is the single character used for matrix votes; it defaults to the first
  character of `name`, uppercased.
- `model` and `chair` are OpenCode model references: `provider/model` or
  `provider/model#variant`.

Exactly three reviewers are required, and reviewer names and codes must be unique.
The plugin resolves the config in this order:

1. `OPENCODE_COUNCIL_CONFIG` — path to the config file.
2. `$OPENCODE_CONFIG_DIR/council.json`.
3. `$XDG_CONFIG_HOME/opencode/council.json`.
4. `~/.config/opencode/council.json`.

If the file is missing or invalid, the council tool returns an error and starts no
reviewers, sandboxes, patches, or sessions. The config is read once per council run, so
changes apply to the next run without `/reload`.

The plugin expects two subagents, installed from `agents/`: `council-reviewer`, shared by
all three reviewers, and `council-chair`. Neither agent pins a model; the plugin passes
the configured reviewer and chair models when it creates their sessions.

## Security and privacy

- The diff under review (including modified tracked files and non-secret untracked
  files) is written to `.git/opencode-council/` in the reviewed repository and sent to
  the configured model providers.
- Secret-like untracked files (`.env*`, `.envrc`, `*.pem`, `*.key`, `*.p12`, `*.pfx`,
  `*.jks`, `id_*`, `credentials*`, `.npmrc`, `.netrc`, `.pypirc`,
  `.git-credentials`, `.kube/config`) are excluded from patches and sandboxes by
  name/path. Content of tracked files is not scanned: do not review changes that contain
  credentials.
- Symlinked and other non-regular untracked entries are never followed, copied, or added
  to the patch. A failed `git diff --no-index` is treated as an omission, never as an
  empty file.
- Each reviewer runs in its own throwaway worktree. If a sandbox cannot be created, that
  reviewer fails with an error instead of falling back to the main checkout. Follow-ups
  are full runs and follow the same rule.
- A follow-up re-runs the full council on the prior target from the same session, with the
  feedback passed to every reviewer. It resolves the target again, so it reviews the
  current state of that target and records a new pinned run. If this session has no prior
  run, it refuses and asks you to run `/council` first.
- The last run's target is recorded per session under `.git/opencode-council/sessions/`.
  Records unused for 30 days are pruned at the next council run. The latest full patch is
  kept in `.git/opencode-council/` for inspection; older patches are pruned at the next run.
- Reviewer permission lists are guardrails, not a security boundary. Reviewers run with
  your user privileges in a git worktree sandbox, and the reviewed content is untrusted
  input: prompt injection in a diff could lead to code execution. Do not point the
  council at untrusted content unless you accept that risk.
- `scripts/scan-secrets.sh` scans this repository for credentials and personal paths.
  Run it before publishing.

## Development

```sh
npm ci --legacy-peer-deps   # dev dependencies for tests and typecheck
npm test                    # 53 tests
npm run typecheck
```

Repository layout:

```text
plugins/council.ts    the plugin (server part)
agents/               the two council subagents
commands/             the /council and /council_followup commands
test/                 node:test suite
scripts/              install, uninstall, secret scan
```

With `--link`, the installed files point back into this checkout, so changes here apply
to OpenCode directly. With a copy install, re-run `scripts/install.sh` after changes.

## License

MIT — see [LICENSE](LICENSE).
