import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'
import { __test as data, apply } from '../index.js'

function configStore(t) {
  const dir = mkdtempSync(join(tmpdir(), 'codehub-config-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return data.createConfigStore(join(dir, 'config.json'))
}

test('config rejects malformed entries before normalization', async t => {
  const store = configStore(t)
  for (const field of ['instances', 'repos', 'organizations']) {
    for (const value of [null, 'text', 42, []]) {
      await assert.rejects(store.set({ [field]: [value] }), error => error.status === 400)
    }
  }
})

test('masked credentials cannot migrate when an instance changes host', async t => {
  const store = configStore(t)
  await store.set({ instances: [{ id: 'gh', host: 'github.com', token: 'fixture-secret' }] })
  await assert.rejects(store.set({ instances: [{ id: 'gh', host: 'other.example.com', token: '****cret' }] }), error => error.status === 400)
  assert.equal(store.get().instances[0].host, 'github.com')
  await store.set({ instances: [{ id: 'gh', host: 'other.example.com', token: '' }] })
  assert.equal(store.get().instances[0].token, '')
})

test('Issue mapping keeps assignees, labels and closed lifecycle', () => {
  assert.equal(typeof data.mapGhIssue, 'function')
  const issue = data.mapGhIssue({ number: 8, title: 'Fix search', body: 'Steps', state: 'CLOSED', author: { login: 'lee' }, assignees: [{ login: 'me' }], labels: [{ name: 'bug' }], createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-02T00:00:00Z', comments: [{ id: 'c1', body: 'repro', author: { login: 'lee' } }] })
  assert.equal(issue.state, 'closed')
  assert.deepEqual(issue.assignees, ['me'])
  assert.deepEqual(issue.labels, ['bug'])
  assert.equal(issue.comments[0].body, 'repro')
})

test('gh pagination joins separately encoded page arrays without dropping comments', () => {
  assert.equal(typeof data.parseGhPages, 'function')
  assert.deepEqual(data.parseGhPages('[[{"id":1}],[{"id":2}]]'), [{ id: 1 }, { id: 2 }])
  assert.throws(() => data.parseGhPages('{"message":"forbidden"}'))
})

test('enterprise CLI environment always selects host and isolates inherited credentials', () => {
  const env = data.ghEnv({ instances: [{ id: 'work', host: 'git.example.com', token: 'private' }] }, 'work')
  assert.equal(env.GH_HOST, 'git.example.com')
  assert.equal(env.GH_ENTERPRISE_TOKEN, 'private')
  assert.equal(env.GH_TOKEN, undefined)
  const stored = data.ghEnv({ instances: [{ id: 'work', host: 'git.example.com' }] }, 'work')
  assert.equal(stored.GH_HOST, 'git.example.com')
})

test('unknown comment resolution does not inflate unresolved counts', () => {
  const mr = data.mapGhPr({ number: 1, comments: [{ body: 'discussion' }], reviews: [] })
  assert.equal(mr.comments[0].resolved, null)
  const result = data.decorate({ ...mr, comments: [...mr.comments, { resolved: false, kind: 'inline', author: { login: 'other' } }] }, '')
  assert.equal(result.unresolvedCount, 1)
  assert.equal(result.commentCount, 2)
})

test('overview includes issue counts and explains sampling', () => {
  assert.equal(typeof data.buildOverview, 'function')
  const overview = data.buildOverview([{ repoKey: 'gh:a/b', repo: { path: 'a/b' }, mrs: [], issues: [{ state: 'open', assignees: ['me'] }, { state: 'closed', assignees: [] }], coverage: { limited: true }, source: 'gh' }], { me: { login: 'me' } })
  assert.equal(overview.summary.openIssues, 1)
  assert.equal(overview.summary.closedIssues, 1)
  assert.equal(overview.summary.assignedIssues, 1)
  assert.equal(overview.coverage.limited, true)
  assert.equal(overview.repos[0].counts.openIssues, 1)
})

test('overview summary aggregates per-repository counts exactly once', () => {
  const snap = (repoKey, mrs) => ({ repoKey, repo: { path: repoKey.split(':')[1] }, mrs, issues: [] })
  const mr = (number, state) => ({ number, state, author: { login: 'me' }, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-02T00:00:00Z' })
  const overview = data.buildOverview([
    snap('gh:a/b', [mr(1, 'open'), mr(2, 'merged')]),
    snap('gh:c/d', [mr(3, 'open'), mr(4, 'closed')]),
  ], { me: { login: 'me' } })
  assert.equal(overview.summary.repos, 2)
  assert.equal(overview.summary.openMrs, 2)
  assert.equal(overview.summary.mergedMrs, 1)
  assert.equal(overview.summary.closedMrs, 1)
  assert.equal(overview.repos.reduce((sum, repo) => sum + repo.counts.total, 0), 4)
})

// `unresolvedComments: 0` has two very different meanings: "no thread is
// unresolved" vs "resolution was never fetched" (REST list payloads carry no
// thread state). resolutionAvailable tells the two apart without changing the
// unresolved/needsReply filters, which keep only an explicit `resolved === false`.
//
// An empty comment list is only a fact once the threads were actually fetched;
// comments load on demand (op=reviews / PR detail), so zero comments with no
// detailLoaded MR means "never queried" and must stay unknown rather than be
// reported as a confident zero.
test('overview reports whether comment resolution is knowable', () => {
  const overview = (mrs) => data.buildOverview([{ repoKey: 'gh:a/b', repo: { path: 'a/b' }, mrs, issues: [] }], { me: { login: 'me' } }).summary
  const mr = (comments) => ({ number: 1, state: 'open', author: { login: 'me' }, comments, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-02T00:00:00Z' })

  const unknown = overview([mr([
    { author: { login: 'other' }, createdAt: '2026-10-01T00:00:00Z' },
    { resolved: null, author: { login: 'other' }, createdAt: '2026-10-01T00:00:00Z' },
  ])])
  assert.equal(unknown.resolutionAvailable, false)
  assert.equal(unknown.unresolvedComments, 0)
  assert.equal(unknown.needsReply, 0)
  assert.equal(unknown.unknownResolutionComments, 2)

  const mixed = overview([mr([
    { resolved: true, author: { login: 'other' }, createdAt: '2026-10-01T00:00:00Z' },
    { resolved: null, author: { login: 'other' }, createdAt: '2026-10-01T00:00:00Z' },
    { resolved: false, author: { login: 'other' }, createdAt: '2026-10-01T00:00:00Z' },
  ])])
  assert.equal(mixed.resolutionAvailable, true)
  assert.equal(mixed.unresolvedComments, 1, 'a resolved:true thread must not count as unresolved')
  assert.equal(mixed.needsReply, 1)
  assert.equal(mixed.unknownResolutionComments, 1)

  // An empty list nobody fetched is "no idea", not "nothing there".
  assert.equal(overview([mr([])]).resolutionAvailable, false, 'an unfetched empty thread list is unknown, not a confirmed zero')
  assert.equal(data.buildOverview([], { me: { login: '' } }).summary.resolutionAvailable, false, 'no repositories means nothing was ever queried')

  // Once the detail really was loaded, zero comments is a fact worth trusting.
  assert.equal(overview([{ ...mr([]), detailLoaded: true }]).resolutionAvailable, true, 'a loaded MR with no comments is a confirmed zero')
  assert.equal(overview([{ ...mr([]), detailLoaded: true }]).totalComments, 0)
})

// `detailsLoaded` answers "were the threads fetched?", never "is the thread state
// known?". The two are independent: an MR whose detail was loaded can still hold
// comments that carry no resolution, and those must keep resolutionAvailable
// false. The invariant is easy to lose by rewriting the summary as
// `detailsLoaded || some(...)`, which these cases pin down.
test('loading a detail does not make unknown thread state knowable', () => {
  const snap = (repoKey, mrs) => ({ repoKey, repo: { path: repoKey.split(':')[1] }, mrs, issues: [] })
  const mr = (comments, extra = {}) => ({ number: 1, state: 'open', author: { login: 'me' }, comments, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-02T00:00:00Z', ...extra })
  const summary = (...snaps) => data.buildOverview(snaps, { me: { login: 'me' } }).summary
  const unresolved = { resolved: null, author: { login: 'other' }, createdAt: '2026-10-01T00:00:00Z' }

  // 1. Detail loaded, comments present, none of them carries a state.
  const loaded = summary(snap('gh:a/b', [mr([unresolved], { detailLoaded: true })]))
  assert.equal(loaded.resolutionAvailable, false,
    'a loaded detail with only unresolved:null comments is still unknowable')
  assert.equal(loaded.unknownResolutionComments, 1)
  assert.equal(loaded.unresolvedComments, 0, 'and it still must not be reported as unresolved')

  // 2. Two snapshots: repo A loaded with no comments (a real zero), repo B never
  //    loaded but holding a null comment. allComments is non-empty, so the
  //    loaded-empty branch cannot apply and the answer must stay false.
  const mixedSnaps = summary(
    snap('gh:a/b', [mr([], { detailLoaded: true })]),
    snap('gh:c/d', [mr([{ ...unresolved, author: { login: 'dave' } }])]),
  )
  assert.equal(mixedSnaps.resolutionAvailable, false,
    'one loaded-but-empty repo must not vouch for a repo whose threads were never fetched')
  assert.equal(mixedSnaps.unknownResolutionComments, 1)

  // 3. detailsLoaded is a per-snapshot OR: A loaded-empty alone is a confirmed
  //    zero even when B is listed and was never loaded, as long as B has no
  //    comments to contradict it.
  const loadedElsewhere = summary(
    snap('gh:a/b', [mr([], { detailLoaded: true })]),
    snap('gh:c/d', [mr([])]),
  )
  assert.equal(loadedElsewhere.resolutionAvailable, true,
    'a loaded-empty repo makes an empty board a confirmed zero')
  assert.equal(loadedElsewhere.totalComments, 0)

  // 4. The other direction: nobody loaded a detail, so even an empty board stays
  //    unknown no matter how many repos are listed.
  const nothingLoaded = summary(snap('gh:a/b', [mr([])]), snap('gh:c/d', [mr([])]))
  assert.equal(nothingLoaded.resolutionAvailable, false,
    'listing repos is not the same as having fetched their threads')
  assert.equal(nothingLoaded.totalComments, 0)

  // 5. A definite state anywhere still wins, loaded or not.
  assert.equal(summary(snap('gh:a/b', [mr([unresolved, { resolved: false, author: { login: 'other' }, createdAt: '2026-10-01T00:00:00Z' }])])).resolutionAvailable, true,
    'one explicit resolved:false is enough to make the filter meaningful')
})

test('organization expansion deduplicates by instance and retains disabled explicit overrides', () => {
  assert.equal(typeof data.mergeRepos, 'function')
  const cfg = { repos: [{ instance: 'gh', path: 'a/b', localPath: '/checkout', enabled: true }, { instance: 'gh', path: 'a/c', enabled: false }] }
  const repos = data.mergeRepos(cfg, [{ instance: 'gh', path: 'a/b' }, { instance: 'gh', path: 'a/c' }, { instance: 'gh', path: 'a/d' }])
  assert.deepEqual(repos.map(r => r.path).sort(), ['a/b', 'a/d'])
  assert.equal(repos.find(r => r.path === 'a/b').localPath, '/checkout')
})

// Fixture reproduces the real gh/GraphQL behaviour measured on cli/cli with
// gh 2.102.0: `--state all --limit 200` including statusCheckRollup returns
// HTTP 502/504 (deterministic from ~80 items), the same list without the
// rollup succeeds, and `--state open` with only number+rollup succeeds.
const ghListFixture = (t) => async (exe, args) => {
  const at = (flag) => args[args.indexOf(flag) + 1]
  const state = at('--state')
  const fields = String(at('--json')).split(',')
  const limit = Number(at('--limit'))
  t.calls.push({ state, limit, fields })
  if (fields.includes('statusCheckRollup') && state === 'all' && limit > 70) {
    return { code: 1, stdout: '', stderr: 'HTTP 504: 504 Gateway Timeout (https://api.github.com/graphql)' }
  }
  if (state === 'all') return { code: 0, stdout: JSON.stringify([
    { number: 1, title: 'Merged work', state: 'MERGED', updatedAt: '2026-10-05T00:00:00Z' },
    { number: 2, title: 'Open work', state: 'OPEN', updatedAt: '2026-10-06T00:00:00Z' },
  ]), stderr: '' }
  if (t.failCi) return { code: 1, stdout: '', stderr: 'HTTP 502: 502 Bad Gateway (https://api.github.com/graphql)' }
  return { code: 0, stdout: JSON.stringify([{ number: 2, statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'FAILURE' }] }]), stderr: '' }
}

test('PR list avoids the oversized check-rollup query and keeps CI where it was fetched', async () => {
  assert.equal(typeof data.ghPrListRows, 'function')
  const t = { calls: [] }
  const { rows, ciCoverage } = await data.ghPrListRows(ghListFixture(t), 'gh', {}, 'cli/cli', 200)
  assert.equal(t.calls.filter(c => c.state === 'all').every(c => !c.fields.includes('statusCheckRollup')), true,
    'the all-state list must not request statusCheckRollup for 200 items (GraphQL gateway times out)')
  assert.deepEqual(rows.map(r => r.number), [1, 2])
  assert.equal(rows.find(r => r.number === 2).statusCheckRollup?.[0].conclusion, 'FAILURE')
  assert.equal(ciCoverage, 'open')
  const mapped = rows.map(data.mapGhPr)
  assert.equal(mapped.find(m => m.number === 2).ciState, 'failure')
  assert.equal(mapped.find(m => m.number === 1).ciState, 'unknown', 'merged PRs were never queried for CI')
})

test('CI enrichment failure degrades the list instead of losing it', async () => {
  const t = { calls: [], failCi: true }
  const { rows, ciCoverage } = await data.ghPrListRows(ghListFixture(t), 'gh', {}, 'cli/cli', 200)
  assert.equal(rows.length, 2)
  assert.equal(ciCoverage, 'unavailable')
  assert.equal(rows.map(r => data.mapGhPr(r).ciState).join(), ['unknown', 'unknown'].join())
})

test('a failing PR list still reports the gh error instead of an empty board', async () => {
  const failing = async () => ({ code: 1, stdout: '', stderr: 'HTTP 502: 502 Bad Gateway (https://api.github.com/graphql)' })
  await assert.rejects(data.ghPrListRows(failing, 'gh', {}, 'cli/cli', 200), /502 Bad Gateway/)
})

test('rollup present but empty stays none, absent stays unknown', () => {
  assert.equal(data.mapGhPr({ number: 1, statusCheckRollup: [] }).ciState, 'none')
  assert.equal(data.mapGhPr({ number: 1 }).ciState, 'unknown')
  assert.equal(data.mapGhPr({ number: 1, statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }] }).ciState, 'success')
})

// Fixture for `gh repo view <path> --json defaultBranchRef,name,description`
// measured against gh 2.102.0: cli/cli → {"defaultBranchRef":{"name":"trunk"}},
// an unknown repo → non-zero exit with a GraphQL error on stderr.
test('repo view supplies the real default branch instead of a PR base guess', async () => {
  assert.equal(typeof data.ghRepoView, 'function')
  const runner = async (exe, args) => {
    assert.deepEqual(args.slice(0, 2), ['repo', 'view'], 'repo metadata must come from `gh repo view <path>`')
    return { code: 0, stdout: JSON.stringify({ defaultBranchRef: { name: 'trunk' }, description: 'GitHub’s official command line tool', name: 'cli' }), stderr: '' }
  }
  const meta = await data.ghRepoView({ path: 'cli/cli' }, runner, 'gh', {})
  assert.equal(meta.defaultBranch, 'trunk')
  assert.equal(meta.description, 'GitHub’s official command line tool')
  const configured = await data.ghRepoView({ path: 'cli/cli', defaultBranch: 'release' }, runner, 'gh', {})
  assert.equal(configured.defaultBranch, 'release', 'a discovered/override value must win')
})

test('a failing repo view degrades to unknown instead of failing the snapshot', async () => {
  const failing = async () => ({ code: 1, stdout: '', stderr: 'GraphQL: Could not resolve to a Repository with the name (repository)' })
  const meta = await data.ghRepoView({ path: 'o/r' }, failing, 'gh', {})
  assert.equal(meta.defaultBranch, '')
  assert.equal(meta.description, 'GitHub 仓库 o/r')
  const garbage = async () => ({ code: 0, stdout: 'not json', stderr: '' })
  assert.equal((await data.ghRepoView({ path: 'o/r' }, garbage, 'gh', {})).defaultBranch, '')
})

test('CLI runner passes review bodies on stdin without command interpretation', async () => {
  assert.equal(typeof data.run, 'function')
  const input = 'quotes " and $(not-a-command)\n正文'
  const result = await data.run(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], { input })
  assert.equal(result.code, 0)
  assert.equal(result.stdout, input)
})

const httpConfig = { provider: 'http', pollMinutes: 10, me: { login: 'me' }, instances: [{ id: 'gh', host: 'github.com', token: 'fixture' }], repos: [{ instance: 'gh', path: 'org/repo' }], http: { perPage: 100, timeoutMs: 1000, detailLimit: 2 } }
const httpRepo = { key: 'gh:org/repo', instanceId: 'gh', path: 'org/repo', localPath: '' }

test('REST provider never claims a CI verdict it did not fetch', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify([{ number: 4, state: 'open', title: 'x', user: { login: 'a' } }])))
  const fetcher = data.createFetcher({ rev: 0, get: () => httpConfig }, { warn() {} })
  const [snapshot] = await fetcher.refreshAll(false)
  assert.equal(snapshot.mrs[0].ciState, 'unknown')
})

test('paginated GitHub reads preserve all pages and reject redirects', async t => {
  const calls = []
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push([url, options])
    return new Response(JSON.stringify([{ id: calls.length }]), { headers: calls.length === 1 ? { link: '<https://api.github.com/next>; rel="next"' } : {} })
  })
  const items = await data.githubRequest(httpRepo, httpConfig, 'orgs/org/repos', { paginate: true })
  assert.deepEqual(items, [{ id: 1 }, { id: 2 }])
  assert.equal(calls[1][0], 'https://api.github.com/orgs/org/repos?per_page=100&page=2')
  assert.equal(calls[0][1].redirect, 'error')
})

test('failed refresh retains previously fetched Issue-only repositories', async t => {
  let failed = false
  t.mock.method(globalThis, 'fetch', async url => {
    if (failed) return new Response('unavailable', { status: 503 })
    return new Response(JSON.stringify(url.includes('/issues?') ? [{ number: 3, title: 'Issue', state: 'open', assignees: [], labels: [] }] : []))
  })
  const store = { rev: 0, get: () => httpConfig }
  const fetcher = data.createFetcher(store, { warn() {} })
  const first = await fetcher.refreshAll(false)
  assert.equal(first[0].issues.length, 1)
  failed = true
  const second = await fetcher.refreshAll(true)
  assert.equal(second[0].issues.length, 1)
  assert.equal(second[0].stale, true)
  assert.match(second[0].error, /503/)
})

test('REST detail enrichment preserves known list CI and review decisions', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response('[]'))
  const store = { rev: 0, get: () => httpConfig }
  const fetcher = data.createFetcher(store, { warn() {} })
  const [snapshot] = await fetcher.refreshAll(false)
  snapshot.mrs.push(data.mapGhPr({ number: 7, title: 'Fix', state: 'OPEN', reviewDecision: 'APPROVED', statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'FAILURE' }] }))
  fetcher.rememberDetail(httpRepo.key, { number: 7, body: 'Detail', ciState: 'none', reviewDecision: 'none', comments: [], reviews: [] }, store.rev)
  const mr = fetcher.cached()[0].mrs[0]
  assert.equal(mr.ciState, 'failure')
  assert.equal(mr.reviewDecision, 'approved')
  assert.equal(mr.body, 'Detail')
  assert.equal(mr.detailLoaded, true)
})

test('PR diff rejects head changes during download', async t => {
  let reads = 0
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (options.headers.accept === 'application/vnd.github.diff') return new Response('diff --git a/a b/a\n+safe')
    if (/\/pulls\/7$/.test(url)) return new Response(JSON.stringify({ number: 7, state: 'open', head: { sha: ++reads === 1 ? 'aaa' : 'bbb' }, base: { sha: 'base' } }))
    return new Response('[]')
  })
  await assert.rejects(data.pullDetail(httpRepo, httpConfig, 7, { diff: true }), err => err.status === 409)
})

/* ===================== ghAvailable failure-state cache (P1-2) ===================== */

// `ghAvailable` used to cache only the SUCCESS branch: `ghOkCache.ok === false`
// fell through to a fresh `gh --version` + `gh auth status` spawn on every
// refresh, so an unauthenticated host paid two process spawns per poll. The fix
// caches both branches with an asymmetric TTL (success 300s, failure 60s).
//
// The probe is a real child process, so counting it needs a real executable.
// `process.execPath` is one, and NODE_OPTIONS makes every spawned node run the
// shim, which appends one line per invocation. `ghProbe` runs two spawns per
// probe (`--version`, then `auth status`), so probe rounds = lines / 2.
const probeCounter = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'codehub-ghprobe-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const log = join(dir, 'probes.log')
  const shim = join(dir, 'shim.mjs')
  writeFileSync(shim, [
    "import { appendFileSync } from 'node:fs'",
    `appendFileSync(${JSON.stringify(log.replaceAll('\\', '/'))}, 'probe\\n')`,
    '',
  ].join('\n'))
  const previous = process.env.NODE_OPTIONS
  process.env.NODE_OPTIONS = `${previous ? `${previous} ` : ''}--import=${pathToFileURL(shim).href}`
  t.after(() => { if (previous === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = previous })
  return {
    // spawn is only counted for a real, runnable executable. The "unavailable"
    // path below is a missing file: `gh --version` fails before node loads
    // NODE_OPTIONS, so that probe leaves no line here. Use this counter to
    // prove *successful* probes did or did not happen, and use the
    // config-swap idiom (see the TTL test) for the failing branch.
    rounds: () => { try { return readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).length } catch { return 0 } },
    // A path that cannot be spawned: `--version` fails, so the probe reports
    // ok:false without ever reaching the shim.
    unavailable: join(dir, 'gh-not-installed.exe'),
    available: process.execPath,
  }
}
const ghCfg = (ghPath) => ({ provider: 'auto', ghPath, instances: [], repos: [], me: { login: 'me' }, pollMinutes: 10 })

// Freeze Date.now so the TTL boundaries are exercised without sleeping for a
// minute. The cache stores its own timestamps, so a monotonic offset is enough.
const withFakeClock = (t) => {
  const real = Date.now
  let skew = 0
  Date.now = () => real() + skew
  t.after(() => { Date.now = real })
  return { advance: (ms) => { skew += ms } }
}

test('an unavailable gh is cached instead of re-probed on every refresh', async t => {
  const counter = probeCounter(t)
  const cfg = ghCfg(counter.unavailable)
  const fetcher = data.createFetcher({ rev: 1, get: () => cfg }, { warn() {} })

  assert.equal(await fetcher.ghAvailable(cfg), false)
  // Swapping in an executable that WOULD succeed must not change the answer:
  // the cached failure still owns the window, so nothing spawns.
  assert.equal(await fetcher.ghAvailable(ghCfg(counter.available)), false,
    'a not-ok probe must stay cached, not fall through to a new spawn')
  assert.equal(counter.rounds(), 0, 'the failing probe never reached the shim (missing executable)')

  // invalidate() is the documented escape hatch and must force a fresh probe.
  fetcher.invalidate()
  assert.equal(await fetcher.ghAvailable(ghCfg(counter.available)), true)
  assert.equal(counter.rounds(), 1, 'invalidate() must force exactly one new probe')
})

test('the failure and success gh caches expire on different TTLs', async t => {
  const counter = probeCounter(t)
  const clock = withFakeClock(t)

  // Failure branch: cached for 60s.
  const failing = data.createFetcher({ rev: 1, get: () => ghCfg(counter.unavailable) }, { warn() {} })
  assert.equal(await failing.ghAvailable(ghCfg(counter.unavailable)), false)
  clock.advance(30_000)
  assert.equal(await failing.ghAvailable(ghCfg(counter.available)), false,
    'inside the 60s failure window the cached false must win')
  assert.equal(counter.rounds(), 0)
  clock.advance(31_000)
  assert.equal(await failing.ghAvailable(ghCfg(counter.available)), true,
    'past the 60s failure window the probe must run again')
  assert.equal(counter.rounds(), 1)

  // Success branch: cached for 300s. A 61s-old success must survive where a
  // 61s-old failure had already expired -- that asymmetry is the whole point.
  const healthy = data.createFetcher({ rev: 1, get: () => ghCfg(counter.available) }, { warn() {} })
  assert.equal(await healthy.ghAvailable(ghCfg(counter.available)), true)
  const roundsAfterSuccess = counter.rounds()
  clock.advance(61_000)
  assert.equal(await healthy.ghAvailable(ghCfg(counter.unavailable)), true,
    'inside the 300s success window the cached true must win')
  assert.equal(counter.rounds(), roundsAfterSuccess, 'no spawn while the success cache is warm')

  // At 301s the success cache is stale, so the probe must run again. Prove it
  // by handing the fetcher a *runnable* executable: a cache that is still warm
  // would keep answering from memory and never look at the new ghPath.
  clock.advance(240_000)
  assert.equal(await healthy.ghAvailable(ghCfg(counter.available)), true,
    'past the 300s success window the probe must run again')
  assert.equal(counter.rounds(), roundsAfterSuccess + 1,
    'a stale success cache must not suppress the next probe')
})

test('an http provider never pays for a gh probe', async () => {
  const cfg = { ...ghCfg('gh'), provider: 'http' }
  const fetcher = data.createFetcher({ rev: 1, get: () => cfg }, { warn() {} })
  assert.equal(await fetcher.ghAvailable(cfg), false)
  // Repeat calls must stay free: this branch returns before the cache is even
  // consulted, so it can never be the reason a refresh spawns gh.
  assert.equal(await fetcher.ghAvailable(cfg), false)
})

/* ===================== config.set refresh is queued, not forced (P1-3) ===================== */

// Saving the config used to run `snapshots(true)` inline: a forced full refresh
// that bypasses the poll TTL, so N quick saves meant N full pulls. It is now a
// single-flight, NON-forced refresh issued after the response.
const routeHarness = async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'codehub-route-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const routes = []
  const cleanups = []
  const ctx = {
    connection: { admit: () => ({ peer: {} }) },
    logger: { warn: () => {} },
    webServer: { register: (route) => { routes.push(route); return () => {} } },
    // apply() arms a 60s poll ticker and a 3s warmup timer; failing to run the
    // effect cleanup leaves them armed and hangs the whole test run.
    effect: (fn) => { cleanups.push(fn()) },
  }
  apply(ctx, { configPath: join(dir, 'config.json') })
  t.after(() => { for (const cleanup of cleanups.splice(0)) { try { cleanup?.() } catch {} } })
  const server = createServer((req, res) => routes[0].handler(req, res).catch((err) => { res.writeHead(500); res.end(String(err)) }))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { server.closeAllConnections?.(); server.close() })
  const base = `http://127.0.0.1:${server.address().port}`
  return {
    dir,
    // The original global, so tests can mock the plugin's own GitHub calls
    // without intercepting the harness's requests to its own server.
    rawFetch: fetch,
    get: (path) => fetch(`${base}${path}`).then((r) => r.json()),
    post: (op, body) => fetch(`${base}/codehub/api?op=${op}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json()),
  }
}
const routeConfig = (extra = {}) => ({
  provider: 'http', pollMinutes: 10, me: { login: 'me' },
  instances: [{ id: 'gh', host: 'github.com', token: 'fixture' }],
  repos: [{ instance: 'gh', path: 'org/repo' }],
  http: { perPage: 100, timeoutMs: 5000, detailLimit: 2 }, ...extra,
})

test('config.set answers before the queued refresh finishes', async t => {
  const harness = await routeHarness(t)
  const slow = 400
  let pulls = 0
  // Only the plugin's outbound GitHub calls are mocked; the harness's own
  // requests to its local server go through the original fetch.
  const realFetch = harness.rawFetch
  globalThis.fetch = async (url, options) => {
    if (String(url).startsWith('http://127.0.0.1:')) return realFetch(url, options)
    pulls++
    await new Promise((r) => setTimeout(r, slow))
    return Response.json([])
  }
  t.after(() => { globalThis.fetch = realFetch })

  const started = Date.now()
  const saved = await harness.post('config.set', routeConfig())
  const elapsed = Date.now() - started
  assert.equal(saved.ok, true)
  assert.equal(saved.overview, null, 'the response keeps overview:null so the UI retains its old value')
  assert.equal(saved.refreshQueued, true)
  assert.ok(elapsed < slow, `saving must not wait for the refresh (took ${elapsed}ms against a ${slow}ms backend)`)

  // The refresh really was queued: it lands after the response.
  await new Promise((r) => setTimeout(r, slow * 3))
  assert.ok(pulls > 0, 'the queued refresh must actually reach the backend')
})

test('concurrent config saves collapse into one queued refresh', async t => {
  const harness = await routeHarness(t)
  let listPulls = 0
  let blocked = null
  const realFetch = harness.rawFetch
  globalThis.fetch = async (url, options) => {
    if (String(url).startsWith('http://127.0.0.1:')) return realFetch(url, options)
    if (!String(url).includes('/issues')) listPulls++
    if (blocked) await blocked
    else await new Promise((r) => setTimeout(r, 100))
    return Response.json([])
  }
  t.after(() => { globalThis.fetch = realFetch })

  // Baseline: one save costs one repository-list pull.
  await harness.post('config.set', routeConfig())
  await new Promise((r) => setTimeout(r, 500))
  const single = listPulls
  assert.equal(single, 1, 'one save performs exactly one repository-list pull')

  // Hold the queued refresh open so all four saves are known to have reached
  // the single-flight helper before it can settle. A wall-clock window made
  // this flaky under CI load: a slow handler could land after the refresh
  // finished and legitimately queue a second one (node 20 saw 2 pulls).
  let release
  blocked = new Promise((resolve) => { release = resolve })
  const saves = await Promise.all([1, 2, 3, 4].map(() => harness.post('config.set', routeConfig())))
  assert.ok(saves.every((saved) => saved.ok), 'all four saves answer without waiting for the refresh')
  release()
  blocked = null
  await new Promise((r) => setTimeout(r, 500))
  assert.equal(listPulls - single, 1, 'four concurrent saves queue one refresh, not four')
})

/* ===================== unknown resolution != unresolved (P1-1) ===================== */

test('an unknown thread state never counts as unresolved at any level', () => {
  const mr = data.mapGhPr({ number: 1, comments: [{ body: 'only a guess at state' }], reviews: [] })
  assert.equal(mr.comments[0].resolved, null, 'REST list payloads carry no thread state')

  // PR level: decorate() must not promote an unknown thread to unresolved.
  const decorated = data.decorate(mr, '')
  assert.equal(decorated.unresolvedCount, 0, 'resolved:null is unknown, not unresolved')
  assert.equal(decorated.commentCount, 1)

  // Overview level: the same guard, plus the flag that tells the UI it is unknown.
  const summary = data.buildOverview([{ repoKey: 'gh:a/b', repo: { path: 'a/b' }, mrs: [mr], issues: [] }], { me: { login: 'me' } }).summary
  assert.equal(summary.resolutionAvailable, false)
  assert.equal(summary.unresolvedComments, 0, 'an unknown thread must not inflate unresolvedComments')
  assert.equal(summary.unknownResolutionComments, 1, 'it is reported separately as unknown instead')
  assert.equal(summary.totalComments, 1)

  // And the moment real state arrives, the same comment can legitimately count.
  // It cannot be simulated through mapGhPr() — index.js:384 and :545 hardcode
  // `resolved: null` for REST-list comments, which is exactly the fix under
  // test. So build the known-state comment the way the payload would look.
  const known = data.mapGhPr({ number: 1, comments: [{ body: 'x' }], reviews: [] })
  known.comments = known.comments.map((c) => ({ ...c, body: 'x', resolved: false }))
  const knownSummary = data.buildOverview([{ repoKey: 'gh:a/b', repo: { path: 'a/b' }, mrs: [known], issues: [] }], { me: { login: 'me' } }).summary
  assert.equal(knownSummary.resolutionAvailable, true)
  assert.equal(knownSummary.unresolvedComments, 1, 'an explicit resolved:false still counts')
  assert.equal(knownSummary.unknownResolutionComments, 0)
})

test('the reviews unresolved filter stays empty while resolution is unknowable', async t => {
  // `/codehub/reviews?unresolved=1` filters on `resolved === false`, which a
  // REST-sourced list can never satisfy. The endpoint must keep reporting an
  // honest empty total (0) rather than inventing "unresolved" rows, and must not
  // change the `total` contract once real state exists.
  const harness = await routeHarness(t)
  const realFetch = harness.rawFetch
  const pullBody = {
    number: 7, state: 'open', title: 'Fix', user: { login: 'other' },
    created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-02T00:00:00Z',
    head: { ref: 'feature', sha: 'abc' }, base: { ref: 'trunk' },
  }
  globalThis.fetch = async (url, options) => {
    if (String(url).startsWith('http://127.0.0.1:')) return realFetch(url, options)
    const href = String(url)
    if (/\/pulls\/7\/comments/.test(href)) return Response.json([{ id: 1, body: 'discussion', user: { login: 'other' }, created_at: '2026-10-01T00:00:00Z' }])
    if (/\/pulls\/7\/reviews/.test(href)) return Response.json([])
    if (/\/pulls\/7$/.test(href)) return Response.json(pullBody)
    if (/\/pulls\?/.test(href)) return Response.json([pullBody])
    if (/\/issues\?/.test(href)) return Response.json([])
    return Response.json([])
  }
  t.after(() => { globalThis.fetch = realFetch })

  await harness.post('config.set', routeConfig())
  await new Promise((r) => setTimeout(r, 600))

  const filtered = await harness.get('/codehub/api?op=reviews&unresolved=1')
  assert.equal(filtered.ok, true)
  assert.deepEqual(filtered.comments, [], 'no thread is known unresolved, so the filter yields nothing')
  assert.equal(filtered.total, 0, 'total reflects the filtered count and must not invent unknowns')
  assert.equal(filtered.coverage.note.includes('线程解决状态未知'), true, 'the payload still discloses the unknown state')

  const all = await harness.get('/codehub/api?op=reviews')
  assert.equal(all.ok, true)
  assert.ok(all.total >= 1, 'the unfiltered list still returns the comment')
  assert.equal(all.comments.every((c) => c.resolved === null), true,
    'REST-sourced comments keep resolved:null rather than being coerced to false')
})

