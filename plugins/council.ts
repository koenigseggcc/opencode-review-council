import { Model, Plugin, type Location } from "@opencode/plugin"
import type { ToolContext } from "@opencode/plugin/promise/tool"
import { Schema } from "effect"
import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { cp, lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

type ShResult = { exitCode: number; stdout: string; stderr: string }

type ShCommand = {
  cwd(dir: string): ShCommand
  /** Decode stdout/stderr as latin1 so every byte round-trips (required for binary diffs). */
  binary(): ShCommand
  nothrow(): Promise<ShResult>
}

type Sh = (strings: TemplateStringsArray, ...values: unknown[]) => ShCommand

function makeShell(signal?: AbortSignal): Sh {
  const run = (strings: TemplateStringsArray, values: unknown[], cwd: string, encoding: BufferEncoding) =>
    new Promise<ShResult>((resolve) => {
      const args: string[] = []
      strings.forEach((part, index) => {
        args.push(...part.split(/\s+/).filter(Boolean))
        if (index < values.length) {
          const value = values[index]
          if (Array.isArray(value)) args.push(...value.map(String))
          else args.push(String(value))
        }
      })
      const [command, ...rest] = args
      execFile(
        command,
        rest,
        { cwd, maxBuffer: 64 * 1024 * 1024, timeout: 300_000, signal, encoding },
        (error, stdout, stderr) => {
          const code =
            error && typeof (error as { code?: unknown }).code === "number"
              ? (error as { code: number }).code
              : error
                ? 1
                : 0
          const message =
            error && typeof (error as { message?: unknown }).message === "string"
              ? (error as { message: string }).message
              : ""
          resolve({
            exitCode: code,
            stdout: stdout.toString(),
            stderr: stderr.toString() || (code !== 0 ? message : ""),
          })
        },
      )
    })
  const sh = (strings: TemplateStringsArray, ...values: unknown[]): ShCommand => {
    let dir = process.cwd()
    let encoding: BufferEncoding = "utf8"
    const command: ShCommand = {
      cwd(next) {
        dir = next
        return command
      },
      binary() {
        encoding = "latin1"
        return command
      },
      nothrow() {
        return run(strings, values, dir, encoding)
      },
    }
    return command
  }
  return sh
}

async function promptWithTimeout<T>(run: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  const timeout = new Promise<never>((_, reject) => {
    controller.signal.addEventListener(
      "abort",
      () => reject(new Error(`timed out after ${Math.round(ms / 60000)}m`)),
      { once: true },
    )
  })
  try {
    return await Promise.race([run(controller.signal), timeout])
  } finally {
    clearTimeout(timer)
  }
}

type Severity = "critical" | "major" | "minor" | "nit"

type Finding = {
  severity: Severity
  file: string
  line?: number
  title: string
  detail: string
  suggestion?: string
}

type ReviewOutput = {
  verdict: "approve" | "approve_with_comments" | "request_changes"
  summary: string
  findings: Finding[]
}

type ReviewerResult = {
  name: string
  label: string
  code: string
  status: "ok" | "failed"
  error?: string
  sessionID?: string
  verdict?: string
  summary?: string
  findings: Finding[]
  droppedFindings?: number
}

type Target =
  | { kind: "pr"; number: string }
  | { kind: "diff"; rev: string[] }
  | { kind: "focus"; focus: string }

type RunReviewer = {
  name?: string
  /** Legacy field from runs recorded before reviewers shared one agent. */
  agent?: string
  label: string
  sessionID?: string
  status: string
}

type RunRecord = {
  runId: string
  time: number
  target: string
  resolved: Target
  /** Session that started this run; follow-ups are scoped to it. */
  parentSessionID: string
  allowPr?: boolean
  /** Explicit focus guidance from the request, carried into follow-ups. */
  focus?: string
  includesWorktree: boolean
  scopedPath?: string
  baseSha?: string
  patchFile: string
  /** Omission/truncation note shown to the reviewers for this run. */
  note?: string
  reviewers: RunReviewer[]
}

/** Input accepted by the shared full-council run. `resolved` is internal to follow-ups. */
type CouncilInput = {
  readonly request?: string
  readonly focus?: string
  readonly allowPr?: boolean
  readonly resolved?: Target
  /** Feedback from a follow-up, appended to the focus for this run only. */
  readonly followUpFeedback?: string
}

function reviewerName(reviewer: RunReviewer): string {
  return reviewer.name ?? reviewer.agent?.replace(/^council-/, "") ?? "unknown"
}

function runRecordPath(stateRoot: string): string {
  return join(stateRoot, "opencode-council", "latest-run.json")
}

function sessionRecordFile(sessionID: string): string {
  return `${sessionID.replace(/[^a-zA-Z0-9._-]/g, "_")}.json`
}

function sessionRunRecordPath(stateRoot: string, sessionID: string): string {
  return join(stateRoot, "opencode-council", "sessions", sessionRecordFile(sessionID))
}

function isTarget(value: unknown): value is Target {
  if (!value || typeof value !== "object") return false
  const target = value as { kind?: unknown; number?: unknown; rev?: unknown; focus?: unknown }
  if (target.kind === "pr") return typeof target.number === "string" && target.number.length > 0
  if (target.kind === "diff") {
    return Array.isArray(target.rev) && target.rev.length > 0 && target.rev.every((part) => typeof part === "string")
  }
  if (target.kind === "focus") return typeof target.focus === "string" && target.focus.length > 0
  return false
}

const REVIEWER_AGENT = "council-reviewer"
const COUNCIL_REVIEWER_COUNT = 3

type ReviewerConfig = {
  name: string
  label: string
  code: string
  model: Model.Ref
}

type CouncilConfig = {
  reviewers: ReviewerConfig[]
  chair: Model.Ref
}

function expandHome(path: string): string {
  if (path === "~") return homedir()
  if (path.startsWith("~/")) return join(homedir(), path.slice(2))
  return path
}

function councilConfigPath(): string {
  const explicit = process.env.OPENCODE_COUNCIL_CONFIG?.trim()
  if (explicit) return expandHome(explicit)
  const base =
    process.env.OPENCODE_CONFIG_DIR?.trim() ||
    join(process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config"), "opencode")
  return join(expandHome(base), "council.json")
}

function configString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a non-empty string`)
  return value.trim()
}

function configModel(value: unknown, field: string): Model.Ref {
  const raw = configString(value, field)
  try {
    return Model.Ref.parse(raw)
  } catch {
    throw new Error(`${field} must be a model reference like "provider/model" or "provider/model#variant"`)
  }
}

async function loadCouncilConfig(): Promise<{ config: CouncilConfig; path: string } | { error: string }> {
  const path = councilConfigPath()
  let text: string
  try {
    text = await readFile(path, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
      const reason = error instanceof Error ? error.message : String(error)
      return { error: `Council aborted: could not read council model configuration at ${path}: ${reason}.` }
    }
    return {
      error: `Council aborted: no council model configuration at ${path}. Create a JSON file with three "reviewers" (each with "name" and "model") and a "chair" model.`,
    }
  }

  try {
    const raw = JSON.parse(text) as unknown
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("expected a JSON object")
    const body = raw as Record<string, unknown>
    if (!Array.isArray(body.reviewers)) throw new Error(`"reviewers" must be an array`)
    if (body.reviewers.length !== COUNCIL_REVIEWER_COUNT) {
      throw new Error(`exactly ${COUNCIL_REVIEWER_COUNT} reviewers are required, found ${body.reviewers.length}`)
    }

    const reviewers = body.reviewers.map((entry, index): ReviewerConfig => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error(`reviewers[${index}] must be an object`)
      }
      const reviewer = entry as Record<string, unknown>
      const name = configString(reviewer.name, `reviewers[${index}].name`)
      const label =
        reviewer.label === undefined ? name : configString(reviewer.label, `reviewers[${index}].label`)
      const rawCode =
        reviewer.code === undefined ? name.slice(0, 1) : configString(reviewer.code, `reviewers[${index}].code`)
      if (!/^[A-Za-z0-9]$/.test(rawCode)) {
        throw new Error(`reviewers[${index}].code must be a single letter or digit`)
      }
      const model = configModel(reviewer.model, `reviewers[${index}].model`)
      return { name, label, code: rawCode.toUpperCase(), model }
    })

    const names = new Set<string>()
    const codes = new Set<string>()
    for (const reviewer of reviewers) {
      const nameKey = reviewer.name.toLowerCase()
      if (names.has(nameKey)) throw new Error(`duplicate reviewer name "${reviewer.name}"`)
      if (codes.has(reviewer.code)) throw new Error(`duplicate reviewer code "${reviewer.code}"`)
      names.add(nameKey)
      codes.add(reviewer.code)
    }

    const chair = configModel(body.chair, "chair")
    return { config: { reviewers, chair }, path }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return { error: `Council aborted: invalid council model configuration at ${path}: ${reason}.` }
  }
}

const REVIEW_TIMEOUT_MS = 15 * 60 * 1000
const RUN_STALE_MS = 90 * 60 * 1000
const SANDBOX_GRACE_MS = 15 * 60 * 1000
/** Session follow-up records expire after this long without a council run. */
const SESSION_RECORD_STALE_MS = 30 * 24 * 60 * 60 * 1000
const MAX_PATCH_CHARS = 400_000
const MAX_PATCH_FILE_CHARS = 5_000_000
const MAX_FILE_DIFF_CHARS = 120_000
const MAX_UNTRACKED_FILES = 50
const MAX_SANDBOX_ENTRIES = 200
const MAX_UNTRACKED_BYTES = 20 * 1024 * 1024
const SEVERITY_RANK: Record<string, number> = { critical: 0, major: 1, minor: 2, nit: 3 }

const FINDINGS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    verdict: {
      type: "string",
      enum: ["approve", "approve_with_comments", "request_changes"],
      description: "Overall verdict for the change under review",
    },
    summary: {
      type: "string",
      description: "Two or three sentences summarizing the review",
    },
    findings: {
      type: "array",
      maxItems: 10,
      description: "Review findings ordered by severity",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          severity: { type: "string", enum: ["critical", "major", "minor", "nit"] },
          file: { type: "string", description: "Repository-relative file path" },
          line: { type: "integer", description: "Line number in the new version of the file" },
          title: { type: "string", description: "Short one-line issue title" },
          detail: { type: "string", description: "Evidence: what is wrong and why it matters" },
          suggestion: { type: "string", description: "Concrete suggested fix" },
        },
        required: ["severity", "file", "title", "detail"],
      },
    },
  },
  required: ["verdict", "summary", "findings"],
}

const MAX_REPAIR_PROBLEMS = 6

type RepairKind = "missing" | "invalid" | "partial"

/**
 * Follow-up sent to a reviewer whose turn did not yield a schema-valid review.
 * It carries the validator's exact complaints and the schema so the reviewer can
 * repair its payload in the same session instead of redoing the whole review.
 */
function buildRepairPrompt(kind: RepairKind, problems: string[]): string {
  const opening =
    kind === "missing"
      ? "Your previous turn ended before you produced the required JSON review."
      : kind === "partial"
        ? "Your previous turn's JSON had findings that do not match the required schema and were excluded."
        : "Your previous turn produced a JSON object that could not be accepted as a council review."
  const shown = problems.slice(0, MAX_REPAIR_PROBLEMS)
  const hidden = problems.length - shown.length
  return [
    opening,
    ...(shown.length > 0 ? ["", "Problems:", ...shown.map((problem) => `- ${problem}`)] : []),
    ...(hidden > 0 ? [`- ...and ${hidden} more`] : []),
    "",
    "Reply now with ONLY the corrected JSON object, exactly once, using the analysis you already did. Do not run any more commands or tools, and do not start over.",
    "Keep every finding that was already valid; fix or remove only the invalid ones. The JSON object must match this schema:",
    JSON.stringify(FINDINGS_SCHEMA),
  ].join("\n")
}

function tokens(text: string): Set<string> {
  const out = new Set<string>()
  for (const word of text.toLowerCase().split(/[^a-z0-9_]+/)) {
    if (word.length > 2) out.add(word)
  }
  return out
}

function overlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let shared = 0
  for (const word of a) if (b.has(word)) shared++
  return shared / (a.size + b.size - shared)
}

function sameFile(a: string, b: string): boolean {
  const clean = (value: string) => value.replace(/^\.\//, "").replace(/^\/+/, "").replace(/\/+$/, "")
  const left = clean(a)
  const right = clean(b)
  return left === right || left.endsWith(`/${right}`) || right.endsWith(`/${left}`)
}

function sameIssue(a: Finding, b: Finding): boolean {
  if (!sameFile(a.file, b.file)) return false
  const lineKnown = a.line != null && b.line != null
  if (lineKnown && Math.abs((a.line as number) - (b.line as number)) > 3) return false
  const titleScore = overlap(tokens(a.title), tokens(b.title))
  const bodyScore = overlap(tokens(`${a.title} ${a.detail}`), tokens(`${b.title} ${b.detail}`))
  if (titleScore >= 0.5) return lineKnown ? true : bodyScore >= 0.5
  return lineKnown && titleScore >= 0.34 && bodyScore >= 0.5
}

type Cluster = { members: { reviewer: ReviewerResult; finding: Finding }[] }

function leadFinding(cluster: Cluster): Finding {
  return [...cluster.members].sort(
    (a, b) => (SEVERITY_RANK[a.finding.severity] ?? 9) - (SEVERITY_RANK[b.finding.severity] ?? 9),
  )[0].finding
}

function buildClusters(results: ReviewerResult[]): Cluster[] {
  const clusters: Cluster[] = []
  for (const reviewer of results) {
    if (reviewer.status !== "ok") continue
    const ordered = [...reviewer.findings].sort(
      (a, b) => (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9),
    )
    for (const finding of ordered) {
      const existing = clusters.find((cluster) => {
        const lead = leadFinding(cluster)
        return (
          sameIssue(lead, finding) ||
          cluster.members.every((member) => sameIssue(member.finding, finding))
        )
      })
      if (existing) existing.members.push({ reviewer, finding })
      else clusters.push({ members: [{ reviewer, finding }] })
    }
  }
  const reviewerCount = (cluster: Cluster) => new Set(cluster.members.map((m) => m.reviewer.name)).size
  const severity = (cluster: Cluster) =>
    Math.min(...cluster.members.map((m) => SEVERITY_RANK[m.finding.severity] ?? 9))
  return clusters.sort((a, b) => reviewerCount(b) - reviewerCount(a) || severity(a) - severity(b))
}

function renderMatrix(clusters: Cluster[], results: ReviewerResult[], reviewers: ReviewerConfig[]): string {
  const completed = results.filter((reviewer) => reviewer.status === "ok").length
  const header = `${completed} of ${reviewers.length} reviewers completed.`
  if (completed === 0) return `${header} No review was produced.`
  if (clusters.length === 0) return `${header}\n\n_No findings were reported._`
  const rows = clusters.map((cluster, index) => {
    const lead = leadFinding(cluster)
    const voting = new Set(cluster.members.map((m) => m.reviewer.name))
    const votes = reviewers
      .filter((r) => voting.has(r.name))
      .map((r) => r.code)
      .join("")
    const location = lead.line != null ? `${lead.file}:${lead.line}` : lead.file
    const title = lead.title.replace(/\s+/g, " ").replace(/\|/g, "\\|")
    return `| ${index + 1} | ${lead.severity} | \`${location}\` | ${title} | ${votes} (${voting.size}/${reviewers.length}) |`
  })
  const table = ["| # | Severity | Location | Finding | Reviewers |", "|---|---|---|---|---|", ...rows].join("\n")
  return `${header}\n\n${table}`
}

async function resolveTarget(
  sh: Sh,
  root: string,
  request: string | undefined,
): Promise<Target> {
  const raw = (request ?? "").trim()
  if (!raw) return { kind: "diff", rev: ["HEAD"] }
  if (raw.startsWith("-")) return { kind: "focus", focus: raw }
  const single = !/\s/.test(raw)
  const pathLike = !raw.startsWith("/") && !raw.startsWith("..")
  if (pathLike && existsSync(join(root, raw))) return { kind: "diff", rev: ["HEAD", "--", raw] }
  if (/^\d+$/.test(raw)) return { kind: "pr", number: raw }
  if (single && !raw.startsWith("..") && /\.\.\.?/.test(raw)) return { kind: "diff", rev: [raw] }
  if (single) {
    const probe = await sh`git rev-parse --verify --quiet ${raw}`.cwd(root).nothrow()
    if (probe.exitCode === 0) return { kind: "diff", rev: [raw] }
  }
  return { kind: "focus", focus: raw }
}

function baseShaFor(resolved: Target): string | undefined {
  if (resolved.kind === "pr") return undefined
  if (resolved.kind === "diff") return rangeRightSide(resolved.rev[0]) ?? resolved.rev[0]
  return "HEAD"
}

function rangeRightSide(rev: string): string | undefined {
  if (!rev.includes("..")) return undefined
  const parts = rev.split(/\.\.\.?/)
  const right = parts[parts.length - 1]
  return right || "HEAD"
}

type PrEvidence = {
  headOid: string
  patch: string
  label: string
}

/**
 * Fetch a PR head and its base branch to run-private refs, then derive the patch from the
 * fetched head OID. Both the patch and every sandbox use that same commit, so a PR update or
 * another concurrent fetch cannot change what is under review.
 */
async function fetchPrEvidence(
  sh: Sh,
  root: string,
  number: string,
  runId: string,
): Promise<PrEvidence | { error: string }> {
  const failure = (step: string, result: ShResult) =>
    `Council aborted: ${step} failed for PR #${number}.\n\n${result.stderr.toString().slice(0, 1000)}`

  const view = await sh`gh pr view ${number} --json baseRefName --jq .baseRefName`.cwd(root).nothrow()
  const baseRefName = view.stdout.toString().trim()
  if (view.exitCode !== 0 || !baseRefName) {
    return { error: failure(`\`gh pr view ${number}\``, view) }
  }

  const headRef = `refs/council/${runId}/pr-${number}-head`
  const baseRef = `refs/council/${runId}/pr-${number}-base`
  const headSpec = `+pull/${number}/head:${headRef}`
  const baseSpec = `+${baseRefName}:${baseRef}`
  const headFetch = await sh`git fetch --quiet origin ${headSpec}`.cwd(root).nothrow()
  if (headFetch.exitCode !== 0) return { error: failure("fetching the PR head", headFetch) }
  const baseFetch = await sh`git fetch --quiet origin ${baseSpec}`.cwd(root).nothrow()
  if (baseFetch.exitCode !== 0) return { error: failure(`fetching the PR base branch \`${baseRefName}\``, baseFetch) }

  const resolve = async (ref: string) =>
    (await sh`git rev-parse --verify ${`${ref}^{commit}`}`.cwd(root).nothrow()).stdout.toString().trim()
  const headOid = await resolve(headRef)
  const baseOid = await resolve(baseRef)
  if (!headOid || !baseOid) return { error: `Council aborted: could not resolve the fetched PR #${number} refs.` }

  const mergeBaseResult = await sh`git merge-base ${baseOid} ${headOid}`.cwd(root).nothrow()
  const mergeBase = mergeBaseResult.stdout.toString().trim()
  if (mergeBaseResult.exitCode !== 0 || !mergeBase) {
    return { error: failure(`finding the merge base for PR #${number}`, mergeBaseResult) }
  }

  // Use the pinned head OID, not the mutable PR ref, so the patch matches the sandboxes exactly.
  const diff = await sh`git diff --binary ${mergeBase} ${headOid}`.cwd(root).binary().nothrow()
  if (diff.exitCode !== 0) return { error: failure("diffing the pinned PR head", diff) }

  return { headOid, patch: diff.stdout.toString(), label: `PR #${number}` }
}

type Sandbox = { dir: string }

type SandboxOptions = {
  includesWorktree: boolean
  scopedPath?: string
  baseSha?: string
  patchFile?: string
}

const SHARED_DEPENDENCY_DIRS = [".venv", "node_modules", "vendor"]

const SECRET_FILE_PATTERNS = [
  /^\.env(\..*)?$/i,
  /^\.envrc$/i,
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /\.jks$/i,
  /^id_/i,
  /^credentials/i,
  /^\.npmrc$/i,
  /^\.netrc$/i,
  /^\.pypirc$/i,
  /^\.git-credentials$/i,
]

const SECRET_PATH_PATTERNS = [/(^|\/)\.kube\/config$/i]

/** Untracked files that look like credentials must never enter a patch or a sandbox. */
function isSecretFile(file: string): boolean {
  const path = file.replace(/^\.\//, "").replace(/\\/g, "/")
  const name = path.split("/").pop() ?? path
  return (
    SECRET_PATH_PATTERNS.some((pattern) => pattern.test(path)) ||
    SECRET_FILE_PATTERNS.some((pattern) => pattern.test(name))
  )
}

type UntrackedEntry = {
  file: string
  size: number
  kind: "file" | "symlink" | "other"
}

async function listUntracked(
  sh: Sh,
  root: string,
  scopedPath?: string,
): Promise<UntrackedEntry[]> {
  const untracked = await sh`git ls-files --others --exclude-standard -z`.cwd(root).nothrow()
  let files = untracked.stdout.toString().split("\0").filter(Boolean)
  if (scopedPath) {
    const prefix = scopedPath.replace(/^\.\//, "").replace(/\/+$/, "")
    if (prefix && prefix !== ".") {
      files = files.filter((file) => file === prefix || file.startsWith(`${prefix}/`))
    }
  }
  const sized: UntrackedEntry[] = []
  for (const file of files) {
    const info = await lstat(join(root, file)).catch(() => undefined)
    const kind = info?.isSymbolicLink() ? "symlink" : info?.isFile() ? "file" : "other"
    sized.push({ file, size: info?.size ?? Number.MAX_SAFE_INTEGER, kind })
  }
  sized.sort((a, b) => a.size - b.size || a.file.localeCompare(b.file))
  return sized
}

function emptyFileDiff(file: string): string {
  return `diff --git a/${file} b/${file}\nnew file mode 100644\nindex 0000000..e69de29\n`
}

type UntrackedDiff =
  | { kind: "diff"; text: string }
  | { kind: "empty" }
  | { kind: "error" }
  | { kind: "skip" }

/**
 * Diff one untracked entry against /dev/null. Symlinks and other non-regular entries are never
 * followed, and a failed `git diff --no-index` must never be mistaken for an empty file.
 */
async function diffUntracked(sh: Sh, root: string, entry: UntrackedEntry): Promise<UntrackedDiff> {
  if (entry.kind !== "file") return { kind: "skip" }
  const diff = await sh`git diff --no-index --binary -- /dev/null ${entry.file}`.cwd(root).binary().nothrow()
  // git diff --no-index exits 1 when the files differ; anything above 1 is a real failure.
  if (diff.exitCode > 1) return { kind: "error" }
  const text = diff.stdout.toString()
  if (text.trim()) return { kind: "diff", text }
  return entry.size === 0 ? { kind: "empty" } : { kind: "skip" }
}

async function createSandbox(
  sh: Sh,
  root: string,
  stateRoot: string,
  sandboxId: string,
  resolved: Target,
  options: SandboxOptions,
): Promise<Sandbox | undefined> {
  if (resolved.kind === "pr" && !options.baseSha) return undefined
  const stateDir = join(stateRoot, "opencode-council")
  const dir = join(stateDir, "worktrees", sandboxId)
  try {
    await mkdir(dirname(dir), { recursive: true })
  } catch {
    return undefined
  }
  const added = await sh`git worktree add --detach ${dir} ${options.baseSha ?? "HEAD"}`.cwd(root).nothrow()
  if (added.exitCode !== 0) return undefined

  const applyPatch = async (text: string) => {
    if (!text.trim()) return
    const scratch = join(stateDir, `${sandboxId}.worktree.patch`)
    await writeFile(scratch, text, "latin1")
    try {
      const applied = await sh`git apply --binary --whitespace=nowarn ${scratch}`.cwd(dir).nothrow()
      if (applied.exitCode !== 0) throw new Error("apply failed")
    } finally {
      await rm(scratch, { force: true })
    }
  }

  try {
    if (resolved.kind === "pr") {
      // The caller fetched this exact commit to a run-private ref; never re-resolve the PR here.
      const checkout = await sh`git checkout --quiet --detach ${options.baseSha}`.cwd(dir).nothrow()
      if (checkout.exitCode !== 0) throw new Error("checkout failed")
    } else if (resolved.kind === "diff" && rangeRightSide(resolved.rev[0])) {
      const right = options.baseSha ?? (rangeRightSide(resolved.rev[0]) as string)
      const checkout = await sh`git checkout --quiet --detach ${right}`.cwd(dir).nothrow()
      if (checkout.exitCode !== 0) throw new Error("checkout failed")
    } else if (options.includesWorktree) {
      if (options.patchFile) {
        const recorded = await readFile(options.patchFile, "latin1").catch(() => undefined)
        if (recorded === undefined) throw new Error("recorded patch missing")
        if (!recorded.trim()) throw new Error("recorded patch empty")
        await applyPatch(recorded)
      } else {
        const base = options.baseSha ?? "HEAD"
        const working = options.scopedPath
          ? await sh`git diff ${base} --binary -- ${options.scopedPath}`.cwd(root).binary().nothrow()
          : await sh`git diff ${base} --binary`.cwd(root).binary().nothrow()
        if (working.exitCode !== 0) throw new Error("diff failed")
        await applyPatch(working.stdout.toString())
      }
    }

    if (options.includesWorktree && !options.patchFile) {
      const files = await listUntracked(sh, root, options.scopedPath)
      let copiedBytes = 0
      for (const { file, size } of files
        .filter((entry) => !isSecretFile(entry.file) && entry.kind === "file")
        .slice(0, MAX_SANDBOX_ENTRIES)) {
        try {
          if (copiedBytes + size > MAX_UNTRACKED_BYTES) continue
          const from = join(root, file)
          const to = join(dir, file)
          await mkdir(dirname(to), { recursive: true })
          await cp(from, to)
          copiedBytes += size
        } catch {
          // best effort: sandbox extras should never fail the review
        }
      }
    }

    const ignored = await sh`git ls-files --others --ignored --exclude-standard --directory`.cwd(root).nothrow()
    const entries = ignored.stdout
      .toString()
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
    for (const entry of entries.slice(0, MAX_SANDBOX_ENTRIES)) {
      const clean = entry.replace(/\/+$/, "")
      const name = clean.split("/").pop() ?? ""
      if (!SHARED_DEPENDENCY_DIRS.includes(name)) continue
      try {
        const source = await realpath(join(root, clean))
        const rootReal = await realpath(root)
        if (source !== rootReal && !source.startsWith(`${rootReal}/`)) continue
        const to = join(dir, clean)
        await mkdir(dirname(to), { recursive: true })
        await symlink(source, to)
      } catch {
        // best effort: dependency dirs are shared via symlink
      }
    }

    return { dir }
  } catch {
    await removeSandbox(sh, root, { dir })
    return undefined
  }
}

async function stateRootFor(sh: Sh, root: string): Promise<string> {
  const resolved = await sh`git rev-parse --path-format=absolute --git-common-dir`.cwd(root).nothrow()
  const value = resolved.stdout.toString().trim()
  if (resolved.exitCode === 0 && value) return value
  return join(root, ".git")
}

async function removeSandbox(sh: Sh, root: string, sandbox: Sandbox | undefined) {
  if (!sandbox) return
  try {
    const removed = await sh`git worktree remove --force ${sandbox.dir}`.cwd(root).nothrow()
    if (removed.exitCode !== 0) {
      await rm(sandbox.dir, { recursive: true, force: true })
      await removeAdminEntry(sh, root, sandbox.dir)
    }
  } catch {
    // cleanup is best effort: a failed removal must never mask the review result
  }
}

/**
 * Remove the `.git/worktrees/<name>` admin entry for a worktree directory, but only when its
 * `gitdir` file actually points at that directory. Never prunes globally, so worktrees owned by
 * other tools or concurrent runs are left untouched.
 */
async function removeAdminEntry(sh: Sh, root: string, dir: string) {
  try {
    const common = await sh`git rev-parse --path-format=absolute --git-common-dir`.cwd(root).nothrow()
    const commonDir = common.stdout.toString().trim()
    const name = dir.split("/").pop() ?? ""
    if (common.exitCode !== 0 || !commonDir || !name) return
    const adminDir = join(commonDir, "worktrees", name)
    const pointer = (await readFile(join(adminDir, "gitdir"), "utf8").catch(() => "")).trim()
    if (pointer && pointer === join(dir, ".git")) await rm(adminDir, { recursive: true, force: true })
  } catch {
    // best effort
  }
}

function activeDir(stateRoot: string): string {
  return join(stateRoot, "opencode-council", "active")
}

async function writeActiveMarker(stateRoot: string, runId: string, sandboxIds: string[]) {
  await mkdir(activeDir(stateRoot), { recursive: true })
  const path = join(activeDir(stateRoot), `${runId}.json`)
  const tmp = `${path}.tmp`
  await writeFile(tmp, JSON.stringify({ pid: process.pid, time: Date.now(), sandboxes: sandboxIds }))
  await rename(tmp, path)
}

async function clearActiveMarker(stateRoot: string, runId: string) {
  await rm(join(activeDir(stateRoot), `${runId}.json`), { force: true }).catch(() => {})
}

/** Remove session follow-up records that have not been used for a council run in a long time. */
async function pruneSessionRecords(stateDir: string, keepSessionID: string) {
  const dir = join(stateDir, "sessions")
  const keep = sessionRecordFile(keepSessionID)
  try {
    for (const file of await readdir(dir)) {
      const path = join(dir, file)
      if (file === keep) continue
      const info = await stat(path).catch(() => undefined)
      if (!info) continue
      if (file.endsWith(".tmp")) {
        if (Date.now() - info.mtimeMs > RUN_STALE_MS) await rm(path, { force: true }).catch(() => {})
        continue
      }
      if (!file.endsWith(".json")) continue
      let time = info.mtimeMs
      try {
        const record = JSON.parse(await readFile(path, "utf8")) as { time?: unknown }
        if (typeof record.time === "number" && Number.isFinite(record.time)) time = record.time
      } catch {
        // fall back to the file's mtime
      }
      if (Date.now() - time > SESSION_RECORD_STALE_MS) await rm(path, { force: true }).catch(() => {})
    }
  } catch {
    // no session records yet
  }
}

async function pruneOldPatches(stateDir: string) {
  let keep: string | undefined
  try {
    const record = JSON.parse(await readFile(join(stateDir, "latest-run.json"), "utf8")) as { patchFile?: string }
    keep = record.patchFile
  } catch {
    // no run record
  }
  try {
    for (const file of await readdir(stateDir)) {
      if (!file.endsWith(".patch")) continue
      const path = join(stateDir, file)
      if (keep === path) continue
      const info = await stat(path).catch(() => undefined)
      if (info && Date.now() - info.mtimeMs > RUN_STALE_MS) await rm(path, { force: true }).catch(() => {})
    }
  } catch {
    // state dir does not exist yet
  }
}

async function sweepSandboxes(sh: Sh, root: string, stateRoot: string) {
  const stateDir = join(stateRoot, "opencode-council")
  const worktreesRoot = join(stateDir, "worktrees")
  const active = activeDir(stateRoot)
  const live = new Set<string>()
  try {
    for (const file of await readdir(active)) {
      const path = join(active, file)
      try {
        const marker = JSON.parse(await readFile(path, "utf8")) as {
          time?: number
          sandboxes?: string[]
          pid?: number
        }
        if (typeof marker.time !== "number") throw new Error("marker missing time")
        const alive =
          typeof marker.pid === "number" &&
          marker.pid > 0 &&
          Date.now() - marker.time < 24 * 60 * 60 * 1000 &&
          (() => {
            try {
              process.kill(marker.pid, 0)
              return true
            } catch {
              return false
            }
          })()
        if (Date.now() - marker.time < RUN_STALE_MS || alive) {
          for (const id of marker.sandboxes ?? []) live.add(id)
          continue
        }
      } catch {
        // unparseable marker: protect that run's worktrees; only clear the marker once it is old
        const runId = file.replace(/\.json$/, "")
        for (const entry of await readdir(worktreesRoot).catch(() => [])) {
          if (entry === runId || entry.startsWith(`${runId}-`)) live.add(entry)
        }
        const info = await stat(path).catch(() => undefined)
        if (!info || Date.now() - info.mtimeMs > RUN_STALE_MS) await rm(path, { force: true }).catch(() => {})
        continue
      }
      await rm(path, { force: true }).catch(() => {})
    }
  } catch {
    // no active markers yet
  }

  const listed = await sh`git worktree list --porcelain`.cwd(root).nothrow()
  for (const line of listed.stdout.toString().split("\n")) {
    if (!line.startsWith("worktree ")) continue
    const path = line.slice("worktree ".length).trim()
    if (path !== worktreesRoot && !path.startsWith(`${worktreesRoot}/`)) continue
    const id = path.slice(worktreesRoot.length + 1)
    if (live.has(id)) continue
    const info = await stat(path).catch(() => undefined)
    if (info && Date.now() - info.mtimeMs < SANDBOX_GRACE_MS) continue
    const removed = await sh`git worktree remove --force ${path}`.cwd(root).nothrow()
    if (removed.exitCode !== 0) {
      await rm(path, { recursive: true, force: true }).catch(() => {})
      await removeAdminEntry(sh, root, path)
    }
  }

  await pruneOldPatches(stateDir)
}

type SessionMessageLike = {
  type?: string
  content?: Array<{ type?: string; text?: string }>
}

function turnAssistantText(messages: unknown): string | undefined {
  const list = Array.isArray(messages) ? (messages as SessionMessageLike[]) : []
  let boundary = -1
  for (let index = list.length - 1; index >= 0; index--) {
    if (list[index]?.type === "user") {
      boundary = index
      break
    }
  }
  for (let index = list.length - 1; index > boundary; index--) {
    const message = list[index]
    if (!message || message.type !== "assistant" || !Array.isArray(message.content)) continue
    const text = message.content
      .filter((part) => part && part.type === "text" && typeof part.text === "string")
      .map((part) => part.text as string)
      .join("\n")
      .trim()
    if (text) return text
  }
  return undefined
}

function extractJson(text: string): unknown | undefined {
  const candidates: string[] = []
  for (const match of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    const body = match[1]?.trim()
    if (body) candidates.push(body)
  }
  const first = text.indexOf("{")
  const last = text.lastIndexOf("}")
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1))
  candidates.push(text.trim())
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate)
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed
    } catch {}
  }
  return undefined
}

function findingProblem(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "must be a JSON object"
  const finding = raw as Record<string, unknown>
  const severity = typeof finding.severity === "string" ? finding.severity.trim().toLowerCase() : ""
  if (!Object.hasOwn(SEVERITY_RANK, severity)) return `"severity" must be one of critical, major, minor, nit`
  if (typeof finding.file !== "string" || !finding.file.trim()) return `"file" must be a non-empty string`
  if (typeof finding.title !== "string" || !finding.title.trim()) return `"title" must be a non-empty string`
  if (typeof finding.detail !== "string" || !finding.detail.trim()) return `"detail" must be a non-empty string`
  return undefined
}

function normalizeFinding(raw: unknown): Finding | undefined {
  if (findingProblem(raw)) return undefined
  const finding = raw as Record<string, unknown>
  const severity = (finding.severity as string).trim().toLowerCase()
  const file = (finding.file as string).trim()
  const title = (finding.title as string).trim()
  const detail = (finding.detail as string).trim()
  let line: number | undefined
  const rawLine = finding.line
  if (typeof rawLine === "number" && Number.isInteger(rawLine)) line = rawLine
  else if (typeof rawLine === "string" && /^\d+$/.test(rawLine.trim())) line = Number(rawLine.trim())
  const suggestion =
    typeof finding.suggestion === "string" && finding.suggestion.trim() ? finding.suggestion.trim() : undefined
  return { severity: severity as Severity, file, line, title, detail, suggestion }
}

function validateReviewOutput(raw: unknown): {
  output?: ReviewOutput
  dropped: number
  error?: string
  problems: string[]
} {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      dropped: 0,
      error: "no review JSON object",
      problems: ["no JSON object was found in the final message"],
    }
  }
  const candidate = raw as Record<string, unknown>
  const verdict = typeof candidate.verdict === "string" ? candidate.verdict.trim() : ""
  if (verdict !== "approve" && verdict !== "approve_with_comments" && verdict !== "request_changes") {
    return {
      dropped: 0,
      error: "review JSON has no valid verdict",
      problems: [`"verdict" must be one of approve, approve_with_comments, or request_changes`],
    }
  }
  const summary = typeof candidate.summary === "string" ? candidate.summary.trim() : ""
  if (!summary) {
    return {
      dropped: 0,
      error: "review JSON has no summary",
      problems: [`"summary" must be a non-empty string`],
    }
  }
  if (!Array.isArray(candidate.findings)) {
    return {
      dropped: 0,
      error: "review JSON has no findings array",
      problems: [`"findings" must be an array`],
    }
  }
  const findings: Finding[] = []
  const problems: string[] = []
  for (let index = 0; index < candidate.findings.length; index++) {
    const entry = candidate.findings[index]
    const problem = findingProblem(entry)
    if (problem) {
      problems.push(`findings[${index}]: ${problem}`)
      continue
    }
    findings.push(normalizeFinding(entry) as Finding)
  }
  return { output: { verdict, summary, findings }, dropped: problems.length, problems }
}

function textResult(text: string, metadata?: Record<string, unknown>) {
  return { output: text, content: text, metadata }
}

const plugin = Plugin.define({
  id: "council",
  setup: async (ctx) => {
    const resolveRoots = async (sh: Sh, sessionID: string) => {
      let cwd: Location.Info["directory"] = ctx.location.directory
      try {
        const session = await ctx.session.get({ sessionID })
        if (session.location?.directory) cwd = session.location.directory as Location.Info["directory"]
      } catch {}
      const top = await sh`git rev-parse --show-toplevel`.cwd(cwd).nothrow()
      const root = top.stdout.toString().trim()
      return { cwd, repoRoot: top.exitCode === 0 && root ? root : cwd }
    }

    await ctx.tool.transform((tools) => {
      const councilTool = {
        name: "council",
        options: { codemode: false },
        description:
          "Convene a three-model code-review council. Each reviewer runs in its own isolated session with its own private throwaway sandbox checkout of the change; they can run tests and cross-reference other repositories under ~/code, then return findings that a chair merges into a consensus report. Use for reviewing a working-tree diff, a branch or commit range, a PR, or specific paths.",
        input: Schema.Struct({
          request: Schema.optionalKey(
            Schema.String.annotate({
              description:
                "What to review: a PR number, a git ref or range (e.g. main...HEAD), or file paths. A numeric request is treated as a PR number unless a file or directory with that name exists in the repository. Anything else is treated as review focus guidance. Omit to review the working-tree diff.",
            }),
          ),
          focus: Schema.optionalKey(
            Schema.String.annotate({ description: "Extra review guidance passed to every reviewer" }),
          ),
          allowPr: Schema.optionalKey(
            Schema.Boolean.annotate({
              description:
                "Allow reviewing a PR authored by someone else. Without it only your own PRs are reviewed, because a third-party PR's code runs in a sandbox on this machine.",
            }),
          ),
        }),
        output: Schema.String,
        execute: async (input: CouncilInput, context: ToolContext) => {
          if (context.agent.startsWith("council-")) {
            return textResult("Council: refusing a recursive invocation from a council agent.")
          }

          const loaded = await loadCouncilConfig()
          if ("error" in loaded) return textResult(loaded.error)
          const { reviewers, chair } = loaded.config

          const sh = makeShell(context.signal)
          const { cwd, repoRoot } = await resolveRoots(sh, context.sessionID)
          const override = input.resolved
          const resolved = override ?? (await resolveTarget(sh, repoRoot, input.request))
          const includesWorktree =
            resolved.kind === "focus" ||
            (resolved.kind === "diff" && rangeRightSide(resolved.rev[0]) === undefined)
          const scopedPath = resolved.kind === "diff" && resolved.rev[1] === "--" ? resolved.rev[2] : undefined
          const stateRoot = await stateRootFor(sh, repoRoot)

          if (resolved.kind === "pr" && input.allowPr !== true) {
            const login = (await sh`gh api user --jq .login`.cwd(repoRoot).nothrow()).stdout.toString().trim()
            const author = (
              await sh`gh pr view ${resolved.number} --json author --jq .author.login`.cwd(repoRoot).nothrow()
            ).stdout.toString().trim()
            if (!login || !author || login !== author) {
              return textResult(
                `Council aborted: PR #${resolved.number} ${
                  author ? `is authored by ${author}` : "has an unknown author"
                } (you are ${login || "not signed in to gh"}). Reviewing a third-party PR runs its code in a sandbox on this machine; pass \`allowPr: true\` to opt in.`,
              )
            }
          }

          const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

          let baseSha: string | undefined
          let label: string
          let patch: string
          if (resolved.kind === "pr") {
            const evidence = await fetchPrEvidence(sh, repoRoot, resolved.number, runId)
            if ("error" in evidence) return textResult(evidence.error)
            baseSha = evidence.headOid
            patch = evidence.patch
            label = evidence.label
          } else {
            baseSha =
              (await sh`git rev-parse ${baseShaFor(resolved)}`.cwd(repoRoot).nothrow()).stdout.toString().trim() ||
              undefined
            const rev = resolved.kind === "diff" ? resolved.rev : ["HEAD"]
            const result = await sh`git diff --binary ${rev}`.cwd(repoRoot).binary().nothrow()
            if (result.exitCode !== 0) {
              return textResult(
                `Council aborted: \`git diff ${rev.join(" ")}\` failed.\n\n${result.stderr.toString().slice(0, 1000)}`,
              )
            }
            patch = result.stdout.toString()
            label = `git diff ${rev.join(" ")}`
          }

          const omissions: string[] = []
          if (includesWorktree) {
            const entries = await listUntracked(sh, repoRoot, scopedPath)
            const secretFiles = entries.filter((entry) => isSecretFile(entry.file))
            const candidates = entries.filter((entry) => !isSecretFile(entry.file))
            const nonRegular = candidates.filter((entry) => entry.kind !== "file")
            const files = candidates.filter((entry) => entry.kind === "file")
            const beyondLimit = Math.max(0, files.length - MAX_UNTRACKED_FILES)
            const skippedLarge: string[] = []
            const unreadable: string[] = []
            let cappedCount = 0
            for (const entry of files.slice(0, MAX_UNTRACKED_FILES)) {
              const diff = await diffUntracked(sh, repoRoot, entry)
              if (diff.kind === "error") {
                unreadable.push(entry.file)
                continue
              }
              if (diff.kind === "skip") continue
              const text = diff.kind === "empty" ? emptyFileDiff(entry.file) : diff.text
              if (text.length > MAX_FILE_DIFF_CHARS) {
                skippedLarge.push(entry.file)
                continue
              }
              if (patch.length + text.length + 1 > MAX_PATCH_CHARS) {
                cappedCount++
                continue
              }
              patch += `${patch.endsWith("\n") ? "" : "\n"}${text}`
            }
            if (secretFiles.length > 0) {
              omissions.push(`${secretFiles.length} secret-like untracked files omitted from the patch (never copied)`)
            }
            if (nonRegular.length > 0) {
              omissions.push(`${nonRegular.length} symlinked or non-regular untracked entries omitted (not followed)`)
            }
            if (unreadable.length > 0) {
              const shown = unreadable.slice(0, 5).join(", ")
              omissions.push(
                `${unreadable.length} untracked files could not be diffed and were omitted (${shown}${unreadable.length > 5 ? ", …" : ""})`,
              )
            }
            if (beyondLimit > 0) omissions.push(`${beyondLimit} untracked files beyond the ${MAX_UNTRACKED_FILES}-file limit`)
            if (skippedLarge.length > 0) {
              const shown = skippedLarge.slice(0, 5).join(", ")
              omissions.push(`${skippedLarge.length} large files omitted from the patch (${shown}${skippedLarge.length > 5 ? ", …" : ""})`)
            }
            if (cappedCount > 0) omissions.push(`${cappedCount} files omitted after the ${MAX_PATCH_CHARS}-character patch cap`)
          }

          await context.progress({ title: `Council: ${label}` })

          const followUpFeedback = input.followUpFeedback?.trim()
          const focus = [
            resolved.kind === "focus" ? resolved.focus : undefined,
            input.focus?.trim() || undefined,
            followUpFeedback
              ? `Follow-up feedback from the user after the previous council report. Re-evaluate the change with this in mind:\n${followUpFeedback}`
              : undefined,
          ]
            .filter(Boolean)
            .join("\n")

          if (!patch.trim()) {
            const status = await sh`git status --short`.cwd(repoRoot).nothrow()
            const dirty = status.stdout.toString().trim()
            return textResult(
              `Council: no diff for \`${label}\`${focus ? ` (focus: ${focus})` : ""}. Nothing to review.${
                dirty
                  ? `\n\nUntracked/other changes (not part of the diff):\n\`\`\`\n${dirty.slice(0, 2000)}\n\`\`\``
                  : ""
              }`,
            )
          }

          let patchFull = patch
          if (patch.length > MAX_PATCH_FILE_CHARS) {
            const cut = patch.lastIndexOf("\ndiff --git ", MAX_PATCH_FILE_CHARS)
            patchFull = cut > 0 ? patch.slice(0, cut + 1) : ""
            omissions.push(
              cut > 0
                ? `the full sandbox patch was capped at ${MAX_PATCH_FILE_CHARS} characters at a file boundary`
                : `the patch exceeded ${MAX_PATCH_FILE_CHARS} characters in a single file, so no sandbox patch was recorded`,
            )
          }
          if (patch.length > MAX_PATCH_CHARS) {
            const cut = patch.lastIndexOf("\ndiff --git ", MAX_PATCH_CHARS)
            if (cut > 0) {
              patch = patch.slice(0, cut + 1)
              omissions.push(`the diff exceeded ${MAX_PATCH_CHARS} characters and was truncated at a file boundary`)
            } else {
              patch = patch.slice(0, MAX_PATCH_CHARS)
              omissions.push(`the diff was truncated mid-file at ${MAX_PATCH_CHARS} characters`)
            }
          }
          const patchNote = omissions.length > 0 ? `NOTE: ${omissions.join("; ")}.` : ""

          const patchDir = join(stateRoot, "opencode-council")
          const patchPath = join(patchDir, `${runId}.patch`)
          const fullPatchPath = join(patchDir, `${runId}.full.patch`)
          await mkdir(patchDir, { recursive: true })
          await writeFile(patchPath, patch, "latin1")
          await writeFile(fullPatchPath, patchFull, "latin1")

          const sandboxIds = reviewers.map((reviewer) => `${runId}-${reviewer.code}`)
          await writeActiveMarker(stateRoot, runId, sandboxIds)
          await sweepSandboxes(sh, repoRoot, stateRoot)
          await pruneSessionRecords(patchDir, context.sessionID)
          const recordedSha = baseSha
          // Replay the recorded full patch so every sandbox matches the diff that was just captured.
          const pinnedPatch = includesWorktree && patchFull.trim() ? fullPatchPath : undefined
          const sandboxes = new Map<string, Sandbox | undefined>()
          try {
            for (const reviewer of reviewers) {
              const sandbox = await createSandbox(sh, repoRoot, stateRoot, `${runId}-${reviewer.code}`, resolved, {
                includesWorktree,
                scopedPath,
                baseSha: recordedSha,
                patchFile: pinnedPatch,
              })
              sandboxes.set(reviewer.name, sandbox)
            }
          } catch (error) {
            for (const sandbox of sandboxes.values()) {
              if (sandbox) await removeSandbox(sh, repoRoot, sandbox)
            }
            await clearActiveMarker(stateRoot, runId)
            throw error
          }

          const buildBrief = (sandbox: Sandbox) =>
            [
              "This change is in review. Evaluate it, looking for issues, and report back. Don't make any changes. If you decide to run any tests, ensure they do not collide with other review sessions.",
              "",
              `Review target: ${label}`,
              `Patch file: ${patchPath} — read it first; it is the diff under review.`,
              `Sandbox checkout: ${sandbox.dir} — a throwaway git worktree with the change applied. Other reviewers may be running the same tests on this machine concurrently: keep any test artifacts inside your sandbox, prefer unique temp paths, and avoid fixed ports or other shared resources. Dependency directories (node_modules, .venv, vendor) are shared with the main checkout via symlinks — read them, never write to them.`,
              focus ? `Focus requested: ${focus}` : undefined,
              patchNote || undefined,
              "",
              "Read the patch and surrounding code before judging.",
              `Run the project's existing tests if useful (shell tool with workdir ${sandbox.dir}, or cd into it). Do not create, edit, or delete files — run tests as-is, and cite the command and observed result in the finding detail.`,
              "Work efficiently: run the project's test suite at most twice, and never re-run a command whose output you already have or has not changed — if a command keeps producing the same result, stop and use it.",
              "Keep your final analysis concise: emit the JSON as soon as your findings are ready — a turn that exhausts the thinking budget before producing it wastes the review.",
              "Environment: macOS with BSD userland — avoid GNU-only flags and escapes (e.g. sed \\x1b, grep -P, find -printf); they fail or silently do nothing here.",
              `Never modify the main checkout at ${repoRoot}.`,
              "You may read other repositories under ~/code (read-only) for callers, conventions, or related implementations.",
              "",
              "FINISHING REQUIREMENT: end your turn with your complete findings as a single JSON object (verdict, summary, findings). Your final message must contain only that JSON object — no prose, no markdown fences, no tool calls.",
              "The JSON object must match this schema:",
              JSON.stringify(FINDINGS_SCHEMA),
            ]
              .filter((line): line is string => line !== undefined)
              .join("\n")

          const reviewerSessionIDs = new Set<string>()
          const runReviewer = async (reviewer: ReviewerConfig): Promise<ReviewerResult> => {
            const base = { name: reviewer.name, label: reviewer.label, code: reviewer.code }
            const sandbox = sandboxes.get(reviewer.name)
            if (!sandbox) {
              return {
                ...base,
                status: "failed",
                error: "sandbox unavailable; refusing to review the main checkout",
                findings: [],
              }
            }
            const resultFor = (sessionID: string, output: ReviewOutput, dropped: number): ReviewerResult => ({
              ...base,
              status: "ok",
              sessionID,
              verdict: output.verdict,
              summary: output.summary,
              findings: output.findings,
              droppedFindings: dropped,
            })
            let lastError: string | undefined
            let failedSession: string | undefined
            let pendingRepair: { sessionID: string; text: string } | undefined
            let best: ReviewerResult | undefined
            const overallDeadline = Date.now() + REVIEW_TIMEOUT_MS * 2
            for (let attempt = 0; attempt < 3; attempt++) {
              let isRescue = false
              let sessionID: string | undefined
              const remaining = overallDeadline - Date.now()
              if (remaining <= 0) {
                lastError = lastError ?? "reviewer deadline exceeded"
                break
              }
              if (context.signal.aborted) {
                lastError = "cancelled"
                break
              }
              const attemptTimeout = Math.min(REVIEW_TIMEOUT_MS, remaining)
              const startedAt = Date.now()
              try {
                let promptText: string
                if (pendingRepair) {
                  isRescue = true
                  sessionID = pendingRepair.sessionID
                  promptText = pendingRepair.text
                  pendingRepair = undefined
                } else {
                  const session = await ctx.session.create({
                    parentID: context.sessionID,
                    title: `Council reviewer: ${reviewer.label}`,
                    agent: REVIEWER_AGENT,
                    model: reviewer.model,
                    location: {
                      directory: sandbox.dir as Location.Info["directory"],
                    },
                  })
                  sessionID = session.id
                  promptText = buildBrief(sandbox)
                }

                const activeSessionID = sessionID
                reviewerSessionIDs.add(activeSessionID)
                await ctx.session.prompt({ sessionID: activeSessionID, text: promptText }, { signal: context.signal })
                await promptWithTimeout(
                  (timeoutSignal) =>
                    ctx.session.wait(
                      { sessionID: activeSessionID },
                      { signal: AbortSignal.any([context.signal, timeoutSignal]) },
                    ),
                  attemptTimeout,
                )
                const messages = await ctx.session.context({ sessionID: activeSessionID }, { signal: context.signal })
                const text = turnAssistantText(messages)
                const parsed = text ? extractJson(text) : undefined
                const validation = validateReviewOutput(parsed)
                if (validation.output && validation.dropped === 0) {
                  return resultFor(activeSessionID, validation.output, 0)
                }
                if (validation.output) {
                  // Keep the valid part of an otherwise good review, but ask the reviewer
                  // to repair the invalid findings once before falling back to it.
                  const candidate = resultFor(activeSessionID, validation.output, validation.dropped)
                  if (!best || (candidate.droppedFindings ?? 0) < (best.droppedFindings ?? 0)) best = candidate
                  if (!isRescue && attempt < 2) {
                    pendingRepair = {
                      sessionID: activeSessionID,
                      text: buildRepairPrompt("partial", validation.problems),
                    }
                    continue
                  }
                  return best ?? candidate
                }
                if (!isRescue && attempt < 2) {
                  pendingRepair = {
                    sessionID: activeSessionID,
                    text: buildRepairPrompt(parsed === undefined ? "missing" : "invalid", validation.problems),
                  }
                }
                throw new Error(`no structured output: ${validation.error ?? "unrecognized review payload"}`)
              } catch (error) {
                lastError = error instanceof Error ? error.message : String(error)
                if (sessionID) {
                  failedSession = sessionID
                  await ctx.session.interrupt({ sessionID }).catch(() => {})
                  const timedOut = Date.now() - startedAt >= attemptTimeout - 2000
                  if (!isRescue && !pendingRepair && timedOut && attempt < 2) {
                    pendingRepair = { sessionID, text: buildRepairPrompt("missing", []) }
                  }
                }
                if (best) return best
              }
            }
            return (
              best ?? { ...base, status: "failed", sessionID: failedSession, error: lastError ?? "unreachable", findings: [] }
            )
          }

          const results = await Promise.all(reviewers.map((reviewer) => runReviewer(reviewer)))
          const clusters = buildClusters(results)
          const matrix = renderMatrix(clusters, results, reviewers)

          const reviewerPayload = results.map((result) => ({
            name: result.name,
            label: result.label,
            status: result.status,
            error: result.error,
            verdict: result.verdict,
            summary: result.summary,
            findings: result.findings,
            droppedFindings: result.droppedFindings,
          }))

          const record: RunRecord = {
            runId,
            time: Date.now(),
            target: label,
            resolved,
            parentSessionID: context.sessionID,
            allowPr: input.allowPr === true,
            focus: input.focus?.trim() || undefined,
            includesWorktree,
            scopedPath,
            baseSha: recordedSha,
            patchFile: fullPatchPath,
            note: patchNote || undefined,
            reviewers: results.map((result) => ({
              name: result.name,
              label: result.label,
              sessionID: result.sessionID,
              status: result.status,
            })),
          }
          try {
            const recordPath = runRecordPath(stateRoot)
            const tempRecordPath = `${recordPath}.${runId}.tmp`
            try {
              await writeFile(tempRecordPath, JSON.stringify(record, null, 2))
              await rename(tempRecordPath, recordPath)
            } catch {
              await rm(tempRecordPath, { force: true }).catch(() => {})
              // a failed record write must not discard the completed review
            }
            const sessionPath = sessionRunRecordPath(stateRoot, context.sessionID)
            const tempSessionPath = `${sessionPath}.${runId}.tmp`
            try {
              await mkdir(dirname(sessionPath), { recursive: true })
              await writeFile(tempSessionPath, JSON.stringify(record, null, 2))
              await rename(tempSessionPath, sessionPath)
            } catch {
              await rm(tempSessionPath, { force: true }).catch(() => {})
            }

            const chairBrief = [
              `Review target: ${label}`,
              `Patch file: ${patchPath}`,
              ...reviewers.map((reviewer) => {
                const sandbox = sandboxes.get(reviewer.name)
                return sandbox ? `${reviewer.label} sandbox: ${sandbox.dir}` : undefined
              }),
              focus ? `Focus requested: ${focus}` : undefined,
              "",
              "Consensus matrix (computed deterministically from the three reviews; ground truth):",
              matrix,
              "",
              "Per-reviewer outputs (JSON):",
              "```json",
              JSON.stringify(reviewerPayload, null, 2),
              "```",
              "",
              "Write the final council report as instructed.",
            ]
              .filter((line): line is string => line !== undefined)
              .join("\n")

            let report: string | undefined
            let chairError: string | undefined
            let chairID: string | undefined
            try {
              const chairSession = await ctx.session.create({
                parentID: context.sessionID,
                title: "Council chair",
                agent: "council-chair",
                model: chair,
                location: { directory: cwd },
              })
              chairID = chairSession.id
              const activeChairID = chairID
              for (let attempt = 0; attempt < 2; attempt++) {
                if (context.signal.aborted) throw new Error("cancelled")
                const promptText =
                  attempt === 0
                    ? chairBrief
                    : "Your previous turn ended before you produced the final report. Write the final council report now, in markdown, from the consensus matrix and reviewer outputs already in your context. Do not start over."
                try {
                  await ctx.session.prompt({ sessionID: activeChairID, text: promptText }, { signal: context.signal })
                  await promptWithTimeout(
                    (timeoutSignal) =>
                      ctx.session.wait(
                        { sessionID: activeChairID },
                        { signal: AbortSignal.any([context.signal, timeoutSignal]) },
                      ),
                    REVIEW_TIMEOUT_MS,
                  )
                  const messages = await ctx.session.context({ sessionID: activeChairID }, { signal: context.signal })
                  const text = turnAssistantText(messages)
                  if (!text) throw new Error("no report text")
                  report = text
                  chairError = undefined
                  break
                } catch (error) {
                  chairError = error instanceof Error ? error.message : String(error)
                  await ctx.session.interrupt({ sessionID: chairID }).catch(() => {})
                }
              }
            } catch (error) {
              chairError = error instanceof Error ? error.message : String(error)
            }

            const failed = results.filter((result) => result.status === "failed")
            const dropped = results.filter((result) => (result.droppedFindings ?? 0) > 0)
            const lines: string[] = []
            if (report) {
              lines.push(report)
            } else {
              lines.push(`# Council review — ${label}`, "", "_The chair failed; this is the raw council output._")
            }
            lines.push("", "---", "", "## Consensus matrix", "", matrix)
            if (patchNote) lines.push("", patchNote)
            if (dropped.length > 0) {
              lines.push("", "## Dropped findings", "")
              lines.push("Findings below did not match the expected schema and were excluded from the matrix:")
              for (const result of dropped) lines.push(`- ${result.label}: ${result.droppedFindings} dropped`)
            }
            if (failed.length > 0) {
              lines.push("", "## Reviewer failures", "")
              for (const result of failed) lines.push(`- ${result.label}: ${result.error}`)
            }
            if (chairError) lines.push("", `Chair error: ${chairError}${chairID ? ` (session ${chairID})` : ""}`)
            lines.push("", "## Reviewer sessions", "")
            lines.push("Give the council further feedback with the `council_followup` tool; it re-runs all three reviewers on the same target in this session.")
            lines.push("")
            for (const result of results) {
              lines.push(`- ${result.label}: \`${result.sessionID ?? "unavailable"}\` (${result.status})`)
            }
            lines.push("", "## Raw reviewer outputs", "", "```json", JSON.stringify(reviewerPayload, null, 2), "```")

            return textResult(lines.join("\n"), {
              target: label,
              patchFile: patchPath,
              reviewers: results.map((result) => ({
                name: result.name,
                status: result.status,
                sessionID: result.sessionID,
                error: result.error,
                droppedFindings: result.droppedFindings,
              })),
            })
          } finally {
            // A reviewer session whose location is a sandbox keeps pointing at the
            // deleted worktree after cleanup, which breaks the next location reload.
            // Move it back to the reviewed checkout before removing the sandbox.
            for (const sessionID of reviewerSessionIDs) {
              await ctx.session
                .move({ sessionID, directory: cwd as Location.Info["directory"] })
                .catch(() => {})
            }
            for (const reviewer of reviewers) await removeSandbox(sh, repoRoot, sandboxes.get(reviewer.name))
            await clearActiveMarker(stateRoot, runId)
          }
        },
      }
      tools.add(councilTool)
      tools.add({
        name: "council_followup",
        options: { codemode: false },
        description:
          "Give the council further feedback after a prior review. Re-runs the full three-model council on the same target in fresh sandboxes, passing the feedback to every reviewer. Requires a prior council run in this session.",
        input: Schema.Struct({
          feedback: Schema.String.annotate({
            description:
              "Further feedback for the council after a prior report. It is passed to every reviewer on a fresh full-council run of the same target.",
          }),
        }),
        output: Schema.String,
        execute: async (input, context) => {
          if (context.agent.startsWith("council-")) {
            return textResult("Council: refusing a recursive invocation from a council agent.")
          }

          const sh = makeShell(context.signal)
          const { repoRoot } = await resolveRoots(sh, context.sessionID)
          const stateRoot = await stateRootFor(sh, repoRoot)

          const readRecord = async (path: string): Promise<RunRecord | undefined> => {
            try {
              return JSON.parse(await readFile(path, "utf8")) as RunRecord
            } catch {
              return undefined
            }
          }

          let record = await readRecord(sessionRunRecordPath(stateRoot, context.sessionID))
          if (record?.parentSessionID !== context.sessionID) {
            const latest = await readRecord(runRecordPath(stateRoot))
            record = latest?.parentSessionID === context.sessionID ? latest : undefined
          }
          if (!record) {
            return textResult("Council follow-up: no previous council run in this session. Run /council first.")
          }
          if (!isTarget(record.resolved)) {
            return textResult("Council follow-up: the previous run record in this session is unreadable. Run /council again.")
          }

          const feedback = input.feedback.trim()
          if (!feedback) {
            return textResult("Council follow-up: feedback cannot be empty.")
          }

          const followInput: CouncilInput = {
            resolved: record.resolved,
            allowPr: record.allowPr === true,
            focus: typeof record.focus === "string" ? record.focus : undefined,
            followUpFeedback: feedback,
          }
          return councilTool.execute(followInput, context)
        },
      })
    })
  },
})

if (process.env.COUNCIL_TEST === "1") {
  Object.assign(plugin, {
    __test: {
      makeShell,
      resolveTarget,
      sameFile,
      sameIssue,
      buildClusters,
      leadFinding,
      createSandbox,
      fetchPrEvidence,
      stateRootFor,
      pruneOldPatches,
      runRecordPath,
      sessionRunRecordPath,
      pruneSessionRecords,
      isTarget,
      baseShaFor,
      sweepSandboxes,
      listUntracked,
      diffUntracked,
      emptyFileDiff,
      renderMatrix,
      reviewerName,
      turnAssistantText,
      extractJson,
      normalizeFinding,
      validateReviewOutput,
      isSecretFile,
      loadCouncilConfig,
      councilConfigPath,
    },
  })
}

export default plugin
