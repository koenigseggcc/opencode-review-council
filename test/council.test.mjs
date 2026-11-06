import { test } from "node:test"
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { existsSync, lstatSync, readdirSync, realpathSync } from "node:fs"
import { mkdtemp, mkdir, readFile, symlink, writeFile, rm, utimes } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { Schema } from "effect"
import { SessionEvent } from "@opencode/schema/session-event"

process.env.COUNCIL_TEST = "1"
process.env.OPENCODE_COUNCIL_CONFIG = fileURLToPath(new URL("./fixtures/council.json", import.meta.url))
const { default: CouncilPlugin } = await import("../plugins/council.ts")

const {
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
  textResult,
  normalizeFinding,
  validateReviewOutput,
  isSecretFile,
  loadCouncilConfig,
  councilConfigPath,
} = CouncilPlugin.__test
const exec = promisify(execFile)
const ARGV_SCRIPT = "console.log(JSON.stringify(process.argv.slice(1)))"

test("makeShell keeps an interpolated refspec as a single argv entry (PR refspec regression)", async () => {
  const sh = makeShell()
  const res = await sh`node -e ${ARGV_SCRIPT} fetch --quiet origin ${"pull/123/head"}`.nothrow()
  assert.equal(res.exitCode, 0)
  const argv = JSON.parse(res.stdout)
  assert.deepEqual(argv, ["fetch", "--quiet", "origin", "pull/123/head"])
})

test("makeShell keeps interpolated values with spaces intact", async () => {
  const sh = makeShell()
  const res = await sh`node -e ${ARGV_SCRIPT} ${"a b c"} tail`.nothrow()
  const argv = JSON.parse(res.stdout)
  assert.deepEqual(argv, ["a b c", "tail"])
})

test("resolveTarget classifies requests", async () => {
  const sh = makeShell()
  const dir = await mkdtemp(join(tmpdir(), "council-test-"))
  const outsideName = `council-outside-${process.pid}-${Date.now()}.txt`
  try {
    await exec("git", ["init", "-q"], { cwd: dir })
    await exec(
      "git",
      ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"],
      { cwd: dir },
    )
    await mkdir(join(dir, "sub"), { recursive: true })
    await writeFile(join(dir, "sub", "file.txt"), "x")

    assert.deepEqual(await resolveTarget(sh, dir, undefined), { kind: "diff", rev: ["HEAD"] })
    assert.deepEqual(await resolveTarget(sh, dir, "456"), { kind: "pr", number: "456" })
    await mkdir(join(dir, "123"), { recursive: true })
    assert.deepEqual(await resolveTarget(sh, dir, "123"), { kind: "diff", rev: ["HEAD", "--", "123"] })
    assert.deepEqual(await resolveTarget(sh, dir, "main...HEAD"), { kind: "diff", rev: ["main...HEAD"] })
    assert.deepEqual(await resolveTarget(sh, dir, "sub"), { kind: "diff", rev: ["HEAD", "--", "sub"] })
    assert.deepEqual(await resolveTarget(sh, dir, "./sub"), { kind: "diff", rev: ["HEAD", "--", "./sub"] })
    assert.deepEqual(await resolveTarget(sh, dir, "HEAD"), { kind: "diff", rev: ["HEAD"] })
    assert.deepEqual(await resolveTarget(sh, dir, "not-a-ref-or-path"), {
      kind: "focus",
      focus: "not-a-ref-or-path",
    })
    assert.deepEqual(await resolveTarget(sh, dir, "--output=/tmp/x..y"), {
      kind: "focus",
      focus: "--output=/tmp/x..y",
    })
    await writeFile(join(dir, "..", outsideName), "x")
    assert.deepEqual(await resolveTarget(sh, dir, `../${outsideName}`), {
      kind: "focus",
      focus: `../${outsideName}`,
    })
    assert.deepEqual(await resolveTarget(sh, dir, "/etc/hosts"), { kind: "focus", focus: "/etc/hosts" })
  } finally {
    await rm(join(dir, "..", outsideName), { force: true })
    await rm(dir, { recursive: true, force: true })
  }
})

const finding = (over = {}) => ({
  severity: "major",
  file: "plugins/council.ts",
  line: 100,
  title: "PR sandbox fetch command is malformed so PR reviews never get a sandbox",
  detail: "makeShell splits the refspec into separate argv entries and git fetch rejects it.",
  ...over,
})

const CANNED_REVIEWS = {
  alpha: { verdict: "request_changes", summary: "alpha", findings: [finding()] },
  beta: { verdict: "approve_with_comments", summary: "beta", findings: [finding()] },
  gamma: { verdict: "approve", summary: "gamma", findings: [] },
}

function makeHarness(repo, options = {}) {
  const tools = new Map()
  const created = []
  const prompts = []
  const moves = []
  const calls = new Map()
  const textFor = async (owner, seen) => {
    if (!owner || owner.agent === "council-chair") {
      return options.fallbackText ?? "# Chair report\n\nVerdict: changes requested."
    }
    if (options.reviewText) return options.reviewText(owner, seen)
    return JSON.stringify(CANNED_REVIEWS[owner.model.id])
  }
  const context = {
    agent: "build",
    sessionID: options.sessionID ?? "ses_parent",
    signal: options.signal ?? new AbortController().signal,
    progress: async () => {},
    location: { directory: repo },
    tool: {
      transform: async (callback) => {
        callback({ add: (tool) => tools.set(tool.name, tool) })
        return { dispose: async () => {} }
      },
    },
    session: {
      get: async () => ({ location: { directory: repo } }),
      create: async (input) => {
        const id = `ses_fake_${created.length + 1}`
        const session = { id, ...input }
        created.push(session)
        if (options.onCreate) await options.onCreate(session)
        return { id }
      },
      prompt: async (input) => {
        prompts.push(input)
      },
      wait: async (input, waitOptions) => {
        if (options.wait) await options.wait(input, waitOptions)
      },
      interrupt: async () => {},
      move: async (input) => {
        moves.push(input)
      },
      context: async (input) => {
        const owner = created.find((session) => session.id === input.sessionID)
        const seen = (calls.get(input.sessionID) ?? 0) + 1
        calls.set(input.sessionID, seen)
        const text = await textFor(owner, seen)
        return [
          { type: "user", content: [{ type: "text", text: "brief" }] },
          { type: "assistant", content: [{ type: "text", text }] },
        ]
      },
    },
  }
  return { context, tools, created, prompts, moves }
}

const runScript = (args, options = {}) =>
  new Promise((resolve) => {
    execFile("bash", args, options, (error, stdout, stderr) => {
      resolve({ code: typeof error?.code === "number" ? error.code : error ? 1 : 0, stdout, stderr })
    })
  })

test("sameIssue matches the same issue across different path prefixes", () => {
  const a = finding()
  const b = finding({ file: "council-review/plugins/council.ts" })
  assert.equal(sameFile(a.file, b.file), true)
  assert.equal(sameIssue(a, b), true)
})

test("sameIssue is conservative when a line number is missing", () => {
  const a = finding({ line: null, title: "Sandbox cleanup removes active worktrees", detail: "" })
  const b = finding({ line: null, title: "Sandbox cleanup removes node_modules symlinks", detail: "" })
  assert.equal(sameIssue(a, b), false)
  assert.equal(sameIssue({ ...a, line: 10 }, { ...b, line: 11 }), false)
  const c = finding({ line: null, title: "Sandbox cleanup removes active worktrees", detail: "" })
  assert.equal(sameIssue(a, c), true)
})

test("sameIssue does not merge distinct issues in the same region", () => {
  const a = finding({
    line: 605,
    title: "Reviewer retry after a timeout reuses the timed-out session",
    detail: "The catch block aborts and rescues even when the prompt timed out, restarting the full review.",
  })
  const b = finding({
    line: 606,
    title: "Clustering merges distinct findings on the same file",
    detail: "The overlap bar is too low and chains unrelated issues into one consensus row.",
  })
  assert.equal(sameIssue(a, b), false)
})

test("buildClusters groups the same issue across reviewers and keeps distinct issues apart", () => {
  const reviewer = (name, findings) => ({ name, label: name, code: "X", status: "ok", findings })
  const results = [
    reviewer("a", [
      finding(),
      finding({
        line: 900,
        title: "Sweep deletes concurrent runs sandboxes",
        detail: "sweepSandboxes removes every worktree under the shared root.",
      }),
    ]),
    reviewer("b", [finding({ file: "council-review/plugins/council.ts" })]),
    reviewer("c", [
      finding(),
      finding({
        line: 901,
        title: "Untracked copy has no size cap",
        detail: "Large artifacts are copied into every sandbox with no byte limit.",
      }),
    ]),
  ]
  const clusters = buildClusters(results)
  const unanimous = clusters.filter((cluster) => new Set(cluster.members.map((m) => m.reviewer.name)).size === 3)
  assert.equal(unanimous.length, 1)
  assert.equal(unanimous[0].members.length, 3)
})

test("buildClusters does not chain distinct issues through a shared member", () => {
  const reviewer = (name, findings) => ({ name, label: name, code: "X", status: "ok", findings })
  const results = [
    reviewer("a", [finding({ title: "Sandbox cleanup removes active worktrees", detail: "" })]),
    reviewer("b", [finding({ title: "Sandbox cleanup removes worktrees", detail: "" })]),
    reviewer("c", [finding({ title: "Sandbox cleanup removes node_modules symlinks", detail: "" })]),
  ]
  const clusters = buildClusters(results)
  assert.equal(clusters.length, 2)
  assert.deepEqual(
    clusters.map((cluster) => cluster.members.length).sort(),
    [1, 2],
  )
})

test("leadFinding returns the highest-severity member", () => {
  const cluster = {
    members: [
      { reviewer: {}, finding: finding({ severity: "minor", title: "b" }) },
      { reviewer: {}, finding: finding({ severity: "critical", title: "a" }) },
    ],
  }
  assert.equal(leadFinding(cluster).severity, "critical")
})

test("createSandbox refuses a PR without a pinned head and checks out the pinned commit", async () => {
  const sh = makeShell()
  const origin = await mkdtemp(join(tmpdir(), "council-origin-"))
  const repo = await mkdtemp(join(tmpdir(), "council-clone-"))
  try {
    await exec("git", ["init", "-q", "--bare"], { cwd: origin })
    await exec("git", ["clone", "-q", origin, repo], { cwd: tmpdir() })
    await exec(
      "git",
      ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "change"],
      { cwd: repo },
    )
    const sha = (await exec("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim()
    await exec("git", ["push", "-q", "origin", "HEAD:refs/pull/7/head"], { cwd: repo })

    const stateRoot = await stateRootFor(sh, repo)
    const unpinned = await createSandbox(
      sh,
      repo,
      stateRoot,
      "test-pr-7",
      { kind: "pr", number: "7" },
      { includesWorktree: false },
    )
    assert.equal(unpinned, undefined, "a PR sandbox never resolves the PR head itself")

    const sandbox = await createSandbox(
      sh,
      repo,
      stateRoot,
      "test-pr-7-pinned",
      { kind: "pr", number: "7" },
      { includesWorktree: false, baseSha: sha },
    )
    assert.ok(sandbox, "sandbox is created from the pinned PR head")
    const head = (await exec("git", ["rev-parse", "HEAD"], { cwd: sandbox.dir })).stdout.trim()
    assert.equal(head, sha)

    // A later PR update must not change a sandbox created for the pinned commit.
    await exec("git", ["commit", "-q", "--allow-empty", "-m", "later"], { cwd: repo })
    await exec("git", ["push", "-q", "origin", "HEAD:refs/pull/7/head"], { cwd: repo })
    const replayed = await createSandbox(
      sh,
      repo,
      stateRoot,
      "test-pr-7-replay",
      { kind: "pr", number: "7" },
      { includesWorktree: false, baseSha: head },
    )
    assert.ok(replayed, "the pinned commit still gets a sandbox")
    const replayedHead = (await exec("git", ["rev-parse", "HEAD"], { cwd: replayed.dir })).stdout.trim()
    assert.equal(replayedHead, head)
  } finally {
    await rm(repo, { recursive: true, force: true })
    await rm(origin, { recursive: true, force: true })
  }
})

test("fetchPrEvidence pins the PR head and base to run-private refs", async () => {
  const sh = makeShell()
  const origin = await mkdtemp(join(tmpdir(), "council-origin-"))
  const repo = await mkdtemp(join(tmpdir(), "council-clone-"))
  const bin = await mkdtemp(join(tmpdir(), "council-bin-"))
  const previousPath = process.env.PATH
  try {
    await exec("git", ["init", "-q", "--bare"], { cwd: origin })
    await exec("git", ["init", "-q"], { cwd: repo })
    await writeFile(join(repo, "base.txt"), "base\n")
    await exec("git", ["add", "base.txt"], { cwd: repo })
    await exec("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "base"], { cwd: repo })
    await exec("git", ["branch", "-M", "main"], { cwd: repo })
    await exec("git", ["remote", "add", "origin", origin], { cwd: repo })
    await exec("git", ["push", "-q", "origin", "main"], { cwd: repo })

    await exec("git", ["checkout", "-q", "-b", "feature"], { cwd: repo })
    await writeFile(join(repo, "feature.txt"), "first\n")
    await exec("git", ["add", "feature.txt"], { cwd: repo })
    await exec("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "feature"], { cwd: repo })
    const head = (await exec("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim()
    await exec("git", ["push", "-q", "origin", "HEAD:refs/pull/7/head"], { cwd: repo })

    const gh = join(bin, "gh")
    await writeFile(gh, '#!/bin/sh\nif [ "$1" = "pr" ] && [ "$2" = "view" ]; then printf "main\\n"; exit 0; fi\necho "unexpected gh: $*" >&2\nexit 1\n')
    await exec("chmod", ["+x", gh])
    process.env.PATH = `${bin}:${previousPath ?? ""}`

    const evidence = await fetchPrEvidence(sh, repo, "7", "run-one")
    assert.equal("error" in evidence, false, "error" in evidence ? evidence.error : undefined)
    assert.equal(evidence.headOid, head)
    assert.equal(evidence.label, "PR #7")
    assert.match(evidence.patch, /feature\.txt/)
    assert.match(evidence.patch, /\+first/)
    assert.equal(
      (await exec("git", ["rev-parse", "refs/council/run-one/pr-7-head"], { cwd: repo })).stdout.trim(),
      head,
    )
    assert.equal(
      (await exec("git", ["rev-parse", "refs/council/run-one/pr-7-base"], { cwd: repo })).stdout.trim(),
      (await exec("git", ["rev-parse", "main"], { cwd: repo })).stdout.trim(),
    )

    // Updating the PR after evidence collection must not change what a sandbox checks out.
    await writeFile(join(repo, "feature.txt"), "second\n")
    await exec("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-am", "later"], { cwd: repo })
    await exec("git", ["push", "-q", "origin", "+HEAD:refs/pull/7/head"], { cwd: repo })
    const sandbox = await createSandbox(
      sh,
      repo,
      await stateRootFor(sh, repo),
      "test-pr-evidence",
      { kind: "pr", number: "7" },
      { includesWorktree: false, baseSha: evidence.headOid },
    )
    assert.ok(sandbox)
    assert.equal((await exec("git", ["rev-parse", "HEAD"], { cwd: sandbox.dir })).stdout.trim(), head)
    assert.equal(await readFile(join(sandbox.dir, "feature.txt"), "utf8"), "first\n")
  } finally {
    process.env.PATH = previousPath
    await rm(repo, { recursive: true, force: true })
    await rm(origin, { recursive: true, force: true })
    await rm(bin, { recursive: true, force: true })
  }
})

test("createSandbox shares dependency dirs and leaves output dirs alone", async () => {
  const sh = makeShell()
  const repo = await mkdtemp(join(tmpdir(), "council-repo-"))
  try {
    await exec("git", ["init", "-q"], { cwd: repo })
    await writeFile(join(repo, ".gitignore"), "node_modules/\nbuild/\n")
    await exec("git", ["add", ".gitignore"], { cwd: repo })
    await exec("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init"], { cwd: repo })
    await mkdir(join(repo, "node_modules", "pkg"), { recursive: true })
    await writeFile(join(repo, "node_modules", "pkg", "index.js"), "x")
    await mkdir(join(repo, "build"), { recursive: true })
    await writeFile(join(repo, "build", "out.txt"), "x")

    const stateRoot = await stateRootFor(sh, repo)
    const sandbox = await createSandbox(
      sh,
      repo,
      stateRoot,
      "test-ignored",
      { kind: "diff", rev: ["HEAD"] },
      { includesWorktree: false },
    )
    assert.ok(sandbox)
    assert.equal(lstatSync(join(sandbox.dir, "node_modules")).isSymbolicLink(), true)
    assert.equal(existsSync(join(sandbox.dir, "build")), false)
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test("baseShaFor pins the sandbox base for each target kind", () => {
  assert.equal(baseShaFor({ kind: "diff", rev: ["HEAD~3"] }), "HEAD~3")
  assert.equal(baseShaFor({ kind: "diff", rev: ["main...HEAD"] }), "HEAD")
  assert.equal(baseShaFor({ kind: "diff", rev: ["HEAD", "--", "sub"] }), "HEAD")
  assert.equal(baseShaFor({ kind: "focus", focus: "anything" }), "HEAD")
  assert.equal(baseShaFor({ kind: "pr", number: "7" }), undefined)
})

test("runRecordPath resolves inside the given git dir, not a nested .git", () => {
  assert.equal(runRecordPath("/tmp/example/.git"), "/tmp/example/.git/opencode-council/latest-run.json")
})

test("reviewerName resolves current records and legacy agent records", () => {
  assert.equal(reviewerName({ name: "alpha", label: "Alpha", status: "ok" }), "alpha")
  assert.equal(reviewerName({ agent: "council-legacy", label: "Legacy", status: "ok" }), "legacy")
  assert.equal(reviewerName({ label: "unknown", status: "failed" }), "unknown")
})

function setEnv(name, value) {
  const previous = process.env[name]
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
  return () => {
    if (previous === undefined) delete process.env[name]
    else process.env[name] = previous
  }
}

test("councilConfigPath honors the explicit override and config directory environment", () => {
  const restores = [
    setEnv("OPENCODE_COUNCIL_CONFIG", "~/council.json"),
    setEnv("OPENCODE_CONFIG_DIR", undefined),
    setEnv("XDG_CONFIG_HOME", undefined),
  ]
  try {
    assert.equal(councilConfigPath(), join(homedir(), "council.json"))
  } finally {
    for (const restore of restores.reverse()) restore()
  }

  const configDir = setEnv("OPENCODE_CONFIG_DIR", "/tmp/opencode-config")
  const xdg = setEnv("XDG_CONFIG_HOME", undefined)
  const override = setEnv("OPENCODE_COUNCIL_CONFIG", undefined)
  try {
    assert.equal(councilConfigPath(), "/tmp/opencode-config/council.json")
  } finally {
    configDir()
    xdg()
    override()
  }

  const xdgRestore = setEnv("XDG_CONFIG_HOME", "/tmp/xdg-config")
  const configDirRestore = setEnv("OPENCODE_CONFIG_DIR", undefined)
  const overrideRestore = setEnv("OPENCODE_COUNCIL_CONFIG", undefined)
  try {
    assert.equal(councilConfigPath(), "/tmp/xdg-config/opencode/council.json")
  } finally {
    xdgRestore()
    configDirRestore()
    overrideRestore()
  }
})

test("loadCouncilConfig parses reviewers and applies label and code defaults", async () => {
  const dir = await mkdtemp(join(tmpdir(), "council-config-"))
  const path = join(dir, "council.json")
  const restore = setEnv("OPENCODE_COUNCIL_CONFIG", path)
  try {
    await writeFile(
      path,
      JSON.stringify({
        reviewers: [
          { name: "one", model: "test/one#max" },
          { name: "two", label: "Second", code: "z", model: "test/two" },
          { name: "three", model: "test/three#fast" },
        ],
        chair: "test/chair#max",
      }),
    )

    const loaded = await loadCouncilConfig()
    if ("error" in loaded) assert.fail(loaded.error)
    assert.equal(loaded.path, path)
    assert.deepEqual(
      loaded.config.reviewers.map(({ name, label, code, model }) => ({
        name,
        label,
        code,
        providerID: model.providerID,
        id: model.id,
        variant: model.variant,
      })),
      [
        { name: "one", label: "one", code: "O", providerID: "test", id: "one", variant: "max" },
        { name: "two", label: "Second", code: "Z", providerID: "test", id: "two", variant: undefined },
        { name: "three", label: "three", code: "T", providerID: "test", id: "three", variant: "fast" },
      ],
    )
    assert.equal(loaded.config.chair.providerID, "test")
    assert.equal(loaded.config.chair.id, "chair")
    assert.equal(loaded.config.chair.variant, "max")
  } finally {
    restore()
    await rm(dir, { recursive: true, force: true })
  }
})

test("loadCouncilConfig rejects missing and invalid configurations", async () => {
  const missingRestore = setEnv("OPENCODE_COUNCIL_CONFIG", join(tmpdir(), `missing-council-${Date.now()}.json`))
  try {
    const missing = await loadCouncilConfig()
    assert.match(missing.error, /^Council aborted: no council model configuration at /)
  } finally {
    missingRestore()
  }

  const dir = await mkdtemp(join(tmpdir(), "council-config-invalid-"))
  const path = join(dir, "council.json")
  const restore = setEnv("OPENCODE_COUNCIL_CONFIG", path)
  try {
    const valid = {
      reviewers: [
        { name: "a", model: "test/a" },
        { name: "b", model: "test/b" },
        { name: "c", model: "test/c" },
      ],
      chair: "test/chair",
    }
    const cases = [
      [{ ...valid, reviewers: valid.reviewers.slice(0, 2) }, /exactly 3 reviewers are required/],
      [{ ...valid, reviewers: undefined }, /"reviewers" must be an array/],
      [{ ...valid, reviewers: [valid.reviewers[0], { ...valid.reviewers[1], name: "A" }, valid.reviewers[2]] }, /duplicate reviewer name "A"/],
      [{ ...valid, reviewers: [valid.reviewers[0], { ...valid.reviewers[1], code: "A" }, valid.reviewers[2]] }, /duplicate reviewer code "A"/],
      [{ ...valid, reviewers: [valid.reviewers[0], { ...valid.reviewers[1], code: "AB" }, valid.reviewers[2]] }, /single letter or digit/],
      [{ ...valid, reviewers: [valid.reviewers[0], { ...valid.reviewers[1], model: "not-a-model" }, valid.reviewers[2]] }, /model reference/],
      [{ ...valid, chair: 42 }, /chair must be a non-empty string/],
    ]
    for (const [config, expected] of cases) {
      await writeFile(path, JSON.stringify(config))
      const loaded = await loadCouncilConfig()
      assert.match(loaded.error, /^Council aborted: invalid council model configuration at /)
      assert.match(loaded.error, expected)
    }

    await writeFile(path, "not json")
    const malformed = await loadCouncilConfig()
    assert.match(malformed.error, /invalid council model configuration/)
  } finally {
    restore()
    await rm(dir, { recursive: true, force: true })
  }
})

test("council run fails closed and starts nothing without a usable config", async () => {
  const repo = await makeCouncilRepo("council-config-fail-closed-")
  const path = join(repo, "council.json")
  const restore = setEnv("OPENCODE_COUNCIL_CONFIG", path)
  try {
    const run = makeHarness(repo)
    await CouncilPlugin.setup(run.context)

    const missing = await run.tools.get("council").execute({}, run.context)
    assert.match(missing.output, /Council aborted: no council model configuration/)
    assert.equal(run.created.length, 0, "a missing config starts no sessions")
    assert.equal(run.prompts.length, 0, "a missing config sends no prompts")
    assert.equal(
      existsSync(join(repo, ".git", "opencode-council")),
      false,
      "a missing config creates no state, patch, or sandboxes",
    )

    await writeFile(path, JSON.stringify({ reviewers: [], chair: "test/chair" }))
    const invalid = await run.tools.get("council").execute({}, run.context)
    assert.match(invalid.output, /Council aborted: invalid council model configuration/)
    assert.equal(run.created.length, 0, "an invalid config starts no sessions")
    assert.equal(run.prompts.length, 0, "an invalid config sends no prompts")
    assert.equal(
      existsSync(join(repo, ".git", "opencode-council")),
      false,
      "an invalid config creates no state, patch, or sandboxes",
    )
  } finally {
    restore()
    await rm(repo, { recursive: true, force: true })
  }
})

test("stateRootFor resolves the git common dir", async () => {
  const sh = makeShell()
  const repo = await mkdtemp(join(tmpdir(), "council-state-"))
  try {
    await exec("git", ["init", "-q"], { cwd: repo })
    const stateRoot = await stateRootFor(sh, repo)
    assert.equal(realpathSync(stateRoot), realpathSync(join(repo, ".git")))
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test("sweepSandboxes keeps live sandboxes, removes stale ones, and stays conservative", async () => {
  const sh = makeShell()
  const repo = await mkdtemp(join(tmpdir(), "council-sweep-"))
  let outside
  try {
    await exec("git", ["init", "-q"], { cwd: repo })
    await exec(
      "git",
      ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"],
      { cwd: repo },
    )
    const stateRoot = realpathSync(await stateRootFor(sh, repo))
    const stateDir = join(stateRoot, "opencode-council")
    const worktrees = join(stateDir, "worktrees")
    const active = join(stateDir, "active")
    await mkdir(worktrees, { recursive: true })
    await mkdir(active, { recursive: true })

    const live = join(worktrees, "live-1")
    const stale = join(worktrees, "stale-1")
    await exec("git", ["worktree", "add", "--detach", live, "HEAD"], { cwd: repo })
    await exec("git", ["worktree", "add", "--detach", stale, "HEAD"], { cwd: repo })
    const aged = new Date(Date.now() - 4 * 60 * 60 * 1000)
    await utimes(stale, aged, aged)
    await writeFile(
      join(active, "run-live.json"),
      JSON.stringify({ pid: process.pid, time: Date.now(), sandboxes: ["live-1"] }),
    )
    await writeFile(
      join(active, "run-stale.json"),
      JSON.stringify({ pid: 2_000_000_000, time: Date.now() - 4 * 60 * 60 * 1000, sandboxes: ["stale-1"] }),
    )

    await sweepSandboxes(sh, repo, stateRoot)
    assert.equal(existsSync(live), true, "live sandbox kept")
    assert.equal(existsSync(stale), false, "stale sandbox removed")
    assert.equal(existsSync(join(active, "run-stale.json")), false, "stale marker removed")

    const protectedWt = join(worktrees, "run-malformed-1")
    await exec("git", ["worktree", "add", "--detach", protectedWt, "HEAD"], { cwd: repo })
    await utimes(protectedWt, aged, aged)
    await writeFile(join(active, "run-malformed.json"), "not json at all")
    const stale2 = join(worktrees, "stale-2")
    await exec("git", ["worktree", "add", "--detach", stale2, "HEAD"], { cwd: repo })
    await utimes(stale2, aged, aged)
    await writeFile(
      join(active, "run-stale2.json"),
      JSON.stringify({ pid: 2_000_000_000, time: Date.now() - 4 * 60 * 60 * 1000, sandboxes: ["stale-2"] }),
    )
    await sweepSandboxes(sh, repo, stateRoot)
    assert.equal(existsSync(protectedWt), true, "an unparseable marker protects that run's worktrees")
    assert.equal(existsSync(stale2), false, "a stale parseable marker does not protect its worktrees")

    await rm(join(active, "run-malformed.json"), { force: true })
    await sweepSandboxes(sh, repo, stateRoot)
    assert.equal(existsSync(protectedWt), false, "the protected worktree is removed once its marker is gone")

    outside = join(realpathSync(tmpdir()), `council-outside-${Date.now()}`)
    await exec("git", ["worktree", "add", "--detach", outside, "HEAD"], { cwd: repo })
    await sweepSandboxes(sh, repo, stateRoot)
    assert.equal(existsSync(outside), true, "worktrees outside the shared root are not removed")
  } finally {
    if (outside) await rm(outside, { recursive: true, force: true })
    await rm(repo, { recursive: true, force: true })
  }
})

test("pruneOldPatches removes old patches and keeps fresh ones", async () => {
  const dir = await mkdtemp(join(tmpdir(), "council-patches-"))
  try {
    const old = join(dir, "old.patch")
    const fresh = join(dir, "fresh.patch")
    await writeFile(old, "x")
    await writeFile(fresh, "x")
    const oldTime = new Date(Date.now() - 3 * 60 * 60 * 1000)
    await utimes(old, oldTime, oldTime)
    await pruneOldPatches(dir)
    assert.equal(existsSync(old), false)
    assert.equal(existsSync(fresh), true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("extractJson parses fenced, bare, and prose-wrapped JSON objects", () => {
  assert.deepEqual(extractJson('```json\n{"verdict":"ok"}\n```'), { verdict: "ok" })
  assert.deepEqual(extractJson('```\n{"a":1}\n```'), { a: 1 })
  assert.deepEqual(extractJson('Here is the result:\n{"a":1,"b":[2]}\nDone.'), { a: 1, b: [2] })
  assert.deepEqual(extractJson('{"nested":{"x":1}}'), { nested: { x: 1 } })
})

test("extractJson prefers a parseable fenced block over surrounding prose", () => {
  assert.deepEqual(extractJson('Preamble {"not":"json"} text\n```json\n{"findings":[]}\n```\nTrailer'), {
    findings: [],
  })
})

test("extractJson returns undefined for non-JSON text and never throws", () => {
  assert.equal(extractJson("no json here"), undefined)
  assert.equal(extractJson("{not json}"), undefined)
  assert.equal(extractJson(""), undefined)
  assert.equal(extractJson("[1,2,3]"), undefined)
})

test("textResult drops nested undefined metadata so the tool success event encodes", () => {
  const result = textResult("report", {
    target: "main...HEAD",
    reviewers: [
      { name: "deepseek", status: "ok", sessionID: "ses_1", error: undefined, droppedFindings: 0 },
      { name: "luna", status: "failed", sessionID: undefined, error: "boom", droppedFindings: undefined },
    ],
  })
  assert.equal(result.output, "report")
  assert.equal(result.content, "report")
  assert.deepEqual(result.metadata, {
    target: "main...HEAD",
    reviewers: [
      { name: "deepseek", status: "ok", sessionID: "ses_1", droppedFindings: 0 },
      { name: "luna", status: "failed", error: "boom" },
    ],
  })
  assert.equal(JSON.stringify(result.metadata).includes("undefined"), false)
  assert.equal(textResult("report").metadata, undefined)
})

test("textResult metadata encodes through the core tool-success schema", () => {
  const metadata = {
    target: "main...HEAD",
    reviewers: [
      { name: "deepseek", status: "ok", sessionID: "ses_1", error: undefined, droppedFindings: 0 },
      { name: "luna", status: "failed", sessionID: undefined, error: "boom", droppedFindings: undefined },
    ],
  }
  const schema = SessionEvent.Tool.Success.fields.data.fields.metadata
  assert.throws(() => Schema.encodeSync(schema)(metadata), /Expected JSON value/)
  const result = textResult("report", metadata)
  assert.deepEqual(Schema.encodeSync(schema)(result.metadata), {
    target: "main...HEAD",
    reviewers: [
      { name: "deepseek", status: "ok", sessionID: "ses_1", droppedFindings: 0 },
      { name: "luna", status: "failed", error: "boom" },
    ],
  })
})

test("textResult keeps JSON-safe metadata values intact", () => {
  const result = textResult("report", {
    string: "",
    number: 0,
    negative: -1.5,
    boolean: false,
    nil: null,
    array: [1, "two", null, false, { nested: [] }],
    object: { deep: { deeper: "value" } },
  })
  assert.deepEqual(result.metadata, {
    string: "",
    number: 0,
    negative: -1.5,
    boolean: false,
    nil: null,
    array: [1, "two", null, false, { nested: [] }],
    object: { deep: { deeper: "value" } },
  })
})

test("textResult turns undefined array items into null like JSON", () => {
  const result = textResult("report", { items: ["a", undefined, { keep: 1, drop: undefined }] })
  assert.deepEqual(result.metadata, { items: ["a", null, { keep: 1 }] })
})

test("textResult rejects metadata JSON cannot represent instead of coercing it", () => {
  assert.throws(() => textResult("report", { bad: Number.NaN }), {
    name: "TypeError",
    message: "textResult metadata must be JSON-safe: metadata.bad is NaN",
  })
  assert.throws(() => textResult("report", { list: [Number.POSITIVE_INFINITY] }), {
    name: "TypeError",
    message: "textResult metadata must be JSON-safe: metadata.list[0] is Infinity",
  })
  assert.throws(() => textResult("report", { count: 1n }), {
    name: "TypeError",
    message: "textResult metadata must be JSON-safe: metadata.count is a bigint",
  })
  assert.throws(() => textResult("report", { callback: () => {} }), {
    name: "TypeError",
    message: "textResult metadata must be JSON-safe: metadata.callback is a function",
  })
  assert.throws(() => textResult("report", { key: Symbol("k") }), {
    name: "TypeError",
    message: "textResult metadata must be JSON-safe: metadata.key is a symbol",
  })
  assert.throws(() => textResult("report", { when: new Date(0) }), {
    name: "TypeError",
    message: "textResult metadata must be JSON-safe: metadata.when is Date",
  })
  assert.throws(() => textResult("report", { lookup: new Map() }), {
    name: "TypeError",
    message: "textResult metadata must be JSON-safe: metadata.lookup is Map",
  })
  assert.throws(() => textResult("report", { seen: new Set() }), {
    name: "TypeError",
    message: "textResult metadata must be JSON-safe: metadata.seen is Set",
  })
})

test("textResult rejects circular metadata and explains where the cycle is", () => {
  const object = { name: "loop" }
  object.self = object
  assert.throws(() => textResult("report", { object }), {
    name: "TypeError",
    message: "textResult metadata must be JSON-safe: metadata.object.self is circular",
  })

  const array = []
  array.push(array)
  assert.throws(() => textResult("report", { array }), {
    name: "TypeError",
    message: "textResult metadata must be JSON-safe: metadata.array[0] is circular",
  })
})

test("textResult allows shared references that are not circular", () => {
  const shared = { name: "same" }
  const result = textResult("report", { first: shared, second: [shared] })
  assert.deepEqual(result.metadata, {
    first: { name: "same" },
    second: [{ name: "same" }],
  })
  assert.notEqual(result.metadata.first, result.metadata.second[0])
})

test("textResult does not mutate the metadata it is given", () => {
  const metadata = {
    target: "main...HEAD",
    undefinedValue: undefined,
    items: ["a", undefined],
    nested: { keep: 1, drop: undefined },
  }
  const before = {
    target: metadata.target,
    hasUndefined: Object.hasOwn(metadata, "undefinedValue"),
    items: [metadata.items[0], metadata.items.length],
    nested: { ...metadata.nested },
  }
  textResult("report", metadata)
  assert.equal(metadata.undefinedValue, undefined)
  assert.equal(Object.hasOwn(metadata, "undefinedValue"), true)
  assert.deepEqual(metadata.items, ["a", undefined])
  assert.deepEqual(metadata.nested, { keep: 1, drop: undefined })
  assert.deepEqual(
    { target: metadata.target, hasUndefined: before.hasUndefined },
    { target: "main...HEAD", hasUndefined: true },
  )
  assert.deepEqual(before.items, ["a", 2])
})

test("turnAssistantText returns the last assistant text within the current turn", () => {
  const messages = [
    { type: "user", content: [{ type: "text", text: "brief" }] },
    {
      type: "assistant",
      content: [
        { type: "reasoning", text: "thinking" },
        { type: "tool", state: "completed" },
        { type: "text", text: "first answer" },
      ],
    },
    {
      type: "assistant",
      content: [
        { type: "text", text: '{"verdict":"ok"}' },
        { type: "reasoning", text: "more thinking" },
      ],
    },
  ]
  assert.equal(turnAssistantText(messages), '{"verdict":"ok"}')
})

test("turnAssistantText ignores assistant text from earlier turns", () => {
  const messages = [
    { type: "assistant", content: [{ type: "text", text: "previous review output" }] },
    { type: "user", content: [{ type: "text", text: "follow-up question" }] },
    { type: "assistant", content: [{ type: "tool", state: "completed" }] },
  ]
  assert.equal(turnAssistantText(messages), undefined)
  assert.equal(
    turnAssistantText([...messages, { type: "assistant", content: [{ type: "text", text: "new answer" }] }]),
    "new answer",
  )
  assert.equal(turnAssistantText(undefined), undefined)
  assert.equal(turnAssistantText([]), undefined)
  assert.equal(turnAssistantText([{ type: "assistant" }]), undefined)
  assert.equal(turnAssistantText([{ type: "assistant", content: [{ type: "text", text: "   " }] }]), undefined)
})

test("normalizeFinding coerces string line numbers and lowercases severity", () => {
  const normalized = normalizeFinding({
    severity: "Major",
    file: " plugins/council.ts ",
    line: "42",
    title: " t ",
    detail: " d ",
    suggestion: " s ",
  })
  assert.deepEqual(normalized, {
    severity: "major",
    file: "plugins/council.ts",
    line: 42,
    title: "t",
    detail: "d",
    suggestion: "s",
  })
  assert.equal(normalizeFinding({ ...finding(), severity: "blocker" }), undefined)
  assert.equal(normalizeFinding({ ...finding(), detail: "  " }), undefined)
  assert.equal(normalizeFinding({ ...finding(), line: "12abc" }).line, undefined)
  assert.equal(normalizeFinding(null), undefined)
})

test("validateReviewOutput accepts a well-formed review and counts dropped findings", () => {
  const valid = validateReviewOutput({
    verdict: "approve_with_comments",
    summary: "Looks fine.",
    findings: [
      finding({ line: "77" }),
      { severity: "major", file: "a.ts", title: "no detail" },
      "not an object",
      finding({ severity: "catastrophic" }),
    ],
  })
  assert.equal(valid.error, undefined)
  assert.equal(valid.dropped, 3)
  assert.equal(valid.problems.length, 3)
  assert.match(valid.problems[0], /findings\[1\]: "detail"/)
  assert.match(valid.problems[1], /findings\[2\]: must be a JSON object/)
  assert.match(valid.problems[2], /findings\[3\]: "severity"/)
  assert.equal(valid.output.verdict, "approve_with_comments")
  assert.equal(valid.output.findings.length, 1)
  assert.equal(valid.output.findings[0].line, 77)
})

test("validateReviewOutput rejects non-review payloads", () => {
  assert.match(validateReviewOutput({ foo: 1 }).error, /verdict/)
  assert.match(validateReviewOutput({ verdict: "approve" }).error, /summary/)
  assert.match(validateReviewOutput({ verdict: "approve", summary: "x" }).error, /findings/)
  assert.match(validateReviewOutput([1, 2, 3]).error, /object/)
  assert.match(validateReviewOutput(undefined).error, /object/)
  assert.equal(validateReviewOutput({ verdict: "approve", summary: "x", findings: [] }).output.verdict, "approve")
})

test("renderMatrix reports how many reviewers completed", () => {
  const ok = (name, findings = []) => ({ name, label: name, code: name.slice(0, 1), status: "ok", findings })
  const failed = (name) => ({ name, label: name, code: name.slice(0, 1), status: "failed", error: "boom", findings: [] })
  const reviewers = [
    { name: "a", label: "a", code: "A" },
    { name: "b", label: "b", code: "B" },
    { name: "c", label: "c", code: "C" },
  ]
  const cluster = {
    members: [
      { reviewer: { name: "a" }, finding: finding() },
      { reviewer: { name: "b" }, finding: finding() },
    ],
  }
  const all = renderMatrix([cluster], [ok("a"), ok("b"), ok("c")], reviewers)
  assert.match(all, /^3 of 3 reviewers completed\./)
  assert.match(all, /\| 1 \| major \|/)
  assert.match(all, /AB \(2\/3\)/)
  const partial = renderMatrix([cluster], [ok("a"), failed("b"), ok("c")], reviewers)
  assert.match(partial, /^2 of 3 reviewers completed\./)
  const none = renderMatrix([], [failed("a"), failed("b"), failed("c")], reviewers)
  assert.match(none, /^0 of 3 reviewers completed\. No review was produced\./)
  const clean = renderMatrix([], [ok("a"), ok("b"), ok("c")], reviewers)
  assert.match(clean, /^3 of 3 reviewers completed\./)
  assert.match(clean, /No findings were reported/)
})

test("isSecretFile flags credential-like untracked files", () => {
  assert.equal(isSecretFile(".env"), true)
  assert.equal(isSecretFile("config/.env.local"), true)
  assert.equal(isSecretFile("certs/server.pem"), true)
  assert.equal(isSecretFile("keys/cert.P12"), true)
  assert.equal(isSecretFile("keys/server.key"), true)
  assert.equal(isSecretFile("certs/client.pfx"), true)
  assert.equal(isSecretFile("certs/store.jks"), true)
  assert.equal(isSecretFile("id_rsa"), true)
  assert.equal(isSecretFile("home/credentials.json"), true)
  assert.equal(isSecretFile("home/.git-credentials"), true)
  assert.equal(isSecretFile(".npmrc"), true)
  assert.equal(isSecretFile(".netrc"), true)
  assert.equal(isSecretFile("project/.pypirc"), true)
  assert.equal(isSecretFile("home/.kube/config"), true)
  assert.equal(isSecretFile(".envrc"), true)
  assert.equal(isSecretFile("src/env.ts"), false)
  assert.equal(isSecretFile("envoy.yaml"), false)
  assert.equal(isSecretFile("ids.txt"), false)
  assert.equal(isSecretFile("backup.pem.bak"), false)
  assert.equal(isSecretFile("home/.kube/other"), false)
  assert.equal(isSecretFile("src/keyfile"), false)
})

test("diffUntracked honors no-index failures and only synthesizes empty regular files", async () => {
  const fakeShell = (result) => {
    const command = {
      cwd: () => command,
      binary: () => command,
      nothrow: async () => result,
    }
    return () => command
  }
  const file = (over = {}) => ({ file: "new.txt", size: 4, kind: "file", ...over })

  assert.deepEqual(await diffUntracked(fakeShell({ exitCode: 2, stdout: "", stderr: "boom" }), "/", file({ size: 0 })), {
    kind: "error",
  })
  assert.deepEqual(await diffUntracked(fakeShell({ exitCode: 0, stdout: "", stderr: "" }), "/", file({ size: 0 })), {
    kind: "empty",
  })
  assert.deepEqual(await diffUntracked(fakeShell({ exitCode: 1, stdout: "", stderr: "" }), "/", file({ size: 4 })), {
    kind: "skip",
  })
  assert.deepEqual(
    await diffUntracked(
      fakeShell({ exitCode: 1, stdout: "diff --git a/new.txt b/new.txt\n", stderr: "" }),
      "/",
      file(),
    ),
    { kind: "diff", text: "diff --git a/new.txt b/new.txt\n" },
  )
  assert.deepEqual(await diffUntracked(fakeShell({ exitCode: 0, stdout: "", stderr: "" }), "/", file({ kind: "symlink" })), {
    kind: "skip",
  })
  assert.match(emptyFileDiff("empty.txt"), /^diff --git a\/empty\.txt b\/empty\.txt\nnew file mode 100644\n/)
})

test("listUntracked marks symlinks and non-regular entries without following them", async () => {
  const sh = makeShell()
  const repo = await mkdtemp(join(tmpdir(), "council-links-"))
  const outside = await mkdtemp(join(tmpdir(), "council-outside-"))
  try {
    await exec("git", ["init", "-q"], { cwd: repo })
    await exec(
      "git",
      ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"],
      { cwd: repo },
    )
    await writeFile(join(repo, "regular.txt"), "data")
    await writeFile(join(repo, "empty.txt"), "")
    await writeFile(join(outside, "secret.txt"), "outside")
    await symlink(join(outside, "secret.txt"), join(repo, "file-link.txt"))
    await symlink(outside, join(repo, "dir-link"))

    const entries = await listUntracked(sh, repo)
    const byFile = new Map(entries.map((entry) => [entry.file, entry]))
    assert.equal(byFile.get("regular.txt").kind, "file")
    assert.equal(byFile.get("empty.txt").kind, "file")
    assert.equal(byFile.get("empty.txt").size, 0)
    assert.equal(byFile.get("file-link.txt").kind, "symlink")
    assert.equal(byFile.get("dir-link").kind, "symlink")
  } finally {
    await rm(repo, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

test("createSandbox copies regular untracked files but never symlinks or secrets", async () => {
  const sh = makeShell()
  const repo = await mkdtemp(join(tmpdir(), "council-copy-"))
  const outside = await mkdtemp(join(tmpdir(), "council-outside-"))
  try {
    await exec("git", ["init", "-q"], { cwd: repo })
    await writeFile(join(repo, "tracked.txt"), "one\n")
    await exec("git", ["add", "tracked.txt"], { cwd: repo })
    await exec("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init"], { cwd: repo })
    await writeFile(join(repo, "tracked.txt"), "two\n")
    await writeFile(join(repo, "untracked.txt"), "extra\n")
    await writeFile(join(outside, "outside.txt"), "outside\n")
    await symlink(join(outside, "outside.txt"), join(repo, "link.txt"))
    await symlink(outside, join(repo, "dir-link"))
    await writeFile(join(repo, ".env"), "SECRET=1\n")

    const stateRoot = await stateRootFor(sh, repo)
    const sandbox = await createSandbox(
      sh,
      repo,
      stateRoot,
      "test-copy",
      { kind: "diff", rev: ["HEAD"] },
      { includesWorktree: true },
    )
    assert.ok(sandbox)
    assert.equal(await readFile(join(sandbox.dir, "tracked.txt"), "utf8"), "two\n")
    assert.equal(await readFile(join(sandbox.dir, "untracked.txt"), "utf8"), "extra\n")
    assert.equal(existsSync(join(sandbox.dir, "link.txt")), false, "symlinked untracked files are not copied")
    assert.equal(existsSync(join(sandbox.dir, "dir-link")), false, "symlinked directories are not copied")
    assert.equal(existsSync(join(sandbox.dir, ".env")), false, "secret files are not copied")
  } finally {
    await rm(repo, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

test("createSandbox replays a bare-ref patch with commits ahead and dirty changes", async () => {
  const sh = makeShell()
  const repo = await mkdtemp(join(tmpdir(), "council-bare-ref-"))
  try {
    await exec("git", ["init", "-q"], { cwd: repo })
    await writeFile(join(repo, "tracked.txt"), "one\n")
    await exec("git", ["add", "tracked.txt"], { cwd: repo })
    await exec("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "one"], { cwd: repo })
    await writeFile(join(repo, "tracked.txt"), "two\n")
    await exec("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-am", "two"], { cwd: repo })
    await writeFile(join(repo, "tracked.txt"), "three\n")
    await writeFile(join(repo, "untracked.txt"), "new\n")

    const patch = (await exec("git", ["diff", "HEAD~1", "--binary"], { cwd: repo })).stdout +
      (await exec("git", ["diff", "--no-index", "--binary", "--", "/dev/null", "untracked.txt"], { cwd: repo }).catch(
        (error) => ({ stdout: error.stdout }),
      )).stdout
    const stateRoot = await stateRootFor(sh, repo)
    const patchFile = join(realpathSync(stateRoot), "opencode-council", "bare-ref.full.patch")
    await mkdir(join(realpathSync(stateRoot), "opencode-council"), { recursive: true })
    await writeFile(patchFile, patch, "latin1")

    const sandbox = await createSandbox(sh, repo, stateRoot, "test-bare-ref", { kind: "diff", rev: ["HEAD~1"] }, {
      includesWorktree: true,
      baseSha: "HEAD~1",
      patchFile,
    })
    assert.ok(sandbox)
    assert.equal(
      await readFile(join(sandbox.dir, "tracked.txt"), "utf8"),
      "three\n",
      "the sandbox includes the committed change and the dirty working tree",
    )
    assert.equal(await readFile(join(sandbox.dir, "untracked.txt"), "utf8"), "new\n")

    const live = await createSandbox(sh, repo, stateRoot, "test-bare-ref-live", { kind: "diff", rev: ["HEAD~1"] }, {
      includesWorktree: true,
      baseSha: "HEAD~1",
    })
    assert.ok(live, "the live fallback also builds a sandbox")
    assert.equal(
      await readFile(join(live.dir, "tracked.txt"), "utf8"),
      "three\n",
      "the fallback diffs against the requested ref, not HEAD",
    )
    assert.equal(await readFile(join(live.dir, "untracked.txt"), "utf8"), "new\n")
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test("council run replays a bare ref into every sandbox with the working tree included", async () => {
  const repo = await mkdtemp(join(tmpdir(), "council-bare-ref-run-"))
  try {
    await exec("git", ["init", "-q"], { cwd: repo })
    await writeFile(join(repo, "tracked.txt"), "one\n")
    await exec("git", ["add", "tracked.txt"], { cwd: repo })
    await exec("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "one"], { cwd: repo })
    await writeFile(join(repo, "tracked.txt"), "two\n")
    await exec("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-am", "two"], { cwd: repo })
    await writeFile(join(repo, "tracked.txt"), "three\n")
    await writeFile(join(repo, "untracked.txt"), "new\n")

    const seen = []
    const { context, tools } = makeHarness(repo, {
      onCreate: async (session) => {
        if (session.agent !== "council-reviewer") return
        seen.push({
          tracked: await readFile(join(session.location.directory, "tracked.txt"), "utf8"),
          untracked: await readFile(join(session.location.directory, "untracked.txt"), "utf8"),
        })
      },
    })
    await CouncilPlugin.setup(context)
    const result = await tools.get("council").execute({ request: "HEAD~1" }, context)

    assert.match(result.output, /3 of 3 reviewers completed/)
    assert.deepEqual(seen, [
      { tracked: "three\n", untracked: "new\n" },
      { tracked: "three\n", untracked: "new\n" },
      { tracked: "three\n", untracked: "new\n" },
    ])
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test("listUntracked treats . and ./ as the whole repository", async () => {
  const sh = makeShell()
  const repo = await mkdtemp(join(tmpdir(), "council-untracked-"))
  try {
    await exec("git", ["init", "-q"], { cwd: repo })
    await exec(
      "git",
      ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"],
      { cwd: repo },
    )
    await writeFile(join(repo, "root.txt"), "x")
    await mkdir(join(repo, "sub"), { recursive: true })
    await writeFile(join(repo, "sub", "inner.txt"), "x")

    const all = (await listUntracked(sh, repo, ".")).map((entry) => entry.file).sort()
    assert.deepEqual(all, ["root.txt", "sub/inner.txt"])
    const allDotSlash = (await listUntracked(sh, repo, "./")).map((entry) => entry.file).sort()
    assert.deepEqual(allDotSlash, ["root.txt", "sub/inner.txt"])
    const scoped = (await listUntracked(sh, repo, "./sub")).map((entry) => entry.file)
    assert.deepEqual(scoped, ["sub/inner.txt"])
    const unscoped = (await listUntracked(sh, repo)).map((entry) => entry.file).sort()
    assert.deepEqual(unscoped, ["root.txt", "sub/inner.txt"])
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test("createSandbox replays a recorded patch and refuses a missing one", async () => {
  const sh = makeShell()
  const repo = await mkdtemp(join(tmpdir(), "council-replay-"))
  try {
    await exec("git", ["init", "-q"], { cwd: repo })
    await writeFile(join(repo, "tracked.txt"), "one\n")
    await exec("git", ["add", "tracked.txt"], { cwd: repo })
    await exec("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init"], { cwd: repo })
    const baseSha = (await exec("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim()
    await writeFile(join(repo, "tracked.txt"), "two\n")
    await writeFile(join(repo, "added.txt"), "new\n")
    await exec("git", ["add", "-N", "added.txt"], { cwd: repo })
    const patch = (await exec("git", ["diff", "--binary"], { cwd: repo })).stdout

    const stateRoot = await stateRootFor(sh, repo)
    const patchFile = join(realpathSync(stateRoot), "opencode-council", "replay.full.patch")
    await mkdir(join(realpathSync(stateRoot), "opencode-council"), { recursive: true })
    await writeFile(patchFile, patch, "latin1")

    const sandbox = await createSandbox(sh, repo, stateRoot, "test-replay", { kind: "diff", rev: ["HEAD"] }, {
      includesWorktree: true,
      baseSha,
      patchFile,
    })
    assert.ok(sandbox, "sandbox replays the recorded patch")
    assert.equal((await readFile(join(sandbox.dir, "tracked.txt"), "utf8")), "two\n")
    assert.equal((await readFile(join(sandbox.dir, "added.txt"), "utf8")), "new\n")

    const missing = await createSandbox(sh, repo, stateRoot, "test-replay-missing", { kind: "diff", rev: ["HEAD"] }, {
      includesWorktree: true,
      baseSha,
      patchFile: join(realpathSync(stateRoot), "opencode-council", "nope.patch"),
    })
    assert.equal(missing, undefined, "a missing recorded patch fails the sandbox instead of using the live diff")
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test("council run binds reviewer sessions to sandboxes, validates output, and reports completions", async () => {
  const repo = await mkdtemp(join(tmpdir(), "council-run-"))
  try {
    await exec("git", ["init", "-q"], { cwd: repo })
    await writeFile(join(repo, "tracked.txt"), "one\n")
    await exec("git", ["add", "tracked.txt"], { cwd: repo })
    await exec("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init"], { cwd: repo })
    await writeFile(join(repo, "tracked.txt"), "two\n")

    const tools = new Map()
    const created = []
    const prompts = []
    const moves = []
    const canned = CANNED_REVIEWS
    const context = {
      agent: "build",
      sessionID: "ses_parent",
      signal: new AbortController().signal,
      progress: async () => {},
      location: { directory: repo },
      tool: {
        transform: async (callback) => {
          callback({ add: (tool) => tools.set(tool.name, tool) })
          return { dispose: async () => {} }
        },
      },
      session: {
        get: async () => ({ location: { directory: repo } }),
        create: async (input) => {
          const id = `ses_fake_${created.length + 1}`
          created.push({ id, ...input })
          return { id }
        },
        prompt: async (input) => {
          prompts.push(input)
        },
        wait: async () => {},
        interrupt: async () => {},
        move: async (input) => {
          moves.push(input)
        },
        context: async (input) => {
          const owner = created.find((session) => session.id === input.sessionID)
          if (!owner || owner.agent === "council-chair") {
            return [
              { type: "user", content: [{ type: "text", text: "brief" }] },
              { type: "assistant", content: [{ type: "text", text: "# Chair report\n\nVerdict: changes requested." }] },
            ]
          }
          const payload = canned[owner.model.id]
          return [
            { type: "user", content: [{ type: "text", text: "brief" }] },
            { type: "assistant", content: [{ type: "text", text: JSON.stringify(payload) }] },
          ]
        },
      },
    }

    await CouncilPlugin.setup(context)
    assert.ok(tools.has("council"), "council tool registered")
    const result = await tools.get("council").execute({}, context)
    assert.match(result.output, /^# Chair report/m)
    assert.match(result.output, /3 of 3 reviewers completed\./)
    assert.equal(result.metadata.reviewers.filter((reviewer) => reviewer.status === "ok").length, 3)

    const reviewerSessions = created.filter(
      (session) => session.agent.startsWith("council-") && session.agent !== "council-chair",
    )
    assert.equal(reviewerSessions.length, 3)
    assert.equal(new Set(reviewerSessions.map((session) => session.agent)).size, 1, "reviewers share one agent")
    assert.equal(reviewerSessions[0].agent, "council-reviewer")
    assert.deepEqual(
      reviewerSessions.map((session) => session.model.id).sort(),
      ["alpha", "beta", "gamma"],
      "each reviewer session gets its own model",
    )
    assert.ok(reviewerSessions.every((session) => session.model.variant === "max"))
    const chairSession = created.find((session) => session.agent === "council-chair")
    assert.ok(chairSession, "the chair session is created")
    assert.equal(chairSession.model.id, "chair", "the chair session gets the configured model")
    for (const session of reviewerSessions) {
      assert.ok(session.location?.directory, "reviewer session is bound to a directory")
      assert.notEqual(session.location.directory, repo, "reviewer session runs in its sandbox, not the checkout")
      assert.match(session.location.directory, /opencode-council[/\\]worktrees[/\\]/, "reviewer session is bound to a sandbox worktree")
    }
    const brief = prompts.find((prompt) => prompt.sessionID === reviewerSessions[0].id).text
    assert.match(brief, /Sandbox checkout: /)

    const worktrees = join(realpathSync(await stateRootFor(makeShell(), repo)), "opencode-council", "worktrees")
    const leftover = existsSync(worktrees) ? readdirSync(worktrees) : []
    assert.deepEqual(leftover, [], "sandboxes are removed after the run")
    assert.deepEqual(
      moves.map((move) => move.sessionID).sort(),
      reviewerSessions.map((session) => session.id).sort(),
      "reviewer sessions are moved out of their sandboxes before cleanup",
    )
    assert.ok(
      moves.every((move) => move.directory === repo),
      "reviewer sessions move to the reviewed checkout",
    )
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test("council run fails reviewers when no sandbox can be created", async () => {
  const repo = await mkdtemp(join(tmpdir(), "council-no-sandbox-"))
  try {
    await exec("git", ["init", "-q"], { cwd: repo })
    await writeFile(join(repo, "tracked.txt"), "one\n")
    await exec("git", ["add", "tracked.txt"], { cwd: repo })
    await exec("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init"], { cwd: repo })
    await writeFile(join(repo, "tracked.txt"), "two\n")

    const stateRoot = await stateRootFor(makeShell(), repo)
    await mkdir(join(stateRoot, "opencode-council"), { recursive: true })
    // A regular file where the worktrees directory should be makes every sandbox fail.
    await writeFile(join(stateRoot, "opencode-council", "worktrees"), "not a directory")

    const { context, tools, created } = makeHarness(repo)
    await CouncilPlugin.setup(context)
    const result = await tools.get("council").execute({}, context)

    assert.match(result.output, /0 of 3 reviewers completed/)
    assert.match(result.output, /sandbox unavailable; refusing to review the main checkout/)
    assert.equal(
      created.filter((session) => session.agent === "council-reviewer").length,
      0,
      "no reviewer session falls back to the live checkout",
    )
    assert.equal(result.metadata.reviewers.every((reviewer) => reviewer.status === "failed"), true)
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test("council run includes regular and zero-byte untracked files but never symlinks or secrets", async () => {
  const repo = await mkdtemp(join(tmpdir(), "council-untracked-run-"))
  const outside = await mkdtemp(join(tmpdir(), "council-outside-"))
  try {
    await exec("git", ["init", "-q"], { cwd: repo })
    await writeFile(join(repo, "tracked.txt"), "one\n")
    await exec("git", ["add", "tracked.txt"], { cwd: repo })
    await exec("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init"], { cwd: repo })
    await writeFile(join(repo, "tracked.txt"), "two\n")
    await writeFile(join(repo, "normal.txt"), "normal\n")
    await writeFile(join(repo, "empty.txt"), "")
    await writeFile(join(outside, "outside.txt"), "outside\n")
    await symlink(join(outside, "outside.txt"), join(repo, "link.txt"))
    await writeFile(join(repo, ".env"), "SECRET=1\n")
    await mkdir(join(repo, ".kube"), { recursive: true })
    await writeFile(join(repo, ".kube", "config"), "token: secret\n")

    const seen = []
    const { context, tools } = makeHarness(repo, {
      onCreate: async (session) => {
        if (session.agent !== "council-reviewer") return
        const dir = session.location.directory
        seen.push({
          dir,
          normal: await readFile(join(dir, "normal.txt"), "utf8"),
          empty: await readFile(join(dir, "empty.txt"), "utf8"),
          link: existsSync(join(dir, "link.txt")),
          env: existsSync(join(dir, ".env")),
          kube: existsSync(join(dir, ".kube", "config")),
        })
      },
    })
    await CouncilPlugin.setup(context)
    const result = await tools.get("council").execute({}, context)

    assert.equal(seen.length, 3)
    for (const entry of seen) {
      assert.equal(entry.normal, "normal\n")
      assert.equal(entry.empty, "")
      assert.equal(entry.link, false, "symlinked untracked files never enter a sandbox")
      assert.equal(entry.env, false, "secret files never enter a sandbox")
      assert.equal(entry.kube, false, "secret paths never enter a sandbox")
    }

    const patch = await readFile(result.metadata.patchFile, "utf8")
    assert.match(patch, /b\/normal\.txt/)
    assert.match(patch, /b\/empty\.txt/)
    assert.doesNotMatch(patch, /b\/link\.txt/)
    assert.doesNotMatch(patch, /b\/\.env/)
    assert.doesNotMatch(patch, /\.kube\/config/)
    assert.match(result.output, /symlinked or non-regular untracked entries omitted/)
    assert.match(result.output, /secret-like untracked files omitted/)
  } finally {
    await rm(repo, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

test("council run rescues a reviewer that ends a turn without JSON", async () => {
  const repo = await mkdtemp(join(tmpdir(), "council-rescue-"))
  try {
    await exec("git", ["init", "-q"], { cwd: repo })
    await writeFile(join(repo, "tracked.txt"), "one\n")
    await exec("git", ["add", "tracked.txt"], { cwd: repo })
    await exec("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init"], { cwd: repo })
    await writeFile(join(repo, "tracked.txt"), "two\n")

    const { context, tools, created, prompts } = makeHarness(repo, {
      reviewText: (session, call) => {
        if (session.model.id === "beta" && call === 1) return "I ran out of time before writing the JSON."
        return JSON.stringify(CANNED_REVIEWS[session.model.id])
      },
    })
    await CouncilPlugin.setup(context)
    const result = await tools.get("council").execute({}, context)

    assert.match(result.output, /3 of 3 reviewers completed/)
    const reviewers = created.filter((session) => session.agent === "council-reviewer")
    assert.equal(reviewers.length, 3, "the rescue reuses the reviewer session instead of creating a new one")
    const beta = reviewers.find((session) => session.model.id === "beta")
    const rescue = prompts.find((prompt) => prompt.sessionID === beta.id && /previous turn ended/.test(prompt.text))
    assert.ok(rescue, "the reviewer receives a rescue prompt")
    assert.match(rescue.text, /"verdict"/, "the rescue prompt repeats the schema")
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test("council run repairs a reviewer whose JSON fails schema validation", async () => {
  const repo = await mkdtemp(join(tmpdir(), "council-repair-"))
  try {
    await exec("git", ["init", "-q"], { cwd: repo })
    await writeFile(join(repo, "tracked.txt"), "one\n")
    await exec("git", ["add", "tracked.txt"], { cwd: repo })
    await exec("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init"], { cwd: repo })
    await writeFile(join(repo, "tracked.txt"), "two\n")

    const { context, tools, created, prompts } = makeHarness(repo, {
      reviewText: (session, call) => {
        if (session.model.id === "beta" && call === 1) {
          return JSON.stringify({ verdict: "looks good", summary: "beta", findings: [] })
        }
        return JSON.stringify(CANNED_REVIEWS[session.model.id])
      },
    })
    await CouncilPlugin.setup(context)
    const result = await tools.get("council").execute({}, context)

    assert.match(result.output, /3 of 3 reviewers completed/)
    const betaSessions = created.filter(
      (session) => session.agent === "council-reviewer" && session.model.id === "beta",
    )
    assert.equal(betaSessions.length, 1, "the repair happens in the reviewer's existing session")
    const repair = prompts.find(
      (prompt) => prompt.sessionID === betaSessions[0].id && /could not be accepted/.test(prompt.text),
    )
    assert.ok(repair, "the reviewer receives a repair prompt")
    assert.match(repair.text, /"verdict" must be one of/, "the repair prompt names the exact problem")
    assert.match(repair.text, /"findings"/, "the repair prompt repeats the schema")
    assert.equal(result.metadata.reviewers.find((reviewer) => reviewer.name === "beta").status, "ok")
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test("council run asks a reviewer to repair invalid findings before dropping them", async () => {
  const repo = await mkdtemp(join(tmpdir(), "council-repair-findings-"))
  try {
    await exec("git", ["init", "-q"], { cwd: repo })
    await writeFile(join(repo, "tracked.txt"), "one\n")
    await exec("git", ["add", "tracked.txt"], { cwd: repo })
    await exec("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init"], { cwd: repo })
    await writeFile(join(repo, "tracked.txt"), "two\n")

    const { context, tools, created, prompts } = makeHarness(repo, {
      reviewText: (session, call) => {
        if (session.model.id === "beta" && call === 1) {
          return JSON.stringify({
            verdict: "approve",
            summary: "beta",
            findings: [
              finding(),
              { severity: "blocker", file: "a.ts", title: "bad severity", detail: "not a schema severity" },
            ],
          })
        }
        return JSON.stringify(CANNED_REVIEWS[session.model.id])
      },
    })
    await CouncilPlugin.setup(context)
    const result = await tools.get("council").execute({}, context)

    assert.match(result.output, /3 of 3 reviewers completed/)
    const betaSessions = created.filter(
      (session) => session.agent === "council-reviewer" && session.model.id === "beta",
    )
    assert.equal(betaSessions.length, 1, "the repair happens in the reviewer's existing session")
    const repair = prompts.find(
      (prompt) => prompt.sessionID === betaSessions[0].id && /were excluded/.test(prompt.text),
    )
    assert.ok(repair, "the reviewer is told which findings were excluded")
    assert.match(repair.text, /findings\[1\]: "severity"/)
    const betaResult = result.metadata.reviewers.find((reviewer) => reviewer.name === "beta")
    assert.equal(betaResult.droppedFindings, 0, "the repaired review has no dropped findings")
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test("council run keeps valid findings when a repair attempt fails", async () => {
  const repo = await mkdtemp(join(tmpdir(), "council-repair-fallback-"))
  try {
    await exec("git", ["init", "-q"], { cwd: repo })
    await writeFile(join(repo, "tracked.txt"), "one\n")
    await exec("git", ["add", "tracked.txt"], { cwd: repo })
    await exec("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init"], { cwd: repo })
    await writeFile(join(repo, "tracked.txt"), "two\n")

    const { context, tools, created } = makeHarness(repo, {
      reviewText: (session, call) => {
        if (session.model.id === "beta" && call === 1) {
          return JSON.stringify({
            verdict: "approve",
            summary: "beta",
            findings: [finding(), { severity: "blocker", file: "a.ts", title: "bad", detail: "bad" }],
          })
        }
        if (session.model.id === "beta" && call === 2) return "I could not repair the payload."
        return JSON.stringify(CANNED_REVIEWS[session.model.id])
      },
    })
    await CouncilPlugin.setup(context)
    const result = await tools.get("council").execute({}, context)

    assert.match(result.output, /3 of 3 reviewers completed/)
    const betaSessions = created.filter(
      (session) => session.agent === "council-reviewer" && session.model.id === "beta",
    )
    assert.equal(betaSessions.length, 1, "a failed repair does not start another reviewer session")
    const betaResult = result.metadata.reviewers.find((reviewer) => reviewer.name === "beta")
    assert.equal(betaResult.status, "ok")
    assert.equal(betaResult.droppedFindings, 1)
    const raw = JSON.parse(
      result.output.match(/## Raw reviewer outputs[\s\S]*?```json\n([\s\S]*?)\n```/)[1],
    )
    assert.equal(
      raw.find((reviewer) => reviewer.name === "beta").findings.length,
      1,
      "the valid finding is preserved",
    )
    assert.match(result.output, /## Dropped findings/)
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test("council run retries a reviewer in a fresh session after a failed turn", async () => {
  const repo = await mkdtemp(join(tmpdir(), "council-retry-"))
  try {
    await exec("git", ["init", "-q"], { cwd: repo })
    await writeFile(join(repo, "tracked.txt"), "one\n")
    await exec("git", ["add", "tracked.txt"], { cwd: repo })
    await exec("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init"], { cwd: repo })
    await writeFile(join(repo, "tracked.txt"), "two\n")

    let failed = false
    const { context, tools, created } = makeHarness(repo, {
      wait: async (input) => {
        const owner = created.find((session) => session.id === input.sessionID)
        if (!failed && owner?.model.id === "beta") {
          failed = true
          throw new Error("turn failed")
        }
      },
    })
    await CouncilPlugin.setup(context)
    const result = await tools.get("council").execute({}, context)

    assert.match(result.output, /3 of 3 reviewers completed/)
    const betaSessions = created.filter(
      (session) => session.agent === "council-reviewer" && session.model.id === "beta",
    )
    assert.equal(betaSessions.length, 2, "a failed turn starts a fresh reviewer session")
    assert.notEqual(result.metadata.reviewers.find((reviewer) => reviewer.name === "beta").sessionID, betaSessions[0].id)
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

async function makeCouncilRepo(prefix) {
  const repo = await mkdtemp(join(tmpdir(), prefix))
  await exec("git", ["init", "-q"], { cwd: repo })
  await exec("git", ["config", "user.email", "t@t"], { cwd: repo })
  await exec("git", ["config", "user.name", "t"], { cwd: repo })
  await writeFile(join(repo, "tracked.txt"), "one\n")
  await exec("git", ["add", "tracked.txt"], { cwd: repo })
  await exec("git", ["commit", "-q", "-m", "init"], { cwd: repo })
  await exec("git", ["branch", "-M", "main"], { cwd: repo })
  return repo
}

async function addFeatureBranch(repo, name, content) {
  await exec("git", ["checkout", "-q", "-b", name], { cwd: repo })
  await writeFile(join(repo, "tracked.txt"), content)
  await exec("git", ["add", "tracked.txt"], { cwd: repo })
  await exec("git", ["commit", "-q", "-m", name], { cwd: repo })
  await exec("git", ["checkout", "-q", "main"], { cwd: repo })
}

test("isTarget validates run record targets", () => {
  assert.equal(isTarget({ kind: "diff", rev: ["HEAD"] }), true)
  assert.equal(isTarget({ kind: "diff", rev: ["HEAD", "--", "src"] }), true)
  assert.equal(isTarget({ kind: "diff", rev: [] }), false)
  assert.equal(isTarget({ kind: "diff", rev: ["HEAD", 1] }), false)
  assert.equal(isTarget({ kind: "pr", number: "123" }), true)
  assert.equal(isTarget({ kind: "pr", number: 123 }), false)
  assert.equal(isTarget({ kind: "focus", focus: "race conditions" }), true)
  assert.equal(isTarget({ kind: "focus", focus: "" }), false)
  assert.equal(isTarget({ kind: "other" }), false)
  assert.equal(isTarget(null), false)
})

test("pruneSessionRecords removes stale session records and keeps the current one", async () => {
  const repo = await mkdtemp(join(tmpdir(), "council-session-prune-"))
  const stateDir = join(repo, ".git", "opencode-council")
  const sessions = join(stateDir, "sessions")
  const now = Date.now()
  const old = now - 31 * 24 * 60 * 60 * 1000
  try {
    await mkdir(sessions, { recursive: true })
    const record = (sessionID, time) =>
      writeFile(join(sessions, `${sessionID}.json`), JSON.stringify({ parentSessionID: sessionID, time }))
    await record("ses_current", old)
    await record("ses_old", old)
    await record("ses_new", now)
    await writeFile(join(sessions, "ses_malformed.json"), "not json")
    await utimes(join(sessions, "ses_malformed.json"), new Date(old), new Date(old))
    const temp = join(sessions, "ses_new.json.old-run.tmp")
    await writeFile(temp, "partial")
    await utimes(temp, new Date(old), new Date(old))

    await pruneSessionRecords(stateDir, "ses_current")

    assert.equal(existsSync(join(sessions, "ses_current.json")), true, "the current session is always kept")
    assert.equal(existsSync(join(sessions, "ses_new.json")), true, "recent records are kept")
    assert.equal(existsSync(join(sessions, "ses_old.json")), false, "stale records are removed")
    assert.equal(existsSync(join(sessions, "ses_malformed.json")), false, "malformed records fall back to mtime")
    assert.equal(existsSync(temp), false, "stale temp files are removed")
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test("council_followup re-runs the full council on the same target with the feedback", async () => {
  const repo = await makeCouncilRepo("council-followup-rerun-")
  try {
    await addFeatureBranch(repo, "feature", "two\n")
    const sessionsDir = join(await stateRootFor(makeShell(), repo), "opencode-council", "sessions")
    await mkdir(sessionsDir, { recursive: true })
    const staleSession = join(sessionsDir, "ses_old.json")
    await writeFile(staleSession, JSON.stringify({ time: Date.now() - 31 * 24 * 60 * 60 * 1000 }))

    const run = makeHarness(repo)
    await CouncilPlugin.setup(run.context)
    const first = await run.tools
      .get("council")
      .execute({ request: "main...feature", focus: "look for races" }, run.context)
    assert.match(first.output, /3 of 3 reviewers completed/)
    assert.equal(existsSync(staleSession), false, "a council run prunes stale session records")

    const feedback = "The race is real; check the cleanup path before approving."
    const follow = makeHarness(repo, {
      fallbackText: "# Follow-up report\n\nThe council stands by its findings.",
    })
    await CouncilPlugin.setup(follow.context)
    const answer = await follow.tools.get("council_followup").execute({ feedback }, follow.context)

    assert.match(answer.output, /Follow-up report/)
    assert.match(answer.output, /council stands by its findings/)
    const reviewers = follow.created.filter((session) => session.agent === "council-reviewer")
    assert.equal(reviewers.length, 3, "the follow-up convenes all three reviewers again")
    assert.equal(follow.created.filter((session) => session.agent === "council-chair").length, 1)
    for (const reviewer of reviewers) {
      const prompt = follow.prompts.find((entry) => entry.sessionID === reviewer.id)
      assert.ok(prompt, "every reviewer is prompted")
      assert.match(prompt.text, /Review target: git diff main\.\.\.feature/, "the prior target is re-used")
      assert.match(prompt.text, /look for races/, "the prior focus is carried forward")
      assert.ok(prompt.text.includes(feedback), "the feedback reaches every reviewer")
      assert.match(prompt.text, /Follow-up feedback from the user after the previous council report/)
      assert.match(prompt.text, /Sandbox checkout: /)
    }
    const chair = follow.created.find((session) => session.agent === "council-chair")
    assert.ok(chair)
    const chairPrompt = follow.prompts.find((entry) => entry.sessionID === chair.id)
    assert.ok(chairPrompt && chairPrompt.text.includes(feedback), "the chair also sees the feedback")
    assert.equal(follow.moves.length, 3, "follow-up reviewer sessions are moved out of their sandboxes")
    assert.deepEqual(
      follow.moves.map((move) => move.sessionID).sort(),
      reviewers.map((session) => session.id).sort(),
      "every follow-up reviewer session is relocated",
    )
    assert.ok(
      follow.moves.every((move) => move.directory === repo),
      "follow-up reviewer sessions move to the reviewed checkout",
    )

    const empty = await follow.tools.get("council_followup").execute({ feedback: "   " }, follow.context)
    assert.match(empty.output, /feedback cannot be empty/)
    assert.equal(follow.created.length, 4, "empty feedback starts no sessions")

    const record = JSON.parse(
      await readFile(sessionRunRecordPath(await stateRootFor(makeShell(), repo), "ses_parent"), "utf8"),
    )
    assert.deepEqual(record.resolved, { kind: "diff", rev: ["main...feature"] })
    assert.equal(record.parentSessionID, "ses_parent")
    assert.equal(record.target, "git diff main...feature")
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test("council_followup refuses when the council has not run in this session", async () => {
  const repo = await makeCouncilRepo("council-followup-no-session-")
  try {
    const follow = makeHarness(repo, { sessionID: "ses_parent" })
    await CouncilPlugin.setup(follow.context)
    const answer = await follow.tools.get("council_followup").execute({ feedback: "Please recheck." }, follow.context)
    assert.match(answer.output, /no previous council run in this session/)
    assert.equal(follow.created.length, 0)
    assert.equal(follow.prompts.length, 0)

    // A run from another session does not count.
    await writeFile(join(repo, "tracked.txt"), "two\n")
    const other = makeHarness(repo, { sessionID: "ses_other" })
    await CouncilPlugin.setup(other.context)
    await other.tools.get("council").execute({}, other.context)

    const stillMissing = await follow.tools.get("council_followup").execute({ feedback: "Please recheck." }, follow.context)
    assert.match(stillMissing.output, /no previous council run in this session/)
    assert.equal(follow.created.length, 0)
    assert.equal(follow.prompts.length, 0)
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test("council_followup keeps each session's prior run separate", async () => {
  const repo = await makeCouncilRepo("council-followup-sessions-")
  try {
    await addFeatureBranch(repo, "feature", "two\n")
    await addFeatureBranch(repo, "other", "three\n")

    const a = makeHarness(repo, { sessionID: "ses_a" })
    await CouncilPlugin.setup(a.context)
    await a.tools.get("council").execute({ request: "main...feature" }, a.context)

    const b = makeHarness(repo, { sessionID: "ses_b" })
    await CouncilPlugin.setup(b.context)
    await b.tools.get("council").execute({ request: "main...other" }, b.context)

    const follow = makeHarness(repo, { sessionID: "ses_a", fallbackText: "# A follow-up" })
    await CouncilPlugin.setup(follow.context)
    const answer = await follow.tools.get("council_followup").execute({ feedback: "Recheck the feature branch." }, follow.context)
    assert.match(answer.output, /A follow-up/)
    const reviewers = follow.created.filter((session) => session.agent === "council-reviewer")
    assert.equal(reviewers.length, 3)
    for (const reviewer of reviewers) {
      const prompt = follow.prompts.find((entry) => entry.sessionID === reviewer.id)
      assert.ok(prompt)
      assert.match(prompt.text, /Review target: git diff main\.\.\.feature/)
      assert.doesNotMatch(prompt.text, /main\.\.\.other/)
    }

    const bRecord = JSON.parse(
      await readFile(sessionRunRecordPath(await stateRootFor(makeShell(), repo), "ses_b"), "utf8"),
    )
    assert.deepEqual(bRecord.resolved, { kind: "diff", rev: ["main...other"] })
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test("install and uninstall reject an empty config directory", async () => {
  const install = await runScript([join(process.cwd(), "scripts", "install.sh"), "--config-dir", ""])
  assert.equal(install.code, 2)
  assert.match(install.stderr, /config directory cannot be empty/)
  const uninstall = await runScript([join(process.cwd(), "scripts", "uninstall.sh"), "--config-dir", ""])
  assert.equal(uninstall.code, 2)
  assert.match(uninstall.stderr, /config directory cannot be empty/)
})

test("install copy mode replaces an identical foreign symlink", async () => {
  const config = await mkdtemp(join(tmpdir(), "council-config-"))
  try {
    const install = join(process.cwd(), "scripts", "install.sh")
    const first = await runScript([install, "--config-dir", config])
    assert.equal(first.code, 0)
    const dst = join(config, "plugins", "council.ts")
    await rm(dst, { force: true })
    await symlink(join(process.cwd(), "plugins", "council.ts"), dst)
    assert.equal(lstatSync(dst).isSymbolicLink(), true)

    const second = await runScript([install, "--config-dir", config])
    assert.equal(second.code, 0)
    assert.equal(lstatSync(dst).isSymbolicLink(), false, "copy mode must not keep a foreign symlink")
    assert.equal(await readFile(dst, "utf8"), await readFile(join(process.cwd(), "plugins", "council.ts"), "utf8"))
  } finally {
    await rm(config, { recursive: true, force: true })
  }
})

test("council agents deny branch and tag creation", async () => {
  for (const file of ["council-reviewer.md", "council-chair.md"]) {
    const text = await readFile(join(process.cwd(), "agents", file), "utf8")
    assert.match(text, /"git \*": allow/)
    assert.match(text, /"git branch \*": deny/)
    assert.match(text, /"git tag \*": deny/)
  }
})

// Mirrors the server's permission rule matcher: wildcards may cross "/", and the last
// matching rule wins. Tests below use it to check the reviewer's bash allow/deny policy.
function permissionPattern(pattern) {
  let source = pattern
    .replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".")
  if (source.endsWith(" .*")) source = source.slice(0, -3) + "( .*)?"
  return new RegExp("^" + source + "$", "s")
}

function bashPermissionEffect(rules, command) {
  const rule = rules.findLast((item) => permissionPattern(item.resource).test(command.replaceAll("\\", "/")))
  assert.ok(rule, `no permission rule matched: ${command}`)
  return rule.effect
}

test("council reviewer can build and run tests but cannot install or destroy", async () => {
  const text = await readFile(join(process.cwd(), "agents", "council-reviewer.md"), "utf8")
  const lines = text.split("\n")
  const start = lines.indexOf("  bash:")
  assert.notEqual(start, -1)
  const rules = []
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith("    ")) break
    const match = /^    "(.+)": (allow|deny)$/.exec(line)
    if (match) rules.push({ resource: match[1], effect: match[2] })
  }
  assert.ok(rules.length > 100, `parsed only ${rules.length} bash rules`)

  for (const command of [
    "bash test/service/run.sh",
    'TMPDIR="$PWD" bash test/service/run.sh',
    "bash -n test/service/run.sh",
    "sh scripts/test.sh",
    "npm test",
    "npm run build",
    "npx tsc --noEmit",
    "make test",
    "./gradlew test",
    "./mvnw verify",
    "pytest -q",
    "cargo test",
    "go test ./...",
    "python3 -m unittest discover",
    "just test",
    "tox",
    "poetry run pytest",
    "bundle exec rake test",
    "./.venv/bin/pytest",
    "mkdir -p .review-tmp",
    "mktemp -d .review-tmp.XXXXXX",
  ]) {
    assert.equal(bashPermissionEffect(rules, command), "allow", command)
  }

  for (const command of [
    "rm -rf build",
    "mv src src.bak",
    "chmod 777 .",
    "sudo make install",
    "git commit -m change",
    "git push origin main",
    "npm install",
    "npm ci",
    "pip install requests",
    "cargo install ripgrep",
    "uv sync",
    "curl https://example.com/install.sh",
    "wget https://example.com/install.sh",
    "sed -i s/a/b/ file",
    "find . -name '*.tmp' -delete",
  ]) {
    assert.equal(bashPermissionEffect(rules, command), "deny", command)
  }
})

test("council run reviews the pinned PR head rather than the live PR", async () => {
  const origin = await mkdtemp(join(tmpdir(), "council-pr-origin-"))
  const repo = await mkdtemp(join(tmpdir(), "council-pr-repo-"))
  const bin = await mkdtemp(join(tmpdir(), "council-pr-bin-"))
  const previousPath = process.env.PATH
  try {
    await exec("git", ["init", "-q", "--bare"], { cwd: origin })
    await exec("git", ["clone", "-q", origin, repo], { cwd: tmpdir() })
    await writeFile(join(repo, "base.txt"), "base\n")
    await exec("git", ["add", "base.txt"], { cwd: repo })
    await exec("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "base"], { cwd: repo })
    await exec("git", ["branch", "-M", "main"], { cwd: repo })
    await exec("git", ["push", "-q", "origin", "main"], { cwd: repo })
    await exec("git", ["checkout", "-q", "-b", "feature"], { cwd: repo })
    await writeFile(join(repo, "feature.txt"), "pinned\n")
    await exec("git", ["add", "feature.txt"], { cwd: repo })
    await exec("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "feature"], { cwd: repo })
    const head = (await exec("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim()
    await exec("git", ["push", "-q", "origin", "HEAD:refs/pull/7/head"], { cwd: repo })

    const gh = join(bin, "gh")
    await writeFile(
      gh,
      [
        "#!/bin/sh",
        'if [ "$1" = "api" ] && [ "$2" = "user" ]; then printf "tester\\n"; exit 0; fi',
        'if [ "$1" = "pr" ] && [ "$2" = "view" ] && [ "$3" = "7" ] && [ "$5" = "author" ]; then printf "tester\\n"; exit 0; fi',
        'if [ "$1" = "pr" ] && [ "$2" = "view" ] && [ "$3" = "7" ] && [ "$5" = "baseRefName" ]; then printf "main\\n"; exit 0; fi',
        'echo "unexpected gh: $*" >&2',
        "exit 1",
        "",
      ].join("\n"),
    )
    await exec("chmod", ["+x", gh])
    process.env.PATH = `${bin}:${previousPath ?? ""}`

    const seen = []
    const { context, tools, prompts } = makeHarness(repo, {
      onCreate: async (session) => {
        if (session.agent !== "council-reviewer") return
        seen.push(await readFile(join(session.location.directory, "feature.txt"), "utf8"))
      },
    })
    await CouncilPlugin.setup(context)
    const result = await tools.get("council").execute({ request: "7" }, context)

    assert.ok(prompts.some((prompt) => /Review target: PR #7/.test(prompt.text)))
    assert.match(result.output, /3 of 3 reviewers completed/)
    assert.deepEqual(seen, ["pinned\n", "pinned\n", "pinned\n"])
    assert.equal(result.metadata.target, "PR #7")

    const record = JSON.parse(
      await readFile(join(realpathSync(await stateRootFor(makeShell(), repo)), "opencode-council", "latest-run.json"), "utf8"),
    )
    assert.equal(record.baseSha, head, "the run record keeps the pinned head for follow-ups")
    assert.equal(
      (await exec("git", ["rev-parse", "refs/council/" + record.runId + "/pr-7-head"], { cwd: repo })).stdout.trim(),
      head,
    )
  } finally {
    process.env.PATH = previousPath
    await rm(repo, { recursive: true, force: true })
    await rm(origin, { recursive: true, force: true })
    await rm(bin, { recursive: true, force: true })
  }
})
