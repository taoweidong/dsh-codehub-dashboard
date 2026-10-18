#!/usr/bin/env node
// Standalone test harness for dsh-codehub-dashboard host half.
// Creates a fake cordis ctx with a real node:http server, imports apply(),
// and probes every API endpoint. Exits non-zero on any failure.

import { createServer, request } from 'node:http'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

// Package root, so manifest assertions read the same files npm publishes.
const pluginDir = dirname(dirname(fileURLToPath(import.meta.url)))

const tmpDir = mkdtempSync(join(tmpdir(), 'codehub-test-'))
const configPath = join(tmpDir, 'config.json')

// Create a minimal git repo for testing git enrichment + repos.discover
const testRepoDir = join(tmpDir, 'test-repo')
mkdirSync(testRepoDir)
execFileSync('git', ['init', '-b', 'main'], { cwd: testRepoDir, stdio: 'ignore' })
execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: testRepoDir, stdio: 'ignore' })
execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: testRepoDir, stdio: 'ignore' })
writeFileSync(join(testRepoDir, 'README.md'), '# Test\n')
execFileSync('git', ['add', '.'], { cwd: testRepoDir, stdio: 'ignore' })
execFileSync('git', ['commit', '-m', 'initial commit'], { cwd: testRepoDir, stdio: 'ignore' })

let passed = 0, failed = 0
function assert(name, cond, detail) {
  if (cond) { console.log(`  ✅ ${name}`); passed++ }
  else { console.error(`  ❌ ${name}: ${detail || 'assertion failed'}`); failed++ }
}

async function main() {
  // Build fake ctx
  const routes = []
  const effects = []
  const ctx = {
    connection: { admit() { return { peer: {} } } },
    logger: { warn: (...a) => console.log('[warn]', ...a) },
    webServer: {
      register(route) { routes.push(route); return () => {} },
    },
    effect(fn, label) {
      const cleanup = fn()
      effects.push({ label, cleanup })
    },
  }

  // Import and apply
  const mod = await import('../index.js')
  assert('exports name', mod.name === 'dsh-codehub-dashboard', `got ${mod.name}`)
  // cordis contract: inject must be a FLAT required-service array. An object
  // form is parsed as service names "required"/"optional" and the plugin never
  // activates in the real host (this shipped once — the host boot log said
  // "codehub-dashboard: pending (waiting for services: required, optional)").
  assert('exports inject is a flat service array', Array.isArray(mod.inject), `got ${JSON.stringify(mod.inject)}`)
  assert('exports inject requires webServer', mod.inject.includes('webServer'), `got ${JSON.stringify(mod.inject)}`)
  assert('exports inject requires connection', mod.inject.includes('connection'), `got ${JSON.stringify(mod.inject)}`)
  assert('exports apply', typeof mod.apply === 'function')

  mod.apply(ctx, { configPath })
  assert('route registered', routes.length === 1 && routes[0].kind === 'prefix' && routes[0].path === '/codehub')

  // Start a real HTTP server using the registered handler
  const handler = routes[0].handler
  const server = createServer((req, res) => handler(req, res).catch((e) => { res.writeHead(500); res.end(String(e)) }))
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const base = `http://127.0.0.1:${port}`

  async function get(path) {
    const r = await fetch(`${base}${path}`, { headers: { accept: 'application/json' } })
    return { status: r.status, data: await r.json() }
  }
  async function post(path, body) {
    const r = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    return { status: r.status, data: await r.json() }
  }

  // --- boot ---
  console.log('\n📡 Testing /codehub/api endpoints...')
  const boot = await get('/codehub/api?op=boot')
  assert('boot ok', boot.data.ok === true)
  // Read the manifest instead of hardcoding, so a version bump cannot silently
  // leave this assertion behind (the same fact is asserted again at the end).
  const manifestVersion = JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8')).version
  assert('boot version', boot.data.version === manifestVersion, `${boot.data.version} vs ${manifestVersion}`)
  assert('boot has config', !!boot.data.config)
  assert('boot config masked', !boot.data.config.instances?.some?.((i) => i.token && !i.token.startsWith('****')))

  // --- config.set ---
  const setRes = await post('/codehub/api?op=config.set', {
    provider: 'git', me: { name: 'Test', login: 'testuser' }, pollMinutes: 5,
    ghPath: 'gh', instances: [{ id: 'gh', name: 'GitHub', host: 'github.com', token: 'ghp_test1234abcd' }],
    repos: [{ id: 'r1', instance: 'gh', path: 'cli/cli', enabled: true }],
  })
  assert('config.set ok', setRes.data.ok === true)
  assert('config.set masked token', setRes.data.config.instances[0].token === '****abcd')
  assert('config.set queues refresh without waiting', setRes.data.overview === null && setRes.data.refreshQueued === true)

  // --- config.get ---
  const cfgGet = await get('/codehub/api?op=config.get')
  assert('config.get ok', cfgGet.data.ok === true)
  assert('config.get masked', cfgGet.data.config.instances[0].token === '****abcd')

  // --- summary (cached, may be empty since gh isn't authenticated) ---
  const summary = await get('/codehub/api?op=summary')
  assert('summary ok', summary.data.ok === true)
  assert('summary has summary obj', !!summary.data.summary)

  // --- overview ---
  const overview = await get('/codehub/api?op=overview')
  assert('overview ok', overview.data.ok === true)
  assert('overview has repos array', Array.isArray(overview.data.overview?.repos))

  // --- mrs ---
  const mrs = await get('/codehub/api?op=mrs&state=all')
  assert('mrs ok', mrs.data.ok === true)
  assert('mrs has mrs array', Array.isArray(mrs.data.mrs))

  // --- reviews ---
  const reviews = await get('/codehub/api?op=reviews')
  assert('reviews ok', reviews.data.ok === true)
  assert('reviews has comments array', Array.isArray(reviews.data.comments))

  // --- activity ---
  const activity = await get('/codehub/api?op=activity')
  assert('activity ok', activity.data.ok === true)
  assert('activity has activity array', Array.isArray(activity.data.activity))

  // --- refresh ---
  const refresh = await get('/codehub/api?op=refresh')
  assert('refresh ok', refresh.data.ok === true)

  // --- config.test ---
  const test = await post('/codehub/api?op=config.test', {})
  assert('config.test ok', test.data.ok === true)
  assert('config.test has results', Array.isArray(test.data.results))
  assert('config.test includes git', test.data.results.some((r) => r.kind === 'cli'))
  assert('config.test includes gh', test.data.results.some((r) => r.kind === 'gh-cli'))

  // --- repos.discover ---
  const discover = await get(`/codehub/api?op=repos.discover&ws=${encodeURIComponent(tmpDir)}&depth=1`)
  assert('repos.discover ok', discover.data.ok === true)
  assert('repos.discover found test repo', discover.data.repos.some((r) => r.path === testRepoDir))

  // --- provider normalization (legacy UI value "git-meta" must map to "git") ---
  const normRes = await post('/codehub/api?op=config.set', {
    provider: 'git-meta', me: { name: 'Test', login: 'testuser' }, pollMinutes: 5,
    ghPath: 'gh', instances: [{ id: 'gh', name: 'GitHub', host: 'github.com', token: 'ghp_test1234abcd' }],
    repos: [{ id: 'r1', instance: 'gh', path: 'cli/cli', enabled: true }],
  })
  assert('config.set normalizes git-meta -> git', normRes.data.config.provider === 'git', `got ${normRes.data.config.provider}`)

  // --- mrs with ci filter (server-side filtering regression) ---
  const mrsCi = await get('/codehub/api?op=mrs&state=all&ci=failure')
  assert('mrs ci filter ok', mrsCi.data.ok === true)
  assert('mrs ci filter has mrs array', Array.isArray(mrsCi.data.mrs))

  // --- overview health: every repo must self-report a source, and a failure
  //     must be visible as an error string (never a silent empty board) ---
  const ovRes = await get('/codehub/api?op=overview')
  const ovRepos = ovRes.data.overview?.repos ?? []
  assert('overview repos all carry a source', ovRepos.length === 0 || ovRepos.every((r) => !!r.source), JSON.stringify(ovRepos.map((r) => r.source)))
  assert('overview repo failures are surfaced', ovRepos.every((r) => typeof r.error === 'string' || r.error === null), 'error field must be string-or-null')

  // --- gh --json field contract (validated locally by gh, before any request) ---
  // A rejected field name fails *every* repository while the HTTP envelope still
  // reports ok:true, which is exactly how the nested-selection bug shipped.
  const t = mod.__test ?? {}
  let ghAvailable = true
  try { execFileSync('gh', ['--version'], { stdio: 'ignore' }) } catch { ghAvailable = false }
  if (!ghAvailable) console.log('  ⏭  gh not installed — skipping field-contract and mapping checks')
  if (ghAvailable) {
    for (const [label, args, fields] of [
      ['pr list', ['pr', 'list', '--repo', 'cli/cli'], t.GH_PR_LIST_FIELDS],
      ['pr list ci', ['pr', 'list', '--repo', 'cli/cli'], t.GH_PR_CI_FIELDS],
      ['pr view', ['pr', 'view', '1', '--repo', 'cli/cli'], t.GH_PR_VIEW_FIELDS],
      ['issue list', ['issue', 'list', '--repo', 'cli/cli'], t.GH_ISSUE_FIELDS],
      // `repo view` takes the repository positionally; `--repo` there means too many args.
      ['repo view', ['repo', 'view', 'cli/cli'], t.GH_REPO_FIELDS],
    ]) {
      let output = ''
      try {
        execFileSync('gh', [...args, '--json', '__invalid_field_probe__'], {
          env: { ...process.env, GH_TOKEN: 'offline-contract-probe' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000,
        })
      } catch (error) { output = `${error.stderr ?? ''}${error.stdout ?? ''}` }
      const supported = new Set(output.split(/\r?\n/).map(line => line.trim()))
      assert(`gh accepts our ${label} field list`, /unknown json field/i.test(output) && fields.split(',').every(field => supported.has(field)), output)
    }
    // Flat-field payloads are what gh actually returns; mapping must not need `{}` selectors.
    assert('no nested selectors left in field lists', !/[{}]/.test(`${t.GH_PR_LIST_FIELDS},${t.GH_PR_CI_FIELDS},${t.GH_PR_VIEW_FIELDS}`))
    // The 502/504 root cause: the rollup must never ride along on the 200-item all-state list.
    assert('all-state list fields exclude statusCheckRollup', !t.GH_PR_LIST_FIELDS.split(',').includes('statusCheckRollup'), t.GH_PR_LIST_FIELDS)
    assert('CI fields stay a bounded number+rollup query', t.GH_PR_CI_FIELDS === 'number,statusCheckRollup', t.GH_PR_CI_FIELDS)

    if (typeof t.mapGhPr === 'function') {
      const sample = {
        number: 12, title: 'Add feature', state: 'OPEN', isDraft: false,
        headRefName: 'feat', baseRefName: 'main', additions: 10, deletions: 2, changedFiles: 3,
        createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-02T00:00:00Z', mergedAt: null,
        reviewDecision: 'APPROVED', url: 'https://github.com/cli/cli/pull/12',
        author: { login: 'alice' }, labels: [{ name: 'bug' }], reviewRequests: [{ login: 'me' }],
        latestReviews: [{ author: { login: 'bob' }, state: 'APPROVED', submittedAt: '2026-10-02T00:00:00Z', body: 'lgtm' }],
        statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'FAILURE' }],
      }
      const m = t.mapGhPr(sample)
      assert('mapGhPr reads flat author object', m.author.login === 'alice', JSON.stringify(m.author))
      assert('mapGhPr reads flat labels', m.labels.join() === 'bug', JSON.stringify(m.labels))
      assert('mapGhPr reads flat reviewRequests', m.requestedReviewers.join() === 'me', JSON.stringify(m.requestedReviewers))
      assert('mapGhPr reads flat latestReviews', m.reviews.length === 1 && m.reviews[0].state === 'approved', JSON.stringify(m.reviews))
      assert('mapGhPr uppercases state to model vocab', m.state === 'open' && m.reviewDecision === 'approved', `${m.state}/${m.reviewDecision}`)
      assert('mapGhPr derives ciState from the list rollup', m.ciState === 'failure', m.ciState)

      const merged = t.mapGhPr({ ...sample, number: 13, state: 'MERGED', mergedAt: '2026-10-03T00:00:00Z', statusCheckRollup: [] })
      assert('mapGhPr maps MERGED to merged', merged.state === 'merged', merged.state)
      assert('mapGhPr empty rollup stays none', merged.ciState === 'none', merged.ciState)
      assert('mapGhPr absent rollup is unknown, not none', t.mapGhPr({ number: 15, state: 'OPEN' }).ciState === 'unknown')
    }
    if (typeof t.ghCiState === 'function') {
      assert('ghCiState handles object-shaped rollup', t.ghCiState({ state: 'SUCCESS' }) === 'success')
      assert('ghCiState: failure beats success', t.ghCiState([{ conclusion: 'SUCCESS', status: 'COMPLETED' }, { conclusion: 'FAILURE', status: 'COMPLETED' }]) === 'failure')
      assert('ghCiState: unfinished stays pending', t.ghCiState([{ status: 'IN_PROGRESS' }]) === 'pending')
      assert('ghCiState: null/empty stays none', t.ghCiState(null) === 'none' && t.ghCiState([]) === 'none')
    }
  }

  // --- config validation: unsafe repo paths / hosts must be rejected ---
  if (typeof t.isSafeRepoPath === 'function') {
    assert('repo path owner/name accepted', t.isSafeRepoPath('cli/cli') === true)
    assert('repo path with dot-segment rejected', t.isSafeRepoPath('cli/../../etc') === false)
    assert('repo path starting with dash rejected', t.isSafeRepoPath('-foo/bar') === false && t.isSafeRepoPath('owner/-x') === false)
    assert('repo path with space rejected', t.isSafeRepoPath('a b/c') === false)
  }
  if (typeof t.isSafeHost === 'function') {
    assert('host example.com accepted', t.isSafeHost('example.com') === true)
    assert('host with scheme rejected', t.isSafeHost('https://evil.example') === false)
    assert('host with credentials rejected', t.isSafeHost('good.example@evil.example') === false)
    assert('host with port rejected', t.isSafeHost('example.com:8443') === false)
  }
  if (typeof t.apiBaseFor === 'function') {
    assert('github.com maps to api.github.com', t.apiBaseFor('github.com') === 'https://api.github.com')
    assert('bad host yields null', t.apiBaseFor('evil.example/redirect') === null)
  }

  // --- token masking must never echo a plaintext secret ---
  const masked = await post('/codehub/api?op=config.set', {
    provider: 'git', instances: [{ id: 'gh', name: 'GitHub', host: 'github.com', token: 'ghp_topsecret9999' }],
    repos: [{ id: 'r1', instance: 'gh', path: 'cli/cli', enabled: true }],
  })
  assert('config.set masks new token', masked.data.config.instances[0].token === '****9999', masked.data.config.instances[0].token)
  const maskedKeep = await post('/codehub/api?op=config.set', {
    instances: [{ id: 'gh', name: 'GitHub', host: 'github.com', token: '****9999' }],
  })
  assert('masked token round-trip keeps the real secret', maskedKeep.data.config.instances[0].token === '****9999')
  try {
    const cfgOnDisk = JSON.parse(readFileSync(configPath, 'utf8'))
    assert('disk keeps the plaintext token (not the mask)', cfgOnDisk.instances[0].token === 'ghp_topsecret9999', cfgOnDisk.instances[0].token)
    assert('disk has no derived hasToken field', !('hasToken' in cfgOnDisk.instances[0]))
    assert('no stray tmp files left next to config', !readdirSync(dirname(configPath)).some((f) => f.endsWith('.tmp')))
  } catch (e) {
    assert('config readable on disk', false, e.message)
  }

  // --- HTTP write fences: content-type, cross-site, oversized body ---
  const nonJson = await fetch(`${base}/codehub/api?op=config.set`, {
    method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}',
  })
  await nonJson.text()
  assert('write rejects non-JSON content-type with 415', nonJson.status === 415, `got ${nonJson.status}`)

  const crossSite = await new Promise((resolve, reject) => {
    const req = request(`${base}/codehub/api?op=config.set`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' },
    }, (res) => { res.resume(); resolve(res.statusCode) })
    req.on('error', reject)
    req.end('{}')
  })
  assert('write rejects sec-fetch-site cross-site with 403', crossSite === 403, `got ${crossSite}`)

  const oversized = await new Promise((resolve) => {
    let settled = false
    const done = (value) => { if (!settled) { settled = true; resolve(value) } }
    const req = request(`${base}/codehub/api?op=config.set`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
    }, (res) => { res.resume(); done({ status: res.statusCode }) })
    req.on('error', (error) => done({ error: error.code || error.message }))
    req.end('x'.repeat(300 * 1024))
  })
  assert(
    'oversized body rejected',
    oversized.status === 500 || oversized.status === 413 || /ECONNRESET|EPIPE|body too large/i.test(String(oversized.error)),
    JSON.stringify(oversized),
  )
  const afterOversize = await get('/codehub/api?op=boot')
  assert('server survives an oversized body', afterOversize.data.ok === true, JSON.stringify(afterOversize.data))

  // --- index.html ---
  const htmlRes = await fetch(`${base}/codehub/index.html`)
  assert('index.html served', htmlRes.status === 200)
  const htmlBody = await htmlRes.text()
  assert('index.html contains CodeHub', htmlBody.includes('CodeHub'))
  const csp = htmlRes.headers.get('content-security-policy') || ''
  assert('index.html CSP keeps default-src self', csp.includes("default-src 'self'"), csp)
  assert('index.html CSP pins frame-ancestors self', csp.includes("frame-ancestors 'self'"), csp)
  assert('index.html sets x-content-type-options nosniff', htmlRes.headers.get('x-content-type-options') === 'nosniff', htmlRes.headers.get('x-content-type-options'))

  // --- SPA inline script parses (syntax guard for web/index.html) ---
  const scriptMatch = htmlBody.match(/<script>([\s\S]*)<\/script>/)
  assert('SPA has inline script', !!scriptMatch)
  if (scriptMatch) {
    try { new Function(scriptMatch[1]); assert('SPA script parses', true) }
    catch (e) { assert('SPA script parses', false, e.message) }
  }

  // --- manifest / version consistency (P2: docs drift is a real bug class) ---
  try {
    const pkg = JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8'))
    const src = readFileSync(join(pluginDir, 'index.js'), 'utf8')
    const m = src.match(/const PLUGIN_VERSION = '([^']+)'/)
    assert('index.js PLUGIN_VERSION matches package.json', !!m && m[1] === pkg.version, `${m?.[1]} vs ${pkg.version}`)
    // The runtime banner must report the same version the manifest ships.
    const live = await get('/codehub/api?op=boot')
    assert('api boot reports manifest version', live.data.version === pkg.version, `${live.data.version} vs ${pkg.version}`)
    assert('client inject declares native services', JSON.stringify(pkg?.dsh?.client?.inject) === '["slots","layout","uiWorkspace"]', JSON.stringify(pkg?.dsh?.client?.inject))
    assert('native host version floor matches lockfile', pkg.engines.dsh === '>=0.2.0-rc.2 <0.3.0' && JSON.parse(readFileSync(join(pluginDir, 'package-lock.json'), 'utf8')).packages[''].engines.dsh === pkg.engines.dsh)
    // Every file the loader needs must actually be published.
    const needed = ['index.js', 'workflows.js', 'client.js', 'web', 'cordis.patch.yml', 'icon.svg']
    assert('package.files covers every runtime asset', needed.every((f) => (pkg.files || []).includes(f)), JSON.stringify(pkg.files))
    // The caveat moved out of the slim README into the usage/dependency doc;
    // assert it is still documented there and that the README points at it.
    const readme = readFileSync(join(pluginDir, 'README.md'), 'utf8')
    const usageDoc = readFileSync(join(pluginDir, 'docs', 'usage-and-dependencies.md'), 'utf8')
    assert('docs document the Windows chmod caveat', /Windows/.test(usageDoc))
    assert('README links the usage doc', /docs\/usage-and-dependencies\.md/.test(readme))
  } catch (e) {
    assert('manifest consistency checks ran', false, e.message)
  }

  // --- 404 ---
  const notFound = await get('/codehub/api?op=nonexistent')
  assert('unknown op returns error', notFound.data.ok === false)

  // Cleanup. The oversized-body probe resets a socket, so make sure the
  // connection teardown completes before exiting (otherwise Windows libuv can
  // trip a UV_HANDLE_CLOSING assertion during process.exit).
  server.closeAllConnections?.()
  await new Promise((resolve) => server.close(resolve))
  for (const e of effects) try { await e.cleanup?.() } catch {}
  rmSync(tmpDir, { recursive: true, force: true })

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => { console.error('Harness crashed:', e); process.exit(1) })
