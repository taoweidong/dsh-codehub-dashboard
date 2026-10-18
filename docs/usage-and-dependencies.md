# 使用说明与依赖

> 本文是 `dsh-codehub-dashboard` 的完整使用手册：依赖与兼容性、安装、配置、界面与工作流、数据口径、已知限制、安全边界、开发工具。README 只保留核心信息，细节以本文与文末「相关文档」为准。

---

## 1. 依赖与兼容性

### 1.1 运行前提

| 依赖 | 要求 | 说明 / 检查 |
|---|---|---|
| DSH | `>=0.2.0-rc.2 <0.3.0` | `engines.dsh`；宿主要提供原生服务，见下 |
| Node.js | `>=18.18` | `engines.node`；CI 覆盖 18 / 20 / 22 |
| [GitHub CLI](https://cli.github.com/) | `>=2.0` | 默认数据源；`gh auth login` 后使用，也可改用 GitHub REST token |
| 宿主服务 | `slots` / `layout` / `uiWorkspace` / `connection` | 由 DSH 提供；**不需要 [dsh-better-sidebar](https://github.com/taoweidong/dsh-better-sidebar)** |
| AI 检视服务 | `llm` + `sessions` | 缺失时 AI 检视不可用，不会降级到自建 Agent |
| Issue 开发服务 | `sessionController` | 缺失时 Issue 开发不可用 |
| 浏览器 | DSH 内的现代浏览器 | 独立浏览器没有客户端桥接，不能选择宿主目录或打开原生会话 |

### 1.2 兼容性

| 组件 | 支持范围 |
|---|---|
| DSH | `>=0.2.0-rc.2 <0.3.0`（peerDependency，optional） |
| Node.js | `>=18.18`（CI：18 / 20 / 22） |
| 操作系统 | Windows（主要验证环境）、Linux / macOS（POSIX 路径与 `0600` 权限） |
| 数据源 | `gh` CLI、GitHub REST API、本地 git 元信息 |
| 运行时依赖 | 无第三方运行时依赖 |

### 1.3 开发 / 发布工具

- 运行时**零依赖**：页面为 vanilla JS + 内联 CSS/SVG，npm 运行时依赖为 0。
- 开发依赖只有 `eslint`（`devDependencies`），不进入发布产物。
- `pnpm` 由 DSH 自带，无需单独安装。
- npm 发布（维护者）需要 `npm >= 11.15.0` 与 Node `>= 22.14`，用于 `npm stage publish` / `npm stage approve`；详见 [npm-package.md](npm-package.md)。

---

## 2. 安装

### 2.1 通过 npm（推荐）

```sh
dsh plugin --profile <profile> add dsh-codehub-dashboard
```

需要固定版本时追加 `@<version>`。当前版本以 `npm view dsh-codehub-dashboard version` 为准；校验、升级、回滚与包内容见 [npm-package.md](npm-package.md)。

### 2.2 从源码 / 本地目录

```sh
git clone https://github.com/taoweidong/dsh-codehub-dashboard.git
dsh plugin --profile <profile> add /path/to/dsh-codehub-dashboard
```

### 2.3 离线 tgz

```sh
npm pack
dsh plugin --profile <profile> add ./dsh-codehub-dashboard-<version>.tgz --offline
```

完整打包、离线交付、手动摆放、卸载与回滚见 [packaging-and-offline-install.md](packaging-and-offline-install.md)。

安装后**完全退出并重启 DSH**，左侧导航出现 **CodeHub**。本项目不会自行修改已安装 DSH 的配置。

---

## 3. 配置与持久化

默认配置路径 `~/.dsh/codehub-dashboard/config.json`，工作流审计保存在相邻的 `config.json.workflows.json`。可通过 bundle 的 `configPath` 或环境变量 `CODEHUB_DASHBOARD_CONFIG` 指定位置。

- 配置包含 GitHub 实例 token；审计文件包含检视草稿、Issue 上下文与模型输入输出。
- 这两个文件都**不要提交或同步**；POSIX 下配置为 `0600`，Windows 没有等效 ACL 保护，应保护所在目录。

---

## 4. 界面与工作流

### 4.1 七个视图

| 视图 | 用途 |
|---|---|
| 概览 | 跨仓库摘要、活动趋势、待办 KPI |
| PR | PR 列表、筛选、详情、diff、AI 检视与问题清单、批量提 Issue |
| Issue | Issue 列表（行内快速开始开发）、详情、开发会话 |
| 检视意见 | 评论收件箱（按需加载） |
| 仓库 | 仓库卡片、同步状态、失败与覆盖披露 |
| 统计 | 状态分布、评审人、活动热力 |
| 设置 | 数据源、实例、仓库、身份、模型、连通性测试 |

### 4.2 首次配置

1. 在设置页选择数据源：`auto`（gh 优先，读取失败时可回退到已配置 token 的 HTTP）、`gh`、`http` 或 `git`（仅本地元信息）。
2. 添加 GitHub 实例、`owner/name` 仓库或组织名；未指定实例时使用 github.com 的 gh 登录态。
3. 填写 GitHub 登录名以启用「待我评审」「分配给我的 Issue」筛选；需要开发 Issue 的仓库须绑定对应本地克隆。
4. 选择宿主提供的模型与 provider，保存配置。保存响应不等待上游同步，刷新在后台进行。
5. 在 PR 详情查看 diff → 生成 AI 草稿 → 勾选要跟踪的问题 → 单独确认批量创建 Issue；或将草稿正文编辑后单独确认发布为 COMMENT。
6. 在 Issue 详情确认开始开发（也可在 Issue 列表行直接「快速开始开发」）；已成功关联的 Issue 会复用原生会话。后续工具执行仍受 DSH 的批准与安全机制控制。

### 4.3 PR AI 检视 → 问题清单 → 提 Issue

- 一次 AI 调用同时产出「可发布评论正文」与「结构化问题清单」（严重度、位置、证据、说明、建议、置信度，最多 12 条）。
- **「一键」不等于跳过确认**：发送 diff 给模型、发布评论、创建 Issue 各保留一次明确确认。
- 草稿绑定生成时的 PR head SHA；发布前重新检查 PR 状态与 SHA，PR 已变更或关闭时拒绝发布。
- 发布以 **COMMENT** 进行，**绝不自动批准或拒绝 PR**；结果不确定时保存 `publish_unknown` 并禁止自动重试，须先到 GitHub 核实。
- **Issue 从不自动创建**：需用户勾选后确认。逐条状态机与 `publish_unknown` 同哲学——`failed`（可证明未创建，可重试）与 `unknown`（结果不确定，永不自动重试，须人工核实）严格区分；已创建的条目不会重复提交。
- 文件/证据是否能在 diff / 变更列表中定位，只作为「已核对 / 未命中 / 截断无法核对」展示，**不阻止提 Issue**；AI 结论不能代替人工检视。
- 模型偶尔不返回约定 JSON 时降级为纯文本草稿（功能不整体失败，仍可发布）。
- AI 检视请求不带工具，不能授权工具执行。

### 4.4 Issue 开发会话

- 核验本地克隆的 `origin` 后，用宿主 `sessionController` 创建会话并注入 Issue 上下文，再由 `uiWorkspace` 打开。
- 会话创建与 prompt 使用持久化的 `sessionId` / `requestId`；重试沿用原身份，不重新提交另一份任务。
- 宿主 `sessionController.prompt(request, signal)` 的第二个 AbortSignal 只约束准入（admission）之前的等待；准入超时后关联保持 pending，重试复用同一 `requestId`。

---

## 5. 数据范围与失败处理

- GitHub CLI 每仓库最多同步 200 条 PR 和 200 条 Issue；HTTP 列表为配置大小的首批结果。统计只基于已同步样本，**不是完整历史统计**。
- CI 状态只查询**未合并**的 PR（全状态查询易触发 GitHub GraphQL 网关 502/504）；已合并 / 已关闭的历史 PR 显示「CI 未查询」，与「CI 无 check」是两回事。该查询失败只降级提示，不影响列表主体。
- 仓库默认分支与描述来自 `gh repo view`；取不到时显示「未知」，不会用某条 PR 的目标分支冒充。
- 组织仓库与按需评论使用分页；评论收件箱受每仓库 `http.detailLimit` 预算约束。
- REST 评论不包含完整线程解决状态：未知显示为未知，**不计为未解决**；普通讨论评论也不自动计为未解决。`resolutionAvailable` 只在真正拿到状态或确认已加载为空时才为真。
- diff、模型输入与输出有大小限制，截断时明确提示检视范围有限。
- 列表页区分三种状态：整列请求失败、部分仓库失败、样本覆盖受限；PR / Issue 详情若某个分段（评论、diff 等）未返回，会在页面内单独提示并建议重开详情，不用空列表冒充「没有意见」。
- 检视草稿绑定生成时的 PR head SHA；发布前重新检查 PR 状态与 SHA，已变更或关闭时拒绝发布。
- 远端发布结果不确定时保存 `publish_unknown` 状态并**禁止自动重试**，避免重复评论；须先到 GitHub 核实。
- Issue 会话创建与 prompt 使用持久化的 `sessionId` / `requestId`；重试沿用原身份，不重新提交另一份任务。

---

## 6. 已知限制

- 检视草稿与 Issue 会话记录写在插件自己的审计文件中，不进入宿主 Agent 的生命周期；宿主不会替你回滚或清理。
- 首次 prompt 可能触发宿主的会话标题生成，检视正文存在经由另一个模型 provider 处理的可能；标题 provider 由宿主选择，插件无法固定。
- rc.2 的 prompt 去重只在准入完成后生效，准入窗口内的并发重试仍可能产生两次会话消息；插件用持久化 `requestId` 收敛，但不保证宿主侧幂等。
- Issue 会话关联标记为 `ready` 时没有独立的落盘屏障；极端崩溃下可能留下已标记但未持久化的关联，重试前应先核对审计文件。

---

## 7. 安全与隐私

- token 仅在响应中脱敏；更换实例域名时必须清空或重新输入 token，不会向新域名转移旧凭据。
- POSIX 文件使用 `0600`；**Windows 上 chmod 不提供等效 ACL 保护**，应保护所在目录。配置含明文 token，工作流审计含代码、Issue 与模型输入输出，**不要提交或同步**这些文件。
- GitHub 内容视为不可信数据，不能授权工具执行、泄密、发布、push 或破坏性操作；AI 检视请求不带工具。
- 本地命令使用 `execFile` 与固定参数，发布正文通过 stdin 传入；写请求不会因失败自动切换传输渠道重发。
- 每个请求先经 DSH 原生 `ctx.connection.admit(req)` 信任校验：未通过返回 401/403，服务缺失返回 503；校验通过前不读取配置、不访问 GitHub。写 API 额外要求同源（`Origin` / `sec-fetch-site`）与 `application/json`。页面带 CSP、`nosniff`、`no-referrer` 响应头，客户端桥接核验 origin 与 iframe 来源。
- 持久化采用锁与原子替换。进程崩溃后若残留 `.lock`，先确认没有写入进程并备份审计记录，再人工恢复；**不要自动删除锁或未决发布记录**。

---

## 8. 开发与测试

```sh
npm install
npm run lint        # eslint，0 error
npm test            # node --test（当前 117 用例）+ test-host.mjs（当前 92 断言）
npm run dev         # 隔离开发服务，默认 127.0.0.1:4173
npm pack --dry-run  # 检查 9 个打包文件
```

- 开发服务使用独立临时配置，退出时清理，不读取或修改真实 DSH 配置；默认无仓库、无模拟数据，也没有原生模型与会话服务，可用 `PORT` 更换端口。
- 测试使用可控的 GitHub / native-service fixture，不会发布真实评论或调用收费模型；CLI 字段检查使用无效字段请求，不依赖真实仓库认证。
- 提交门禁与契约字段核对见 [AGENTS.md](../AGENTS.md)；改动 host 半（`index.js` / `workflows.js`）后还须在真实 DSH 中确认激活日志。

---

## 9. 项目结构

仓库根即插件包根（npm 包名 `dsh-codehub-dashboard`），没有中间层目录。

| 路径 | 职责 |
|---|---|
| `index.js` | gh / git / HTTP 数据、配置、缓存、统计与 HTTP 路由 |
| `workflows.js` | 原生模型检视、确认发布、Issue 会话及审计持久化 |
| `client.js` | 原生左侧导航注册、iframe 与受限宿主桥接 |
| `web/index.html` | 看板、详情、工作流与设置 UI |
| `package.json` / `cordis.patch.yml` | 插件清单（`dsh.client.inject`、`dsh.bundle.patch`）与 DSH 挂载声明 |
| `scripts/` | 单元 / 集成测试与隔离开发服务 |
| `docs/` | 使用与依赖、设计、API、gh CLI 契约、npm 发布、打包交付与验证报告 |
| `releases/` | 交付件归档（`.tgz` 不入 git，仅 README 保留目录） |
| `.github/workflows/` | CI（`npm ci` + lint + test，node 18/20/22）与 tag 触发的 staged npm 发布 |
| `AGENTS.md` | 贡献者契约：提交门禁、契约字段交叉核对、真实宿主激活验收 |

---

## 10. HTTP API

全部挂载在 `/codehub/api?op=...`；读取用 GET，写入用 JSON POST。完整参数、响应与错误码见 [api-reference.md](api-reference.md)。

`gh --json` 使用平铺顶层字段（如 `author,labels,reviewRequests`），不支持嵌套选择器；详情、diff、组织展开与发布使用 `gh api --hostname`，分页读取使用 `--paginate --slurp`。

---

## 11. 相关文档

| 文档 | 内容 |
|---|---|
| [README](../README.md) | 项目定位、核心特性与快速开始 |
| [design.md](design.md) | 架构、原生服务契约、数据模型、工作流状态机、测试策略 |
| [api-reference.md](api-reference.md) | `/codehub/api?op=…` 全部 20 个 op 的参数、响应与错误码 |
| [npm-package.md](npm-package.md) | npm 发布状态、安装 / 校验 / 升级 / 回滚、包内容与发布流程 |
| [packaging-and-offline-install.md](packaging-and-offline-install.md) | 打包、离线交付、手动摆放、卸载与回滚（本机实测） |
| [gh-cli-contract.md](gh-cli-contract.md) | gh CLI 字段契约、`statusCheckRollup` 网关上限实测与执行方式 |
| [AGENTS.md](../AGENTS.md) | 贡献者契约：提交门禁、契约字段交叉核对、真实宿主激活验收 |
