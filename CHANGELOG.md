# 变更记录

兼容性一栏列出该版本支持的 DSH 宿主版本区间。

## 0.1.10

**兼容性**：dsh `^0.1.2-alpha.2 || ^0.2.0-rc.1 || ^0.2.1-alpha.1` —— 已在 dsh web `0.2.1-alpha.1` 与 DSH Desktop `0.2.0-rc.2` 上验证。

**变更**
- 构建基线 `@deepseek-ai/*` 从 `0.2.0-rc.1` 升到 `0.2.1-alpha.1`（含 `@deepseek-ai/cordis` `4.0.5-alpha.1`、`@deepseek-ai/schemastery` `3.18.5-alpha.1`）。
- 每个 `@deepseek-ai/dsh*` 的 `peerDependencies` 追加 `|| ^0.2.1-alpha.1`。
- 把 `@deepseek-ai/dsh-settings` 从 `dependencies` 移出：源码从未在运行时 import 它，但该条目把 `0.1.2-alpha.2` 钉进了 node_modules（宿主为 `0.2.1-alpha.1`）。它本来就已声明为 peer。

**验证**：`pnpm install` / `typecheck` / `build` / `test`（82 项）全部通过；隔离 profile 冷启动（真 `0.2.1-alpha.1` 宿主）通过。
