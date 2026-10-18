# dsh-codehub-dashboard

> DSH 原生 CodeHub 工作台：在 DSH 左侧导航中聚合 GitHub 仓库 / 组织的 PR、Issue、检视意见与统计，复用宿主的模型、会话和目录选择能力，不另建 Agent 或模型认证体系。

[![CI](https://github.com/taoweidong/dsh-codehub-dashboard/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/taoweidong/dsh-codehub-dashboard/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/dsh-codehub-dashboard)](https://www.npmjs.com/package/dsh-codehub-dashboard)
[![Release](https://img.shields.io/github/v/tag/taoweidong/dsh-codehub-dashboard?label=release)](https://github.com/taoweidong/dsh-codehub-dashboard/tags)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18.18-brightgreen)](package.json)
[![DSH](https://img.shields.io/badge/DSH-%3E%3D0.2.0--rc.2%20%3C0.3.0-blueviolet)](package.json)
[![runtime deps](https://img.shields.io/badge/runtime%20dependencies-0-brightgreen)](package.json)

> **npm**：`dsh-codehub-dashboard`。当前版本以 `npm view dsh-codehub-dashboard version` 为准；安装、校验与发布说明见 [docs/npm-package.md](docs/npm-package.md)。

## 核心特性

- **原生 7 视图**：概览、PR、Issue、检视意见、仓库、统计、设置，全部在 DSH 内以原生 UI 呈现。
- **PR AI 检视 → 问题清单 → 提 Issue**：一次模型调用同时产出「可发布评论」与「结构化问题清单」（含严重度、位置、证据、修复建议、置信度）；勾选要跟踪的条目即可批量创建 GitHub Issue（正文自动带 MR 溯源与 AI 证据），创建后直接接着走 Issue 开发流程。评论仍二次确认后仅发布 **COMMENT**，绝不自动批准或拒绝 PR；Issue **从不自动创建**。
- **Issue 开发会话**：核验本地克隆的 `origin` 后复用宿主 `sessionController`，重试沿用持久化 `requestId`；Issue 列表行提供「快速开始开发」一键入口。
- **诚实降级**：线程解决状态未知时显示「未知」并单独计数，不把「没查到」当成「未解决 0」；失败时保留已同步数据。
- **多数据源**：`auto` / `gh` / `http` / `git`，支持多 GitHub 实例、组织自动展开、显式仓库覆盖与禁用。
- **零运行时依赖**：vanilla JS + 内联 CSS/SVG，不需要额外的 sidebar 插件。

## 快速开始

**要求**：DSH `>=0.2.0-rc.2 <0.3.0`、Node.js `>=18.18`、[GitHub CLI](https://cli.github.com/)（或 GitHub REST token）。完整依赖、宿主服务、配置与工作流见 [使用说明与依赖](docs/usage-and-dependencies.md)。

```sh
# 从 npm 安装（也可用本地目录：dsh plugin --profile web add /path/to/dsh-codehub-dashboard）
dsh plugin --profile web add dsh-codehub-dashboard
```

安装后完全退出并重启 DSH，左侧导航选择 **CodeHub** → 设置页添加 GitHub 实例 / 仓库 / 模型即可。

## 文档

| 文档 | 内容 |
|---|---|
| [docs/usage-and-dependencies.md](docs/usage-and-dependencies.md) | **使用说明与依赖**：依赖兼容性、安装、配置、界面与工作流、数据口径、已知限制、安全边界、开发工具与项目结构 |
| [docs/npm-package.md](docs/npm-package.md) | npm 发布状态、安装 / 校验 / 升级 / 回滚、包内容与维护者发布流程 |
| [docs/packaging-and-offline-install.md](docs/packaging-and-offline-install.md) | 打包、离线交付、手动摆放、卸载与回滚（本机实测） |
| [docs/design.md](docs/design.md) | 架构、原生服务契约、数据模型、工作流状态机、测试策略 |
| [docs/api-reference.md](docs/api-reference.md) | `/codehub/api?op=…` 全部 20 个 op 的参数、响应与错误码 |
| [docs/gh-cli-contract.md](docs/gh-cli-contract.md) | gh CLI 字段契约与 `statusCheckRollup` 网关上限实测 |
| [AGENTS.md](AGENTS.md) | 贡献者契约：提交门禁、契约字段交叉核对、真实宿主激活验收 |

## 贡献与安全

- 提交前必须 `npm run lint` 与 `npm test` 全绿，细则见 [AGENTS.md](AGENTS.md)。
- 配置与工作流审计文件含明文 token、代码与模型输入输出，**不要提交或同步**。
- 安全漏洞请通过 GitHub Security Advisories 私下报告。

## License

[MIT](LICENSE)
