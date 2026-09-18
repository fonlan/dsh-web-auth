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
- **远程设置解锁（可选）**：`unlockRemoteSettings` 组合配置在启动页注入 `__DSH_TRANSPORT__.ownsHost` 标志，让反代域名下的设置面（模型页、插件配置、常规设置等）完整可用，默认关闭（见下文安全权衡）
- **启动令牌收口**：未登录浏览器带旧 `?token=` 链接访问一律重定向回登录页，只有插件自身的服务端 mint 走回环放行通道——既不需要手工引导，也不会再撞上 DSH 的 `401` 死页面（`0.1.7` 起）
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
| DSH 启动令牌交换（`GET /?token=…`） | 仅**插件服务端的 mint 重入**（直连回环对端 + 内部标记头）或**已持有插件会话**的请求放行并改写为回环来源转发：DSH 自行校验令牌、签发自己的 `dsh-auth` cookie（`303` → 干净 `/`）；令牌无效则收到 DSH 自带的 `401` |
| 浏览器直接打开打印的令牌 URL（未登录） | `302` → `/login?next=/`，**丢弃 `token` 参数**：令牌每次启动重新生成，旧书签/旧链接本就无效，放行只会把用户丢到 DSH 的 `401` 页面；登录后服务端 mint 会自动补发有效的 `dsh-auth` cookie |
| DSH 会话 cookie 自动签发 | 插件在放行响应上**服务端代理 DSH 的令牌交换**（走本机回环 `/?token=`），把 `dsh-auth` Set-Cookie 随响应转发给浏览器——新浏览器无需再手工打开打印的 token URL；每分钟最多一次（结果会持续续期 DSH 的 30 天 cookie） |
| 反代域名下已登录访问任意路径（含 `/api`、插件前缀） | 改写为回环来源放行，网关特权方法与插件围栏不再 403 |
| 反代域名下的设置页（模型页等） | 默认报 `settings are unavailable in this browser`——dsh 客户端按页面 hostname 判定"非本机浏览器"，设置镜像保持进程本地。开启 `unlockRemoteSettings` 后启动页注入 `ownsHost`，设置面完整可用（读写仍过密码门 + 回环围栏） |
| 跨站请求（即使带 Cookie） | 仍被围栏 `403` 拒绝 |
| 未登录 WebSocket 升级 | 握手直接 `401` 拒绝 |
| 登录失败 | 跳回登录页显示「密码错误」（统一文案） |
| 连续失败 | 按 IP 限速，提示「尝试过于频繁」 |
| 会话过期 | 跳回登录页；滑动续期：剩余不足 24h 自动刷新 |
| 修改密码 | 校验旧密码 → 轮换签名密钥 → **全员下线**，跳转登录页 |
| 切换监听地址（设置卡片） | 校验取值（仅 `127.0.0.1` / `0.0.0.0`）→ 写入 `web-auth` settings 命名空间（revision 设栅）→ host 半区应用 patch（profile 优先，home 兜底）→ HMR 热重载 webserver 重新绑定；**WebSocket 短暂断连后自动重连** |
| `/logout` | 清除 Cookie，跳转登录页 |

> **无需再处理 DSH 自己的启动令牌**：DSH 的浏览器会话认证（`dsh web` 启动时打印的 `http://127.0.0.1:3080/?token=…`）用 cookie 绑定 Host。插件会把所有已认证请求的 Host 改写为回环地址，而 DSH 的 cookie 必须与「DSH 看到的 Host」一致——`0.1.5` 起插件会在登录/会话期间**自动在服务端完成 DSH 令牌交换**并把 `dsh-auth` cookie 转交给浏览器（含持续续期），所以外部设备、新浏览器都不需要再手工访问带 token 的 URL。`0.1.7` 起这条路径进一步收紧：未登录浏览器带 `token` 访问会被重定向到 `/login` 并丢弃该参数（旧令牌在 dsh 重启后即失效，放行只会展示 DSH 自己的 `401` 页面），登录本身就已经完成 mint，不再需要任何手工引导步骤。

### 切换监听地址

dsh 默认只监听 `127.0.0.1`。在 **设置 → 插件 → 插件配置 → 访问认证** 卡片底部可以把它切换为 `0.0.0.0`（所有网卡，局域网可访问），或切回仅本机——无需重启 dsh 进程：

- 切换写入 `web-auth` settings 命名空间（`$DSH_HOME/settings.yaml`，revision 设栅）；host 半区监听到提交后应用到当前部署的 patch 层：profile 的 `cordis.patch.yml`；若 home 层（`$DSH_HOME/cordis.patch.yml`）已声明 webserver 行则写 home 层（home 优先级更高，改在低层会被覆盖）。文件里其余内容（注释、`!!js` 端口表达式）原样保留。
- dsh 的 HMR 会监听到 patch 文件变化并热重载 webserver 行：**关闭旧监听、按新地址重新绑定**，全程无需重启进程。重启进程后该设置依然生效（settings 命名空间 + patch 文件都在）。
- 切换瞬间所有连接（包括当前页面与 WebSocket）会断开重连，属正常现象；卡片会轮询状态确认新地址生效。
- 注意：若你正通过**局域网 IP**（`0.0.0.0` 模式）访问并切回 `127.0.0.1`，切回后只能在本机访问，请改用 `127.0.0.1` 重新打开页面。

> 该能力依赖 webserver 行位于 profile/home patch 层（默认安装即如此）。若你的 webserver 配置来自自定义 `--patch` overlay，请直接编辑 overlay 文件。

### 远程设置解锁（`unlockRemoteSettings`，默认关闭）

**现象**：通过域名反代访问 dsh 时，设置 → 模型页报「加载提供方目录失败: settings are unavailable in this browser」，常规设置、插件配置等设置面同样不可用。这不是故障，是 dsh 的有意设计：设置文档（含 provider 凭据引用等敏感配置）只对"本机浏览器"开放——客户端在页面加载时按 `location.hostname` 判定是否回环（`localhost` / `127.x`），反代域名永远不算，设置镜像因此保持进程本地、根本不发起读取。注意这与服务端无关：本插件已把已认证请求改写为回环来源，`/api` 通道完全正常，只有客户端这道门在拦。

**开启**：在 profile 的 `cordis.patch.yml`（`~/.dsh/profiles/<profile>/cordis.patch.yml`）加一条 config 覆盖：

```yaml
- id: web-auth
  config:
    unlockRemoteSettings: true
```

HMR 会监听到 patch 变化并热重载 web-auth 行（无需重启进程）。生效后，域名下已登录页面的启动 HTML 会携带一段内联脚本，设置 `window.__DSH_TRANSPORT__.ownsHost = true`——dsh 客户端把它读作"该页面由宿主直接提供"，设置镜像随之正常加载。只在成功渲染的 index 响应上注入（未登录请求在闸门处就被 302/401，根本到不了渲染）；已存在的 `__DSH_TRANSPORT__` 载体只会合并、不会被覆盖。不需要时删掉该配置即回退（同样热生效）。

**安全权衡（请务必理解后再开启）**：`ownsHost` 是 dsh 画的"设置仅本机可改"边界；开启等于把这道边界改由本插件的密码门承担——**每个通过密码认证的浏览器**都能读写 host 设置文档（包括 provider API key 的引用、监听地址等）。若域名暴露在公网，请确保：强密码、反代全程 HTTPS、最好叠加反代层限流/IP 白名单。只在本机/内网使用或设置面不受影响时，保持默认关闭即可。

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
npm run test       # 单元 + 集成测试（node:test，真实 HTTP/WS 全流程）
```

仓库结构：

- `src/auth-core.ts` — 纯逻辑：scrypt 哈希、Cookie 签名/校验、限速器、`next` 校验
- `src/gate.ts` — 把认证闸门包到 node:http 服务器的 request/upgrade 监听器外层
- `src/handlers.ts` — 登录页/登录/登出/改密/状态/监听切换 路由处理
- `src/profile-patch.ts` — 监听地址切换：webserver 行的 patch 层文本改写（保留注释与 `!!js` 表达式）
- `src/remote-unlock.ts` — 远程设置解锁：`unlockRemoteSettings` 开启时经 `webServer.tapIndex` 注入 `ownsHost` 启动页脚本
- `src/settings.ts` — `web-auth` settings 命名空间注册 + listenHost 变更应用（卡片的分发键与数据源）
- `src/index.ts` — cordis 插件装配（host 半区）
- `src/client/index.tsx` — 设置卡片（浏览器半区，`settings.plugin.item` 插槽，keyed by `web-auth` 命名空间）
- `cordis.patch.yml` — bundle 补丁层（insert 插件行）

## License

MIT
