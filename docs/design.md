# dsh-codehub-dashboard 设计文档

> 版本：0.1.5 | 最后更新：2026-10-17
>
> 本文描述**当前实现**。与早期草案的三处结构性差异：不再依赖 dsh-better-sidebar（改用 DSH 原生 `slots`/`layout`/`uiWorkspace`）；新增 `workflows.js`（原生模型检视 + Issue 开发会话 + 审计持久化）；HTTP 路由加入 DSH 原生 `connection` 信任校验。
>
> 仓库布局：GitHub 仓库与 npm 包同名 `dsh-codehub-dashboard`，**仓库根就是插件包根**（早期版本放在 `dsh-codehub-dashboard/` 子目录，2026-10-17 已扁平化）。

## 1. 项目概述

### 1.1 目标

在 DSH 左侧导航中提供 **CodeHub 工作区**，聚合多个 GitHub 仓库/组织的 Pull Request、Issue 与检视意见，并复用 DSH 已有能力完成两条工作流：

- 看板：待处理 PR、待我评审、未解决意见、需我回复、CI 失败、仓库健康度。
- AI 检视：调用宿主配置的模型，一次产出可发布草稿与结构化问题清单；草稿经用户编辑并**二次确认**后以 **COMMENT** 事件发布；问题清单经用户勾选并**单独确认**后批量创建 GitHub Issue（**从不自动创建**）。
- Issue 开发：核验本地克隆后，由宿主 `sessionController` 创建原生会话并提交 Issue 上下文；列表行另提供「快速开始开发」入口。

### 1.2 核心约束

| 约束 | 说明 |
|------|------|
| 复用宿主架构 | 模型、会话、目录选择、导航、鉴权全部走 DSH 原生服务，不自建 Agent/认证/工作区框架 |
| 真实数据 | 不使用 mock 数据；数据缺失时如实标注，不伪装成「空即正常」 |
| 零运行时依赖 | SPA 为单文件 vanilla JS + 内联 CSS/SVG；`package.json` 无 runtime dependencies |
| 绝不自动批准 | 发布只使用 `COMMENT` 事件，代码路径不接受客户端传入的 event 类型 |
| 发布不重放 | 远端结果不确定时进入 `publish_unknown`，禁止自动重试 |
| 离线容错 | gh 不可用降级 HTTP；两者都失败时显示明确错误并保留已同步数据 |

### 1.3 技术选型

| 层面 | 选择 | 理由 |
|------|------|------|
| 主数据源 | gh CLI v2.102+ | 官方工具、`--json` 平铺字段稳定、`gh api` 覆盖 REST 端点 |
| 备选数据源 | GitHub REST（`fetch` + Bearer token） | gh 未安装/未登录且已配置 token 时降级 |
| 辅助数据源 | git CLI | 本地仓库元信息、Issue 开发前的 origin 核验 |
| 导航集成 | `ctx.slots.inject('main' / 'sidebar.panellist')` | DSH 0.2 原生扩展点，无需第三方侧边栏插件 |
| AI 检视 | `ctx.llm.stream` + `ctx.sessions.create/flush` | 宿主模型目录与会话语义，凭据由宿主管理 |
| Issue 开发 | `ctx.sessionController.create/prompt` + `ctx.uiWorkspace.openSession` | 原生会话生命周期，插件不实现 Agent |
| Host 通信 | webServer `kind:'prefix'` path `/codehub` | DSH 标准路由机制 |

---

## 2. 系统架构

```
┌──────────────────────── DSH Desktop ────────────────────────┐
│  client half (client.js, window.__ModuleLoader__)           │
│   ├─ ctx.slots.inject('sidebar.panellist') → CodeHub 图标    │
│   ├─ ctx.slots.inject('main')              → CodeHubView    │
│   └─ iframe(/codehub/index.html) ⇄ postMessage 受限桥接      │
│         · origin + event.source + 消息白名单 + id 去重        │
│                        ↕ HTTP（同源）                        │
│  host half (index.js)  /codehub prefix route                │
│   ├─ ctx.connection.admit(req)  ← 每个请求的原生信任校验      │
│   ├─ Config Store（原子写、rev 版本号、token 脱敏）            │
│   ├─ Fetcher（TTL 缓存、并发 3、inflight 去重、gh 探测缓存）    │
│   ├─ Providers：gh / http / git-meta                        │
│   ├─ Aggregator：decorate / buildOverview / filterMrs       │
│   └─ Workflows（workflows.js）                              │
│        ├─ ctx.llm / ctx.sessions / ctx.sessionController    │
│        └─ 审计文件持久化（锁 + fsync + rename）               │
└───────────────────────────┬─────────────────────────────────┘
                    GitHub API / 本地 Git 仓库
```

### 2.1 模块职责

| 模块 | 文件 | 行数 | 职责 |
|------|------|------|------|
| Host half | `index.js` | 1265 | 配置存储、gh/http/git provider、缓存与聚合、HTTP 路由与安全栅栏 |
| Workflows | `workflows.js` | 502 | 原生模型检视草稿、COMMENT 发布、Issue 开发会话、审计持久化 |
| Client half | `client.js` | 90 | 原生左导航注册、iframe 容器、受限宿主桥接 |
| Dashboard SPA | `web/index.html` | 995 | 7 个视图、详情抽屉、工作流交互、设置表单、内联 SVG 图表 |
| Bundle patch | `cordis.patch.yml` | — | DSH loader 挂载声明 |
| Tests / dev | `scripts/` | — | 数据/契约/工作流/SPA/集成测试与隔离开发服务 |

---

## 3. 原生服务契约

### 3.1 Host inject

```javascript
export const name = 'dsh-codehub-dashboard'
export const inject = ['webServer', 'connection']
```

`connection` 为**必需**：路由在拿到它之前不处理任何请求。cordis 的 `Inject.resolve` 把**数组元素**当服务名，对象形态 `{required, optional}` 会被解析成两个叫 `required`/`optional` 的服务，插件在真实宿主永远 pending（2026-10-16 实机验证抓出的 P0，见 [host-verification-2026-10-16.md](host-verification-2026-10-16.md)）。

`llm`、`sessions`、`sessionController` 因此**不进 inject 列表**，改由 `workflows.js` 的 `service(name)` 在调用时探测（`ctx.get(name, false)`，无该服务时返回 undefined）。可选服务缺失时对应动作返回 503 并在 UI 中禁用，不会降级到自建实现；直接 `ctx.llm` 属性访问在未注入服务上会抛错而非返回 undefined，禁止使用。

### 3.2 Client inject

`package.json` 的 `dsh.client.inject = ['slots', 'layout', 'uiWorkspace']`，注册面板 `PANEL_ID = 'codehub:dashboard'`（order 45，label「CodeHub」）。宿主桥接只暴露两个动作：`pick-directory` 与 `open-session`；请求必须满足 `type/id/action(/sessionId)` 的严格键集与格式校验，响应按 iframe 生命周期 generation 与 origin 双重核验，并对已见 id 去重（上限 4096）。

### 3.3 已核实的宿主签名（证据：已安装 app.asar，宿主包版本 0.2.0-rc.2）

| 服务 | 契约 | 插件用法 |
|------|------|----------|
| `sessionController.create(request)` | 单参数；显式传入 `sessionId` 时宿主**采纳**该 id | 用持久化的 sessionId 创建/复用会话 |
| `sessionController.prompt(request, signal)` | **两参数**，实现内 `signal.throwIfAborted()` | 必须传 `AbortSignal.timeout(60_000)`；signal 只约束准入前的等待，超时后关联保持 pending，重试复用同一 requestId |
| `llm.stream(request)` | 需要 `provider/model/maxTokens/messages` | 检视请求带 `purpose: 'codehub-review'` 与 `AbortSignal.timeout(120_000)` |
| `sessions.create/flush/append/deriveMessages` | 会话消息与 request/header 的原生落盘 | system/user 消息 + `request/header`，不伪造 assistant 结算 |
| `uiWorkspace.pickDirectory/openSession` | 目录选择、打开原生会话 | 设置页绑定本地路径、Issue 开发跳转 |

### 3.4 能力探测

`workflows.capabilities()` 返回 `{ ai, develop }`，由 `boot` 响应带给 SPA；UI 据此启用/禁用按钮，避免用户点击后才知道服务缺失。

---

## 4. 数据模型

所有 provider 输出统一为归一化快照，aggregator 与 workflows 只消费该格式：

```typescript
interface Snapshot {
  repoKey: string                  // "{host}:{owner/name}"
  source: 'gh' | 'http' | 'git-meta' | 'error'
  fetchedAt: string                // ISO 8601
  error: string | null
  issueError?: string | null       // Issue 拉取独立失败（不影响 PR 数据）
  degradedNote?: string            // 例如「gh 失败（…），已降级为 HTTP API」
  elapsedMs?: number
  coverage: { limited: boolean; details: 'on-demand' }
  repo: RepoMeta                   // { key,name,owner,path,defaultBranch,description,localPath? }
  mrs: MR[]
  issues: Issue[]
}

interface MR {
  number: number; title: string; author: Person
  state: 'open' | 'merged' | 'closed'; draft: boolean
  sourceBranch: string; targetBranch: string
  createdAt: string; updatedAt: string; mergedAt: string | null
  additions: number; deletions: number; changedFiles: number; labels: string[]
  ciState: 'success' | 'failure' | 'pending' | 'none' | 'unknown'   // none=查了但没有 check；unknown=本次未查询
  reviewDecision: 'approved' | 'changes_requested' | 'pending' | 'none'
  requestedReviewers: string[]; reviews: Review[]; comments: ReviewComment[]
  url: string; body: string; headSha: string; baseSha: string
}

interface ReviewComment {
  id: string; author: Person; body: string
  file: string | null; line: number | null; createdAt: string
  resolved: boolean | null         // null = 未知（gh/REST 不返回线程解决状态）
  kind: 'comment' | 'conversation'
}
```

`resolved` 为 **`null`（未知）**而非 `false` —— gh/REST 评论不携带线程解决状态，未知不能当成未解决；`unresolvedCount` 与 `needsReplyCount` 只计 `resolved === false`。

派生字段（`decorate`）：

| 字段 | 计算逻辑 |
|------|----------|
| `needsMyReview` | open && !draft && me ∈ requestedReviewers && me 未提交 `approved`/`changes_requested`（GitHub 只在这两种评审下清除评审请求，`commented` 仍算待我评审） |
| `commentCount` | `comments.length` |
| `unresolvedCount` | `comments.filter(c => c.resolved === false).length` |
| `needsReplyCount` | 未解决 && author ≠ me && (mr.author = me ∨ reviewDecision = changes_requested) |
| `reviewCount` | `reviews.length` |

`buildOverview` 输出 `summary / repos[] / statusDist / activity[30天] / topReviewers[8] / recent[24] / coverage / generatedAt`，其中 `coverage.note` 固定说明样本口径（gh 每仓库 200 条上限、HTTP 首批、按需评论、未获取线程不计未解决）。`summary` 另带 `unknownResolutionComments`（`resolved == null` 的条数）与 `resolutionAvailable`——**后者回答的是「未解决 0 到底可不可信」，而不是「评论数是不是 0」**。它按三态取值：任一条评论带明确的 `true`/`false` 时为 `true`；评论已按需加载（存在 `detailLoaded` 的 MR）且确实一条都没有时为 `true`（此时的 0 是既成事实）；**空列表但详情从未加载时为 `false`**，因为评论只在 `op=reviews` / PR 详情路径按需拉取，空 `allComments` 通常意味着「还没查」而非「已知为 0」，不能把「未查询」包装成确信的 0。UI 据此在 `resolutionAvailable !== true` 时显示「未知」而非 0。

---

## 5. Provider 设计

### 5.1 调度

```
planSource(repo, cfg, ghOk):
  'gh'   → gh
  'http' → http
  'git'  → git-meta（仅元信息，不能取 PR/Issue；相关请求返回 503）
  'auto' → ghOk ? gh : (实例有 token ? http : error)
```

### 5.2 gh Provider

`gh pr list --state all --limit 200 --json <平铺字段>` + `gh issue list` 同规格；详情、diff、组织展开、评论与发布走 `gh api --hostname <host> …`，分页读取使用 `--paginate --slurp`。

关键点（详见 [gh-cli-contract.md](gh-cli-contract.md)）：`gh --json` 只接受**顶层平铺字段**，嵌套选择器 `author{login,name}` 会被 gh 在发请求前本地拒绝；`statusCheckRollup` 虽在 list 合法，但 200 条全状态 PR 带上它会让 GraphQL 网关 502/504（实测 ≥80 条稳定失败、≤60 条成功），所以列表主体不申请它，CI 由并行的 `--state open --json number,statusCheckRollup` 补齐，未覆盖的历史 PR 记为 `unknown`。仓库默认分支与描述来自 `gh repo view`（软失败，未知即留空），不再拿「最近一条 PR 的目标分支」冒充。

执行方式：`execFile`（无 shell）、固定参数数组、30s 超时、16MB 缓冲、`GH_PROMPT_DISABLED=1`、`GH_PAGER=cat`；token 按实例 host 选择 `GH_TOKEN` 或 `GH_ENTERPRISE_TOKEN`，并在注入前清除继承来的其它 token 环境变量。

### 5.3 HTTP Provider

REST 列表 + 逐 PR 详情（受 `http.detailLimit` 预算约束），`fetch` + `Authorization: Bearer <token>`，`perPage`/`detailLimit`/`timeoutMs` 可配置；分页最多 100 页后报 422 而不是静默截断；`AbortSignal.timeout` 控制单次请求；`redirect: 'error'` 防止 token 随重定向外泄。CI 状态恒为 `none`（不逐 PR 拉 check-runs，属诚实降级）。

### 5.4 传输回退规则

`githubRequest()` 先试 `gh api`，失败后**只对 GET** 且实例有 token 时才回退 REST。写操作（`method !== 'GET'`）失败绝不换渠道重发 —— CLI 退出码不能证明 GitHub 未收到请求。

### 5.5 缓存与并发

| 项 | 值 | 说明 |
|----|-----|------|
| TTL | `pollMinutes × 60s`（默认 10 分钟） | 绑定 `store.rev`，配置变更即失效 |
| 并发 | 3 | `mapLimit` |
| 仓库解析缓存 | 同 TTL + rev | 组织展开结果复用 |
| gh 探测缓存 | 5 分钟 | 避免每仓库重复 `auth status`；`invalidate()` 一并重置 |
| 整轮去重 | `inflight` promise | 并发请求合并为一次刷新 |
| 页面缓存 | mtime 校验 | `web/index.html` 不逐请求读盘 |
| 预热 / ticker | 启动后 3s；60s 检查 TTL | 不阻塞插件激活 |

快照**不持久化**：重启后重新拉取。这是刻意取舍 —— 避免陈旧数据被误读为实时状态。

---

## 6. 工作流设计

### 6.1 AI 检视（`review.create` → `review.publish`）

```
review.create {repoKey,number,confirmed:true}
  ├─ 确认门 + 服务/配置校验（llm.stream、sessions.create/flush、cfg.ai.provider/model）
  ├─ disk.read()：历史审计状态不可恢复时拒绝调用模型
  ├─ getPullRequest(diff) → assertBinding + assertOpen + head SHA 校验
  ├─ reviewSnapshot()：字段 8KB、diff 64KB 上限，截断时置 truncated
  │   并在草稿正文尾部追加「检视范围受限」声明
  ├─ 落盘 status='generating'（先落盘再调模型）
  ├─ sessions.create + append(system/user/request/header) + flush
  ├─ llm.stream(request, AbortSignal.timeout(120s)) → 汇总流式 block（模型输出上限 96KB）
  ├─ parseReviewOutput(rawText, snapshot)
  │    ├─ 成功：summary + findings 归一化（别名/截断/去重/排序/12 条上限）→ body 由清单合成
  │    └─ 失败：structured=false，body 为原始文本（按 32KB 边界裁剪），findings=[]（降级不整体失败）
  └─ 落盘 status='draft' + structured/reviewSummary/findings/findingsTruncated/parseWarnings；
     失败则 status='failed' 并保留 failure
  · 同一 MR 并发 → 409（进程内 generating 锁，避免前端超时后重复调用模型）

review.latest {repoKey,number}（GET）
  └─ 按 repoKey+number 取 createdAt 最新草稿（含 generating），无则 draft:null（200，不是 404）

review.publish {id,body?,confirmed:true}
  ├─ 状态机：published 幂等返回（且禁止改正文）/ publishing|publish_unknown → 409 needsVerification
  │          / 仅 draft 可发布
  ├─ 记录 store.rev，预检后校验 rev 未变（配置竞态 → 409）
  ├─ 预检：仓库与 PR 标识、URL、仍为 open、head SHA 未变；预检失败回退为 draft
  └─ publishReview() 固定 POST repos/{path}/pulls/{n}/reviews
        { event:'COMMENT', body, commit_id }
       · 成功 → published + 远端结果
       · 任何派发后错误 → publish_unknown + needsVerification，永不自动重发

review.issues.create {id,findingIds[],confirmed:true}
  ├─ 确认门 + 严格 findingIds 校验（非空/去重/1–10/格式）+ filing 锁（并发 → 409）
  ├─ 草稿需 structured===true 且有清单（否则 409）；creating/unknown 条目 → 409 needsVerification
  ├─ created 条目幂等跳过（不重复 POST）；队列为空直接 200 返回
  ├─ 顺序逐条：issueStatus='creating' → createIssue() → created | failed | unknown
  │    · knownNotCreated（4xx / 未派发）→ failed（可重试）
  │    · 网络/超时/5xx/响应无法解析 → unknown（永不自动重试）
  │    · fail-fast：遇错即停，剩余保持 idle
  └─ 90s 批次预算与配置变更检测 → stopped: null|timeout|config|error
     createIssue() 固定 POST repos/{path}/issues {title,body}，端点与字段名不受客户端控制；
     该路径启用 preserveStatus 保留 GitHub 原始状态码（评审发布路径行为不变）。
```

检视是**辅助调用而非 Agent 回合**：结果与失败都活在审计工件里，不伪造 assistant 结算或 turn id。请求不带任何工具，GitHub 内容以「不可信数据」前缀送入模型。`publish_unknown` 与 `unknown` 同哲学：不确定就停，永不自动重试。

### 6.2 Issue 开发（`issue.develop`）

```
确认 → getIssue → assertBinding
     → repo.localPath 必填 → verifyLocalRepo() 校验 origin 与 Issue 仓库一致，返回绝对 cwd
     → 进程内 developing 集合去重（同 filePath+repoKey+number 并发 → 409）
     → 读/建关联：sessionId=session-<uuid>、requestId=codehub-issue-<uuid>、context=issueContext(data)
     → status==='ready' → 直接复用返回 {sessionId, reused:true}
     → 已有关联但 cwd / repositoryPath 变化 → 409（不静默迁移会话）
     → sessionController.create({cwd, sessionId})；返回 id 不一致即 503
     → sessionController.prompt({sessionId, requestId, content, mode:'followup'},
                               AbortSignal.timeout(60s))
     → accepted !== true → 503；否则落盘 status='ready'
```

重试永远复用同一 sessionId/requestId 与同一份上下文，因此不会产生第二份任务。SPA 拿到 sessionId 后经宿主桥接 `open-session` 打开原生会话；后续工具执行仍由宿主的批准与安全机制控制。

### 6.3 审计持久化

路径：`<configPath>.workflows.json`（默认 `~/.dsh/codehub-dashboard/config.json.workflows.json`）。

- 写入序列：`open → write → fsync → rename`，配合 `.lock` 与 `MAX_STATE_BYTES`（48MB）上限。
- 草稿上限 100（保护态 `generating/publishing/publish_unknown` 不被淘汰），Issue 关联上限 1000。
- 读取时 `validateState()` 校验状态集合与 id 唯一性；无法恢复的历史状态 **fail-closed**，不覆盖既有发布证据。
- 记录含代码、Issue 正文与模型输入输出，属敏感文件，不要提交或同步。

---

## 7. 配置设计

`~/.dsh/codehub-dashboard/config.json`（可被 bundle `configPath` 或 `CODEHUB_DASHBOARD_CONFIG` 覆盖）：

```jsonc
{
  "version": 1,
  "provider": "auto",            // auto | gh | http | git（历史值 git-meta 自动迁移为 git）
  "me": { "name": "", "login": "" },
  "pollMinutes": 10,
  "ghPath": "gh",
  "instances": [{ "id": "i1", "name": "GitHub", "host": "github.com", "token": "" }],
  "repos": [{ "id": "r1", "instance": "i1", "path": "owner/name", "localPath": "", "enabled": true, "defaultBranch": "" }],
  "organizations": [{ "owner": "some-org", "instance": "i1", "enabled": true }],
  "ai": { "provider": "", "model": "" },
  "http": { "perPage": 100, "detailLimit": 25, "timeoutMs": 15000 }
}
```

`normalize()` 负责区间钳制（perPage 1–100、detailLimit 0–50、timeoutMs 1–60s、pollMinutes 1–1440）、`provider` 白名单与 `git-meta → git` 迁移，并丢弃 UI 派生的 `hasToken`。`store.set()` 校验实例 id 唯一/host 合法、仓库 `owner/name`、组织名正则、引用完整性，保存队列串行化，成功后 `rev++`。

安全规则：token 仅在响应中脱敏（`****`+末 4 位）；masked 值回传时保留原 token，但**更换 host 必须清空重填**（否则 400）；临时文件带 pid+随机后缀防撕裂；POSIX `mode 0600` + `chmod`，Windows 上 chmod 为 no-op（真正屏障是目录 ACL）。

---

## 8. HTTP API 设计

挂载于 `/codehub` prefix。完整参数与响应见 [api-reference.md](api-reference.md)。

### 8.1 请求栅栏（顺序固定）

1. `ctx.connection.admit(req)`：方法不存在 → 503；返回含 `rejection` → 401（登录失效）或 403（未通过信任校验）。校验通过前不读配置、不访问 GitHub。
2. `ensureBoot()`：配置加载失败时回滚 `booted`，允许下次重试。
3. 路径分派：`/codehub`（及 `/`、`/index.html`）返回 SPA（CSP + `nosniff` + `no-referrer` + `no-store`）；`/codehub/api` 进入 op；其它 404。
4. 写 op（`config.set`、`config.test`、`review.create`、`review.publish`、`review.issues.create`、`issue.develop`）：非 POST → 405；Origin 主机不匹配或 `sec-fetch-site: cross-site` → 403；`content-type` 非 `application/json` → 415；其余 op 非 GET → 405。
5. body 上限 256KB，`readBody` 超限后立即短路后续 data 事件。

### 8.2 op 一览

`boot`、`summary`、`overview`、`mrs`、`mr`、`mr.diff`、`issues`、`issue`、`reviews`、`activity`、`refresh`、`models`、`review.create`、`review.get`、`review.latest`、`review.publish`、`review.issues.create`、`issue.develop`、`config.get`、`config.set`、`config.test`、`repos.discover`（共 22 个）。

`config.set` 立即返回 `{ok, config:masked, overview:null, refreshQueued:true}`，随后在后台刷新 —— 保存不等待上游。

`mrs` 响应为 `{ok,total,mrs,errors,coverage}`：`errors` 列出拉取失败的仓库，`coverage` 与 overview 共用 `buildCoverage()` 口径；失败仓库不会以空行静默消失。

---

## 9. Dashboard UI 设计

### 9.1 视图（7 个）

| 视图 | Hash | 内容 |
|------|------|------|
| 概览 | `#/overview` | KPI、仓库健康、最近动态 |
| MR | `#/mrs` | 筛选（仓库/状态/CI/待我评审/未解决/搜索/排序）+ 列表 + 详情抽屉（评论、diff、AI 草稿） |
| Issue | `#/issues` | 筛选 + 列表 + 详情抽屉（开始开发） |
| 检视意见 | `#/reviews` | 收件箱，按 MR 分组 |
| 仓库 | `#/repos` | 仓库卡片与错误/降级说明 |
| 统计 | `#/stats` | 折线 / 环形 / 双水平柱（全内联 SVG/HTML） |
| 设置 | `#/settings` | 数据源、身份、实例、仓库、组织、模型、gh CLI、连通性测试 |

### 9.2 诚实性渲染

| 情形 | 渲染 |
|------|------|
| 整列请求失败 | `listFailure(err)`：错误文案 + 刷新重试提示，不显示空列表 |
| 部分仓库失败 | `partialErrors(data.errors)`：列出失败仓库与原因；PR 列表由服务端 `errors` 提供，不再只靠前端推断 |
| 样本受限 | `coverageNote(coverage)`：说明统计口径 |
| 详情分段缺失 | `detailErrors(...)`：提示「部分信息未返回，当前详情不完整」，建议重新打开重试并在 GitHub 核对 |
| 解决状态未知 | 显示「未知」，不计为未解决 |

`state.issueError / rvError / modelsError` 等为三态（未加载 / 失败 / 成功），加载中文案独立于失败文案。

### 9.3 并发与路由守卫

`overviewSeq / mrSeq / rvSeq / issueSeq / routeSeq / detailSeq` 生成号守卫：过期响应与已被取代的路由不得再写入 state 或发起后续列表请求。所有列表视图先确保 overview（仓库清单）就绪，再加载本页数据。

其余交互：350ms 防抖搜索、render 前后恢复焦点与光标位置、事件委托（click/change/input + `data-*`）、右侧抽屉与 Esc/遮罩关闭、toast、页面可见时 60s 自动刷新（设置页脏状态跳过）、`prefers-color-scheme` 变量主题。

---

## 10. 测试策略

`npm test` = `node --test scripts/test-data.mjs scripts/test-api.mjs scripts/test-workflows.mjs scripts/test-client.mjs`（**117 用例 / 117 pass / 0 fail**）**+** `node scripts/test-host.mjs`（**92 断言 / 92 passed / 0 failed**），合计 **209** 项检查。

| 文件 | 用例 | 覆盖 |
|------|------|------|
| `scripts/test-data.mjs` | 29 | gh 字段契约、映射、CI 聚合、分页解析、配置脱敏、REST 回退与保留旧数据 |
| `scripts/test-api.mjs` | 4 | 配置归一化、provider 调度与缓存、filterMrs、鉴权围栏、Origin/415、保存不阻塞、mrs 错误与 coverage |
| `scripts/test-workflows.mjs` | 23 | 确认门、状态机、SHA/配置竞态、`publish_unknown`、持久化与崩溃恢复、宿主 `create/prompt` 契约（含 signal 必填断言）；4 种终止原因展开为 4 个用例 |
| `scripts/test-client.mjs` | 61 | SPA 渲染与状态机：三态失败、coverage/detailErrors、路由守卫、工作流交互、设置保存；列表/视图用表驱动展开 |
| `scripts/test-host.mjs` | 92 断言 | 真实 node:http + fake cordis ctx 的端到端 op 验证（含 CSP、401/403/405/415、256KB body 上限、脱敏、discover、inject 扁平数组契约、README/使用文档守卫） |

测试使用可控 fixture，**不发布真实评论、不调用收费模型**；gh 字段检查用本地无效字段请求验证，不依赖真实登录。`npm run dev` 监听 `127.0.0.1:4173`（`PORT` 可改），使用独立临时配置并在退出时清理，不读取或修改真实 DSH 配置。

---

## 11. 部署与排查

安装：`dsh plugin --profile desktop add <仓库根绝对路径>`（仓库根即包根）→ 重启 DSH → 左侧 **CodeHub**。详见 [packaging-and-offline-install.md](packaging-and-offline-install.md)。交付件归档在 `releases/`，`.tgz` 不入 git。

| 现象 | 排查 |
|------|------|
| 左侧无入口 | 确认 bundles 含 `dsh-codehub-dashboard`，且宿主 ≥ 0.2.0-rc.2（原生 slots） |
| API 全 503 | `connection` 服务不可用（宿主异常），非插件配置问题 |
| AI 按钮禁用 | `boot.capabilities.ai === false`，或 `cfg.ai.provider/model` 未填 |
| 开始开发失败 | 仓库未绑定本地克隆，或 origin 与 Issue 仓库不一致 |
| 发布提示需核实 | `publish_unknown`：先去 GitHub 确认，不要直接重发 |
| 全部报错 | `gh auth status`；或为实例配置 token 走 HTTP |
| 数据不更新 | 调小 `pollMinutes` 或使用刷新 |

---

## 12. 明确不做

- **自建 Agent / 模型认证**：交给宿主 `llm` / `sessions` / `sessionController`。
- **快照持久化（SWR）**：重启即重拉，避免陈旧数据被当成实时状态。
- **批准/拒绝型评审发布**：只发 COMMENT。
- **HTTP provider 的 CI 状态**：需逐 PR 追加 check-runs 请求，代价过大，显示 `CI —`。
- **列表虚拟化**：窗口化方案见 [layout-and-dataflow-optimization.md](layout-and-dataflow-optimization.md)，属未实施提案；当前保留「一屏纵览」的滚动语义。
