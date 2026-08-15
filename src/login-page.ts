/**
 * dsh-web-auth — server-rendered login / first-setup page.
 *
 * A single self-contained HTML document (inline CSS only, no external
 * assets, dark theme matching the dsh shell). Two modes:
 *   setup  — no password has been configured yet: the form sets the first
 *            password (this is the bootstrap path — see README for the
 *            window this opens on public deployments).
 *   login  — a password exists: the form signs a session cookie.
 */
export interface LoginPageState {
  setup: boolean
  error?: string
  next?: string
  /** True right after a successful logout. */
  loggedOut?: boolean
}

const PAGE_STYLE = `
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background: #0b0e14; color: #e6e6e6;
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif;
  }
  .card {
    width: min(380px, calc(100vw - 40px)); background: #131722;
    border: 1px solid #232a38; border-radius: 14px; padding: 28px 26px;
    box-shadow: 0 12px 40px rgba(0,0,0,.45);
  }
  h1 { margin: 0 0 6px; font-size: 17px; font-weight: 650; }
  .sub { margin: 0 0 20px; color: #8b93a7; font-size: 12.5px; line-height: 1.6; }
  label { display: block; margin: 12px 0 6px; color: #aab2c5; font-size: 12px; font-weight: 600; }
  input {
    width: 100%; height: 38px; padding: 0 12px; border-radius: 9px; outline: none;
    border: 1px solid #2a3346; background: #0d1017; color: #e6e6e6; font: inherit; font-size: 13.5px;
  }
  input:focus { border-color: #4f8cff; }
  button {
    width: 100%; height: 40px; margin-top: 20px; border: none; border-radius: 9px; cursor: pointer;
    background: #4f8cff; color: #fff; font: inherit; font-size: 14px; font-weight: 600;
  }
  button:hover { background: #6b9dff; }
  .error {
    margin: 14px 0 0; padding: 9px 12px; border-radius: 8px; font-size: 12.5px;
    background: rgba(255, 82, 82, .12); border: 1px solid rgba(255, 82, 82, .35); color: #ff8f8f;
  }
  .info {
    margin: 14px 0 0; padding: 9px 12px; border-radius: 8px; font-size: 12.5px;
    background: rgba(79, 140, 255, .1); border: 1px solid rgba(79, 140, 255, .3); color: #9dbdff;
  }
  .foot { margin: 18px 0 0; color: #5c657a; font-size: 11.5px; line-height: 1.6; }
`

function esc(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/**
 * Render the login/setup page. `next` is the hidden form target; `error`
 * renders the failure banner (kept generic for the login case).
 */
export function renderLoginPage(state: LoginPageState): string {
  const title = state.setup ? '设置访问密码' : '访问认证'
  const sub = state.setup
    ? '首次使用 dsh web：设置一个访问密码（至少 8 位）。此后访问本服务需要输入该密码。'
    : '此服务需要密码访问。请输入访问密码。'
  const error = state.error === undefined ? '' : `<p class="error">${esc(state.error)}</p>`
  const loggedOut = state.loggedOut === true ? '<p class="info">已退出登录。</p>' : ''
  const nextField = state.next === undefined ? '' : `<input type="hidden" name="next" value="${esc(state.next)}">`
  const confirmField = state.setup
    ? `<label for="confirm">确认密码</label><input id="confirm" name="confirm" type="password" required minlength="8" autocomplete="new-password">`
    : ''
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} — DSH Web</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
<main class="card">
  <h1>${title}</h1>
  <p class="sub">${sub}</p>
  ${loggedOut}${error}
  <form method="post" action="/login">
    ${nextField}
    <label for="password">${state.setup ? '新密码' : '密码'}</label>
    <input id="password" name="password" type="password" required minlength="8"
      autocomplete="${state.setup ? 'new-password' : 'current-password'}" autofocus>
    ${confirmField}
    <button type="submit">${state.setup ? '设置密码并进入' : '登录'}</button>
  </form>
  <p class="foot">DSH Web 访问认证 · 会话有效期 7 天（活动自动续期）</p>
</main>
</body>
</html>`
}
