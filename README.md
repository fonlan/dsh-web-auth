# dsh-web-auth

为 [DSH](https://github.com/deepseek-ai/deepseek-harness) Web GUI 增加**密码访问认证**的插件：所有 HTTP 请求与 WebSocket 升级都必须携带有效会话，未登录一律跳转到登录页。装上它之后，把 dsh 反代到公网（或直接暴露端口）才不至于裸奔。

## 特性

- **登录页 + HttpOnly 签名 Cookie**（HMAC-SHA256，7 天滑动续期），浏览器自动携带，HTTP / WebSocket / SSE / 静态资源全覆盖
- **首次设置**：未配置密码时，登录页显示「设置访问密码」表单（引导流程，见下文安全说明）
- **GUI 改密**：设置 → 插件 →「访问认证」卡片（插件配置 tab），需旧密码；改密后**轮换签名密钥，所有已登录会话立即下线**
- **退出登录**：设置卡片按钮，或访问 `/logout`
- **防爆破**：登录与改密接口按客户端 IP 限速（连续 5 次失败锁 1 分钟起，指数退避至 30 分钟；15 分钟内累计）
- **反代友好**：Cookie `Secure` 自动跟随 `x-forwarded-proto`；限速信任回环对端的 `X-Forwarded-For`
- **监听地址切换**：设置卡片可一键把 dsh 的监听地址在 `127.0.0.1`（仅本机）与 `0.0.0.0`（所有网卡 / 局域网可访问）之间切换，热生效、无需重启进程（写入 `web-auth` settings 命名空间 → host 半区应用 patch → HMR 重绑 webserver）
- 密码以 **scrypt 加盐哈希**存储（`$DSH_HOME/web-auth/password.hash`，0600），永不回显、不落明文配置

## 安装

```bash
dsh plugin --profile web add @fonlan/dsh-web-auth
```

从 npm 安装：`dsh plugin add` 会把包写入 profile 的依赖与 bundle 栈（`cordis.patch.yml` 自动 insert 插件行，host 半区 + 浏览器半区一次挂载）。升级到新版本：

```bash
dsh plugin --profile web update @fonlan/dsh-web-auth
```

> 安装后**需要重启 dsh web 进程**才生效（当前会话会短暂断连重连）。

## 激活（首次设置密码）

重启后打开 dsh web，会被重定向到登录页：

1. 未设置过密码时，登录页显示「设置访问密码」——输入 **≥8 位**的新密码并确认
2. 设置成功后立即签发会话并跳回原页面；此后每次访问都要输密码

改密入口在 **设置 → 插件 → 插件配置 → 访问认证**（需先登录）。

## 行为细节

| 场景 | 行为 |
|---|---|
| 未登录访问页面（GET/HEAD） | `302` → `/login?next=原路径`，登录后跳回 |
| 未登录访问 API（POST 等） | `401` JSON |
| DSH 启动令牌交换（`GET /?token=…`） | 放行并改写为回环来源转发：DSH 自行校验令牌、签发自己的 `dsh-auth` cookie（`303` → 干净 `/`）；令牌无效则收到 DSH 自带的 `401` |
| DSH 会话 cookie 自动签发 | 插件在放行响应上**服务端代理 DSH 的令牌交换**（走本机回环 `/?token=`），把 `dsh-auth` Set-Cookie 随响应转发给浏览器——新浏览器无需再手工打开打印的 token URL；每分钟最多一次（结果会持续续期 DSH 的 30 天 cookie） |
| 反代域名下已登录访问任意路径（含 `/api`、插件前缀） | 改写为回环来源放行，网关特权方法与插件围栏不再 403 |
| 跨站请求（即使带 Cookie） | 仍被围栏 `403` 拒绝 |
| 未登录 WebSocket 升级 | 握手直接 `401` 拒绝 |
| 登录失败 | 跳回登录页显示「密码错误」（统一文案） |
| 连续失败 | 按 IP 限速，提示「尝试过于频繁」 |
| 会话过期 | 跳回登录页；滑动续期：剩余不足 24h 自动刷新 |
| 修改密码 | 校验旧密码 → 轮换签名密钥 → **全员下线**，跳转登录页 |
| 切换监听地址（设置卡片） | 校验取值（仅 `127.0.0.1` / `0.0.0.0`）→ 写入 `web-auth` settings 命名空间（revision 设栅）→ host 半区应用 patch（profile 优先，home 兜底）→ HMR 热重载 webserver 重新绑定；**WebSocket 短暂断连后自动重连** |
| `/logout` | 清除 Cookie，跳转登录页 |

> **无需再处理 DSH 自己的启动令牌**：DSH 的浏览器会话认证（`dsh web` 启动时打印的 `http://127.0.0.1:3080/?token=…`）用 cookie 绑定 Host。插件会把所有已认证请求的 Host 改写为回环地址，而 DSH 的 cookie 必须与「DSH 看到的 Host」一致——`0.1.5` 起插件会在登录/会话期间**自动在服务端完成 DSH 令牌交换**并把 `dsh-auth` cookie 转交给浏览器（含持续续期），所以外部设备、新浏览器都不需要再手工访问带 token 的 URL。唯一的例外：旧版本插件（< 0.1.5）签发的 cookie 过期后，需要手动以 `https://<域名>/?token=<dsh web 启动打印的令牌>` 打开一次完成引导。

### 切换监听地址

dsh 默认只监听 `127.0.0.1`。在 **设置 → 插件 → 插件配置 → 访问认证** 卡片底部可以把它切换为 `0.0.0.0`（所有网卡，局域网可访问），或切回仅本机——无需重启 dsh 进程：

- 切换写入 `web-auth` settings 命名空间（`$DSH_HOME/settings.yaml`，revision 设栅）；host 半区监听到提交后应用到当前部署的 patch 层：profile 的 `cordis.patch.yml`；若 home 层（`$DSH_HOME/cordis.patch.yml`）已声明 webserver 行则写 home 层（home 优先级更高，改在低层会被覆盖）。文件里其余内容（注释、`!!js` 端口表达式）原样保留。
- dsh 的 HMR 会监听到 patch 文件变化并热重载 webserver 行：**关闭旧监听、按新地址重新绑定**，全程无需重启进程。重启进程后该设置依然生效（settings 命名空间 + patch 文件都在）。
- 切换瞬间所有连接（包括当前页面与 WebSocket）会断开重连，属正常现象；卡片会轮询状态确认新地址生效。
- 注意：若你正通过**局域网 IP**（`0.0.0.0` 模式）访问并切回 `127.0.0.1`，切回后只能在本机访问，请改用 `127.0.0.1` 重新打开页面。

> 该能力依赖 webserver 行位于 profile/home patch 层（默认安装即如此）。若你的 webserver 配置来自自定义 `--patch` overlay，请直接编辑 overlay 文件。

## 安全模型与风险（请务必阅读）

- **认证是访问控制，不是安全边界**。dsh 的 agent 拥有 bash 执行能力（远程代码执行级别），即使有密码保护，也不要把它当成不可攻破的堡垒：密码强度、反代层 WAF/限流、IP 白名单仍然值得做。
- **首密窗口期**：未设置密码时，**任何人**都能访问登录页并抢注密码（设计如此，作为 bootstrap 通道）。启动日志会打印警告；请装好插件后**第一时间设置密码**。生产环境建议先用 `127.0.0.1` + SSH 端口转发完成首密设置，再开放公网。
- **会话是无状态的**（HMAC 签名），服务端无法单独吊销某一个会话；`/logout` 只清浏览器 Cookie。密码泄露时请**修改密码**——这会轮换密钥并让所有会话失效。
- 密码哈希与签名密钥存放于 `$DSH_HOME/web-auth/`（默认 `~/.dsh/web-auth/`），权限 0600；删除 `password.hash` 即回到未配置状态（认证关闭）。
- 限速为**进程内存级**，多实例部署时各自独立，重启清零；如需更强防护请依赖反代层限流。

## 开发

```bash
pnpm install
npm run build      # host: tsc → lib/；client: esbuild → lib/client.js（ModuleLoader 格式）
npm run typecheck
npm run test       # 32 项单元 + 集成测试（node:test，真实 HTTP/WS 全流程）
```

仓库结构：

- `src/auth-core.ts` — 纯逻辑：scrypt 哈希、Cookie 签名/校验、限速器、`next` 校验
- `src/gate.ts` — 把认证闸门包到 node:http 服务器的 request/upgrade 监听器外层
- `src/handlers.ts` — 登录页/登录/登出/改密/状态/监听切换 路由处理
- `src/profile-patch.ts` — 监听地址切换：webserver 行的 patch 层文本改写（保留注释与 `!!js` 表达式）
- `src/settings.ts` — `web-auth` settings 命名空间注册 + listenHost 变更应用（卡片的分发键与数据源）
- `src/index.ts` — cordis 插件装配（host 半区）
- `src/client/index.tsx` — 设置卡片（浏览器半区，`settings.plugin.item` 插槽，keyed by `web-auth` 命名空间）
- `cordis.patch.yml` — bundle 补丁层（insert 插件行）

## License

MIT
