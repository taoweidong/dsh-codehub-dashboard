# releases/ — 交付件归档目录

本目录存放本仓库的**交付打包产物**（npm pack 产出的 `.tgz` 等 tar 类归档），按版本号命名保留，便于回溯与离线交付。

## 规则

- 打包产物统一归档到这里，**不放在仓库根或别处**——仓库根只保留项目内容（源码、docs、AGENTS.md）。
- 目录内容不纳入 git 版本控制（见根 `.gitignore`），仅本 README 入库以保留目录结构。
- 打包命令在**仓库根**执行（`npm pack` 按调用目录产出），完成后把产物移入本目录：

  ```sh
  npm pack
  mv dsh-codehub-dashboard-*.tgz releases/
  ```

## 当前归档

| 文件 | 大小 | 生成时间 | 对应提交 |
|------|------|----------|----------|
| dsh-codehub-dashboard-0.1.0.tgz | 63,874 B | 2026-10-16 14:11 | 布局优化版（设计 token 化重排版），已装入 web profile 实机验证 |
| dsh-codehub-dashboard-0.1.1.tgz | 68,188 B | 2026-10-17 17:59 | Host 数据契约 + SPA 失败三态 + CI/publish 门禁 + 文档同步；9 文件 / 210.6 kB unpacked |
| dsh-codehub-dashboard-0.1.2.tgz | 68,505 B | 2026-10-17 20:19 | 复审修复版：P1-1 未知解决状态诚实降级、P1-2 gh 失败态短路缓存、P1-3 保存后去抖刷新、P2-1 kpi sub 转义、P2-5 注释漂移；测试 116+91 |
| dsh-codehub-dashboard-0.1.3.tgz | 68,883 B | 2026-10-17 21:54 | 首个 npm 发布版：含 `a0b5da7` 的 `resolutionAvailable` 三态修复（未加载评论不再冒充确信的 0）；9 文件 / 218.8 kB unpacked；测试 117+91；2026-10-17 已发布到 npm（`latest`，发布件 68,719 B / LF） |
| dsh-codehub-dashboard-0.1.4.tgz | 69,829 B | 2026-10-17 22:32 | 文档重构版：README 按标准开源项目重组、新增 `docs/npm-package.md`、回填 0.1.3 npm 发布事实；代码与测试同 0.1.3（117+91）；9 文件 / 221.7 kB unpacked；2026-10-17 已发布到 npm（`latest`，发布件 69,663 B / LF） |
| dsh-codehub-dashboard-0.1.5.tgz | 65,153 B | 2026-10-17 22:42 | README 精简版：README 只保留定位 / 特性 / 快速开始 / 文档索引，详细内容移入新增的 `docs/usage-and-dependencies.md`；host 断言增至 92；9 文件 / 212.0 kB unpacked |
| dsh-codehub-dashboard-0.1.6.tgz | 74,242 B | 2026-10-18 11:41 | MR AI 检视 → 问题清单 → 提 Issue（Phase 0–3）：结构化输出解析与降级、服务端 `fileIssues` 逐条状态机、`review.latest` 恢复、GitHub 4xx 状态保留、评审区问题清单与批量创建、Issue 行快速开始开发；9 文件 / 243.0 kB unpacked；测试 149+92 |

> 归档包按**当时**的仓库布局打包，只作历史交付凭证。0.1.0 包内 `README.md` 与当前源码不一致，不要直接复用；**0.1.6 为当前最新交付版本**（0.1.5 为上一版，`0.1.2` 未发布到 npm）。未发布到 npm。

> 交付与离线安装操作详见 [docs/packaging-and-offline-install.md](../docs/packaging-and-offline-install.md)。
