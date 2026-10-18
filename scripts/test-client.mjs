import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const client = await readFile(new URL('../client.js', import.meta.url), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));

function mount(overrides = {}) {
  const registrations = [], injections = [], effects = [], listeners = new Set(), replies = [], calls = [];
  const owned = { postMessage: (message, origin) => replies.push({ message, origin }) };
  const frame = { contentWindow: owned };
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useRef: () => ({ current: frame }),
    useEffect: (fn) => effects.push(fn),
  };
  let plugin;
  const window = {
    __ModuleLoader__: { load: ({ factory }) => { plugin = factory(name => { assert.equal(name, 'react'); return react; }); } },
    addEventListener: (name, fn) => { if (name === 'message') listeners.add(fn); },
    removeEventListener: (name, fn) => { if (name === 'message') listeners.delete(fn); },
  };
  vm.runInNewContext(client, { window, location: { origin: 'https://dsh.local' }, console, URL, setInterval, clearInterval });
  const ctx = {
    slots: {
      inject: (slot, fn) => { injections.push(slot); return fn(); },
      register: (spec, Component) => { registrations.push({ spec, Component }); return () => {}; },
    },
    layout: { selectPanel: id => calls.push(['selectPanel', id]) },
    uiWorkspace: {
      openSession: async id => { calls.push(['openSession', id]); },
      pickDirectory: async () => { calls.push(['pickDirectory']); return 'E:/work/repo'; },
      ...overrides,
    },
  };
  plugin.apply(ctx);
  const main = registrations.find(r => r.spec.name === 'main');
  assert.ok(main, 'register the official main slot without betterSidebar');
  const tree = main.Component({});
  function find(node) { if (node.type === 'iframe') return node; for (const child of node.children || []) { if (child && typeof child === 'object') { const found = find(child); if (found) return found; } } }
  const iframe = find(tree);
  assert.ok(iframe, 'main component owns its iframe');
  const cleanups = effects.map(fn => fn()).filter(fn => typeof fn === 'function');
  iframe.props.onLoad?.();
  const emit = (data, origin = 'https://dsh.local', source = owned) => { for (const fn of listeners) fn({ data, origin, source }); };
  return { plugin, injections, registrations, iframe, frame, owned, replies, calls, emit, listeners, unmount: () => cleanups.forEach(fn => fn()) };
}
const request = (id, action, rest = {}) => ({ type: 'codehub:request', id, action, ...rest });

test('native main and sidebar registrations share a stable panel id and icon size', () => {
  const m = mount();
  assert.deepEqual(Array.from(m.plugin.inject), ['slots', 'layout', 'uiWorkspace']);
  assert.deepEqual(m.injections, ['main', 'sidebar.panellist']);
  const main = m.registrations.find(r => r.spec.name === 'main');
  const sidebar = m.registrations.find(r => r.spec.name === 'sidebar.panellist');
  assert.equal(main.spec.key, 'codehub:dashboard');
  assert.equal(sidebar.spec.id, main.spec.key);
  assert.equal(typeof sidebar.spec.label === 'function' ? sidebar.spec.label() : sidebar.spec.label, 'CodeHub');
  assert.equal(sidebar.Component({ size: 23 }).props.width, 23);
  assert.equal(m.iframe.props.src, '/codehub/index.html');
  m.unmount();
});

test('bridge accepts only owned same-origin messages with the two exact schemas', async () => {
  const m = mount();
  const good = request('open-1', 'open-session', { sessionId: 'session-42' });
  m.emit(good, 'https://attacker.invalid');
  m.emit(good, 'https://dsh.local', {});
  for (const data of [null, [], 'bad', {}, { ...good, type: 'execute' }, { ...good, action: 'execute' }, { ...good, id: '' }, { ...good, sessionId: '' }, { ...good, sessionId: {} }, { ...good, command: 'rm -rf' }, request('pick-1', 'pick-directory', { sessionId: 'unexpected' })]) m.emit(data);
  await flush();
  assert.deepEqual(m.calls, []);
  m.emit(good);
  m.emit(good);
  await flush();
  assert.deepEqual(m.calls, [['openSession', 'session-42']]);
  const response = m.replies.find(r => r.message.id === 'open-1');
  assert.equal(response.origin, 'https://dsh.local');
  assert.equal(response.message.type, 'codehub:response');
  assert.equal(response.message.action, 'open-session');
  assert.equal(response.message.ok, true);
  m.emit(request('pick-2', 'pick-directory'));
  await flush();
  assert.equal(m.replies.find(r => r.message.id === 'pick-2').message.path, 'E:/work/repo');
  m.unmount();
});

test('bridge returns correlated errors without generic execution', async () => {
  const m = mount({ openSession: async () => { throw new Error('session unavailable'); } });
  m.emit(request('err-1', 'open-session', { sessionId: 'missing' }));
  await flush();
  const response = m.replies.find(r => r.message.id === 'err-1').message;
  assert.equal(response.ok, false);
  assert.equal(response.error, 'session unavailable');
  m.unmount();
});

test('unmount removes listener and suppresses pending replies', async () => {
  let resolve;
  const m = mount({ pickDirectory: () => new Promise(r => { resolve = r; }) });
  m.emit(request('pending-1', 'pick-directory'));
  assert.equal(m.listeners.size, 1);
  m.unmount();
  assert.equal(m.listeners.size, 0);
  resolve('E:/late');
  await flush();
  assert.ok(!m.replies.some(r => r.message.id === 'pending-1'));
});

test('iframe navigation invalidates replies from its previous document', async () => {
  let resolve;
  const m = mount({ pickDirectory: () => new Promise(r => { resolve = r; }) });
  m.emit(request('old-page', 'pick-directory'));
  m.iframe.props.onLoad();
  resolve('E:/late');
  await flush();
  assert.ok(!m.replies.some(r => r.message.id === 'old-page'));
  m.unmount();
});

const html = await readFile(new URL('../web/index.html', import.meta.url), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
function spa() {
  const nodes = new Map(), events = new Map(), documentEvents = new Map(), intervals = [];
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { innerHTML: '', textContent: '', value: '', disabled: false, classList: { add() {}, remove() {} }, focus() {}, setAttribute() {}, querySelectorAll: () => [] });
    return nodes.get(id);
  };
  const window = { addEventListener: (name, fn) => { events.set(name, fn); }, removeEventListener: (name) => events.delete(name) };
  window.parent = window;
  const sandbox = vm.createContext({ window, location: { origin: 'https://dsh.local', search: '', hash: '#/overview' }, URL, URLSearchParams, console,
    document: { querySelector: node, getElementById: id => node('#'+id), querySelectorAll: () => [], addEventListener: (name, fn) => documentEvents.set(name, fn), visibilityState: 'visible', activeElement: null },
    fetch: () => new Promise(() => {}), setTimeout: () => 1, clearTimeout() {}, setInterval: fn => { intervals.push(fn); return 1; }, clearInterval() {},
    crypto: { randomUUID: () => 'request-uuid' }, confirm: () => true,
    AbortSignal: { timeout: (ms) => ({ ms }) },
  });
  vm.runInContext(script, sandbox);
  const run = code => vm.runInContext(code, sandbox);
  const ov = { summary: { repos: 1, errors: 0 }, repos: [], activity: [], statusDist: { open: 0, merged: 0, closed: 0 }, topReviewers: [], recent: [], coverage: { limited: true, note: 'sample coverage' } };
  sandbox.fixtureOverview = ov;
  run(`state.boot={hasData:false,capabilities:{ai:true,develop:true},config:{provider:'gh',repos:[],instances:[],organizations:[],ai:{},me:{}}}; state.overview=fixtureOverview;`);
  const click = selector => documentEvents.get('click')({ target: { closest: value => value === selector ? {} : null }, preventDefault() {} });
  return { sandbox, run, node, window, events, documentEvents, intervals, click };
}

test('initial boot requests overview even when hasData is false', async () => {
  const s = spa(), ops = [];
  s.sandbox.answer = async op => { ops.push(op); return op === 'boot' ? { hasData: false, config: { repos: [], instances: [], me: {} } } : { overview: s.sandbox.fixtureOverview }; };
  await s.run('api=answer; boot()');
  assert.ok(ops.includes('overview'));
});

test('drawer ignores late MR success and error after another selection or close', async () => {
  const s = spa(), pending = new Map();
  s.sandbox.answer = (op, p) => new Promise((resolve, reject) => pending.set(p.number, { resolve, reject }));
  s.run('api=answer');
  const a = s.run(`openMr('repo',1)`), b = s.run(`openMr('repo',2)`);
  pending.get(2).resolve({ diff: 'diff text', files: [], diffTruncated: true, mr: { number: 2, title: 'Second', body: '<unsafe>', state: 'open' }, repo: {} });
  await b;
  pending.get(1).resolve({ diff: '', files: [], mr: { number: 1, title: 'First', state: 'open' }, repo: {} });
  await a;
  assert.match(s.node('#drawerTitle').textContent || s.node('#drawerTitle').innerHTML, /Second/);
  assert.doesNotMatch(s.node('#drawerBody').innerHTML, /<unsafe>/);
  const c = s.run(`openMr('repo',3)`);
  s.run('closeDrawer()');
  const before = s.node('#drawerBody').innerHTML;
  pending.get(3).reject(new Error('late failure'));
  await c;
  assert.equal(s.node('#drawerBody').innerHTML, before);
});

test('MR detail uses the single mr.diff response when it carries the MR', async () => {
  const s = spa(), ops = [];
  s.sandbox.answer = async op => { ops.push(op); return { diff: 'one request diff', files: ['a.js'], diffTruncated: false, mr: { number: 9, title: 'Single fetch', state: 'open', reviews: [], comments: [] }, repo: {} }; };
  await s.run(`api=answer;openMr('repo',9)`);
  // review.latest restores any prior AI review draft for this MR (drafts used to live only in memory)
  assert.deepEqual(ops, ['mr.diff', 'review.latest']);
  assert.match(s.node('#drawerBody').innerHTML, /one request diff/);
  assert.match(s.node('#drawerBody').innerHTML, /a\.js/);
});

test('MR detail falls back to the mr op when mr.diff has no MR payload', async () => {
  const s = spa(), ops = [];
  s.sandbox.answer = async (op) => { ops.push(op); return op === 'mr.diff' ? { error: 'diff denied' } : { mr: { number: 10, title: 'Fallback', state: 'open', reviews: [], comments: [] }, repo: {}, detailErrors: ['comments denied'] }; };
  await s.run(`api=answer;openMr('repo',10)`);
  assert.deepEqual(ops, ['mr.diff', 'mr', 'review.latest']);
  assert.match(s.node('#drawerTitle').textContent, /Fallback/);
  assert.match(s.node('#drawerBody').innerHTML, /Diff 加载失败：diff denied/);
});

test('MR detail empty arrays are rendered as empty, not as missing fields', async () => {
  const s = spa();
  s.sandbox.answer = async () => ({ diff: '', files: [], mr: { number: 11, title: 'Empty', state: 'open', reviews: [], comments: [] }, repo: {} });
  await s.run(`api=answer;openMr('repo',11)`);
  const body = s.node('#drawerBody').innerHTML;
  assert.match(body, /暂无评审记录/);
  assert.match(body, /暂无检视意见/);
  assert.doesNotMatch(body, /接口未返回/);
});

test('unknown thread resolution stays distinct from unresolved', () => {
  const s = spa();
  assert.match(s.run(`cmtRow({resolved:null,body:'safe'})`), /状态未知/);
  assert.match(s.run(`cmtRow({resolved:false,body:'safe'})`), /未解决/);
  assert.match(s.run(`cmtRow({resolved:true,body:'safe'})`), /已解决/);
});

test('standalone SPA rejects native requests and ignores forged host announcements', async () => {
  const s = spa();
  assert.equal(s.run('host.available'), false);
  s.events.get('message')?.({ origin: 'https://attacker.invalid', source: {}, data: { type: 'codehub:host-ready', version: 1, openSession: true, pickDirectory: true } });
  assert.equal(s.run('host.available'), false);
  await assert.rejects(s.run(`hostRequest('pick-directory')`), /DSH.*不可用/);
});

test('saving settings retains the settings view and an edit made while saving', async () => {
  const s = spa();
  let resolve;
  s.sandbox.save = () => new Promise(r => { resolve = r; });
  s.run(`apiPost=save; state.view='settings'; draft().me.name='before';`);
  const saving = s.run('saveConfig()');
  s.run(`draft().me.name='after'`);
  resolve({ config: { repos: [], instances: [], organizations: [], me: { name: 'before' }, ai: {} }, overview: null });
  await saving;
  assert.equal(s.run('state.view'), 'settings');
  assert.equal(s.run('draft().me.name'), 'after');
  assert.match(s.node('#toast').textContent, /排队|队列/);
});

test('review create and publish require separate consent and post only the edited preview', async () => {
  const s = spa(), posts = [];
  s.sandbox.answer = async op => op==='mr.diff'?{diff:'partial diff',diffTruncated:true,files:[]}:{mr:{number:4,title:'Review target',state:'open'},repo:{}};
  s.sandbox.post = async (op, body) => { posts.push({ op, body: JSON.parse(JSON.stringify(body)) });return op==='review.create'?{draft:{id:'draft-4',body:'AI body',status:'draft',headSha:'abc'}}:{draft:{id:'draft-4',body:body.body,status:'published'}}; };
  await s.run(`api=answer;apiPost=post;openMr('repo',4)`);
  s.sandbox.confirm = () => false;
  await s.run('createReview()');
  assert.equal(posts.length, 0);
  s.sandbox.confirm = () => true;
  await s.run('createReview()');
  assert.deepEqual(posts[0], { op:'review.create',body:{repoKey:'repo',number:4,confirmed:true} });
  s.run(`reviewWork.get('repo|4').body='only edited text'; previewReview()`);
  assert.equal(posts.length,1);
  s.sandbox.confirm = () => false;
  await s.run('publishReview()');
  assert.equal(posts.length,1);
  s.sandbox.confirm = () => true;
  await s.run('publishReview()');
  assert.deepEqual(posts[1], {op:'review.publish',body:{id:'draft-4',body:'only edited text',confirmed:true}});
  await s.run('publishReview()');
  assert.equal(posts.length,2);
});

test('findings restore from review.latest, preselect severe ones, and file each Issue once', async () => {
  const s = spa(), posts = [];
  const draft = {
    id: 'draft-f', number: 6, repoKey: 'repo', headSha: 'def', status: 'draft',
    structured: true, findingsTruncated: false, parseWarnings: [],
    findings: [
      { id: 'f1', severity: 'blocker', category: 'bug', title: '空指针', file: 'src/a.js', line: 1, evidence: 'x', detail: 'd', suggestion: 's', confidence: 'high', fileVerified: true, evidenceVerified: true, issueStatus: 'idle', issue: null, issueError: null },
      { id: 'f2', severity: 'nit', category: 'other', title: '命名', file: null, line: null, evidence: '', detail: 'd2', suggestion: 's2', confidence: 'low', fileVerified: null, evidenceVerified: null, issueStatus: 'idle', issue: null, issueError: null },
    ],
  };
  const filed = JSON.parse(JSON.stringify(draft));
  filed.findings[0].issueStatus = 'created';
  filed.findings[0].issue = { number: 501, url: 'https://github.com/o/r/issues/501', createdAt: 'now' };
  s.sandbox.answer = async op => op === 'review.latest'
    ? { ok: true, draft }
    : { diff: 'diff', files: [], mr: { number: 6, title: 'Findings target', state: 'open', reviews: [], comments: [] }, repo: {} };
  s.sandbox.post = async (op, body) => {
    posts.push({ op, body: JSON.parse(JSON.stringify(body)) });
    return { ok: true, draft: filed, stopped: null, results: [{ findingId: 'f1', status: 'created', issue: filed.findings[0].issue }] };
  };
  await s.run(`api=answer;apiPost=post;openMr('repo',6)`);
  // The draft came back from the audit file, so reopening the MR no longer loses findings.
  // Recovery runs when the workspace renders; await it here for a deterministic assertion.
  await s.run('ensureReviewState(detail)');
  const wsHtml = () => s.run('document.getElementById("reviewWorkspace").innerHTML');
  const html = wsHtml();
  assert.match(html, /AI 问题清单（2 条）/);
  assert.match(html, /空指针/);
  assert.match(html, /src\/a\.js:1/);
  // blocker/major are preselected; nit is not
  assert.equal(s.run(`[...reviewWork.get('repo|6').selected].join(",")`), 'f1');
  s.sandbox.confirm = () => true;
  await s.run('fileSelectedIssues()');
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0], { op: 'review.issues.create', body: { id: 'draft-f', findingIds: ['f1'], confirmed: true } });
  assert.match(wsHtml(), /已创建 Issue/);
  // A created finding is locked and must never be posted again.
  await s.run('fileSelectedIssues()');
  assert.equal(posts.length, 1, 'must not re-post a finding that already has an Issue');
});

test('review create locks duplicate clicks and preserves draft and edits on publish error', async () => {
  const s = spa();let resolve, posts=0;
  s.sandbox.answer=async op=>op==='mr.diff'?{diff:'diff',files:[]}:{mr:{number:5,title:'Target'},repo:{}};
  s.sandbox.post=()=>{posts++;return new Promise(r=>{resolve=r;});};
  await s.run(`api=answer;apiPost=post;openMr('repo',5)`);
  const pending=s.run('createReview()');await s.run('createReview()');assert.equal(posts,1);
  resolve({draft:{id:'draft-5',body:'draft',status:'draft'}});await pending;
  s.sandbox.post=async()=>{throw new Error('publish denied');};
  s.run(`apiPost=post;reviewWork.get('repo|5').body='keep edited body';previewReview()`);
  await s.run('publishReview()');
  assert.equal(s.run(`reviewWork.get('repo|5').body`),'keep edited body');
  assert.equal(s.run(`reviewWork.get('repo|5').draft.id`),'draft-5');
  assert.match(s.run(`reviewWork.get('repo|5').error`),/publish denied/);
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const listCases = [
  { name: 'MR', op: 'mrs', loader: 'loadMrs', view: 'viewMrs', field: 'mrData', rows: 'mrs', empty: /没有符合条件的 MR/, item: { repoKey: 'enterprise:acme/app', number: 7, title: 'retained MR', state: 'open' } },
  { name: 'review', op: 'reviews', loader: 'loadReviews', view: 'viewReviews', field: 'rvData', rows: 'comments', empty: /暂无检视意见|没有符合条件的检视意见/, item: { repoKey: 'enterprise:acme/app', mrNumber: 7, mrTitle: 'retained MR', body: 'retained review', resolved: null } },
  { name: 'Issue', op: 'issues', loader: 'loadIssues', view: 'viewIssues', field: 'issueData', rows: 'issues', empty: /没有符合条件的 Issue/, item: { repoKey: 'enterprise:acme/app', number: 7, title: 'retained Issue', state: 'open' } },
];

for (const c of listCases) {
  test(`${c.name} list distinguishes HTTP 503, loading, and successful empty retry`, async () => {
    const s = spa(), pending = deferred();
    s.sandbox.fetch = () => pending.promise;
    const loading = s.run(`${c.loader}()`);
    const before = s.run(`${c.view}()`);
    assert.match(before, /加载中/);
    assert.doesNotMatch(before, c.empty);
    pending.resolve({ ok: false, status: 503, json: async () => ({ ok: false, error: 'HTTP 503 <unavailable>' }) });
    await loading;
    const failed = s.run(`${c.view}()`);
    assert.match(failed, /加载失败/);
    assert.match(failed, /HTTP 503 &lt;unavailable&gt;/);
    assert.match(failed, /刷新.*重试/);
    assert.doesNotMatch(failed, /加载中|<unavailable>/);
    assert.doesNotMatch(failed, c.empty);
    s.sandbox.fetch = async () => ({ ok: true, json: async () => ({ ok: true, [c.rows]: [], total: 0 }) });
    await s.run(`${c.loader}()`);
    const empty = s.run(`${c.view}()`);
    assert.match(empty, c.empty);
    assert.doesNotMatch(empty, /加载中|加载失败|HTTP 503/);
  });

  test(`${c.name} list preserves rows and exposes partial errors with response coverage`, async () => {
    const s = spa();
    s.sandbox.answer = async () => ({ [c.rows]: [c.item], total: 1,
      errors: ['comments <denied>', { repoKey: 'enterprise:acme/app', error: 'repo <denied>' }, { owner: 'private-org', error: 'organization denied' }],
      coverage: { limited: true, note: `${c.name} response coverage <limited>` },
    });
    await s.run(`api=answer;${c.loader}()`);
    const content = s.run(`${c.view}()`);
    for (const expected of [/retained/, /comments &lt;denied&gt;/, /enterprise:acme\/app/, /repo &lt;denied&gt;/, /private-org/, /organization denied/, /response coverage &lt;limited&gt;/, /部分|不完整/, /刷新.*重试/]) assert.match(content, expected);
    assert.doesNotMatch(content, /<denied>|<limited>|\[object Object\]|sample coverage/);
    s.run(`state.${c.field}.${c.rows}=[];state.${c.field}.total=0;`);
    const partialEmpty = s.run(`${c.view}()`);
    assert.match(partialEmpty, /部分|不完整/);
    assert.match(partialEmpty, /comments &lt;denied&gt;/);
  });

  test(`${c.name} list uses overview coverage when the response omits it`, async () => {
    const s = spa();
    s.sandbox.answer = async () => ({ [c.rows]: [], total: 0 });
    await s.run(`api=answer;${c.loader}()`);
    assert.match(s.run(`${c.view}()`), /sample coverage/);
  });

  test(`${c.name} list ignores stale success and failure after a newer request`, async () => {
    const s = spa(), old = deferred(), lateError = deferred();
    s.sandbox.answer = () => old.promise;
    const first = s.run(`api=answer;${c.loader}()`);
    s.sandbox.answer = () => lateError.promise;
    const second = s.run(`api=answer;${c.loader}()`);
    s.sandbox.answer = async () => ({ [c.rows]: [c.item], total: 1 });
    await s.run(`api=answer;${c.loader}()`);
    old.resolve({ [c.rows]: [], total: 0 });
    lateError.reject(new Error('obsolete failure'));
    await Promise.all([first, second]);
    const content = s.run(`${c.view}()`);
    assert.match(content, /retained/);
    assert.doesNotMatch(content, /obsolete failure|加载失败/);
  });
}

test('Issue local override uses canonical instanceId, not the same path in another instance', async () => {
  const s = spa();
  s.sandbox.answer = async () => ({ issue: { number: 7, title: 'Identity target' }, repo: { key: 'enterprise:acme/app', path: 'acme/app', instanceId: 'enterprise' } });
  s.run(`state.boot.config.repos=[{instance:'github.com',path:'acme/app',localPath:'E:/wrong'},{instance:'enterprise',path:'acme/app',localPath:'E:/correct'}]`);
  await s.run(`api=answer;openIssue('enterprise:acme/app',7)`);
  assert.match(s.node('#drawerBody').innerHTML, /E:\/correct/);
  assert.doesNotMatch(s.node('#drawerBody').innerHTML, /E:\/wrong/);
  s.run(`state.boot.config.repos.pop();renderIssueDetail(detail)`);
  assert.match(s.node('#drawerBody').innerHTML, /尚未配置本地路径/);
  assert.doesNotMatch(s.node('#drawerBody').innerHTML, /E:\/wrong/);
});

test('Issue local overrides support the default instance and prefer a server local path', () => {
  const s = spa();
  s.run(`state.boot.config.repos=[{path:'acme/app',localPath:'E:/default'}]`);
  assert.equal(s.run(`localRepo({repoKey:'github.com:acme/app',repo:{path:'acme/app',instanceId:'github.com'}}).localPath`), 'E:/default');
  assert.equal(s.run(`localRepo({repoKey:'github.com:acme/app',repo:{path:'acme/app',instanceId:'github.com',localPath:'E:/server'}}).localPath`), 'E:/server');
  assert.equal(s.run(`localRepo({repoKey:'unknown:acme/app',repo:{path:'acme/app'}}).localPath`), undefined);
});

test('Issue settings adds the canonical instance row without cross-instance deduplication', async () => {
  const s = spa();
  s.sandbox.answer = async () => ({ issue: { number: 7, title: 'Identity target' }, repo: { path: 'acme/app', instanceId: 'enterprise' } });
  s.run(`state.boot.config.repos=[{instance:'github.com',path:'acme/app',localPath:'E:/wrong'}]`);
  await s.run(`api=answer;openIssue('enterprise:acme/app',7)`);
  await s.click('#issueSettings');
  assert.equal(s.sandbox.location.hash, '#/settings');
  assert.deepEqual(JSON.parse(s.run(`JSON.stringify(draft().repos.map(({instance,path,localPath})=>({instance,path,localPath})))`)), [
    { instance: 'github.com', path: 'acme/app', localPath: 'E:/wrong' },
    { instance: 'enterprise', path: 'acme/app', localPath: '' },
  ]);
  await s.run(`openIssue('enterprise:acme/app',7)`);
  await s.click('#issueSettings');
  assert.equal(s.run('draft().repos.length'), 2);
});

for (const kind of ['mr', 'issue']) {
  test(`${kind} detail shows escaped backend detailErrors without hiding usable data`, async () => {
    const s = spa();
    s.sandbox.answer = async op => op === 'mr.diff'
      ? { diff: 'retained diff', files: [], detailErrors: ['diff comments <denied>'] }
      : { [kind]: { number: 7, title: 'retained detail', body: 'retained body', state: 'open', comments: [], reviews: [] }, repo: {}, detailErrors: ['detail comments <denied>'] };
    await s.run(`api=answer;${kind === 'mr' ? 'openMr' : 'openIssue'}('repo',7)`);
    const content = s.node('#drawerBody').innerHTML;
    assert.match(content, /retained body/);
    assert.match(content, /detail comments &lt;denied&gt;/);
    assert.match(content, /部分|不完整/);
    assert.match(content, /重新打开.*重试/);
    assert.doesNotMatch(content, /<denied>/);
    if (kind === 'mr') {
      assert.match(content, /diff comments &lt;denied&gt;/);
      assert.match(content, /retained diff/);
    }
  });
}

for (const view of ['overview', 'mrs', 'reviews', 'issues', 'repos', 'stats']) {
  test(`leaving saved settings for ${view} keeps the saved overview and loads its list`, async () => {
    const s = spa(), ops = [];
    s.sandbox.fixtureOverview.repos = [{ key: 'enterprise:acme/app', path: 'acme/app', name: 'app', counts: { open: 1, merged: 0, closed: 0, needsReview: 0, unresolved: 0, failingCi: 0, mergedWeek: 0 } }];
    s.sandbox.post = async (_op, body) => ({ config: body, overview: null });
    s.sandbox.answer = async op => {
      ops.push(op);
      if (op === 'overview') return { overview: { ...s.sandbox.fixtureOverview, coverage: { note: 'fresh overview' } } };
      const list = listCases.find(c => c.op === op);
      assert.ok(list, `unexpected request ${op}`);
      return { [list.rows]: [list.item], total: 1 };
    };
    await s.run(`api=answer;apiPost=post;state.view='settings';saveConfig()`);
    assert.equal(s.run('state.view'), 'settings');
    assert.equal(s.run('state.saving'), false);
    assert.equal(s.run('state.overview.summary.repos'), 1, 'config.set(overview:null) must not clear a healthy overview');
    assert.deepEqual(ops, [], 'save remains nonblocking and does not wait for background refresh');
    s.sandbox.location.hash = '#/' + view;
    await s.run('route()');
    await flush();
    assert.deepEqual(ops, ['mrs', 'reviews', 'issues'].includes(view) ? [view] : [], 'no overview request is needed; only the active list may reload');
    assert.equal(s.run('state.overview.repos[0].path'), 'acme/app');
    assert.doesNotMatch(s.node('#main').innerHTML, /还没有可显示的仓库数据|加载中/);
    if (['mrs', 'reviews', 'issues'].includes(view)) assert.match(s.node('#main').innerHTML, /retained/);
  });
}

test('a late overview route cannot restart the active list or overwrite newer results', async () => {
  const s = spa(), old = deferred(), current = deferred(), ops = [];
  s.sandbox.answer = op => {
    ops.push(op);
    if (op === 'overview') return ops.length === 1 ? old.promise : current.promise;
    assert.equal(op, 'reviews');
    return Promise.resolve({ comments: [], total: 0 });
  };
  const a = s.run(`api=answer;state.overview=null;location.hash='#/mrs';route()`);
  const b = s.run(`location.hash='#/reviews';route()`);
  current.resolve({ overview: s.sandbox.fixtureOverview });
  await b;
  await flush();
  old.resolve({ overview: { ...s.sandbox.fixtureOverview, coverage: { note: 'obsolete overview' } } });
  await a;
  await flush();
  assert.deepEqual(ops, ['overview', 'overview', 'reviews']);
  assert.equal(s.run('state.view'), 'reviews');
  assert.doesNotMatch(s.node('#main').innerHTML, /obsolete overview|加载中/);
});

test('saving settings supersedes an in-flight overview and keeps later edits', async () => {
  const s = spa(), old = deferred(), saving = deferred(), ops = [];
  s.sandbox.answer = op => { ops.push(op); return op === 'models' ? Promise.resolve({ providers: [] }) : old.promise; };
  s.sandbox.post = () => saving.promise;
  const routing = s.run(`api=answer;apiPost=post;state.overview=null;location.hash='#/mrs';route()`);
  s.run(`location.hash='#/settings';route();draft().me.name='before'`);
  const saved = s.run('saveConfig()');
  s.run(`draft().me.name='after'`);
  saving.resolve({ config: { repos: [], instances: [], organizations: [], ai: {}, me: { name: 'before' } }, overview: { ...s.sandbox.fixtureOverview, summary: { repos: 9, errors: 0 } } });
  await saved;
  old.resolve({ overview: s.sandbox.fixtureOverview });
  await routing;
  await flush();
  assert.equal(s.run('state.overview.summary.repos'), 9, 'config.set overview wins over the stale in-flight overview');
  assert.equal(s.run('draft().me.name'), 'after');
  assert.equal(s.run('state.view'), 'settings');
  assert.deepEqual(ops, ['overview', 'models']);
});

test('settings accurately describes GitHub gh and HTTP workflow support', () => {
  const content = spa().run('viewSettings()');
  assert.match(content, /工作流[^<]*GitHub[^<]*gh[^<]*HTTP/);
  assert.doesNotMatch(content, /工作流仅支持 GitHub gh 数据源/);
});

test('overview failure renders a retryable error instead of pretending there is no data', async () => {
  const s = spa();
  s.run(`state.overview=null;state.overviewError="";state.overviewLoaded=false`);
  let reject;
  s.sandbox.fetch = () => new Promise((_, no) => { reject = no; });
  const loading = s.run('loadOverview()');
  assert.match(s.run('viewOverview()'), /正在加载仓库数据/);
  assert.doesNotMatch(s.run('viewOverview()'), /还没有可显示的仓库数据|加载中…/);
  reject(Object.assign(new Error('boom'), { name: 'TimeoutError' }));
  await loading;
  const failed = s.run('viewOverview()');
  assert.match(failed, /仓库数据加载失败/);
  assert.match(failed, /请求超时/);
  assert.match(failed, /id="retryOverview"/);
  s.sandbox.fetch = async () => ({ ok: true, json: async () => ({ ok: true, overview: s.sandbox.fixtureOverview }) });
  await s.click('#retryOverview');
  assert.equal(s.run('state.overviewError'), '');
  assert.match(s.run('viewOverview()'), /我的工作收件箱/);
});

test('route stops at a failed overview and does not request the target list', async () => {
  const s = spa(), ops = [];
  s.run(`state.overview=null;state.overviewError="";state.overviewLoaded=false;location.hash='#/mrs'`);
  s.sandbox.fetch = async (u) => {
    const op = new URL(String(u)).searchParams.get('op');
    ops.push(op);
    return op === 'overview' ? { ok: false, status: 502, json: async () => ({ ok: false, error: 'overview <down>' }) } : { ok: true, json: async () => ({ ok: true, mrs: [], total: 0 }) };
  };
  s.run('route()');
  await flush();
  assert.deepEqual(ops, ['overview']);
  assert.match(s.node('#main').innerHTML, /仓库数据加载失败/);
  assert.match(s.node('#main').innerHTML, /overview &lt;down&gt;/);
});

test('list failure keeps the last successful rows and marks them stale', async () => {
  const s = spa();
  s.sandbox.answer = async () => ({ mrs: [{ repoKey: 'acme/app', number: 1, title: 'retained row', state: 'open' }], total: 1 });
  await s.run(`api=answer;state.mrData=null;loadMrs()`);
  s.sandbox.answer = async () => { throw new Error('later <failure>'); };
  await s.run('api=answer;loadMrs()');
  const content = s.run('viewMrs()');
  assert.match(content, /retained row/);
  assert.match(content, /刷新失败：later &lt;failure&gt;/);
  assert.match(content, /已保留上次成功数据/);
  assert.doesNotMatch(content, /<failure>|加载失败：later/);
});

test('MR list shows partial errors and discloses truncated totals', async () => {
  const s = spa();
  s.sandbox.answer = async () => ({ mrs: [{ repoKey: 'acme/app', number: 1, title: 'one', state: 'open' }], total: 500, errors: ['comments <denied>'], coverage: { note: 'sample <partial>' } });
  await s.run(`api=answer;state.mrData=null;loadMrs()`);
  const content = s.run('viewMrs()');
  assert.match(content, /部分数据加载失败/);
  assert.match(content, /comments &lt;denied&gt;/);
  assert.match(content, /显示前 1 \/ 共 500 条/);
  assert.match(content, /sample &lt;partial&gt;/);
  assert.doesNotMatch(content, /<denied>|<partial>/);
});

test('CI filter is visible, serialized to the hash, and no longer silently persists', async () => {
  const s = spa();
  s.sandbox.fetch = async () => ({ ok: true, json: async () => ({ ok: true, mrs: [], total: 0 }) });
  s.run(`state.mrFilters.ci='failure'`);
  assert.equal(s.run('flatMrFilters().ci'), 'failure');
  assert.match(s.run('viewMrs()'), /id="fCi"[\s\S]*value="failure" selected/);
  s.documentEvents.get('change')({ target: { id: 'fCi', value: 'success' } });
  assert.equal(s.run('state.mrFilters.ci'), 'success');
  assert.match(s.sandbox.location.hash, /ci=success/);
  await flush();
  s.run(`state.mrFilters.ci=''`);
  assert.doesNotMatch(s.run('viewMrs()'), /value="failure" selected/);
});

test('publish_unknown disables generate/preview/publish and demands GitHub verification', async () => {
  const s = spa(), posts = [];
  s.sandbox.answer = async () => ({ diff: 'd', files: [], mr: { number: 12, title: 'Unknown state', state: 'open' }, repo: {} });
  s.sandbox.post = async (op, body) => { posts.push(op); return {}; };
  await s.run(`api=answer;apiPost=post;openMr('repo',12)`);
  s.run(`reviewWork.get('repo|12').draft={id:'draft-x',status:'publish_unknown',headSha:'abc'};renderReviewWorkspace(detail)`);
  const body = s.node('#reviewWorkspace').innerHTML;
  assert.match(body, /发布结果未知/);
  assert.match(body, /不会自动重试/);
  assert.match(body, /id="createReview" disabled/);
  assert.match(body, /id="reloadDraft" disabled/);
  assert.match(body, /id="previewReview" disabled/);
  s.run(`reviewWork.get('repo|12').draft={id:'draft-x',status:'publishing'};renderReviewWorkspace(detail)`);
  assert.match(s.node('#reviewWorkspace').innerHTML, /id="createReview" disabled/);
  s.run(`reviewWork.get('repo|12').draft={id:'draft-x',status:'draft',needsVerification:true};renderReviewWorkspace(detail)`);
  assert.match(s.node('#reviewWorkspace').innerHTML, /id="createReview" disabled/);
  s.run(`reviewWork.get('repo|12').draft={id:'draft-x',status:'publish_unknown'};renderReviewWorkspace(detail)`);
  await s.run('createReview()');
  await s.run('publishReview()');
  s.run('previewReview()');
  assert.deepEqual(posts, []);
});

test('api converts an aborted/timed-out request into an explicit timeout error', async () => {
  const s = spa();
  s.sandbox.fetch = () => Promise.reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' }));
  await assert.rejects(s.run(`api('overview')`), /请求超时（20 秒）/);
});

test('apiPost honors a per-call timeoutMs override and keeps the 20s default', () => {
  const s = spa();
  const seen = [];
  s.sandbox.fetch = (u, opts) => { seen.push(opts.signal && opts.signal.ms); return Promise.reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' })); };
  s.run('apiPost("overview", {})').catch(() => {});
  assert.equal(seen[0], 20000, 'default apiPost uses the 20s signal');
  s.run('apiPost("review.create", { confirmed: true }, { timeoutMs: 150000 })').catch(() => {});
  assert.equal(seen[1], 150000, 'review.create passes the 150s signal override');
});

test('MR diff truncation is disclosed in the detail notice', async () => {
  const s = spa();
  s.sandbox.answer = async () => ({ diff: 'partial', files: [], diffTruncated: true, mr: { number: 13, title: 'Truncated', state: 'open' }, repo: {} });
  await s.run(`api=answer;openMr('repo',13)`);
  assert.match(s.node('#drawerBody').innerHTML, /Diff 已截断/);
});

test('discover prompts for a workspace path when the iframe URL has no cwd', async () => {
  const s = spa(), requests = [];
  s.sandbox.window.prompt = () => 'E:/workspace';
  s.sandbox.fetch = async (u) => {
    requests.push(new URL(String(u)));
    return { ok: true, json: async () => ({ ok: true, repos: [{ name: 'app', path: 'E:/workspace/app', remotePath: 'acme/app' }] }) };
  };
  const settings = s.run('viewSettings()');
  assert.match(settings, /id="discoverBtn"/);
  assert.doesNotMatch(settings, /id="discoverBtn"[^>]*disabled/);
  await s.click('#discoverBtn');
  assert.equal(requests[0].searchParams.get('op'), 'repos.discover');
  assert.equal(requests[0].searchParams.get('ws'), 'E:/workspace');
  assert.equal(s.run('state.discover.length'), 1);
  assert.match(s.run('viewSettings()'), /acme\/app/);
});

test('masked tokens are labelled and focus-selectable, not presented as real values', () => {
  const s = spa();
  s.run(`state.boot.config.instances=[{id:'i1',name:'gh',host:'github.com',token:'****abcd'}]`);
  const content = s.run('viewSettings()');
  assert.match(content, /已保存的 token 以 \*\*\*\* 显示/);
  assert.match(content, /value="\*\*\*\*abcd"/);
  assert.match(content, /data-k="token"/);
});

// --- W4: kpi() sub escaping (P2-1) -----------------------------------------

function overviewWith(s, extra = {}) {
  s.sandbox.EXTRA = extra;
  s.run(`state.overview={summary:Object.assign({repos:1,errors:0},EXTRA),repos:[],activity:[],statusDist:{open:0,merged:0,closed:0},topReviewers:[],recent:[],coverage:{limited:true,note:'n'}}`);
}

test('kpi sub escapes markup from values instead of executing it', () => {
  const s = spa();
  const evil = s.run(`kpi("","身份",1,"<img src=x onerror=alert(1)>","#/x")`);
  assert.match(evil, /<div class="sub">&lt;img src=x onerror=alert\(1\)&gt;<\/div>/);
  assert.doesNotMatch(evil, /<img/, 'no raw markup tag may survive inside the sub element');
  assert.doesNotMatch(evil, /&amp;lt;/, 'escaping must not be applied twice (no double escape)');
});

test('kpi sub does not double-escape an ampersand that is already data', () => {
  const s = spa();
  const content = s.run(`kpi("","身份",1,"A &amp; B","#/x")`);
  assert.match(content, /<div class="sub">A &amp;amp; B<\/div>/, 'a literal &amp; in the value is escaped exactly once');
  assert.doesNotMatch(content, /A &amp; B</, 'the raw entity must not be emitted unescaped');
});

test('overview identity KPI renders an escaped name without double escaping', () => {
  const s = spa();
  overviewWith(s, { me: { name: 'a<b>&c' } });
  const content = s.run('viewStats()');
  assert.match(content, /身份：a&lt;b&gt;&amp;c/, 'the login-derived name is escaped at the kpi boundary');
  assert.doesNotMatch(content, /身份：a<b>/, 'unescaped name must never reach the markup');
  assert.doesNotMatch(content, /&amp;lt;/, 'the name must not be escaped twice');
});

// --- W4: honest degradation for unknown thread resolution (P1-1 front half) --

test('unknown resolution hides the constant-zero unresolved KPI behind explicit wording', () => {
  const s = spa();
  for (const resolutionAvailable of [undefined, false]) {
    overviewWith(s, { resolutionAvailable, unresolvedComments: 0, totalComments: 12 });
    const content = s.run('viewStats()');
    const card = content.match(/<a class="card kpi[^"]*"[^>]*>[\s\S]*?未解决检视意见[\s\S]*?<\/a>/)[0];
    assert.match(card, /线程解决状态未知/, `resolutionAvailable=${resolutionAvailable} must disclose unknown state`);
    assert.doesNotMatch(card, /共 12 条/, 'the misleading total/sub pairing must not appear');
    assert.doesNotMatch(card, /<div class="val">0<\/div>/, 'an unknowable count must not be presented as a real zero');
    assert.doesNotMatch(card, /NaN/, 'the KPI value must not render as NaN');
    assert.match(card, /<div class="val">—<\/div>/, 'the value is an explicit unknown marker, not a number');
  }
});

test('known resolution shows the real unresolved KPI instead of the unknown wording', () => {
  const s = spa();
  overviewWith(s, { resolutionAvailable: true, unresolvedComments: 0, totalComments: 12 });
  const zero = s.run('viewStats()');
  const zeroCard = zero.match(/<a class="card kpi[^"]*"[^>]*>[\s\S]*?未解决检视意见[\s\S]*?<\/a>/)[0];
  assert.match(zeroCard, /<div class="val">0<\/div>/, 'a genuine zero is reported as zero');
  assert.match(zeroCard, /共 12 条/);
  assert.doesNotMatch(zeroCard, /线程解决状态未知|NaN/);
  overviewWith(s, { resolutionAvailable: true, unresolvedComments: 5, totalComments: 12 });
  const five = s.run('viewStats()');
  assert.match(five.match(/<a class="card kpi[^"]*"[^>]*>[\s\S]*?未解决检视意见[\s\S]*?<\/a>/)[0], /<div class="val">5<\/div>/);
});

test('MR and review unresolved filters are disabled while resolution is unknown', () => {
  const s = spa();
  for (const resolutionAvailable of [undefined, false]) {
    overviewWith(s, { resolutionAvailable });
    s.run('state.mrFilters.unresolved=true;state.rvData={comments:[],total:0};state.rvFilters.unresolved=true');
    const mrs = s.run('viewMrs()');
    assert.match(mrs, /<label class="tgl" title="线程解决状态未知，暂不可用"><input type="checkbox" id="fUnres" disabled\/>/,
      `fUnres must be visibly disabled when resolutionAvailable=${resolutionAvailable}`);
    assert.doesNotMatch(mrs, /id="fUnres" checked/, 'a stale unresolved filter must not render as active');
    const reviews = s.run('viewReviews()');
    assert.match(reviews, /<label class="tgl" title="线程解决状态未知，暂不可用"><input type="checkbox" id="rUnres" disabled\/>/,
      `rUnres must be visibly disabled when resolutionAvailable=${resolutionAvailable}`);
    assert.doesNotMatch(reviews, /id="rUnres" checked/);
  }
});

test('MR and review unresolved filters become usable once resolution is known', () => {
  const s = spa();
  overviewWith(s, { resolutionAvailable: true });
  s.run('state.mrFilters.unresolved=true;state.rvData={comments:[],total:0};state.rvFilters.unresolved=true');
  const mrs = s.run('viewMrs()');
  assert.match(mrs, /<label class="tgl on" title=""><input type="checkbox" id="fUnres" checked\/>/,
    'a known-resolution filter must render as an active, enabled control');
  assert.doesNotMatch(mrs, /id="fUnres"[^>]*disabled/);
  const reviews = s.run('viewReviews()');
  assert.match(reviews, /<label class="tgl on" title=""><input type="checkbox" id="rUnres" checked\/>/);
  assert.doesNotMatch(reviews, /id="rUnres"[^>]*disabled/);
});

test('repo card unresolved count is unknown rather than a fabricated zero', () => {
  const s = spa();
  const card = `repoCard({name:'a',owner:'o',counts:{open:1,merged:0,closed:0,needsReview:0,unresolved:0,failingCi:0,mergedWeek:0}})`;
  for (const resolutionAvailable of [undefined, false]) {
    overviewWith(s, { resolutionAvailable });
    const unknown = s.run(card);
    assert.match(unknown, /title="线程解决状态未知，暂不可用">—<\/div><div class="l">未解决意见/,
      `repo unresolved must read as unknown when resolutionAvailable=${resolutionAvailable}`);
    assert.doesNotMatch(unknown, />0<\/div><div class="l">未解决意见/, 'unknown must not be shown as a real zero');
  }
  overviewWith(s, { resolutionAvailable: true });
  const known = s.run(card);
  assert.match(known, /title="">0<\/div><div class="l">未解决意见/, 'a genuine zero is shown once resolution is known');
});

test('drawer notice discloses unknown thread resolution when the field is absent', async () => {
  const s = spa();
  const detail = { diff: 'd', files: [], mr: { number: 6, title: 'T', state: 'open', reviews: [], comments: [] }, repo: {} };
  overviewWith(s, {});
  s.sandbox.answer = async () => detail;
  await s.run(`api=answer;openMr('repo',6)`);
  const unknown = s.node('#drawerBody').innerHTML;
  assert.match(unknown, /线程解决状态可能未知/, 'the drawer must hedge when resolution is unknowable');
  assert.doesNotMatch(unknown, /评论线程解决状态来自接口返回/, 'the definitive wording must not appear while the field is absent');
  overviewWith(s, { resolutionAvailable: true });
  await s.run(`openMr('repo',7)`);
  const known = s.node('#drawerBody').innerHTML;
  assert.match(known, /评论线程解决状态来自接口返回/, 'the definitive wording appears once resolution is known');
  assert.doesNotMatch(known, /线程解决状态可能未知/);
});

test('mr row keeps reporting comment and unresolved counts under unknown resolution', () => {
  const s = spa();
  overviewWith(s, {});
  const row = s.run(`mrRow({repoKey:'r',number:1,title:'t',commentCount:3,unresolvedCount:2})`);
  assert.match(row, /💬 3\s*<b style="color:var\(--red\)">\(2\)<\/b>/, 'the three-state comment count is unaffected by the degradation');
});
