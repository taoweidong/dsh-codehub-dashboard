# MR AI 检视 → Issue 设计方案 · 分析与优化

> 附 `ai-review-to-issue-design.md`（v0.1.6 设计稿，2026-10-17）  
> 分析日期：2026-10-18  
> 方法：对照 `workflows.js` / `index.js` / `web/index.html` 当前实现逐条核实设计中的「代码事实」与「新增假设」

## 0. 总体评价

方案骨架成立，质量高于平均设计稿：

- **复用优先**落到实处：扩展 review 草稿而非新工作流，确认门 / SHA 校验 / 审计持久化 / `publish_unknown` 失败哲学全部复用。
- **一次模型调用**同时产出评论与清单，避免费用与双份结果不一致。
- **诚实性口径**到位：`unknown` 不自动重试、`coverage` 必须展示、`null` 文案为「无法核对」而非「未命中」。
- **状态机** `idle→creating→created/failed/unknown` 收敛、幂等、终态清晰。

下面只列**需要修正或补充**的点，按优先级排序。多数不是「设计意图错」，而是「设计没写清、而代码现状会直接破坏该意图」。

## 1. 已对照代码核实的事实

| 编号 | 设计中的说法 | 代码现状（核实） | 结论 |
|------|--------------|------------------|------|
| F1 | 7.6 需要 `githubRequest` 增加 `preserveStatus` 把 4xx 原样抛出 | `index.js:507` gh 写失败一律 `apiError(cliError, 502)`；`index.js:520` http 路径仅 404 保留，其余一律 502 | **4xx 目前在两条路径都不会保留**，设计的前提尚未存在 |
| F2 | 新增 `review.latest` 恢复最近草稿 | 现有只有 `getReview(id)`（按 UUID）与 `reviews`（评论列表），无按 `(repoKey, number)` 扫描的函数 | `latestReview` 是真新增，需新增扫描逻辑 |
| F3 | `review.issues.create` 输入只传 `id` + `findingIds` | `getReview(id)` 确实按 `findDraft(state, id)` 查（`workflows.js:231`） | 输入不含 repoKey/number 可行，身份来自 draft 本身 |
| F4 | `createIssue` 注入并复用 `store.rev` 竞态保护 | `createWorkflows` 已注入 `store`（`index.js:1105`），`publishReview` 同款 `revision = store.rev` 校验（`index.js:1107`） | 实现路径存在，照搬即可 |
| F5 | 文本上限调到 96KB | `reviewText` 在 body 聚合阶段硬上限 `MAX_BODY_BYTES-256`=32KB（`workflows.js:276`） | 改造需把「原始输出上限」与「评论正文上限」拆成两层 |
| F6 | 客户端 20s 超时 < 服务端 120s | `web/index.html:314` 固定 20s；`REVIEW_TIMEOUT_MS=120000`（`workflows.js:12`） | Phase 0 提 150s 正确，但需保证不等式约束 |
| F7 | 新增进程内 `generating` 锁 | 现有 `developing` 锁为 module-level Set，键 `JSON.stringify([resolve(filePath), repoKey, number])`（`workflows.js:19,456`） | 可直接照搬模式 |

## 2. 必须修正的点（正确性 / 回归风险）

### 2.1 `preserveStatus` 必须同时覆盖 gh 与 http 两条路径（最高优先级）

设计 7.5 错误分类表依赖「4xx → `failed`（已知未创建），网络/5xx/超时 → `unknown`」。
但当前 `githubRequest`：

- **gh 路径**（`index.js:503-508`）：CLI 非零退出时设置 `cliError`，随后 `if (method !== 'GET' || !inst?.token) throw apiError(cliError, 502)`——**403/422/429 一律变成 502**。
- **http 路径**（`index.js:520`）：`throw apiError('GitHub HTTP ...', response.status === 404 ? 404 : 502)`——**除 404 外一律 502**。

后果：Issue 创建遇到「无权限 / 校验失败 / 限流」时，`workflows.js` 会把它们误判为 `unknown`（网络/5xx 桶），与 7.5 设计意图相反，且 `unknown` 永久禁止重试会让「本来可重试的明确失败」卡死。

**修正**：
- `preserveStatus` 选项必须同时作用于 gh 与 http 两条路径。
- gh 路径需从 `cliError`（stderr）里解析 `HTTP 4xx` 关键字，映射为对应状态码；解析不到则维持 502（归入 unknown）。
- 仅 `review.issues.create` 这一调用启用，不影响 `review.publish`（保持现有 502→publish_unknown 行为）。
- 把 13.1 里 test-data.mjs 的「若调整 4xx 透传则补」**升级为必须覆盖**。

### 2.2 96KB 模型输出上限与 32KB 评论上限必须拆两层（Phase 1 隐藏耦合）

设计 7.1 说「把文本上限调到 96KB」，7.2 步骤 5 说「降级时原文按 32KB 裁剪」。
当前 `reviewText` 只有一个 `MAX_BODY_BYTES-256` 上限（`workflows.js:276`），且它返回的 `body` 既是「原始模型文本」（正常路径交由 `parseReviewOutput` 解析），又是「降级评论正文」。

风险：若只把 `reviewText` 上限改成 96KB，降级草稿的 `draft.body` 会达到 96KB；
而 `publish` 在用户未改 body 时仍用 `current.body` 走 `reviewBody()` 的 32KB 校验（`workflows.js:405`）→ **降级草稿超 32KB 时 publish 直接 400**。

**修正**：
1. `reviewText` 聚合上限改为 `MAX_MODEL_OUTPUT_BYTES`（96KB）——这是原始输出层。
2. 解析失败时，再对降级 `body` 单独做 32KB UTF-8 边界裁剪（`bounded(..., MAX_BODY_BYTES)`），裁剪后追加「模型输出已截断」提示。
3. 这两个改动必须在**同一个 PR** 配对落地，否则中间态会破坏 publish。建议在实施计划 Phase 1 显式绑定。
4. 防御性：给 `composeReviewBody` 输出也过一遍 `bounded(..., MAX_BODY_BYTES)`，防止模型 summary 被篡改超长。

### 2.3 `generating` 锁的获取时机要与 `developing` 对齐

设计 7.1 把「获取 in-flight 锁」放在 `getPullRequest` **之前**。现有 `developing` 锁在 `disk.read()` 之后、`getIssue` 之前（`workflows.js:456-458`）——即「确认能力/配置、确认能读审计」之后再锁。

锁过早会挡掉「合法的重试恢复」（例如前一个请求因客户端 20s 超时已 409 退出、但服务端其实没在生成）；锁过晚会漏掉并发。
**修正**：明确 `generating` 锁的获取点放在「能力/配置校验通过、`disk.read()` 成功之后、真正发起 `getPullRequest` 之前」，与 `develop` 保持一致。键沿用 `JSON.stringify([resolve(filePath), repoKey, number])`。

### 2.4 超时不等式约束写成硬规则

各超时当前取值：客户端 150s（计划）> 服务端 `REVIEW_TIMEOUT_MS` 120s（现状），轮询上限 180s（设计）> 120s。均成立，但都是「碰巧」。
**修正**：在常量表旁写明不等式约束：

```
CLIENT_REVIEW_TIMEOUT_MS (150) >= REVIEW_TIMEOUT_MS (120)
GENERATING_POLL_MAX_MS (180)  >= REVIEW_TIMEOUT_MS (120)
CLIENT_REVIEW_TIMEOUT_MS      >= REVIEW_TIMEOUT_MS   // 否则客户端先断、服务端继续生成
```

## 3. 一致性 / 边界澄清

| 编号 | 点 | 建议 |
|------|----|------|
| C1 | `review.issues.create` 不传 repoKey/number | 明确「身份来自 draft 而非入参」；`id` 必须复用 `draftId()`（UUID 正则，`workflows.js:62`）校验，否则 400。避免实现者照抄 `target()` 要求传 repoKey/number 造成前端契约漂移 |
| C2 | 轮询用 `review.get` 还是 `review.latest` | 5.2 说轮询 `review.get`，但 `review.latest` 同样返回最新草稿。**统一用 `review.latest` 轮询**，少传一个 id、语义一致、缩小 op 使用面 |
| C3 | `unknown` 是否跨草稿传染 | 状态机里 `unknown` 仅针对**当前草稿的该条记录**；重新检视生成新草稿（新 id、新 f1..f12）不受旧 `unknown` 约束。建议在开放问题里显式写明，否则实现者可能误以为 unknown 会跨草稿传染 |
| C4 | evidence 中的 `@mention` | 证据用四空格缩进代码块（`7.7`），GitHub 在代码块内**不解析** `@mention`，故 evidence 无需零宽空格中和。建议在文档点明，消除实现者疑虑 |
| C5 | Issue 正文 `mr.url`/`headSha` 来源 | `createIssue` 应从 draft 的 `headSha`/`input.mr.url`/`input.mr.state` 取值（createReview 时的快照），**不重新请求 GitHub**——与 7.5 步骤 8「不要求 MR 仍为 open」一致，确认即可 |
| C6 | `validateState` findings 校验短路 | 仅当 `structured === true` 时深校验 findings；旧草稿（`structured === undefined`）完全跳过，避免 100 条旧草稿在启动时拖慢或误判结构化失败 |

## 4. 优化建议清单（按价值）

1. **Phase 1 双层上限 + 降级裁剪绑定同 PR**（见 2.2）——最高回归风险。
2. **preserveStatus 双路径覆盖**（见 2.1）——最高正确性风险。
3. **轮询统一用 `review.latest`**（C2）——减少 op 面，降低前端复杂度。
4. **常量集中 + 不等式约束**（见 2.4）——防日后改一边忘另一边。
5. **`review.latest` 在 Phase 0 即按最终契约实现**（按 repoKey+number 取最新、含 `generating` 状态），不要「先只返回草稿」——Phase 2 UI 直接依赖，提前定好避免二次返工。
6. **`composeReviewBody` 输出过 `bounded(..., MAX_BODY_BYTES)`**——防御性长度保护。
7. **fail-fast 在 `unknown` 后继续创建是否合理**：当前 `unknown` 即 `break`。理由（避免连锁未知）成立；但建议把 `stopped` 原因在 UI 文案里区分「timeout / config / error / unknown」，让用户知道剩余为何保持 idle。
8. **测试缺口补充**：除 13.1 已列用例外，强制补两条：① `githubRequest` preserveStatus 后 4xx→failed 映射；② `review.latest` 在多草稿 + 旧草稿无 `structured` 下返回最新且不误判。
9. **体验权衡记录**：5.2「不持久化临时勾选」避免多窗口分叉，但代价是「用户取消某 blocker 后刷新又被默认勾上」。本期可接受；未来可只持久化「显式取消/补选的 diff 集合」。

## 5. 对实施计划的修订

| Phase | 现有计划 | 修订 |
|-------|----------|------|
| Phase 0 | 新增 `review.latest`「先只返回草稿，不做 UI」 | 按最终契约实现（含 `generating` 状态、按 repoKey+number 取最新）；写 `generating` 锁并绑定获取时机（见 2.3） |
| Phase 1 | 调 `MAX_TOKENS`、加常量、`parseReviewOutput` 等 | **必须**把「`reviewText` 上限→96KB」与「降级 body→32KB 裁剪」配对；`composeReviewBody` 加防御性 `bounded`；`validateState` 仅在 `structured===true` 深校验 findings |
| Phase 2 | 实现 `createIssue` + `preserveStatus` | `preserveStatus` 同时覆盖 gh（stderr 解析 `HTTP 4xx`）与 http 路径；`id` 走 `draftId()` 校验；轮询改用 `review.latest` |
| Phase 3 | 文档 + lint/test + 真实宿主 | 测试补 2.1 / 2.2 回归用例；真实宿主验收明确覆盖「无权限 token → failed 可重试」「断网 → unknown 禁重试」 |

**结论**：设计意图无需推翻，主要把三处「代码现状会直接破坏设计意图」的缺口（4xx 状态不保留、双层上限耦合、锁时机）写死为实施约束，并把若干边界澄清进文档即可落地。
