// dsh-codehub-dashboard — host half
//
// A GitHub MR / review-comment aggregation dashboard for DSH, powered by the
// `gh` CLI (https://cli.github.com/). Serves under the /codehub prefix:
//   GET  /codehub/index.html            -> the dashboard SPA (web/index.html)
//   GET  /codehub/api?op=<op>&...       -> JSON data
//   POST /codehub/api?op=<op>           -> JSON mutations
//
// Data sources (per repo):
//   gh    - primary: `gh pr list/view/review list/comments` via the official
//           GitHub CLI. Requires `gh auth login` or a GH_TOKEN env var.
//   git   - supplementary: local git CLI augments repo metadata (default branch,
//           remote URL) when a localPath is configured.
//   http  - fallback: GitHub REST API v3 with a personal access token, used
//           when gh is unavailable but a token is configured.
//
// Commands are executed with execFile (no shell), fixed argument lists only.
// Tokens are persisted in the plugin's own config file and are never echoed back
// by the API (masked as ****last4). The file is written atomically and chmod'ed
// 0600 best-effort — note `chmod` is a no-op on Windows, where the ACL of the
// user profile directory is the only real barrier, so the file stays plaintext.

import { execFile } from 'node:child_process'
import { existsSync, statSync, readFileSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile, chmod, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createWorkflows } from './workflows.js'

const here = dirname(fileURLToPath(import.meta.url))
const webRoot = join(here, 'web')
const PLUGIN_VERSION = '0.1.6'

const MAX_EXEC_BUFFER = 16 * 1024 * 1024
const EXEC_TIMEOUT_MS = 30_000
const FETCH_CONCURRENCY = 3
const DAY_MS = 86_400_000

export const name = 'dsh-codehub-dashboard'
// cordis contract: `inject` is a FLAT required-service array (see better-sidebar:
// export const inject = ['webServer', 'sessions', 'webRuntime', 'tools']).
// An object form ({required, optional}) is parsed as two service NAMES called
// "required"/"optional" and the plugin stays pending forever in the real host.
// Optional native services (llm/sessions/sessionController) are probed at
// runtime via ctx.get(name, false) inside workflows.js.
export const inject = ['webServer', 'connection']

/* ===================== generic helpers ===================== */

const pad2 = (n) => String(n).padStart(2, '0')
function dateKey(t) {
  const d = new Date(t)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}
const isoOr = (v, fallback) => {
  if (!v) return fallback
  const t = new Date(v).getTime()
  return Number.isFinite(t) ? new Date(t).toISOString() : fallback
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      const i = next++
      if (i >= items.length) return
      out[i] = await fn(items[i], i)
    }
  })
  await Promise.all(workers)
  return out
}

function run(file, args, opts = {}) {
  const { input, ...execOpts } = opts
  return new Promise((res) => {
    const child = execFile(file, args, {
      maxBuffer: MAX_EXEC_BUFFER, windowsHide: true, timeout: EXEC_TIMEOUT_MS, encoding: 'utf8', ...execOpts,
    }, (err, stdout, stderr) => {
      if (err && err.killed) { res({ stdout: '', stderr: `timeout after ${EXEC_TIMEOUT_MS}ms`, code: -1, error: err }); return }
      res({ stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, error: err ?? null })
    })
    child.stdin?.on('error', () => {})
    child.stdin?.end(input ?? '')
  })
}

const maskToken = (t) => { const s = String(t ?? ''); if (!s) return ''; return s.length > 4 ? `****${s.slice(-4)}` : '****' }
const isMaskedToken = (t) => typeof t === 'string' && t.startsWith('****')
const clip = (s, n) => { const v = String(s ?? ''); return v.length > n ? v.slice(0, n - 1) + '…' : v }

/* ===================== config store ===================== */

function defaultConfig() {
  return {
    version: 1,
    // gh | git | http | auto  (auto = gh first, then http if token set, then git-only metadata)
    provider: 'auto',
    me: { name: '', login: '' },
    pollMinutes: 10,
    ghPath: 'gh',          // path to gh executable
    instances: [],         // { id, name, host (e.g. github.com), token }
    repos: [],             // { id, instance, path:'owner/name', localPath?, enabled, defaultBranch? }
    organizations: [],
    ai: { provider: '', model: '', maxTokens: 16384 },
    http: { perPage: 100, detailLimit: 25, timeoutMs: 15000 },
  }
}

function createConfigStore(filePath, log) {
  let current = defaultConfig()
  let rev = 0, loaded = false, saving = Promise.resolve()
  const normalize = (cfg) => {
    const base = defaultConfig()
    const out = { ...base, ...cfg }
    out.me = { ...base.me, ...(cfg?.me ?? {}) }
    out.http = { ...base.http, ...(cfg?.http ?? {}) }
    out.instances = Array.isArray(cfg?.instances) ? cfg.instances : []
    // `hasToken` is derived by masked() for the UI; the SPA posts the masked
    // config back verbatim, so drop it here instead of persisting a stale flag.
    out.instances = out.instances.map(({ hasToken, ...rest }) => rest)
    out.repos = Array.isArray(cfg?.repos) ? cfg.repos : []
    out.organizations = Array.isArray(cfg?.organizations) ? cfg.organizations : []
    out.ai = { ...base.ai, ...(cfg?.ai ?? {}) }
    // Blank means "use the workflow default"; anything else is clamped so a
    // hand-edited config cannot ask a provider for an unbounded completion.
    out.ai.maxTokens = String(out.ai.maxTokens ?? '').trim() === ''
      ? base.ai.maxTokens
      : Math.max(1024, Math.min(32768, Number(out.ai.maxTokens) || base.ai.maxTokens))
    out.http.perPage = Math.max(1, Math.min(100, Number(out.http.perPage) || 100))
    out.http.detailLimit = Math.max(0, Math.min(50, Number(out.http.detailLimit) || 0))
    out.http.timeoutMs = Math.max(1000, Math.min(60000, Number(out.http.timeoutMs) || 15000))
    out.pollMinutes = Math.max(1, Math.min(1440, Number(out.pollMinutes) || base.pollMinutes))
    // "git-meta" was the pre-0.1.1 UI value; map it so hand-edited or
    // legacy configs keep working instead of silently falling back to auto.
    if (out.provider === 'git-meta') out.provider = 'git'
    if (!['auto', 'gh', 'git', 'http'].includes(out.provider)) out.provider = 'auto'
    let n = 0; for (const inst of out.instances) if (!inst.id) inst.id = `i${++n}`
    n = 0; for (const repo of out.repos) if (!repo.id) repo.id = `r${++n}`
    return out
  }
  const load = async () => {
    try { const raw = await readFile(filePath, 'utf8'); current = normalize(JSON.parse(raw)) }
    catch (err) { if (err?.code !== 'ENOENT') log?.warn?.('[codehub] config load failed:', err?.message ?? err); current = defaultConfig() }
    loaded = true; return current
  }
  const save = async (config) => {
    await mkdir(dirname(filePath), { recursive: true })
    // Unique tmp suffix: two concurrent saves writing the same `${filePath}.tmp`
    // can interleave writeFile/rename and leave a torn or wrong-content config.
    const tmp = `${filePath}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`
    await writeFile(tmp, JSON.stringify(config, null, 2), { encoding: 'utf8', mode: 0o600 })
    try { await chmod(tmp, 0o600) } catch {}
    await rename(tmp, filePath)
  }
  return {
    get path() { return filePath }, get rev() { return rev },
    async init() { if (!loaded) await load(); return current },
    get() { return current },
    async set(patch) {
      const operation = saving.catch(() => {}).then(async () => {
        if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw apiError('配置必须是对象')
        for (const field of ['instances', 'repos', 'organizations']) {
          if (patch[field] === undefined) continue
          if (!Array.isArray(patch[field]) || patch[field].some(item => !item || typeof item !== 'object' || Array.isArray(item))) throw apiError(`${field} 必须是对象数组`)
        }
        const prev = current; const next = normalize({ ...prev, ...patch })
        const ids = new Set()
        for (const inst of next.instances) {
          if (!inst?.id || ids.has(inst.id) || !isSafeHost(inst.host || 'github.com')) throw apiError('实例标识重复或域名不合法')
          ids.add(inst.id)
        }
        for (const repo of next.repos) {
          if (!isSafeRepoPath(repo?.path)) throw apiError('仓库路径必须是 owner/name')
          if (repo.instance && repo.instance !== 'github.com' && !ids.has(repo.instance)) throw apiError('仓库引用了不存在的实例')
          if (repo.localPath !== undefined && typeof repo.localPath !== 'string') throw apiError('本地路径必须是文本')
        }
        for (const org of next.organizations) {
          if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(org?.owner || '')) throw apiError('组织名称不合法')
          if (org.instance && org.instance !== 'github.com' && !ids.has(org.instance)) throw apiError('组织引用了不存在的实例')
        }
        next.instances = next.instances.map((inst) => {
          const old = prev.instances.find(i => i.id === inst.id)
          if (!isMaskedToken(inst.token)) return inst
          if (!old || (old.host || 'github.com').toLowerCase() !== (inst.host || 'github.com').toLowerCase()) throw apiError('更换实例域名后必须清空或重新输入 token')
          return { ...inst, token: old.token }
        })
        await save(next); current = next; rev++; return current
      })
      saving = operation
      return operation
    },
    masked() {
      return { ...current, instances: current.instances.map((i) => ({ ...i, token: maskToken(i.token), hasToken: !!i.token })) }
    },
  }
}

/* ===================== repo model ===================== */

function effectiveRepos(cfg) {
  return mergeRepos(cfg, [])
}
function mergeRepos(cfg, discovered) {
  const repos = new Map()
  for (const r of [...discovered, ...(cfg.repos ?? [])]) {
    if (!r?.path) continue
    const instanceId = r.instance || 'github.com'
    const key = `${instanceId}:${r.path.toLowerCase()}`
    if (r.enabled === false) { repos.delete(key); continue }
    repos.set(key, { key: `${instanceId}:${r.path}`, instanceId, path: r.path, localPath: r.localPath || '', defaultBranch: r.defaultBranch || '' })
  }
  return [...repos.values()]
}
const repoName = (path) => String(path ?? '').split('/').pop() || String(path ?? '')
const repoOwner = (path) => String(path ?? '').split('/')[0] || ''

/**
 * `owner/name` in the shape GitHub accepts. Repos that fail this are dropped
 * before their path can reach an execFile argv (`--repo <path>`, where a value
 * starting with `-` would be parsed as a gh flag) or a REST path segment
 * (`../x` or `x?y` would rewrite the request target).
 */
const SAFE_REPO_PATH = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/
function isSafeRepoPath(p) {
  if (typeof p !== 'string' || !SAFE_REPO_PATH.test(p)) return false
  // Reject `.`/`..` segments and values that start with `-` — the latter would
  // be read as an option rather than the `--repo` argument by gh/cobra.
  return p.split('/').every((seg) => seg !== '.' && seg !== '..' && !seg.startsWith('-'))
}

/**
 * Bare hostname only. `instance.host` is interpolated into an https origin that
 * we then send the user's Bearer token to, so a value carrying a scheme, port,
 * path or `@` must never reach it.
 */
const SAFE_HOSTNAME = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/
function isSafeHost(h) { return typeof h === 'string' && h.length <= 253 && SAFE_HOSTNAME.test(h) }

/** REST root for an instance, or null when the configured host is unusable. */
function apiBaseFor(host) {
  const h = String(host || 'github.com')
  if (h === 'github.com') return 'https://api.github.com'
  return isSafeHost(h) ? `https://${h}/api/v3` : null
}

/* ===================== gh provider (primary) ===================== */

/** Resolve the gh executable. Bare names rely on PATH; paths must exist. */
function ghExecutable(cfg) { return String(cfg.ghPath || 'gh').trim() || 'gh' }

async function ghProbe(cfg) {
  const exe = ghExecutable(cfg)
  const t0 = Date.now()
  const ver = await run(exe, ['--version'])
  if (ver.code !== 0) return { ok: false, detail: clip(ver.stderr || ver.stdout || 'gh --version 失败', 300), ms: Date.now() - t0 }
  const auth = await run(exe, ['auth', 'status'], { env: { ...process.env } })
  // `gh auth status` exits non-zero for every not-usable state, including an
  // invalid GH_TOKEN (stderr: "The token in GH_TOKEN is invalid."). Matching on
  // the literal "not logged in" text used to call that case *logged in*, which
  // sent users chasing the wrong failure whenever every query then returned 401.
  const loggedIn = auth.code === 0
  const authDetail = loggedIn ? '' : clip(auth.stderr || auth.stdout || 'gh auth status 失败', 160)
  return { ok: true, loggedIn, detail: clip(ver.stdout.trim(), 120) + (loggedIn ? '' : `（未登录或凭据无效：${authDetail || '需 gh auth login / 设置 GH_TOKEN'}）`), ms: Date.now() - t0 }
}

/** Build environment with optional per-instance GH_TOKEN override. */
function ghEnv(cfg, instanceId) {
  const inst = (cfg.instances ?? []).find((i) => i.id === instanceId)
  const host = inst?.host || 'github.com'
  if (!isSafeHost(host)) throw Object.assign(new Error('实例 host 不合法'), { status: 400 })
  const env = { ...process.env, GH_HOST: host, GH_PROMPT_DISABLED: '1', GH_PAGER: 'cat' }
  if (inst?.token) {
    delete env.GH_TOKEN; delete env.GITHUB_TOKEN
    delete env.GH_ENTERPRISE_TOKEN; delete env.GITHUB_ENTERPRISE_TOKEN
    env[host === 'github.com' ? 'GH_TOKEN' : 'GH_ENTERPRISE_TOKEN'] = inst.token
  }
  return env
}

// gh --json accepts FLAT top-level field names only. Nested GraphQL-style
// selection (`author{login,name}`) is rejected *locally* by gh with
// `Unknown JSON field: "author{login"` before any HTTP request is made, so it
// fails identically whether or not the user is authenticated. gh already
// returns these fields as fully-formed objects, so no mapping change is needed.
// Field names verified against the available-fields dump of gh 2.102.0
// (`gh pr list --json ___` prints it).
//
// `statusCheckRollup` is deliberately NOT part of the list payload. Measured
// against cli/cli with gh 2.102.0: `--state all --limit 200` including the
// rollup fails with HTTP 502/504 from the GraphQL gateway (deterministic from
// ~80 items, succeeds at 60), because the rollup resolves every check run of
// every PR in one request. The same 200 items without it succeed at ~446 KB.
// CI state therefore comes from a separate bounded query,
// `--state open --json number,statusCheckRollup` (~209 KB for 69 open PRs,
// succeeds). Merged/closed PRs keep no rollup and map to `unknown`.
const GH_PR_COMMON_FIELDS = [
  'number','title','state','isDraft','headRefName','baseRefName',
  'createdAt','updatedAt','mergedAt','additions','deletions','changedFiles',
  'reviewDecision','url',
  'author','labels','reviewRequests',
  'statusCheckRollup',
]
const GH_PR_LIST_FIELDS = [...GH_PR_COMMON_FIELDS.filter(f => f !== 'statusCheckRollup'), 'latestReviews'].join(',')
const GH_PR_CI_FIELDS = 'number,statusCheckRollup'
const GH_PR_VIEW_FIELDS = [...GH_PR_COMMON_FIELDS, 'reviews','comments', 'body', 'headRefOid', 'baseRefOid'].join(',')
const GH_PR_LIST_LIMIT = 200
const GH_ISSUE_LIMIT = 200
const GH_REPO_FIELDS = 'defaultBranchRef,name,description'
const GH_ISSUE_FIELDS = 'number,title,body,state,author,assignees,labels,createdAt,updatedAt,closedAt,url'

function parseGhPages(stdout) {
  const pages = JSON.parse(stdout)
  if (!Array.isArray(pages) || !pages.every(Array.isArray)) throw new Error('GitHub 分页响应格式不正确')
  return pages.flat()
}

function mapGhIssue(raw) {
  return {
    number: Number(raw.number), title: String(raw.title ?? ''), body: String(raw.body ?? ''),
    state: String(raw.state).toLowerCase() === 'closed' ? 'closed' : 'open', author: ghPerson(raw.author ?? raw.user),
    assignees: (raw.assignees ?? []).map(p => p.login).filter(Boolean), labels: (raw.labels ?? []).map(l => typeof l === 'string' ? l : l.name).filter(Boolean),
    createdAt: raw.createdAt ?? raw.created_at, updatedAt: raw.updatedAt ?? raw.updated_at,
    closedAt: raw.closedAt ?? raw.closed_at ?? null, url: raw.url ?? raw.html_url ?? '',
    comments: (Array.isArray(raw.comments) ? raw.comments : []).map(c => ({ id: String(c.id), body: String(c.body ?? ''), author: ghPerson(c.author ?? c.user), createdAt: c.createdAt ?? c.created_at })),
  }
}

function ghPerson(o) {
  if (!o) return { name: 'unknown', login: 'unknown' }
  if (typeof o === 'object') return { name: o.name || o.login || 'unknown', login: o.login || 'unknown' }
  return { name: String(o), login: String(o) }
}

/**
 * Aggregate gh's `statusCheckRollup` into the plugin's ciState vocabulary.
 * The rollup is a union of CheckRun and StatusContext entries and gh has shipped
 * it both as a single object and as a list, with the verdict living in `state`
 * (StatusContext) or `status` + `conclusion` (CheckRun) — so accept all shapes
 * and stay honest (`none`) whenever nothing is recognisable.
 */
function ghCiState(rollup) {
  const items = Array.isArray(rollup) ? rollup : (rollup && typeof rollup === 'object' ? [rollup] : [])
  let sawPending = false, sawRunning = false, sawSuccess = false, sawFailure = false
  for (const it of items) {
    if (!it || typeof it !== 'object') continue
    const status = String(it.status ?? '').toUpperCase()
    const verdict = String(it.conclusion ?? it.state ?? '').toUpperCase()
    const isCheckRun = status !== ''
    const settled = isCheckRun ? status === 'COMPLETED' : ['SUCCESS', 'FAILURE', 'ERROR'].includes(verdict)
    if (!settled) { sawPending = true; if (['IN_PROGRESS', 'RUNNING', 'QUEUED', 'PENDING'].includes(status)) sawRunning = true; continue }
    if (['SUCCESS', 'NEUTRAL', 'SKIPPED', 'ACTION_REQUIRED'].includes(verdict) || ['ACTIONS_SKIPPED'].includes(verdict)) sawSuccess = true
    else if (['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'STARTUP_FAILURE', 'STALE'].includes(verdict)) sawFailure = true
    else sawSuccess = true
  }
  if (sawFailure) return 'failure'
  if (sawPending || sawRunning) return 'pending'
  if (sawSuccess) return 'success'
  return 'none'
}

function mapGhPr(raw) {
  const author = ghPerson(raw?.author)
  let state = String(raw?.state ?? 'OPEN').toUpperCase()
  if (state === 'MERGED' || (state === 'CLOSED' && raw?.mergedAt)) state = 'merged'
  else if (state === 'CLOSED') state = 'closed'
  else state = 'open'
  const labels = (raw?.labels ?? []).map((l) => l?.name).filter(Boolean)
  const requestedReviewers = (raw?.reviewRequests ?? []).map((r) => r?.login).filter(Boolean)
  const decision = String(raw?.reviewDecision ?? 'NONE').toLowerCase()
  const reviews = (raw?.latestReviews ?? raw?.reviews ?? []).map((r) => ({
    id: `rv-${raw.number}-${r.author?.login || '?'}`,
    author: ghPerson(r.author),
    state: String(r.state ?? '').toLowerCase() === 'approved' ? 'approved'
      : String(r.state ?? '').toLowerCase() === 'changes_requested' ? 'changes_requested'
        : String(r.state ?? '').toLowerCase() === 'pending' ? 'pending' : 'commented',
    submittedAt: isoOr(r.submittedAt, raw.updatedAt),
    body: String(r.body ?? ''),
  })).filter((r) => r.state !== 'pending')
  const comments = (raw?.comments ?? []).map((c, i) => ({
    id: `rc-${raw.number}-${i}`,
    author: ghPerson(c.author),
    body: String(c.body ?? ''),
    file: c.path ?? null,
    line: c.line != null ? Number(c.line) : null,
    createdAt: isoOr(c.createdAt, raw.updatedAt),
    resolved: null, kind: 'conversation',
  }))
  // An absent rollup means it was never queried (see GH_PR_LIST_FIELDS), which
  // is not the same claim as an empty rollup — "the repo has no checks".
  const ciState = raw?.statusCheckRollup === undefined ? 'unknown' : ghCiState(raw.statusCheckRollup)
  return {
    number: Number(raw?.number) || 0, title: String(raw?.title ?? ''), author, state,
    draft: !!raw?.isDraft, sourceBranch: raw?.headRefName ?? '', targetBranch: raw?.baseRefName ?? '',
    createdAt: isoOr(raw?.createdAt, new Date().toISOString()),
    updatedAt: isoOr(raw?.updatedAt ?? raw?.createdAt, new Date().toISOString()),
    mergedAt: raw?.mergedAt ? isoOr(raw.mergedAt, null) : null,
    additions: Number(raw?.additions) || 0, deletions: Number(raw?.deletions) || 0,
    changedFiles: Number(raw?.changedFiles) || 0, labels,
    ciState, reviewDecision: ['approved', 'changes_requested', 'pending', 'none'].includes(decision) ? decision : 'none',
    requestedReviewers, reviews, comments, url: String(raw?.url ?? ''),
    body: String(raw?.body ?? ''), headSha: raw?.headRefOid ?? '', baseSha: raw?.baseRefOid ?? '',
  }
}

/**
 * Repository display metadata from `gh repo view`. The base branch of the most
 * recently updated PR is not the default branch — measured on cli/cli, where it
 * reported a contributor's `topic/branch` while the real default is `trunk`.
 * Failure is soft: the snapshot must not be lost over a badge, and an unknown
 * branch stays empty so git enrichment and the UI can say 未知.
 */
async function ghRepoView(repo, runGh, exe, env) {
  const fallback = { defaultBranch: repo.defaultBranch || '', description: `GitHub 仓库 ${repo.path}` }
  const res = await runGh(exe, ['repo', 'view', repo.path, '--json', GH_REPO_FIELDS], { env })
  if (res.code !== 0) return fallback
  let meta = null
  try { meta = JSON.parse(res.stdout) } catch { return fallback }
  if (!meta || typeof meta !== 'object') return fallback
  return {
    defaultBranch: repo.defaultBranch || String(meta.defaultBranchRef?.name ?? ''),
    description: clip(String(meta.description ?? ''), 200) || fallback.description,
  }
}

async function ghPrListRows(runGh, exe, env, repoPath, limit = GH_PR_LIST_LIMIT) {
  const listRes = await runGh(exe, [
    'pr', 'list', '--repo', repoPath, '--state', 'all', '--limit', String(limit),
    '--json', GH_PR_LIST_FIELDS,
  ], { env })
  let rows = null
  if (listRes.code === 0) { try { rows = JSON.parse(listRes.stdout) } catch { /* fall through */ } }
  if (!Array.isArray(rows)) throw new Error(clip(listRes.stderr || listRes.stdout || 'gh pr list 失败', 400))

  const ciRes = await runGh(exe, [
    'pr', 'list', '--repo', repoPath, '--state', 'open', '--limit', String(limit),
    '--json', GH_PR_CI_FIELDS,
  ], { env })
  let ciOk = false
  const ciByNumber = new Map()
  if (ciRes.code === 0) {
    try {
      const ciRows = JSON.parse(ciRes.stdout)
      if (Array.isArray(ciRows)) {
        ciOk = true
        for (const row of ciRows) if (row?.number != null) ciByNumber.set(Number(row.number), row.statusCheckRollup ?? [])
      }
    } catch { /* treat as unavailable */ }
  }
  const merged = ciOk
    ? rows.map(row => { const n = Number(row?.number); return ciByNumber.has(n) ? { ...row, statusCheckRollup: ciByNumber.get(n) } : row })
    : rows
  return { rows: merged, prLimit: limit, ciCoverage: ciOk ? 'open' : 'unavailable' }
}

async function ghSnapshot(repo, cfg) {
  if (!isSafeRepoPath(repo.path)) throw new Error(`仓库路径不合法（需 owner/name）：${clip(repo.path, 80)}`)
  const exe = ghExecutable(cfg)
  const env = ghEnv(cfg, repo.instanceId)
  const t0 = Date.now()

  const { rows, prLimit, ciCoverage } = await ghPrListRows(run, exe, env, repo.path)
  const mrs = rows.map(mapGhPr)
  const meta = await ghRepoView(repo, run, exe, env)

  let issues = [], issueError = null
  const issueRes = await run(exe, ['issue', 'list', '--repo', repo.path, '--state', 'all', '--limit', String(GH_ISSUE_LIMIT), '--json', GH_ISSUE_FIELDS], { env })
  try {
    if (issueRes.code !== 0) throw new Error(issueRes.stderr || 'Issue 拉取失败')
    issues = JSON.parse(issueRes.stdout).map(mapGhIssue)
  } catch (err) { issueError = clip(err.message, 300) }

  mrs.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
  return {
    repoKey: repo.key, source: 'gh', fetchedAt: new Date().toISOString(), error: null, elapsedMs: Date.now() - t0,
    repo: {
      key: repo.key, name: repoName(repo.path), owner: repoOwner(repo.path), path: repo.path,
      defaultBranch: meta.defaultBranch,
      description: meta.description, demo: false,
    },
    mrs, issues, issueError,
    degradedNote: ciCoverage === 'unavailable' ? 'CI 状态查询失败（GitHub GraphQL 返回 5xx），本次所有 PR 的 CI 显示为未查询。' : null,
    coverage: {
      limited: mrs.length >= prLimit || issues.length >= GH_ISSUE_LIMIT,
      details: 'on-demand', ci: ciCoverage,
      note: ciCoverage === 'open'
        ? `最多 ${prLimit} 条 PR / Issue；CI 状态仅查询未合并的 PR，已合并或关闭的历史 PR 显示为未查询。`
        : `最多 ${prLimit} 条 PR / Issue；本次未获取任何 CI 状态。`,
    },
  }
}

function apiError(message, status = 400) { return Object.assign(new Error(message), { status }) }

async function githubRequest(repo, cfg, endpoint, { paginate = false, method = 'GET', body, text = false, preserveStatus = false } = {}) {
  if (!isSafeRepoPath(repo.path)) throw apiError('仓库路径不合法')
  const inst = instanceOf(cfg, repo.instanceId)
  const env = ghEnv(cfg, repo.instanceId)
  if (cfg.provider === 'git') throw apiError('Git 元信息模式不能获取 PR / Issue，请选择 gh 或 HTTP', 503)
  let cliError
  if (cfg.provider !== 'http') {
    const args = ['api', '--hostname', env.GH_HOST, endpoint, '--method', method]
    if (paginate) args.push('--paginate', '--slurp')
    if (text) args.push('-H', 'Accept: application/vnd.github.diff')
    if (body !== undefined) args.push('--input', '-')
    const result = await run(ghExecutable(cfg), args, { env, input: body === undefined ? undefined : JSON.stringify(body) })
    if (result.code === 0) return text ? result.stdout : paginate ? parseGhPages(result.stdout) : JSON.parse(result.stdout)
    cliError = clip(result.stderr || 'gh api 失败', 400)
    // A failed write may already have reached GitHub. Never retry it via another transport.
    if (method !== 'GET' || !inst?.token) {
      if (preserveStatus) {
        const match = cliError.match(/HTTP\s+(\d{3})/i)
        throw apiError(cliError, match ? Number(match[1]) : 502)
      }
      throw apiError(cliError, 502)
    }
  }
  if (!inst?.token) throw apiError(cliError || 'HTTP 模式需要实例 token', 503)
  const base = apiBaseFor(env.GH_HOST)
  if (!base) throw apiError('实例 host 不合法')
  const rows = []
  for (let page = 1; page <= 100; page++) {
    const path = paginate ? `${endpoint}${endpoint.includes('?') ? '&' : '?'}per_page=100&page=${page}` : endpoint
    const response = await fetch(`${base}/${path}`, {
      method, redirect: 'error', signal: AbortSignal.timeout(cfg.http?.timeoutMs || 15000),
      headers: { accept: text ? 'application/vnd.github.diff' : 'application/vnd.github+json', authorization: `Bearer ${inst.token}`, 'content-type': 'application/json', 'user-agent': `dsh-codehub-dashboard/${PLUGIN_VERSION}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (!response.ok) {
      if (preserveStatus) throw apiError(`GitHub HTTP ${response.status}`, response.status)
      throw apiError(`GitHub HTTP ${response.status}`, response.status === 404 ? 404 : 502)
    }
    if (text) return response.text()
    const value = await response.json()
    if (!paginate) return value
    if (!Array.isArray(value)) throw apiError('GitHub 返回的列表格式不正确', 502)
    rows.push(...value)
    if (!/rel="next"/.test(response.headers.get('link') || '')) return rows
  }
  throw apiError('分页超过 100 页，请缩小组织范围', 422)
}

async function pullDetail(repo, cfg, number, { diff = false } = {}) {
  const endpoint = `repos/${repo.path}/pulls/${number}`
  const raw = await githubRequest(repo, cfg, endpoint)
  const mr = mapGithubPr(raw)
  mr.headSha = raw.head?.sha || ''; mr.baseSha = raw.base?.sha || ''; mr.body = String(raw.body || '')
  const detailErrors = []
  const readList = async (path) => {
    try { return await githubRequest(repo, cfg, path, { paginate: true }) }
    catch (err) { detailErrors.push(err.message); return [] }
  }
  const [reviews, inline, conversation] = await Promise.all([
    readList(`${endpoint}/reviews`), readList(`${endpoint}/comments`), readList(`repos/${repo.path}/issues/${number}/comments`),
  ])
  mr.reviews = reviews.filter(r => r.state !== 'PENDING').map(r => ({ id: String(r.id), author: ghPerson(r.user), state: String(r.state).toLowerCase(), body: String(r.body || ''), submittedAt: r.submitted_at }))
  mr.comments = [...inline.map(c => ({ ...c, kind: 'inline' })), ...conversation.map(c => ({ ...c, kind: 'conversation' }))].map(c => ({ id: `${c.kind}-${c.id}`, author: ghPerson(c.user), body: String(c.body || ''), file: c.path ?? null, line: c.line ?? null, createdAt: c.created_at, kind: c.kind, resolved: null }))
  let diffText = '', files = [], diffTruncated = false
  if (diff) {
    const results = await Promise.all([githubRequest(repo, cfg, endpoint, { text: true }), githubRequest(repo, cfg, `${endpoint}/files`, { paginate: true })])
    diffTruncated = results[0].length > 120000
    diffText = results[0].slice(0, 120000)
    files = results[1].map(f => ({ path: f.filename, status: f.status, additions: f.additions, deletions: f.deletions }))
    const check = await githubRequest(repo, cfg, endpoint)
    if (check.head?.sha !== mr.headSha || check.base?.sha !== mr.baseSha) throw apiError('PR 在读取期间发生变化，请重新加载', 409)
  }
  return { mr, repo, source: cfg.provider === 'http' ? 'http' : 'gh', detailErrors, diff: diffText, files, diffTruncated }
}

async function issueDetail(repo, cfg, number) {
  const raw = await githubRequest(repo, cfg, `repos/${repo.path}/issues/${number}`)
  if (raw.pull_request) throw apiError('该编号是 PR，不是 Issue', 400)
  const comments = await githubRequest(repo, cfg, `repos/${repo.path}/issues/${number}/comments`, { paginate: true })
  return { issue: mapGhIssue({ ...raw, url: raw.html_url, comments }), repo }
}

async function organizationRepos(org, cfg) {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(org.owner || '')) throw apiError('组织名不合法')
  const repo = { path: `${org.owner}/discovery`, instanceId: org.instance || 'github.com' }
  const rows = await githubRequest(repo, cfg, `orgs/${org.owner}/repos?type=all&sort=updated`, { paginate: true })
  return rows.filter(r => !r.archived && !r.disabled && isSafeRepoPath(r.full_name)).map(r => ({ instance: repo.instanceId, path: r.full_name, defaultBranch: r.default_branch }))
}

/* ===================== git provider (supplementary metadata) ===================== */

const git = (args, cwd) => run('git', args, { cwd })

async function isGitRepo(dir) {
  if (!dir) return false
  const r = await git(['rev-parse', '--is-inside-work-tree'], dir)
  return r.code === 0 && r.stdout.trim() === 'true'
}

function parseRemotePath(url) {
  const s = String(url ?? '').trim()
  if (!s) return null
  const m = s.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?\/?$/)
  if (!m) return null
  return m[1]
}

async function gitEnrich(repo, snap) {
  const dir = repo.localPath
  if (!(await isGitRepo(dir))) return snap
  // Enrich repo metadata from local git
  const remote = await git(['remote', 'get-url', 'origin'], dir)
  if (remote.code === 0) {
    const rp = parseRemotePath(remote.stdout.trim())
    if (rp) { snap.repo.remoteUrl = remote.stdout.trim(); snap.repo.remotePath = rp }
  }
  const head = await git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], dir)
  if (head.code === 0 && !snap.repo.defaultBranch) {
    snap.repo.defaultBranch = head.stdout.trim().replace(/^origin\//, '')
  }
  if (!snap.repo.defaultBranch) {
    for (const cand of ['main', 'master']) {
      const r = await git(['show-ref', '--verify', '--quiet', `refs/heads/${cand}`], dir)
      if (r.code === 0) { snap.repo.defaultBranch = cand; break }
    }
  }
  snap.repo.localPath = dir
  return snap
}

/* ===================== http provider (fallback REST) ===================== */

function instanceOf(cfg, id) {
  return (cfg.instances ?? []).find((i) => i.id === id) ?? null
}

async function httpJson(url, token, timeoutMs) {
  const res = await fetch(url, {
    redirect: 'error',
    headers: { accept: 'application/vnd.github+json', 'user-agent': `dsh-codehub-dashboard/${PLUGIN_VERSION}`, ...(token ? { authorization: `Bearer ${token}` } : {}) },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) { const body = await res.text().catch(() => ''); throw new Error(`HTTP ${res.status} ${clip(body, 200)}`) }
  return res.json()
}

function mapGithubPr(pr) {
  const state = pr?.merged_at ? 'merged' : String(pr?.state ?? 'open').toLowerCase() === 'closed' ? 'closed' : 'open'
  return {
    number: Number(pr?.number) || 0, title: String(pr?.title ?? ''),
    author: { name: pr?.user?.login || 'unknown', login: pr?.user?.login || 'unknown' },
    state, draft: !!pr?.draft, sourceBranch: pr?.head?.ref ?? '', targetBranch: pr?.base?.ref ?? '',
    createdAt: isoOr(pr?.created_at, new Date().toISOString()),
    updatedAt: isoOr(pr?.updated_at ?? pr?.created_at, new Date().toISOString()),
    mergedAt: pr?.merged_at ? isoOr(pr.merged_at, null) : null,
    additions: Number(pr?.additions) || 0, deletions: Number(pr?.deletions) || 0,
    changedFiles: Number(pr?.changed_files) || 0,
    labels: (pr?.labels ?? []).map((l) => l?.name).filter(Boolean),
    ciState: 'unknown', reviewDecision: 'none',
    requestedReviewers: (pr?.requested_reviewers ?? []).map((r) => r?.login).filter(Boolean),
    reviews: [], comments: [], url: String(pr?.html_url ?? ''),
  }
}

async function httpSnapshot(repo, cfg) {
  const inst = instanceOf(cfg, repo.instanceId)
  if (!inst?.token) throw new Error(`实例 ${repo.instanceId} 未配置 token`)
  if (!isSafeRepoPath(repo.path)) throw new Error(`仓库路径不合法（需 owner/name）：${clip(repo.path, 80)}`)
  const timeoutMs = Number(cfg.http?.timeoutMs ?? 15000)
  const host = inst.host || 'github.com'
  const apiBase = apiBaseFor(host)
  if (!apiBase) throw new Error(`实例 host 不合法（需纯域名）：${clip(host, 80)}`)
  const t0 = Date.now()
  const pulls = await httpJson(`${apiBase}/repos/${repo.path}/pulls?state=all&per_page=${Number(cfg.http?.perPage ?? 100)}&sort=updated&direction=desc`, inst.token, timeoutMs)
  if (!Array.isArray(pulls)) throw new Error('pulls 响应不是数组')
  const mrs = pulls.map(mapGithubPr)

  let issues = [], issueError = null
  try {
    const rows = await httpJson(`${apiBase}/repos/${repo.path}/issues?state=all&per_page=100&sort=updated&direction=desc`, inst.token, timeoutMs)
    issues = rows.filter(i => !i.pull_request).map(i => mapGhIssue({ ...i, url: i.html_url }))
  } catch (err) { issueError = clip(err.message, 300) }

  mrs.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
  return {
    repoKey: repo.key, source: 'http', fetchedAt: new Date().toISOString(), error: null, elapsedMs: Date.now() - t0,
    repo: {
      key: repo.key, name: repoName(repo.path), owner: repoOwner(repo.path), path: repo.path,
      defaultBranch: repo.defaultBranch || '',
      description: `GitHub 仓库 ${repo.path}（REST API）`, demo: false, instanceId: inst.id,
    },
    mrs, issues, issueError, coverage: { limited: true, details: 'on-demand' },
  }
}

/* ===================== provider dispatch + cache ===================== */

function planSource(repo, cfg, ghOk) {
  const p = cfg.provider
  if (p === 'gh') return 'gh'
  if (p === 'git') return 'git-meta' // git alone can't provide MRs; treat as metadata-only
  if (p === 'http') return 'http'
  // auto: gh first, then http if token available, otherwise error
  if (ghOk) return 'gh'
  const inst = instanceOf(cfg, repo.instanceId)
  if (inst?.token) return 'http'
  return 'error' // no data source available
}

function createFetcher(store, log) {
  const cache = new Map()
  let ghOkCache = { at: 0, ok: false, loggedIn: false }
  let inflight = null
  let repoCache = { rev: -1, at: 0, repos: [], errors: [] }

  const resolveRepos = async (force = false) => {
    const cfg = store.get(), rev = store.rev
    const ttl = Math.max(1, Number(cfg.pollMinutes) || 10) * 60000
    if (!force && repoCache.rev === rev && Date.now() - repoCache.at < ttl) return repoCache
    const discovered = [], errors = []
    await mapLimit((cfg.organizations ?? []).filter(o => o.enabled !== false), FETCH_CONCURRENCY, async org => {
      try { discovered.push(...await organizationRepos(org, cfg)) }
      catch (err) {
        errors.push({ owner: org.owner, error: err.message })
        if (repoCache.rev === rev) discovered.push(...repoCache.repos.filter(r => r.instanceId === (org.instance || 'github.com') && repoOwner(r.path).toLowerCase() === String(org.owner).toLowerCase()).map(r => ({ ...r, instance: r.instanceId })))
      }
    })
    const result = { rev, at: Date.now(), repos: mergeRepos(cfg, discovered), errors }
    if (store.rev === rev) repoCache = result
    return result
  }

  const ghAvailable = async (cfg) => {
    if (cfg.provider === 'http') return false
    const exe = ghExecutable(cfg)
    if (!exe) return false
    const age = Date.now() - ghOkCache.at
    const ttl = ghOkCache.ok ? 300_000 : 60_000
    if (age < ttl) return ghOkCache.ok
    const probe = await ghProbe(cfg)
    ghOkCache = { at: Date.now(), ok: !!probe.ok, loggedIn: !!probe.loggedIn }
    return ghOkCache.ok
  }

  const fetchOne = async (repo, cfg, ghOk, force, rev = store.rev) => {
    const hit = cache.get(repo.key)
    const ttl = Math.max(1, Number(cfg.pollMinutes) || 10) * 60_000
    if (!force && hit && hit.rev === rev && Date.now() - hit.at < ttl) return hit.snapshot

    const planned = planSource(repo, cfg, ghOk)
    let snapshot
    try {
      if (planned === 'gh') snapshot = await ghSnapshot(repo, cfg)
      else if (planned === 'http') snapshot = await httpSnapshot(repo, cfg)
      else if (planned === 'git-meta') {
        snapshot = { repoKey: repo.key, source: 'git-meta', fetchedAt: new Date().toISOString(), error: 'git 数据源仅提供仓库元信息，MR 数据需要 gh CLI 或 HTTP token', repo: { key: repo.key, name: repoName(repo.path), owner: repoOwner(repo.path), path: repo.path, defaultBranch: repo.defaultBranch || '', description: '', demo: false }, mrs: [] }
      } else {
        snapshot = { repoKey: repo.key, source: 'error', fetchedAt: new Date().toISOString(), error: '无可用数据源：请安装并登录 gh CLI（gh auth login），或在设置中配置 HTTP token', repo: { key: repo.key, name: repoName(repo.path), owner: repoOwner(repo.path), path: repo.path, defaultBranch: repo.defaultBranch || '', description: '', demo: false }, mrs: [] }
      }
    } catch (err) {
      const msg = clip(err?.message ?? String(err), 400)
      // Fallback chain: gh -> http (if token) -> error
      if (planned === 'gh') {
        const inst = instanceOf(cfg, repo.instanceId)
        if (inst?.token) {
          try { snapshot = await httpSnapshot(repo, cfg); snapshot.degradedNote = `gh 失败（${msg}），已降级为 HTTP API` }
          catch { snapshot = { repoKey: repo.key, source: 'error', fetchedAt: new Date().toISOString(), error: msg, repo: { key: repo.key, name: repoName(repo.path), owner: repoOwner(repo.path), path: repo.path, defaultBranch: repo.defaultBranch || '', description: '', demo: false }, mrs: [] } }
        } else {
          snapshot = { repoKey: repo.key, source: 'error', fetchedAt: new Date().toISOString(), error: msg, repo: { key: repo.key, name: repoName(repo.path), owner: repoOwner(repo.path), path: repo.path, defaultBranch: repo.defaultBranch || '', description: '', demo: false }, mrs: [] }
        }
      } else {
        snapshot = { repoKey: repo.key, source: 'error', fetchedAt: new Date().toISOString(), error: msg, repo: { key: repo.key, name: repoName(repo.path), owner: repoOwner(repo.path), path: repo.path, defaultBranch: repo.defaultBranch || '', description: '', demo: false }, mrs: [] }
      }
      log?.warn?.(`[codehub] repo ${repo.key}: ${snapshot.degradedNote ?? msg}`)
    }

    // Git enrichment (supplementary metadata from local clone)
    if (repo.localPath && snapshot) {
      try { snapshot = await gitEnrich(repo, snapshot) } catch {}
    }

    if (snapshot.error && hit?.rev === rev && (hit.snapshot.mrs?.length || hit.snapshot.issues?.length)) {
      snapshot = { ...hit.snapshot, error: snapshot.error, stale: true }
    } else if (!snapshot.error && hit?.rev === rev) {
      snapshot.mrs = snapshot.mrs.map(mr => {
        const prior = hit.snapshot.mrs?.find(m => m.number === mr.number && new Date(m.updatedAt).getTime() === new Date(mr.updatedAt).getTime())
        return prior?.detailLoaded ? { ...mr, reviews: prior.reviews, comments: prior.comments, detailLoaded: true } : mr
      })
      if (snapshot.issueError && hit.snapshot.issues?.length) { snapshot.issues = hit.snapshot.issues; snapshot.stale = true }
    }
    if (store.rev === rev) cache.set(repo.key, { snapshot, at: Date.now(), rev })
    return snapshot
  }

  const refreshAll = async (force) => {
    const rev = store.rev
    if (inflight?.rev === rev) return inflight.promise
    const promise = (async () => {
      const cfg = store.get()
      const resolved = await resolveRepos(force)
      const ghOk = await ghAvailable(cfg)
      const result = (await mapLimit(resolved.repos, FETCH_CONCURRENCY, repo => fetchOne(repo, cfg, ghOk, force, rev))).filter(Boolean)
      for (const org of resolved.errors) result.push({ repoKey: `organization:${org.owner}`, repo: { name: org.owner, path: org.owner }, source: 'error', error: `组织仓库发现失败：${org.error}`, mrs: [], issues: [] })
      return result
    })()
    inflight = { rev, promise }
    try { return await promise } finally { if (inflight?.promise === promise) inflight = null }
  }

  const cached = () => {
    const repos = repoCache.rev === store.rev ? repoCache.repos : effectiveRepos(store.get())
    const out = []
    for (const repo of repos) { const hit = cache.get(repo.key); if (hit && hit.rev === store.rev) out.push(hit.snapshot) }
    if (repoCache.rev === store.rev) for (const org of repoCache.errors) out.push({ repoKey: `organization:${org.owner}`, repo: { name: org.owner, path: org.owner }, source: 'error', error: `组织仓库发现失败：${org.error}`, mrs: [], issues: [] })
    return out
  }
  const rememberDetail = (repoKey, mr, rev) => {
    const hit = cache.get(repoKey)
    if (!hit || hit.rev !== rev || store.rev !== rev) return
    const index = hit.snapshot.mrs.findIndex(m => m.number === mr.number)
    if (index < 0) return
    const prior = hit.snapshot.mrs[index]
    // REST details do not return the list's check rollup or review decision.
    hit.snapshot.mrs[index] = { ...prior, ...mr, ciState: prior.ciState, reviewDecision: prior.reviewDecision, detailLoaded: true }
    return hit.snapshot.mrs[index]
  }

  return { refreshAll, cached, fetchOne, resolveRepos, rememberDetail, ghAvailable, ghProbe, invalidate: () => { cache.clear(); repoCache = { rev: -1, at: 0, repos: [], errors: [] }; ghOkCache = { at: 0, ok: false, loggedIn: false } } }
}

/* ===================== aggregation ===================== */

function computeNeedsMyReview(mr, meLogin) {
  if (!meLogin) return false
  if (mr.state !== 'open' || mr.draft) return false
  if (!(mr.requestedReviewers ?? []).includes(meLogin)) return false
  // GitHub only clears a review request on approve / request-changes.
  // A bare "commented" review leaves me on the requested list, so it must
  // still count as waiting for my review.
  return !(mr.reviews ?? []).some((r) => r.author?.login === meLogin && (r.state === 'approved' || r.state === 'changes_requested'))
}

function commentNeedsReply(mr, c, meLogin) {
  if (!meLogin) return false
  if (c.resolved !== false) return false
  if (c.author?.login === meLogin) return false
  return mr.author?.login === meLogin || mr.reviewDecision === 'changes_requested'
}

function decorate(mr, meLogin) {
  const unresolved = (mr.comments ?? []).filter((c) => c.resolved === false)
  return {
    ...mr, needsMyReview: computeNeedsMyReview(mr, meLogin),
    commentCount: (mr.comments ?? []).length, unresolvedCount: unresolved.length,
    needsReplyCount: unresolved.filter((c) => commentNeedsReply(mr, c, meLogin)).length,
    reviewCount: (mr.reviews ?? []).length,
  }
}

/**
 * Coverage disclosure shared by `overview` and list responses (`mrs`), so a
 * list that silently drops a failing repo still tells the SPA its sample is
 * incomplete. Keeping it in one place prevents the two surfaces diverging.
 */
function buildCoverage(snapshots) {
  return {
    limited: snapshots.some(s => s.coverage?.limited || s.error || s.issueError || s.stale),
    note: '统计基于已同步样本：gh 每仓库最多 200 条 PR / Issue，HTTP 为首批结果；CI 状态仅覆盖未合并的 PR，历史 PR 显示为未查询；意见按需加载，未获取的线程解决状态不计为未解决。不是完整历史统计。',
  }
}

function buildOverview(snapshots, cfg) {
  const meLogin = (cfg.me?.login || '').trim()
  const now = Date.now(); const weekAgo = now - 7 * DAY_MS
  const repos = []; const allMrs = []; const allComments = []
  let detailsLoaded = false
  const statusDist = { open: 0, merged: 0, closed: 0 }
  const reviewerAgg = new Map(); const dayMap = new Map(); const events = []
  const dayBucket = (t) => { const k = dateKey(t); if (!dayMap.has(k)) dayMap.set(k, { date: k, opened: 0, merged: 0, comments: 0 }); return dayMap.get(k) }
  for (let i = 29; i >= 0; i--) dayBucket(now - i * DAY_MS)

  for (const snap of snapshots) {
    if (!snap) continue
    const mrs = (snap.mrs ?? []).map((mr) => decorate(mr, meLogin))
    if ((snap.mrs ?? []).some((mr) => mr.detailLoaded)) detailsLoaded = true
    let open = 0, merged = 0, closed = 0, needsReview = 0, unresolved = 0, failing = 0, drafts = 0, mergedWeek = 0, lastActivity = 0
    for (const mr of mrs) {
      allMrs.push({ ...mr, repoKey: snap.repoKey, repoPath: snap.repo?.path, repoName: snap.repo?.name })
      if (mr.state === 'open') { open++; if (mr.draft) drafts++ } else if (mr.state === 'merged') merged++; else closed++
      if (mr.needsMyReview) needsReview++
      if (mr.state === 'open' && mr.ciState === 'failure') failing++
      if (mr.mergedAt && new Date(mr.mergedAt).getTime() >= weekAgo) mergedWeek++
      const upd = new Date(mr.updatedAt).getTime(); if (upd > lastActivity) lastActivity = upd
      const created = new Date(mr.createdAt).getTime()
      if (created >= now - 30 * DAY_MS) dayBucket(created).opened++
      if (mr.mergedAt) { const mt = new Date(mr.mergedAt).getTime(); if (mt >= now - 30 * DAY_MS) dayBucket(mt).merged++ }
      events.push({ type: mr.state === 'merged' ? 'merged' : 'opened', at: mr.state === 'merged' ? mr.mergedAt : mr.createdAt, repoKey: snap.repoKey, repoName: snap.repo?.name, mrNumber: mr.number, title: mr.title, actor: mr.author?.name ?? mr.author?.login, state: mr.state })
      for (const rv of mr.reviews ?? []) {
        const key = rv.author?.login || 'unknown'
        if (!reviewerAgg.has(key)) reviewerAgg.set(key, { login: key, name: rv.author?.name || key, reviews: 0, approvals: 0, changesRequested: 0, comments: 0, unresolved: 0 })
        const agg = reviewerAgg.get(key); agg.reviews++
        if (rv.state === 'approved') agg.approvals++; if (rv.state === 'changes_requested') agg.changesRequested++
        if (rv.submittedAt) events.push({ type: 'review', at: rv.submittedAt, repoKey: snap.repoKey, repoName: snap.repo?.name, mrNumber: mr.number, title: mr.title, actor: rv.author?.name ?? rv.author?.login, reviewState: rv.state })
      }
      for (const c of mr.comments ?? []) {
        const key = c.author?.login || 'unknown'
        if (!reviewerAgg.has(key)) reviewerAgg.set(key, { login: key, name: c.author?.name || key, reviews: 0, approvals: 0, changesRequested: 0, comments: 0, unresolved: 0 })
        const agg = reviewerAgg.get(key); agg.comments++; if (c.resolved === false) { agg.unresolved++; unresolved++ }
        const ct = new Date(c.createdAt).getTime(); if (ct >= now - 30 * DAY_MS) dayBucket(ct).comments++
        allComments.push({
          id: c.id, repoKey: snap.repoKey, repoPath: snap.repo?.path, repoName: snap.repo?.name,
          mrNumber: mr.number, mrTitle: mr.title, mrState: mr.state, mrUrl: mr.url || '',
          author: c.author, body: c.body, file: c.file, line: c.line, createdAt: c.createdAt,
          resolved: c.resolved ?? null, needsReply: commentNeedsReply(mr, c, meLogin), kind: c.kind || 'comment',
        })
        events.push({ type: 'comment', at: c.createdAt, repoKey: snap.repoKey, repoName: snap.repo?.name, mrNumber: mr.number, title: mr.title, actor: c.author?.name ?? c.author?.login })
      }
      statusDist.open += mr.state === 'open' ? 1 : 0; statusDist.merged += mr.state === 'merged' ? 1 : 0; statusDist.closed += mr.state === 'closed' ? 1 : 0
    }
    repos.push({
      key: snap.repoKey, name: snap.repo?.name, owner: snap.repo?.owner, path: snap.repo?.path,
      description: snap.repo?.description ?? '', defaultBranch: snap.repo?.defaultBranch ?? '',
      source: snap.source, degradedNote: snap.degradedNote ?? null, error: snap.error || snap.issueError || null, stale: !!snap.stale,
      fetchedAt: snap.fetchedAt, demo: false, localPath: snap.repo?.localPath ?? '', url: snap.repo?.remoteUrl ?? '',
      counts: { open, merged, closed, needsReview, unresolved, failingCi: failing, drafts, mergedWeek, total: mrs.length,
        openIssues: (snap.issues ?? []).filter(i => i.state === 'open').length,
        closedIssues: (snap.issues ?? []).filter(i => i.state === 'closed').length,
      }, 
      lastActivity: lastActivity ? new Date(lastActivity).toISOString() : null,
    })
  }

  const activity = [...dayMap.values()].sort((a, b) => a.date < b.date ? -1 : 1)
  const topReviewers = [...reviewerAgg.values()].map((r) => ({ ...r, score: r.comments + r.reviews * 2 })).sort((a, b) => b.score - a.score).slice(0, 8)
  events.sort((a, b) => new Date(b.at) - new Date(a.at))

  const summary = {
    repos: repos.length, errors: repos.filter((r) => r.error || r.source === 'error').length,
    openMrs: statusDist.open, mergedMrs: statusDist.merged, closedMrs: statusDist.closed,
    needsReview: allMrs.filter((m) => m.needsMyReview).length, drafts: repos.reduce((s, r) => s + r.counts.drafts, 0),
    unresolvedComments: allComments.filter((c) => c.resolved === false).length,
    unknownResolutionComments: allComments.filter(c => c.resolved == null).length,
    // `unresolvedComments: 0` is only trustworthy when threads were actually
    // fetched. Comments load on demand (op=reviews / PR detail), so an empty
    // allComments usually means "never queried", not "known to be zero" — that
    // zero must not be presented as a confident result. detailLoaded marks an MR
    // whose comments really were loaded, which is the only case where an empty
    // list is a fact. A non-empty list still counts only when at least one
    // thread carries a definite state; all-null stays unknown.
    resolutionAvailable: allComments.some(c => c.resolved != null) || (detailsLoaded && allComments.length === 0),
    openIssues: repos.reduce((s, r) => s + r.counts.openIssues, 0),
    closedIssues: repos.reduce((s, r) => s + r.counts.closedIssues, 0),
    assignedIssues: snapshots.reduce((s, r) => s + (r.issues ?? []).filter(i => i.state === 'open' && !!meLogin && i.assignees.includes(meLogin)).length, 0),
    needsReply: allComments.filter((c) => c.needsReply).length,
    failingCi: repos.reduce((s, r) => s + r.counts.failingCi, 0),
    mergedThisWeek: repos.reduce((s, r) => s + r.counts.mergedWeek, 0),
    totalComments: allComments.length,
    me: meLogin ? { login: meLogin, name: cfg.me?.name || meLogin } : null,
  }
  const coverage = buildCoverage(snapshots)
  return { summary, repos, statusDist, activity, topReviewers, coverage, recent: events.slice(0, 24), generatedAt: new Date().toISOString() }
}

function filterMrs(allMrs, params) {
  const { repoKey, state, q, needsReview, unresolved, author, sort, limit, ci } = params
  let out = allMrs
  if (repoKey) out = out.filter((m) => m.repoKey === repoKey)
  if (state && state !== 'all') out = out.filter((m) => m.state === state)
  if (needsReview) out = out.filter((m) => m.needsMyReview)
  if (unresolved) out = out.filter((m) => m.unresolvedCount > 0)
  if (author) out = out.filter((m) => m.author?.login === author || m.author?.name === author)
  if (ci) out = out.filter((m) => (m.ciState || 'none') === ci)
  if (q) { const s = String(q).toLowerCase(); out = out.filter((m) => m.title?.toLowerCase().includes(s) || String(m.number).includes(s) || m.author?.name?.toLowerCase().includes(s) || m.author?.login?.toLowerCase().includes(s) || m.sourceBranch?.toLowerCase().includes(s) || (m.labels ?? []).some((l) => l.toLowerCase().includes(s))) }
  out = [...out]
  if (sort === 'created') out.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
  else if (sort === 'comments') out.sort((a, b) => b.unresolvedCount - a.unresolvedCount || b.commentCount - a.commentCount)
  else out.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
  const lim = Math.max(1, Math.min(500, Number(limit) || 200))
  return { total: out.length, mrs: out.slice(0, lim).map((m) => ({
    number: m.number, title: m.title, author: m.author, state: m.state, draft: m.draft,
    sourceBranch: m.sourceBranch, targetBranch: m.targetBranch,
    createdAt: m.createdAt, updatedAt: m.updatedAt, mergedAt: m.mergedAt,
    additions: m.additions, deletions: m.deletions, changedFiles: m.changedFiles,
    labels: m.labels, ciState: m.ciState, reviewDecision: m.reviewDecision,
    requestedReviewers: m.requestedReviewers, url: m.url,
    needsMyReview: m.needsMyReview, commentCount: m.commentCount, unresolvedCount: m.unresolvedCount,
    needsReplyCount: m.needsReplyCount, reviewCount: m.reviewCount,
    repoKey: m.repoKey, repoPath: m.repoPath, repoName: m.repoName,
  })) }
}

/* ===================== workspace repo discovery ===================== */

async function discoverGitRepos(ws, depth = 2) {
  const found = []; const root = resolve(String(ws || ''))
  if (!root || !existsSync(root)) return found
  const walk = async (dir, level) => {
    if (level > depth || found.length >= 40) return
    let entries; try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (found.length >= 40) return; if (!e.isDirectory()) continue
      if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'dist' || e.name === 'build') continue
      const p = join(dir, e.name)
      try {
        const st = await stat(join(p, '.git'))
        if (st) {
          const remote = await git(['remote', 'get-url', 'origin'], p)
          const head = await git(['symbolic-ref', '--short', 'HEAD'], p)
          found.push({ path: p, name: e.name, remote: remote.code === 0 ? remote.stdout.trim() : '', remotePath: remote.code === 0 ? (parseRemotePath(remote.stdout.trim()) ?? '') : '', branch: head.code === 0 ? head.stdout.trim() : '' })
          continue
        }
      } catch {}
      await walk(p, level + 1)
    }
  }
  try { const st = await stat(join(root, '.git')); if (st) {
    const remote = await git(['remote', 'get-url', 'origin'], root); const head = await git(['symbolic-ref', '--short', 'HEAD'], root)
    found.push({ path: root, name: basename(root), remote: remote.code === 0 ? remote.stdout.trim() : '', remotePath: remote.code === 0 ? (parseRemotePath(remote.stdout.trim()) ?? '') : '', branch: head.code === 0 ? head.stdout.trim() : '' })
  } } catch {}
  await walk(root, 1); return found
}

/* ===================== connectivity tests ===================== */

async function testTargets(cfg, fetcher) {
  const results = []
  const gitVer = await run('git', ['--version'])
  results.push({ target: 'git', kind: 'cli', ok: gitVer.code === 0, detail: clip(gitVer.stdout.trim() || gitVer.stderr, 160), ms: null })
  const ghRes = await fetcher.ghProbe(cfg)
  results.push({ target: cfg.ghPath || 'gh', kind: 'gh-cli', ok: !!ghRes.ok, detail: clip(ghRes.detail ?? '', 200), ms: ghRes.ms ?? null })
  for (const inst of cfg.instances ?? []) {
    if (!inst.token) { results.push({ target: inst.name || inst.id, kind: 'instance-token', ok: false, detail: 'token 未配置' }); continue }
    const t0 = Date.now()
    try {
      const host = inst.host || 'github.com'
      const apiBase = apiBaseFor(host)
      if (!apiBase) { results.push({ target: inst.name || inst.id, kind: 'http-api', ok: false, detail: `host 不合法（需纯域名）：${clip(host, 80)}`, ms: null }); continue }
      const res = await fetch(`${apiBase}/rate_limit`, { headers: { accept: 'application/json', authorization: `Bearer ${inst.token}`, 'user-agent': `dsh-codehub-dashboard/${PLUGIN_VERSION}` }, signal: AbortSignal.timeout(8000) })
      results.push({ target: inst.name || inst.id, kind: 'http-api', ok: res.ok, detail: `HTTP ${res.status} ${host}`, ms: Date.now() - t0 })
    } catch (err) { results.push({ target: inst.name || inst.id, kind: 'http-api', ok: false, detail: clip(err?.message ?? String(err), 200), ms: Date.now() - t0 }) }
  }
  for (const repo of (cfg.repos ?? []).filter((r) => r.enabled !== false)) {
    if (!repo.localPath) continue
    const ok = await isGitRepo(repo.localPath)
    results.push({ target: repo.path || repo.localPath, kind: 'local-repo', ok, detail: ok ? repo.localPath : `不是有效的 git 仓库: ${repo.localPath}` })
  }
  return results
}

/* ===================== HTTP plumbing ===================== */

// Serve web/index.html with a process-level cache validated by mtime, so
// repeat requests skip a 56KB disk read without risking stale content.
let htmlCache = { mtimeMs: 0, body: '' }
function readDashboardHtml() {
  const file = join(webRoot, 'index.html')
  const st = statSync(file)
  if (!htmlCache.body || st.mtimeMs !== htmlCache.mtimeMs) {
    htmlCache = { mtimeMs: st.mtimeMs, body: readFileSync(file, 'utf8') }
  }
  return htmlCache.body
}

function readBody(req, limit = 256 * 1024) {
  return new Promise((resolveP, rejectP) => {
    let size = 0; let destroyed = false; const chunks = []
    req.on('data', (c) => {
      if (destroyed) return
      size += c.length
      if (size > limit) { destroyed = true; rejectP(new Error('body too large')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => { if (!destroyed) resolveP(Buffer.concat(chunks).toString('utf8')) })
    req.on('error', (err) => { if (!destroyed) { destroyed = true; rejectP(err) } })
  })
}

/* ===================== plugin entry ===================== */

export function apply(ctx, loaderConfig = {}) {
  const log = ctx.logger ?? console
  const configPath = String(loaderConfig?.configPath || process.env.CODEHUB_DASHBOARD_CONFIG || join(homedir(), '.dsh', 'codehub-dashboard', 'config.json'))
  const store = createConfigStore(configPath, log)
  const fetcher = createFetcher(store, log)
  let lastRefreshAt = 0, bootPromise = null

  // Memoise the promise, not a boolean: with a boolean flag, two requests that
  // arrive before the load finishes both fall through, and the second one can
  // read the still-default config and persist it over the real one on save.
  const ensureBoot = () => {
    if (!bootPromise) bootPromise = store.init().catch((err) => { bootPromise = null; throw err })
    return bootPromise
  }
  const snapshots = async (force = false) => { await ensureBoot(); const list = await fetcher.refreshAll(force); lastRefreshAt = Date.now(); return list }
  const overviewFrom = (snaps, cfg) => buildOverview(snaps, cfg)
  const resolveRepo = async (repoKey, number) => {
    if (!Number.isSafeInteger(number) || number <= 0) throw apiError('PR / Issue 编号必须是正整数')
    const explicit = effectiveRepos(store.get()).find(r => r.key === repoKey)
    const repo = explicit || (await fetcher.resolveRepos()).repos.find(r => r.key === repoKey)
    if (!repo) throw apiError('仓库未配置或已禁用', 404)
    return repo
  }
  const getPullRequest = async (repoKey, number, options) => {
    const rev = store.rev, cfg = store.get()
    const repo = await resolveRepo(repoKey, number)
    const detail = await pullDetail(repo, cfg, number, options)
    detail.mr = fetcher.rememberDetail(repoKey, detail.mr, rev) ?? detail.mr
    return detail
  }
  const getIssue = async (repoKey, number) => issueDetail(await resolveRepo(repoKey, number), store.get(), number)
  const verifyLocalRepo = async (repo) => {
    if (!repo.localPath) throw apiError('请在仓库设置中绑定本地克隆路径')
    const path = resolve(repo.localPath)
    if (!(await isGitRepo(path))) throw apiError('绑定路径不是 Git 工作区')
    const remote = await git(['remote', 'get-url', 'origin'], path)
    const expectedHost = ghEnv(store.get(), repo.instanceId).GH_HOST
    const url = remote.stdout.trim()
    let remoteHost = ''
    try { remoteHost = new URL(url).hostname } catch { remoteHost = url.match(/^(?:[^@]+@)?([^:]+):/)?.[1] || '' }
    if (remote.code !== 0 || parseRemotePath(url)?.toLowerCase() !== repo.path.toLowerCase() || remoteHost.toLowerCase() !== expectedHost.toLowerCase()) throw apiError('本地 origin 与所选 GitHub 仓库不一致')
    return path
  }
  const workflows = createWorkflows({ ctx, store, filePath: `${configPath}.workflows.json`, getPullRequest, getIssue, verifyLocalRepo,
    publishReview: async ({ repoKey, number, headSha, body }) => {
      const revision = store.rev, config = store.get()
      const repo = await resolveRepo(repoKey, number)
      if (store.rev !== revision) throw apiError('发布前配置已变更，请重新核对目标仓库', 409)
      return githubRequest(repo, config, `repos/${repo.path}/pulls/${number}/reviews`, { method: 'POST', body: { commit_id: headSha, event: 'COMMENT', body } })
    },
    createIssue: async ({ repoKey, number, title, body }) => {
      if (typeof title !== 'string' || !title.trim()) throw Object.assign(apiError('Issue 标题缺失', 400), { knownNotCreated: true })
      if (typeof body !== 'string' || !body.trim()) throw Object.assign(apiError('Issue 正文缺失', 400), { knownNotCreated: true })
      const revision = store.rev
      const repo = await resolveRepo(repoKey, number)
      if (store.rev !== revision) throw Object.assign(apiError('创建前配置已变更，请重新核对仓库', 409), { knownNotCreated: true })
      try {
        // Fixed endpoint and issue shape: clients cannot steer the target repo,
        // PR number, label, or assignee. preserveStatus keeps GitHub's 4xx so the
        // workflow can mark the finding failed (provably uncreated) instead of unknown.
        const issue = await githubRequest(repo, store.get(), `repos/${repo.path}/issues`, { method: 'POST', body: { title, body }, preserveStatus: true })
        if (!issue || typeof issue.number !== 'number' || typeof issue.html_url !== 'string') throw apiError('GitHub 返回的 Issue 格式不正确', 502)
        return { number: issue.number, url: issue.html_url }
      } catch (error) {
        if (error?.status && [400, 401, 403, 404, 410, 422, 429].includes(error.status)) error.knownNotCreated = true
        throw error
      }
    },
  })
  let reviewLoad = null
  let saveRefresh = null
  const queueRefreshAfterSave = () => {
    if (saveRefresh) return saveRefresh
    saveRefresh = snapshots(false)
      .catch(err => log?.warn?.('[codehub] refresh after save failed:', err.message))
      .finally(() => { saveRefresh = null })
    return saveRefresh
  }
  const reviewSnapshots = async () => {
    if (reviewLoad) return reviewLoad
    const rev = store.rev
    const pending = (async () => {
      const list = await snapshots()
      const targets = list.flatMap(s => (s.mrs ?? []).filter(m => !m.detailLoaded).slice(0, store.get().http.detailLimit).map(m => ({ repoKey: s.repoKey, number: m.number })))
      const errors = []
      await mapLimit(targets, FETCH_CONCURRENCY, async target => {
        try { const detail = await getPullRequest(target.repoKey, target.number); errors.push(...detail.detailErrors) }
        catch (err) { errors.push(err.message) }
      })
      return { snapshots: rev === store.rev ? fetcher.cached() : [], errors }
    })()
    reviewLoad = pending
    try { return await pending } finally { if (reviewLoad === pending) reviewLoad = null }
  }

  ctx.effect(() => {
    const disposeRoute = ctx.webServer.register({
      kind: 'prefix', path: '/codehub',
      handler: async (req, res) => {
        const sendJson = (obj, status = 200) => { const body = JSON.stringify(obj); res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(body) }
        try {
          if (typeof ctx.connection?.admit !== 'function') { sendJson({ ok: false, error: 'DSH 原生鉴权服务不可用' }, 503); return }
          const admission = ctx.connection.admit(req)
          if ('rejection' in admission) { sendJson({ ok: false, error: admission.rejection === 401 ? 'DSH 登录已失效，请从宿主重新打开' : '请求未通过 DSH 信任校验' }, admission.rejection); return }
          await ensureBoot()
          const url = new URL(req.url, 'http://localhost'); const pathname = url.pathname; const q = url.searchParams
          if (pathname === '/codehub' || pathname === '/codehub/' || pathname === '/codehub/index.html') {
            // Defence in depth: PR titles/bodies are attacker-influenced strings
            // rendered inside a same-origin iframe that can reach the config API.
            // 'unsafe-inline' is required by the SPA's own inline script/styles, so
            // this CSP does not stop an injected inline handler — it stops the far
            // worse outcome of loading remote code or exfiltrating to another origin.
            res.writeHead(200, {
              'content-type': 'text/html; charset=utf-8',
              'cache-control': 'no-store',
              'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
              'x-content-type-options': 'nosniff',
              'referrer-policy': 'no-referrer',
            })
            res.end(readDashboardHtml()); return
          }
          if (pathname !== '/codehub/api') { sendJson({ ok: false, error: 'not-found' }, 404); return }

          const op = q.get('op') || 'boot'; const cfg = store.get()
          const writes = ['config.set', 'config.test', 'review.create', 'review.publish', 'review.issues.create', 'issue.develop']
          if (writes.includes(op)) {
            if (req.method !== 'POST') { sendJson({ ok: false, error: 'POST required' }, 405); return }
            const origin = req.headers.origin
            let foreignOrigin = false
            if (origin) { try { foreignOrigin = new URL(origin).host !== req.headers.host } catch { foreignOrigin = true } }
            if (foreignOrigin || req.headers['sec-fetch-site'] === 'cross-site') { sendJson({ ok: false, error: '跨站请求已拒绝' }, 403); return }
            if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) { sendJson({ ok: false, error: 'application/json required' }, 415); return }
          } else if (req.method !== 'GET') { sendJson({ ok: false, error: 'GET required' }, 405); return }
          const payload = async () => {
            let value
            try { value = JSON.parse(await readBody(req) || '{}') } catch { throw apiError('invalid json') }
            if (!value || typeof value !== 'object' || Array.isArray(value)) throw apiError('请求内容必须是对象')
            return value
          }

          if (op === 'boot') {
            const snaps = fetcher.cached(); const overview = snaps.length ? overviewFrom(snaps, cfg) : null
            sendJson({ ok: true, version: PLUGIN_VERSION, config: store.masked(), configPath, capabilities: workflows.capabilities(), summary: overview?.summary ?? null, hasData: !!overview, generatedAt: overview?.generatedAt ?? null }); return
          }
          if (op === 'summary') {
            const snaps = fetcher.cached(); const overview = overviewFrom(snaps, cfg)
            sendJson({ ok: true, summary: overview.summary, generatedAt: overview.generatedAt, cached: snaps.length > 0 }); return
          }
          if (op === 'overview') {
            const snaps = await snapshots(q.get('force') === '1'); const overview = overviewFrom(snaps, cfg)
            sendJson({ ok: true, overview, lastRefreshAt }); return
          }
          if (op === 'mrs') {
            const snaps = await snapshots(); const meLogin = (cfg.me?.login || '').trim(); const all = []
            for (const snap of snaps) for (const mr of snap.mrs ?? []) all.push({ ...decorate(mr, meLogin), repoKey: snap.repoKey, repoPath: snap.repo?.path, repoName: snap.repo?.name })
            const filtered = filterMrs(all, { repoKey: q.get('repoKey') || '', state: q.get('state') || 'all', q: q.get('q') || '', needsReview: q.get('needsReview') === '1', unresolved: q.get('unresolved') === '1', author: q.get('author') || '', sort: q.get('sort') || 'updated', limit: q.get('limit') || 200, ci: q.get('ci') || '' })
            // A failing repo contributes zero rows but is not "no work": report
            // it and mark the sample as limited instead of showing a clean board.
            const errors = snaps.filter(s => s.error || s.issueError).map(s => ({ repoKey: s.repoKey, error: s.error || s.issueError }))
            sendJson({ ok: true, ...filtered, errors, coverage: buildCoverage(snaps) }); return
          }
          if (op === 'mr' || op === 'mr.diff') {
            const detail = await getPullRequest(q.get('repoKey') || '', Number(q.get('number')), { diff: op === 'mr.diff' })
            sendJson({ ok: true, ...detail, mr: decorate(detail.mr, (cfg.me?.login || '').trim()) }); return
          }
          if (op === 'issues') {
            const snaps = await snapshots(), repoKey = q.get('repoKey'), status = q.get('state') || 'all'
            const search = (q.get('q') || '').toLowerCase(), assignee = q.get('assignee')
            let issues = snaps.flatMap(s => (s.issues ?? []).map(i => ({ ...i, repoKey: s.repoKey, repoPath: s.repo.path })))
            issues = issues.filter(i => (!repoKey || i.repoKey === repoKey) && (status === 'all' || i.state === status) && (!assignee || i.assignees.includes(assignee)) && (!search || `${i.number} ${i.title} ${i.author.login} ${i.labels.join(' ')}`.toLowerCase().includes(search)))
            issues.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
            sendJson({ ok: true, issues: issues.slice(0, 500), total: issues.length, errors: snaps.filter(s => s.issueError || s.error).map(s => ({ repoKey: s.repoKey, error: s.issueError || s.error })) }); return
          }
          if (op === 'issue') { sendJson({ ok: true, ...await getIssue(q.get('repoKey') || '', Number(q.get('number'))) }); return }
          if (op === 'models') { sendJson({ ok: true, ...await workflows.models() }); return }
          if (op === 'review.create') { sendJson({ ok: true, draft: await workflows.createReview(await payload()) }); return }
          if (op === 'review.get') { sendJson({ ok: true, draft: await workflows.getReview(q.get('id')) }); return }
          if (op === 'review.latest') { sendJson({ ok: true, draft: await workflows.latestReview(q.get('repoKey'), Number(q.get('number'))) }); return }
          if (op === 'review.publish') { sendJson({ ok: true, ...await workflows.publish(await payload()) }); return }
          if (op === 'review.issues.create') { sendJson({ ok: true, ...await workflows.fileIssues(await payload()) }); return }
          if (op === 'issue.develop') { sendJson({ ok: true, ...await workflows.develop(await payload()) }); return }
          if (op === 'reviews') {
            const loaded = await reviewSnapshots(); const snaps = loaded.snapshots; const meLogin = (cfg.me?.login || '').trim(); let comments = []
            for (const snap of snaps) for (const mr of snap.mrs ?? []) for (const c of mr.comments ?? []) comments.push({ id: c.id, repoKey: snap.repoKey, repoPath: snap.repo?.path, repoName: snap.repo?.name, mrNumber: mr.number, mrTitle: mr.title, mrState: mr.state, mrUrl: mr.url || '', author: c.author, body: c.body, file: c.file, line: c.line, createdAt: c.createdAt, resolved: c.resolved ?? null, needsReply: commentNeedsReply(mr, c, meLogin), kind: c.kind || 'comment' })
            const rk = q.get('repoKey') || ''; if (rk) comments = comments.filter((c) => c.repoKey === rk)
            // 该筛选依赖线程解决状态，当前数据源恒为 null（REST 不返回线程解决状态，未知不冒充 false），
            // 故 unresolved=1 的结果必然为空；前端在 resolutionAvailable!==true 时已禁用该入口。
            if (q.get('unresolved') === '1') comments = comments.filter((c) => c.resolved === false)
            if (q.get('needsReply') === '1') comments = comments.filter((c) => c.needsReply)
            const s = (q.get('q') || '').toLowerCase(); if (s) comments = comments.filter((c) => c.body?.toLowerCase().includes(s) || c.author?.name?.toLowerCase().includes(s) || c.file?.toLowerCase().includes(s) || c.mrTitle?.toLowerCase().includes(s))
            comments.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
            const limit = Math.max(1, Math.min(1000, Number(q.get('limit') || 300)))
            sendJson({ ok: true, comments: comments.slice(0, limit), total: comments.length, errors: loaded.errors, coverage: { limited: true, note: '按仓库详情预算加载评论，线程解决状态未知；此列表不是完整历史。' } }); return
          }
          if (op === 'activity') { const snaps = await snapshots(); const overview = overviewFrom(snaps, cfg); sendJson({ ok: true, activity: overview.activity, recent: overview.recent, topReviewers: overview.topReviewers }); return }
          if (op === 'refresh') { const snaps = await snapshots(true); const overview = overviewFrom(snaps, cfg); sendJson({ ok: true, overview, lastRefreshAt }); return }
          if (op === 'config.get') { sendJson({ ok: true, config: store.masked(), configPath }); return }
          if (op === 'config.set') {
            if (req.method !== 'POST') { sendJson({ ok: false, error: 'POST required' }, 405); return }
            await store.set(await payload()); fetcher.invalidate()
            sendJson({ ok: true, config: store.masked(), overview: null, refreshQueued: true })
            queueRefreshAfterSave(); return
          }
          if (op === 'config.test') {
            if (req.method !== 'POST') { sendJson({ ok: false, error: 'POST required' }, 405); return }
            const results = await testTargets(cfg, fetcher); sendJson({ ok: true, results }); return
          }
          if (op === 'repos.discover') {
            const ws = q.get('ws') || ''; if (!ws) { sendJson({ ok: false, error: 'ws required' }, 400); return }
            const depth = Math.max(1, Math.min(3, Number(q.get('depth') || 2))); const repos = await discoverGitRepos(ws, depth)
            sendJson({ ok: true, repos }); return
          }
          sendJson({ ok: false, error: `unknown op: ${op}` }, 400)
        } catch (err) {
          log?.warn?.('[codehub] api error:', err)
          try { if (!res.headersSent) { res.writeHead(Number.isInteger(err.status) ? err.status : 500, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify({ ok: false, error: clip(err?.message ?? String(err), 300) })) } } catch {}
        }
      },
    })

    const ticker = setInterval(() => {
      const cfg = store.get(); const ttl = Math.max(1, Number(cfg.pollMinutes) || 10) * 60_000
      if (bootPromise && Date.now() - lastRefreshAt > ttl) snapshots(false).catch((err) => log?.warn?.('[codehub] background refresh failed:', err?.message ?? err))
    }, 60_000)
    const warmup = setTimeout(() => { snapshots(false).catch((err) => log?.warn?.('[codehub] initial refresh failed:', err?.message ?? err)) }, 3000)

    return () => { clearInterval(ticker); clearTimeout(warmup); disposeRoute() }
  }, 'codehub-dashboard.routes')
}

/**
 * Test-only surface. The gh field list and the payload→model mapping are the
 * places where a failure is total but silent: one rejected `--json` field makes
 * every repository error out, and the HTTP envelope still reports `ok: true`.
 * Exposing them lets the harness pin the contract without a live gh login.
 */
export const __test = {
  mapGhPr, ghCiState, isSafeRepoPath, isSafeHost, apiBaseFor,
  GH_PR_LIST_FIELDS, GH_PR_VIEW_FIELDS, GH_ISSUE_FIELDS, GH_PR_CI_FIELDS, GH_REPO_FIELDS,
  ghPrListRows, ghRepoView,
  mapGhIssue, parseGhPages, ghEnv, decorate, buildOverview, mergeRepos, run,
  createFetcher, createConfigStore, githubRequest, pullDetail, issueDetail,
}
