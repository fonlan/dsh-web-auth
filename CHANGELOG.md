# 变更记录

兼容性一栏列出该版本支持的 DSH 宿主版本区间。

## 0.2.3

**兼容性**：dsh `^0.1.2-alpha.2 || ^0.2.0-rc.1 || ^0.2.1-alpha.1 || ^0.2.1-alpha.2 || ^0.2.1-rc.2 || ^0.2.1-rc.3 || ^0.2.1-rc.5` —— 已在 DSH Desktop `0.2.1-rc.5` 上验证（隔离 profile 冷启动 `pass-timeout-alive`）。

**变更**
- 构建基线 `@deepseek-ai/*` 从 `0.2.1-rc.3` 升到 `0.2.1-rc.5`（`@deepseek-ai/cordis` `4.0.5`、`@deepseek-ai/schemastery` `3.18.5` 不变）。
- 每个 `@deepseek-ai/dsh*` 的 `peerDependencies` 追加 `|| ^0.2.1-rc.5`。
- 源码零改动：`0.2.1-rc.3 → 0.2.1-rc.5` 的两处宿主变化都在宿主内部（rc.4 修 ACP 模式诊断输出混入 stdout；rc.5 优化对话思考内容展示），未触及本插件消费的 API（typecheck 通过）。

**验证**：`pnpm install` / `typecheck` / `build` / `test`（111 项）全部通过；隔离 profile 冷启动（真 `0.2.1-rc.5` 宿主）通过。

## 0.2.2

**兼容性**：dsh `^0.1.2-alpha.2 || ^0.2.0-rc.1 || ^0.2.1-alpha.1 || ^0.2.1-alpha.2 || ^0.2.1-rc.2 || ^0.2.1-rc.3` —— 已在 DSH Desktop `0.2.1-rc.3` 上验证（隔离 profile 冷启动 `pass-timeout-alive`）。

**变更**
- 构建基线 `@deepseek-ai/*` 从 `0.2.1-rc.2` 升到 `0.2.1-rc.3`（`@deepseek-ai/cordis` `4.0.5`、`@deepseek-ai/schemastery` `3.18.5` 不变）。
- 每个 `@deepseek-ai/dsh*` 的 `peerDependencies` 追加 `|| ^0.2.1-rc.3`。
- 源码零改动：`0.2.1-rc.2 → 0.2.1-rc.3` 的宿主变化是新增 entry 自定义菜单/图标与两个新槽位（`sidebar.panellist.actions`、`conversation.session.header.views.actions`），未触及本插件消费的 API（typecheck 通过）。

**验证**：`pnpm install` / `typecheck` / `build` / `test`（111 项）全部通过；隔离 profile 冷启动（真 `0.2.1-rc.3` 宿主）通过。

## 0.2.1

**兼容性**：dsh `^0.1.2-alpha.2 || ^0.2.0-rc.1 || ^0.2.1-alpha.1 || ^0.2.1-alpha.2 || ^0.2.1-rc.2` —— 已在 DSH Desktop `0.2.1-rc.2` 上验证（隔离 profile 冷启动 `pass-timeout-alive`）；dsh web `0.2.1-alpha.2` 仍落在同一 peer 区间内（门禁离线求值 ADMITTED）。

**变更**
- 构建基线 `@deepseek-ai/*` 从 `0.2.1-alpha.2` 升到 `0.2.1-rc.2`（含 `@deepseek-ai/cordis` `4.0.5`、`@deepseek-ai/schemastery` `3.18.5`）。
- 每个 `@deepseek-ai/dsh*` 的 `peerDependencies` 追加 `|| ^0.2.1-rc.2`。
- 源码零改动：`0.2.1-alpha.2 → 0.2.1-rc.2` 的声明面变化未触及本插件消费的 API（typecheck 通过）。

**验证**：`pnpm install` / `typecheck` / `build` / `test`（111 项）全部通过；隔离 profile 冷启动（真 `0.2.1-rc.2` 宿主）通过。

## 0.2.0

**兼容性**：dsh `^0.2.0-rc.1 || ^0.2.1-alpha.1 || ^0.2.1-alpha.2` —— 已在 dsh web `0.2.1-alpha.2` 上验证（冷启动 + 监听地址切换）。

**破坏性修复（重要）**：0.1.10 及更早版本会把 `0.0.0.0` 写进 profile 的 `cordis.patch.yml`，而 dsh `0.2.1-alpha.2` 的 `dsh-host-webserver` 在**解析配置阶段**就拒绝通配符地址：

```
webserver: host "0.0.0.0" is an unspecified (wildcard) address, which is not supported ...
```

该校验发生在任何插件激活之前，所以一旦写进去就是**硬砖**：`webserver` 从未激活，`web-auth` 等 10 个插件永远 waiting，watchdog 反复重启失败，而插件自己也不可能在下次启动时改回来。**若已中招，手工把 `~/.dsh/profiles/<profile>/cordis.patch.yml` 中 `- id: webserver` 下的 `host:` 改成具体地址（如 `127.0.0.1`）即可恢复。**

**变更**
- 监听地址取值域从「`127.0.0.1` / `0.0.0.0` 二选一」改为**本机网卡实际拥有的具体 IPv4/IPv6 字面量**：新增 `src/listen-addresses.ts`（字面量/通配符判定、网卡枚举、本机对端判定）。
- **写路径守卫（三类砖全部堵死）**：`setWebserverHost` 在改动任何字节之前校验；`POST /api/web-auth/listen` 返回 `400 invalid-host`（附合法候选）。三类不再可能被写出：
  1. **通配符**（`0.0.0.0` / `::` / 映射形式）——宿主解析配置阶段直接失败；
  2. **本机没有的地址**（如 macOS 的 `127.0.0.2`、失效的 DHCP 地址）——绑定期 `EADDRNOTAVAIL`，同样让下次启动失败；只接受 `os.networkInterfaces()` 报告的地址（`127.0.0.1` 恒定可用）；
  3. **把行追加到模板空序列 `[]` 之后**产生的非法 YAML（`failed to parse overlay …: end of the stream or a document separator is expected`）——现在识别并**替换** `[]`；非空 flow 文档直接拒绝编辑。
  新增 `yaml` 作为 devDependency，测试对每一种写入形态做真实 YAML 回解析，把「绝不写出无法解析的 patch」固化为不变式。
- **对端信任从「回环」扩展为「本机地址集」**：绑定具体网卡地址后 `127.0.0.1` 不再监听，DSH cookie 的 mint 重入与同机反代的 `X-Forwarded-For` 信任都会失效；现由 `os.networkInterfaces()`（10s 缓存，切换后立即失效）判定，安全等价性见 `isLocalPeerAddress` 注释。
- **设置页改走本插件 REST**：`GET /api/web-auth/status` 返回 `allowed`（网卡候选列表）与 `needsMigration`；`POST /api/web-auth/listen` 负责写入。下拉框由服务端枚举，不再硬编码 `0.0.0.0`。
- **修复宿主升级导致的设置页消失**：dsh `0.2.1-alpha.2` 移除了客户端 `settingsScope` 服务，旧代码 `ctx.inject(['settingsScope'], …)` 在服务不存在时永不触发，设置页会静默消失；宿主侧 `settings` 服务的 `register(ns, schema, {base})` 也已被 schema 驱动的 `SettingsForms`（`describe`/`update`）取代，旧的 `settings.register` 调用在新宿主上必然抛错。`src/settings.ts` 与其命名空间集成已移除，取值只剩「REST → patch 文件」一条路径。
- devDependencies 基线 `@deepseek-ai/dsh*` 从 `0.2.1-alpha.1` 升到 `0.2.1-alpha.2`（`cordis` `4.0.5-alpha.1`、`schemastery` `3.18.5-alpha.1` 不变），peer 追加 `|| ^0.2.1-alpha.2`。
- `dsh.client.inject` 收敛为 `slots` + `ui-settings`（不再需要 `connection` / `api-remotes`）。

**验证**：`pnpm install` / `typecheck` / `build` / `test`（111 项，`0.2.1-alpha.2` 基线）全部通过——含通配符与各拼写拒绝、未拥有地址拒绝、网卡枚举、本机对端判定、每种写入形态的 YAML 回解析。真机端到端（隔离 `DSH_HOME` + 真 `0.2.1-alpha.2` 宿主）：模板 `[]` 冷启动 → 首密 → 切到 `192.168.123.39`（en0）→ 重启后确实绑定该地址 → 在**无回环监听**的该绑定下登录，响应成功带回 minted `dsh-auth-<sha256(127.0.0.1:3199)>` cookie（证明对端信任扩展到本机网卡地址后 mint 仍可用）→ 切回 `127.0.0.1` 重启确认。

## 0.1.10

**兼容性**：dsh `^0.1.2-alpha.2 || ^0.2.0-rc.1 || ^0.2.1-alpha.1` —— 已在 dsh web `0.2.1-alpha.1` 与 DSH Desktop `0.2.0-rc.2` 上验证。

**变更**
- 构建基线 `@deepseek-ai/*` 从 `0.2.0-rc.1` 升到 `0.2.1-alpha.1`（含 `@deepseek-ai/cordis` `4.0.5-alpha.1`、`@deepseek-ai/schemastery` `3.18.5-alpha.1`）。
- 每个 `@deepseek-ai/dsh*` 的 `peerDependencies` 追加 `|| ^0.2.1-alpha.1`。
- 把 `@deepseek-ai/dsh-settings` 从 `dependencies` 移出：源码从未在运行时 import 它，但该条目把 `0.1.2-alpha.2` 钉进了 node_modules（宿主为 `0.2.1-alpha.1`）。它本来就已声明为 peer。

**验证**：`pnpm install` / `typecheck` / `build` / `test`（82 项）全部通过；隔离 profile 冷启动（真 `0.2.1-alpha.1` 宿主）通过。
