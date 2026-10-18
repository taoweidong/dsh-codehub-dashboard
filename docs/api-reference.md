# API Reference

> dsh-codehub-dashboard v0.1.5 HTTP API 完整参考 | 最后更新：2026-10-17

## Base URL

所有端点挂载在 DSH webServer 的 `/codehub` prefix route 下。响应一律 `cache-control: no-store`。

---

## 访问控制（先于任何 op 执行）

| 顺序 | 检查 | 失败响应 |
|------|------|----------|
| 1 | `ctx.connection.admit(req)` —— DSH 原生信任校验 | 服务不可用 → **503**；`rejection=401`（登录失效）→ **401**；`rejection=403` → **403** |
| 2 | `ensureBoot()` 配置就绪 | 加载失败时回滚，下次请求重试 |
| 3 | 路径分派 | 非 `/codehub`、`/codehub/`、`/codehub/index.html`、`/codehub/api` → **404** |
| 4 | 写 op 额外栅栏 | 非 POST → **405**；Origin 主机不匹配或 `sec-fetch-site: cross-site` → **403**；`content-type` 非 `application/json` → **415** |
| 5 | 读 op 方法 | 非 GET → **405** |

写 op：`config.set`、`config.test`、`review.create`、`review.publish`、`review.issues.create`、`issue.develop`。

`GET /codehub/index.html` 返回 SPA，并带：

```
content-security-policy: default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline';
  img-src 'self' data:; connect-src 'self'; font-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'
x-content-type-options: nosniff
referrer-policy: no-referrer
```

POST body 上限 256 KB，超限立即拒绝并短路后续数据事件。

---

## GET /codehub/api?op=boot

初始化端点，SPA 首个请求。

**Response:**
```json
{
  "ok": true,
  "version": "0.1.5",
  "config": { /* 脱敏配置 */ },
  "configPath": "C:/Users/you/.dsh/codehub-dashboard/config.json",
  "capabilities": { "ai": true, "develop": true, "issueWrite": true },
  "summary": { /* Summary 或 null */ },
  "hasData": true,
  "generatedAt": "2026-10-15T12:00:00.000Z"
}
```

`capabilities` 决定是否启用 AI 检视 / Issue 开发 / 批量提 Issue 按钮（宿主可选服务缺失时为 `false`）：

| 字段 | 含义 | 为 false 时 |
|------|------|------------|
| `ai` | `llm.stream` + `sessions.create/flush` 可用 | 禁用「生成 AI 检视」 |
| `develop` | `sessionController` + 本地克隆校验可用 | 禁用 Issue 的「确认后在 DSH 中开发」与列表行「快速开始开发」 |
| `issueWrite` | 已注入 `createIssue`（Issue 写路径可用） | 禁用问题清单的「创建 N 个 Issue」 |

---

## GET /codehub/api?op=summary

轻量摘要，纯缓存读取，不触发上游 I/O。

**Response:** `{ ok, summary, generatedAt, cached }`

```json
"summary": {
  "repos": 3, "errors": 0,
  "openMrs": 12, "mergedMrs": 45, "closedMrs": 3,
  "needsReview": 4, "drafts": 2,
  "unresolvedComments": 0, "unknownResolutionComments": 26, "resolutionAvailable": false,
  "needsReply": 0,
  "failingCi": 1, "mergedThisWeek": 8, "totalComments": 67,
  "openIssues": 9, "closedIssues": 40, "assignedIssues": 2,
  "me": { "login": "taowd", "name": "陶伟东" }
}
```

`resolutionAvailable=false` 时，`unresolvedComments: 0` 与 `needsReply: 0` 只表示「本次没有拿到线程解决状态」，不代表没有未解决意见；`unknownResolutionComments` 给出 `resolved == null` 的条数，UI 显示「未知」且不把相关评论计入未解决/待回复。`resolutionAvailable` 只在两种情况下为 `true`：评论里已有明确的解决状态，或评论**确实按需加载过**且加载后为空——后者的 0 才是可信的。**评论未加载时，即使条数为 0 也返回 `false`**：「没有查询过」不等于「已知为 0」，未加载的空列表不能被当作确信的零。当前 gh/REST provider 不返回线程解决状态，因此实际响应通常为 `unresolvedComments: 0`、`resolutionAvailable: false`。

---

## GET /codehub/api?op=overview

完整看板数据；缓存过期时触发刷新。

**Query:** `force=1` 忽略 TTL 强制刷新。

**Response:** `{ ok, overview, lastRefreshAt }`

```json
"overview": {
  "summary": { /* 同上 */ },
  "repos": [ {
      "key": "github.com:cli/cli", "name": "cli", "owner": "cli", "path": "cli/cli",
      "description": "GitHub 仓库 cli/cli", "defaultBranch": "trunk",
      "source": "gh", "degradedNote": null, "error": null, "stale": false,
      "fetchedAt": "2026-10-15T12:00:00.000Z", "localPath": "", "url": "",
      "counts": { "open": 5, "merged": 20, "closed": 1, "needsReview": 2, "unresolved": 6,
                  "failingCi": 0, "drafts": 1, "mergedWeek": 3, "total": 26 },
      "lastActivity": "2026-10-15T10:30:00.000Z"
  } ],
  "statusDist": { "open": 12, "merged": 45, "closed": 3 },
  "activity": [ { "date": "2026-10-01", "opened": 3, "merged": 2, "comments": 5 } ],
  "topReviewers": [ { "login": "alice", "name": "Alice", "reviews": 12, "approvals": 8,
                      "changesRequested": 2, "comments": 24, "unresolved": 3, "score": 48 } ],
  "coverage": {
    "limited": true,
    "note": "统计基于已同步样本：gh 每仓库最多 200 条 PR / Issue，HTTP 为首批结果；CI 状态仅覆盖未合并的 PR，历史 PR 显示为未查询；意见按需加载，未获取的线程解决状态不计为未解决。不是完整历史统计。"
  },
  "recent": [ /* Event[]，最多 24 */ ],
  "generatedAt": "2026-10-15T12:00:00.000Z"
}
```

`coverage` 必须原样呈现给使用者：统计口径是样本而非全量历史。

---

## GET /codehub/api?op=mrs

MR 列表（多仓库聚合 + 筛选排序）。

| 参数 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `repoKey` | string | `""` | 按仓库过滤 |
| `state` | `all\|open\|merged\|closed` | `all` | 状态 |
| `q` | string | `""` | 搜索标题/编号/作者/源分支/标签 |
| `needsReview` | `1` | - | 仅待我评审 |
| `unresolved` | `1` | - | 仅有已确认未解决意见（`resolved === false`） |
| `author` | string | `""` | 按作者 login 或 name 精确匹配 |
| `ci` | `success\|failure\|pending\|none` | `""` | 服务端 CI 过滤（避免在前端截断数据上过滤） |
| `sort` | `updated\|created\|comments` | `updated` | `comments` 先按未解决数再按意见数 |
| `limit` | number | 200 | 1–500 |

**Response:** `{ ok, total, mrs[], errors[], coverage }` —— `total` 为过滤后总数，`mrs` 为截断后的页；`errors` 为拉取失败的仓库（`[{repoKey,error}]`），`coverage` 与 overview 同口径，供 UI 显式提示样本不完整。

返回字段（每条）：`number, title, author, state, draft, sourceBranch, targetBranch, createdAt, updatedAt, mergedAt, additions, deletions, changedFiles, labels, ciState, reviewDecision, requestedReviewers, url, needsMyReview, commentCount, unresolvedCount, needsReplyCount, reviewCount, repoKey, repoPath, repoName`。**不含** `reviews/comments` 正文，需要时走 `op=mr`。

`ciState` 取值 `success | failure | pending | none | unknown`；`none` 是「查了，该 PR 没有配置 check」，`unknown` 是「本次未查询」（已合并/已关闭的 PR、CI 查询软失败、HTTP provider）。`ci=` 过滤按字面值匹配，`ci=unknown` 用来查看未查询区间。

---

## GET /codehub/api?op=mr | op=mr.diff

单个 PR 详情；`mr.diff` 额外返回 diff。

| 参数 | 必填 | 说明 |
|------|------|------|
| `repoKey` | ✅ | 仓库 key |
| `number` | ✅ | PR 编号 |

**Response:**
```json
{
  "ok": true,
  "mr": { /* 装饰后的 MR，含 reviews[]、comments[]（resolved 可为 null）、body、headSha */ },
  "repo": { /* RepoMeta */ },
  "source": "gh",
  "detailErrors": ["repos/cli/cli/pulls/1/comments: HTTP 403 …"],
  "diff": "…仅 op=mr.diff…",
  "files": [ /* 仅 op=mr.diff */ ],
  "diffTruncated": false
}
```

`detailErrors` 非空表示评论/评审/文件等分段有未返回项，SPA 会显示「部分信息未返回，当前详情不完整」而不是空列表。

---

## GET /codehub/api?op=issues

Issue 列表。

| 参数 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `repoKey` | string | - | 按仓库过滤 |
| `state` | `all\|open\|closed` | `open` | 状态（SPA 默认 open） |
| `q` | string | `""` | 搜索编号/标题/作者/标签 |
| `assignee` | string | - | 按受理人 login 精确匹配 |

**Response:** `{ ok, total, issues[] /* 最多 500 */, errors[] }`

`errors` 为 `[{ repoKey, error }]`：Issue 拉取按仓库独立失败，不影响 PR 数据，但必须展示。

---

## GET /codehub/api?op=issue

Issue 详情（含分页拉取的评论）。**参数：** `repoKey`、`number`。

**Response:** `{ ok, issue: { number,title,body,state,author,assignees[],labels[],createdAt,updatedAt,closedAt,url,comments[] }, repo, detailErrors? }`

若该编号实际是 PR，返回 **400**「该编号是 PR，不是 Issue」。

---

## GET /codehub/api?op=reviews

检视意见收件箱（按需加载，受每仓库 `http.detailLimit` 预算约束）。

| 参数 | 类型 | 说明 |
|------|------|------|
| `repoKey` | string | 按仓库过滤 |
| `unresolved` | `1` | 仅 `resolved === false`（未知状态不计） |
| `needsReply` | `1` | 仅需我回复 |
| `q` | string | 搜索正文/作者/文件/MR 标题 |
| `limit` | number | 默认 300，最大 1000 |

**Response:** `{ ok, total, comments[], errors[], coverage }`

```json
{
  "id": "rc-1234-v-0", "repoKey": "github.com:org/repo", "repoPath": "org/repo", "repoName": "repo",
  "mrNumber": 1234, "mrTitle": "feat: …", "mrState": "open", "mrUrl": "https://…",
  "author": { "name": "Bob", "login": "bob" }, "body": "…", "file": "src/a.ts", "line": 42,
  "createdAt": "2026-10-12T10:00:00.000Z", "resolved": null, "needsReply": false, "kind": "comment"
}
```

`coverage` 恒为 `{ limited: true, note: "按仓库详情预算加载评论，线程解决状态未知；此列表不是完整历史。" }`。

---

## GET /codehub/api?op=activity

**Response:** `{ ok, activity[], recent[], topReviewers[] }`（取自同一次 overview 计算）。

---

## GET /codehub/api?op=refresh

强制刷新全部仓库（忽略 TTL）。**Response:** 同 `overview`。

---

## GET /codehub/api?op=models

宿主模型目录（需要 `llm.listProviders/listModels`，否则 503）。

**Response:**
```json
{ "ok": true, "providers": [ { "id": "p1", "name": "Provider", "models": [ { "id": "m1", "name": "Model" } ] } ] }
```

---

## POST /codehub/api?op=review.create

生成 AI 检视草稿（第一次确认）。

**Body:** `{ "repoKey": "…", "number": 1234, "confirmed": true }` —— 缺 `confirmed:true` → **403**；多余字段 → **400**。

**Response:** `{ ok, draft }`

```json
"draft": {
  "id": "uuid", "repoKey": "…", "number": 1234, "headSha": "40位sha",
  "status": "draft", "body": "…可发布的草稿正文（截断时附范围受限声明）…",
  "createdAt": "…", "completedAt": "…", "sessionId": "session-uuid",
  "diffTruncated": false, "inputTruncated": false,
  "input": { /* 送入模型的快照，含 repo/mr/diff/files */ },
  "output": { /* 流式聚合结果 */ },

  // 以下为结构化问题清单字段（v0.1.6 起）
  "structured": true,                 // 本次模型输出是否成功解析为清单；解析失败为 false
  "reviewSummary": "…模型摘要（≤4096 字符）…",
  "findings": [ /* 0..12 条，见下 */ ],
  "findingsTruncated": false,         // 模型返回超过 12 条，仅保留前 12
  "parseWarnings": []                 // 最多 5 条，如「2 条无效或重复问题已忽略」
}
```

`structured === true` 时 `body` 由摘要 + 问题表格自动合成（用户仍可编辑后发布）；`structured === false` 时模型输出未按 JSON 契约返回，`body` 为原始文本（按 32 KB 边界裁剪），`findings` 为空数组——降级不整体失败，仍可发布。旧草稿可能完全缺失这些字段，消费方请用 `draft.findings ?? []`。

`findings[]` 每条：

```json
{
  "id": "f1", "severity": "blocker", "category": "bug",
  "title": "空指针解引用", "file": "src/a.js", "line": 42,
  "evidence": "+ return user.name", "detail": "…", "suggestion": "…",
  "confidence": "high",
  "fileVerified": true, "evidenceVerified": true,
  "issueStatus": "idle", "issue": null, "issueError": null
}
```

| 字段 | 取值 |
|------|------|
| `severity` | `blocker \| major \| minor \| nit`（模型的 `critical/p0→blocker`、`high/p1→major`、`low/p3/suggestion→nit`，未知归一为 `minor`） |
| `category` | `bug \| security \| regression \| perf \| test \| maintainability \| other` |
| `file` / `line` | 未给出时为 `null` |
| `confidence` | `high \| medium \| low` |
| `fileVerified` | `true` 命中变更列表 / `false` 列表完整但未命中 / `null` 列表被截断或未给出（无法核对） |
| `evidenceVerified` | `true` diff 含该片段 / `false` diff 完整但未命中 / `null` diff 被截断或无证据 |
| `issueStatus` | `idle \| creating \| created \| failed \| unknown` |

文件/证据核验结果**只做展示与说明，不阻止提 Issue**——用户看到「证据未定位」仍有最终决定权。

客户端超时注意：该 op 允许最长 120s 的模型时间，前端调用需放宽超时（本插件用 150s），否则会出现「前端先超时、服务端仍在生成」并诱发重复调用。同一 MR 并发调用会返回 **409**。

状态取值：`generating | failed | draft | publishing | publish_unknown | published`。失败时 `failure: { message, finish? }`，响应 HTTP 状态取 `err.status`（服务缺失 503、PR 已关闭/标识变化 409）。

**输出预算（`ai.maxTokens`）**：检视请求的 `maxTokens` 取配置项 `ai.maxTokens`，默认 `16384`，写入时被钳制在 `1024–32768`（空值回落默认）。部分提供方把 `enable_thinking` 限制为必须为 `true`，推理消耗与 JSON 产出**共用**这一个上限；预算不足时模型以 `finish.kind = "max-tokens"` 结束，服务端按 fail-closed 拒收（`failure.message` 会明确提示「used all N output tokens … raise the AI output limit (ai.maxTokens)」，**不会**把半截 JSON 当成检视结果）。

---

## GET /codehub/api?op=review.get

按 id 读取审计草稿。**参数：** `id`（UUID，否则 400）。**Response:** `{ ok, draft }`。

---

## GET /codehub/api?op=review.latest

读取某 MR **最近一条** AI 草稿（按 `repoKey + number` 筛选、`createdAt` 取最新，含 `generating` 状态）。用于重新打开 MR 后恢复问题清单与 Issue 关联；纯只读，不触发模型。

**参数：** `repoKey`、`number`。

**Response:** `{ ok, draft }` —— 没有记录时 `draft` 为 **`null`（HTTP 200，不是 404）**，避免前端把「从未生成过」当错误处理。

---

## POST /codehub/api?op=review.issues.create

把草稿里勾选的问题批量创建为 GitHub Issue（单独一次确认；与发布评审互相独立）。

**Body:** `{ "id": "草稿UUID", "findingIds": ["f1","f3"], "confirmed": true }` —— 严格键集，多余字段 → **400**；`findingIds` 必须非空、去重、长度 1–10；缺 `confirmed:true` → **403**。

**Response（HTTP 200，即使部分失败；逐条状态在 `results`）：**

```json
{
  "ok": true,
  "draft": { /* 更新后的草稿，含每条 finding 的 issueStatus / issue */ },
  "stopped": null,
  "results": [
    { "findingId": "f1", "status": "created", "issue": { "number": 128, "url": "https://github.com/org/repo/issues/128", "createdAt": "…" } },
    { "findingId": "f3", "status": "failed", "error": "forbidden" }
  ]
}
```

`stopped`：`null`（全部尝试完）/ `"timeout"`（超过 90s 批次预算）/ `"config"`（批次中配置变更）/ `"error"`（遇到失败或未知后停止）。未尝试的条目保持 `idle`，UI 保留其勾选以便下次提交。

| 情形 | 响应 |
|------|------|
| 草稿不存在 | 404 |
| 草稿无有效清单（`structured!==true` 或 `findings` 为空） | 409 |
| 选中项含 `creating` / `unknown` | 409 `{ needsVerification: true, findingIds }` |
| 同一草稿并发 | 409（`filing` 锁） |
| 选中项全部为 `created` | 200 幂等返回，**不发任何请求** |

**错误分类**（决定该条变 `failed` 还是 `unknown`）：

| 错误 | 状态 | 理由 |
|------|------|------|
| GitHub 400/401/403/404/410/422/429 | `failed` | 服务器明确拒绝，Issue 未创建 |
| 本地参数/标题/正文校验失败、仓库解析失败、配置竞态 | `failed` | 请求没有到达 GitHub |
| gh CLI 非零退出但 stderr 含 `HTTP 4xx` | `failed` | 可证明被拒绝 |
| 网络错误、超时、5xx、响应无法解析 | `unknown` | 请求可能已到达 GitHub |

`failed` 可重试；`unknown` **永不自动重试**，须人工到 GitHub 核对（与 `publish_unknown` 哲学一致）。

写入实现要点：端点固定为 `repos/{仓库}/issues`，**客户端无法传入** owner/repo/编号之外的任何目标、label 或 assignee；`githubRequest` 在该路径启用 `preserveStatus` 保留 GitHub 原始状态码，其它调用（含评审发布）行为不变。**不要求 MR 仍为 open**——Issue 是对已发生检视的记录。

---

## POST /codehub/api?op=review.publish

发布草稿为 **COMMENT**（第二次确认）。

**Body:** `{ "id": "uuid", "body": "用户编辑后的正文（可选，省略则用草稿正文）", "confirmed": true }`

**Response:** `{ ok, draft, result }` —— `result` 为 GitHub 返回的 review 对象。

| 情形 | 响应 |
|------|------|
| 已 `published` 且正文一致 | 200 幂等返回，不重复发布 |
| 已 `published` 但想改正文 | 409 |
| `publishing` / `publish_unknown` | 409 `{ needsVerification: true, draftId }` |
| 非 draft 状态 | 409 |
| 预检失败（PR 关闭 / head 变化 / 标识变化 / 配置变更） | 409，草稿回退为 `draft` |
| 派发后任何错误 | 409 `publish_unknown` + `needsVerification`，**永不自动重发** |

`body` 必须非空且 ≤ 32 KB UTF-8。事件类型固定为 `COMMENT`，客户端无法传入 `APPROVE`/`REQUEST_CHANGES`。

---

## POST /codehub/api?op=issue.develop

创建或复用 DSH 原生开发会话。

**Body:** `{ "repoKey": "…", "number": 42, "confirmed": true }`

**Response:** `{ ok, sessionId, reused }` —— SPA 用 `sessionId` 经宿主桥接 `open-session` 打开会话。

失败：未绑定本地克隆 400；origin 与仓库不一致 400；`sessionController` 缺失 503；已有会话属于别的本地克隆 / 仓库标识变化 409；同一 Issue 正在启动 409。重试复用同一 `sessionId`/`requestId`，不会提交第二份任务。

---

## GET /codehub/api?op=config.get

**Response:** `{ ok, config /* token 脱敏为 ****末4位，附派生 hasToken */, configPath }`

---

## POST /codehub/api?op=config.set

保存配置。Body 为完整或部分配置对象；`token` 以 `****` 开头时保留原值，但**更换实例 host 时必须清空或重填**（否则 400）。

**Response:**
```json
{ "ok": true, "config": { /* masked */ }, "overview": null, "refreshQueued": true }
```

保存后立即返回并在**后台**刷新（`overview` 恒为 `null`）—— 保存不等待上游同步。校验失败 400（实例 id 重复/host 非法、仓库路径非 `owner/name`、组织名非法、仓库/组织引用不存在的实例等）。

---

## POST /codehub/api?op=config.test

连通性测试。

**Response:** `{ ok, results[] }`

```json
[
  { "target": "git", "kind": "cli", "ok": true, "detail": "git version 2.55.0", "ms": null },
  { "target": "gh", "kind": "gh-cli", "ok": true, "detail": "gh version 2.102.0", "ms": 120 },
  { "target": "GitHub", "kind": "instance-token", "ok": false, "detail": "token 未配置" },
  { "target": "GitHub", "kind": "http-api", "ok": true, "detail": "HTTP 200 github.com", "ms": 340 },
  { "target": "cli/cli", "kind": "local-repo", "ok": true, "detail": "E:/repos/cli" }
]
```

---

## GET /codehub/api?op=repos.discover

扫描工作区目录下的 Git 仓库（最多 40 个，跳过 `.*/node_modules/dist/build`）。

| 参数 | 必填 | 说明 |
|------|------|------|
| `ws` | ✅ | 工作区绝对路径；缺失 → 400 |
| `depth` | - | 1–3，默认 2 |

**Response:** `{ ok, repos: [{ path, name, remote, remotePath, branch }] }`

---

## Error Responses

统一格式 `{ "ok": false, "error": "…" }`，错误消息截断至 300 字符。

| Status | 场景 |
|--------|------|
| 400 | 未知 op、缺必填参数、非法 JSON / 配置 / repoKey / number / draft id |
| 401 | DSH 登录失效（`connection.admit` 拒绝） |
| 403 | 未通过 DSH 信任校验、跨站写请求、缺少 `confirmed:true` |
| 404 | 非 API 路径、MR/Issue 未找到 |
| 405 | 方法不匹配（写 op 收到 GET，读 op 收到非 GET） |
| 409 | 标识/SHA/配置变化、状态机拒绝、`publish_unknown`、并发启动 |
| 415 | 写请求 `content-type` 非 `application/json` |
| 422 | GitHub 分页超过 100 页 |
| 500 | 未标注 status 的服务端异常 |
| 502 | gh api 与 REST 均失败（GET 回退后）、GitHub 上游错误 |
| 503 | `connection` 服务不可用、可选原生服务缺失、`git` 模式请求 PR/Issue、未配置 token |
