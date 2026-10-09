/**
 * dsh-web-auth — client half: the plugin's own settings page.
 *
 * Registers into the "settings.section" list slot with the stable id
 * "web-auth", so the page owns one entry in the settings sidebar and renders
 * in the settings panel's content column. The shell draws no page heading, so
 * the page renders its own header (title + one-line summary) over the body.
 *
 * The page shows whether the password gate is configured, changes the
 * password (old + new, via the host's POST /api/web-auth/password — which
 * rotates the signing secret and invalidates every session, including this
 * one), and switches the listen host: the address is one of the machine's
 * concrete interface addresses (reported by GET /api/web-auth/status, never
 * the wildcard — dsh 0.2.1-alpha.2+ fails the whole startup on it), POSTed to
 * /api/web-auth/listen, applied to the patch layer by the host half, and then
 * hot-applied by HMR. The page polls /api/web-auth/status until the new host
 * is live.
 *
 * Deps resolved from the browser module table: react only. The slots and
 * settingsScope services are reached through the cordis context; types come
 * from devDependencies and are erased at build time.
 */
import { useEffect, useState } from 'react'
import type { Context } from '@deepseek-ai/cordis'

/** Services provided by other browser plugins before this one mounts. */
export const inject: string[] = ['slots']

/** The settings namespace this page edits (must match the host half). */
const WEB_AUTH_NS = 'web-auth'

interface SlotEntry {
  name: string
  id?: string
  order?: number
  label?: string | (() => string)
  locale?: string
  inject?: () => unknown
}

interface Slots {
  inject(name: string, register: () => unknown): unknown
  register(def: SlotEntry, component: unknown): unknown
}

const CSS = `
.dwa-page { display: flex; flex-direction: column; gap: 16px; max-width: 720px; }
.dwa-page-head { display: flex; flex-direction: column; gap: 6px; }
.dwa-page-title { color: var(--dsw-alias-label-primary, #e6e6e6); margin: 0; font-size: 15px; font-weight: 600; line-height: 1.4; }
.dwa-page-sub { color: var(--dsw-alias-label-tertiary, #8b93a7); margin: 0; font-size: 13px; line-height: 1.5; }
.dwa-body { display: flex; flex-direction: column; gap: 12px; }
.dwa-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.dwa-status { font-size: 13px; line-height: 1.6; }
.dwa-status[data-on] { color: var(--dsw-alias-label-primary, #e6e6e6); }
.dwa-status[data-off] { color: var(--dsw-alias-state-warn-primary, #e0a53b); }
.dwa-hint { color: var(--dsw-alias-label-tertiary, #8b93a7); font-size: 12px; line-height: 1.6; margin: 0; }
.dwa-field { display: flex; flex-direction: column; gap: 5px; }
.dwa-label { color: var(--dsw-alias-label-secondary, #aab2c5); font-size: 12px; font-weight: 600; }
.dwa-input {
  height: 34px; padding: 0 12px; border-radius: 8px; outline: none;
  border: 1px solid var(--dsw-alias-border-l2, #2a3346);
  background: var(--dsw-alias-bg-layer-3, #0d1017);
  color: var(--dsw-alias-label-primary, #e6e6e6); font: inherit; font-size: 13px;
}
.dwa-input:focus { border-color: var(--dsw-alias-brand-primary, #4f8cff); }
.dwa-actions { display: flex; align-items: center; gap: 10px; }
.dwa-btn {
  height: 32px; padding: 0 14px; border: none; border-radius: 8px; cursor: pointer;
  background: var(--dsw-alias-button-info-fill, #4f8cff); color: #fff;
  font: inherit; font-size: 13px; font-weight: 600;
}
.dwa-btn:hover:not(:disabled) { background: var(--dsw-alias-button-info-hover, #6b9dff); }
.dwa-btn:disabled { opacity: .5; cursor: default; }
.dwa-btn[data-ghost] {
  background: transparent; color: var(--dsw-alias-label-secondary, #aab2c5);
  border: 1px solid var(--dsw-alias-border-l2, #2a3346); font-weight: 500;
}
.dwa-msg { margin: 0; font-size: 12.5px; line-height: 1.6; }
.dwa-msg[data-kind=ok] { color: var(--dsw-alias-state-success-primary, #4caf7d); }
.dwa-msg[data-kind=err] { color: var(--dsw-alias-state-error-primary, #ff8f8f); }
.dwa-divider { border: none; border-top: 1px solid var(--dsw-alias-border-l1, #232a38); margin: 2px 0; }
`

function injectStyle(): void {
  const id = 'dsh-web-auth/settings-section.css'
  if (document.getElementById(id) !== null) return
  const tag = document.createElement('style')
  tag.id = id
  tag.dataset.plugin = 'dsh-web-auth'
  tag.textContent = CSS
  document.head.appendChild(tag)
}

async function changePassword(oldPassword: string, newPassword: string): Promise<{ ok: boolean; message: string }> {
  try {
    const response = await fetch('/api/web-auth/password', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ oldPassword, newPassword })
    })
    const data = (await response.json()) as { ok?: boolean; error?: string }
    if (response.ok && data.ok === true) return { ok: true, message: '密码已修改，所有会话已失效，请重新登录。' }
    if (data.error === 'wrong-password') return { ok: false, message: '旧密码错误。' }
    if (data.error === 'password-too-short') return { ok: false, message: '新密码至少 8 位。' }
    if (data.error === 'rate-limited') return { ok: false, message: '尝试过于频繁，请稍后再试。' }
    return { ok: false, message: '修改失败：' + String(data.error ?? response.status) }
  } catch {
    return { ok: false, message: '网络错误，请重试。' }
  }
}

type ListenOption = { value: string; label: string; loopback: boolean }

/** Whether a value looks like a concrete bind host (client-side guard only). */
function isListenHost(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

interface StatusPayload {
  configured: boolean
  host?: string
  allowed: ListenOption[]
  needsMigration: boolean
}

/** Fetch the auth status (configured + runtime bind host + selectable addresses). */
async function fetchStatus(): Promise<StatusPayload | null> {
  try {
    const response = await fetch('/api/web-auth/status')
    if (!response.ok) return null
    const data = (await response.json()) as {
      configured?: boolean
      host?: unknown
      allowed?: unknown
      needsMigration?: unknown
    }
    return {
      configured: data.configured === true,
      host: isListenHost(data.host) ? data.host : undefined,
      allowed: Array.isArray(data.allowed) ? (data.allowed as ListenOption[]) : [],
      needsMigration: data.needsMigration === true
    }
  } catch {
    return null
  }
}

/** Ask the host half to switch the bind address; returns an error message on refusal. */
async function postListenHost(host: string): Promise<{ ok: boolean; message?: string }> {
  try {
    const response = await fetch('/api/web-auth/listen', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ host })
    })
    const data = (await response.json()) as { ok?: boolean; error?: string; message?: string }
    if (response.ok && data.ok === true) return { ok: true }
    return { ok: false, message: data.message ?? data.error ?? String(response.status) }
  } catch {
    return { ok: false, message: '网络错误' }
  }
}

function WebAuthSettingsSection(): JSX.Element | null {
  const [configured, setConfigured] = useState<boolean | null>(null)
  const [host, setHost] = useState<string | null>(null)
  const [options, setOptions] = useState<ListenOption[]>([])
  const [needsMigration, setNeedsMigration] = useState(false)
  const [oldPassword, setOldPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [listenPick, setListenPick] = useState<string>('')
  const [listenBusy, setListenBusy] = useState(false)
  const [listenMsg, setListenMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)

  useEffect(() => {
    let alive = true
    void fetchStatus().then((status) => {
      if (!alive || status === null) return
      setConfigured(status.configured)
      setOptions(status.allowed)
      setNeedsMigration(status.needsMigration)
      // Preselect the address that is actually live when it is selectable;
      // otherwise fall back to the first (loopback) option instead of
      // echoing a value the host half would refuse on write.
      const selectable = status.host !== undefined && status.allowed.some((o) => o.value === status.host)
      const pick = selectable ? (status.host as string) : (status.allowed[0]?.value ?? '')
      setHost(status.host ?? null)
      setListenPick(pick)
    })
    return () => {
      alive = false
    }
  }, [])

  const submit = async (): Promise<void> => {
    if (newPassword.length < 8) {
      setMessage({ kind: 'err', text: '新密码至少 8 位。' })
      return
    }
    if (newPassword !== confirm) {
      setMessage({ kind: 'err', text: '两次输入的新密码不一致。' })
      return
    }
    setBusy(true)
    setMessage(null)
    const result = await changePassword(oldPassword, newPassword)
    setBusy(false)
    setMessage({ kind: result.ok ? 'ok' : 'err', text: result.message })
    if (result.ok) {
      setConfigured(true)
      setOldPassword('')
      setNewPassword('')
      setConfirm('')
      // The signing secret rotated: this session is dead. Send the user to
      // the login page after a beat so the success message is visible.
      window.setTimeout(() => {
        window.location.href = '/login'
      }, 1600)
    }
  }

  const applyListen = async (): Promise<void> => {
    if (listenPick.length === 0 || host === listenPick) return
    setListenBusy(true)
    setListenMsg(null)
    const result = await postListenHost(listenPick)
    if (!result.ok) {
      setListenBusy(false)
      setListenMsg({ kind: 'err', text: '写入失败：' + String(result.message) })
      return
    }
    setListenMsg({ kind: 'ok', text: '已切换，正在重新绑定监听端口，页面将短暂断连…' })
    // Poll until the new bind host is reported (the connection drops in
    // between; fetch retries once the listener is back).
    for (let i = 0; i < 15; i++) {
      await new Promise((resolve) => setTimeout(resolve, 600))
      const status = await fetchStatus()
      if (status?.host === listenPick) {
        setHost(listenPick)
        setNeedsMigration(status.needsMigration)
        setOptions(status.allowed)
        setListenMsg({ kind: 'ok', text: '已生效：监听地址为 ' + listenPick + '。' })
        setListenBusy(false)
        return
      }
    }
    setListenMsg({ kind: 'ok', text: '已应用，若页面连接中断请稍候刷新（监听地址：' + listenPick + '）。' })
    setListenBusy(false)
  }

  return (
    <div className="dwa-page">
      <header className="dwa-page-head">
        <h3 className="dwa-page-title">访问认证</h3>
        <p className="dwa-page-sub">Web 访问密码与监听地址</p>
      </header>
      <div className="dwa-body">
        <div className="dwa-row">
          <p className="dwa-status" data-on={configured ? undefined : ''} data-off={configured ? '' : undefined}>
            {configured === null ? '加载中…' : configured ? '访问认证：已启用' : '访问认证：未设置密码（当前未启用）'}
          </p>
        </div>
        <p className="dwa-hint">
          设置后，访问本服务需要输入密码；会话有效期 7 天（活动自动续期）。修改密码会使所有已登录会话立即失效。
        </p>
        <hr className="dwa-divider" />
        {configured && (
          <div className="dwa-field">
            <label className="dwa-label" htmlFor="dwa-old">旧密码</label>
            <input id="dwa-old" className="dwa-input" type="password" autoComplete="current-password"
              value={oldPassword} onChange={(e) => setOldPassword(e.target.value)} />
          </div>
        )}
        <div className="dwa-field">
          <label className="dwa-label" htmlFor="dwa-new">新密码（至少 8 位）</label>
          <input id="dwa-new" className="dwa-input" type="password" autoComplete="new-password"
            value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
        </div>
        <div className="dwa-field">
          <label className="dwa-label" htmlFor="dwa-confirm">确认新密码</label>
          <input id="dwa-confirm" className="dwa-input" type="password" autoComplete="new-password"
            value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </div>
        <div className="dwa-actions">
          <button className="dwa-btn" disabled={busy} onClick={() => void submit()}>修改密码</button>
          <button className="dwa-btn" data-ghost="" onClick={() => { window.location.href = '/logout' }}>退出登录</button>
        </div>
        {message !== null && <p className="dwa-msg" data-kind={message.kind} role="alert">{message.text}</p>}
        <hr className="dwa-divider" />
        <div className="dwa-field">
          <label className="dwa-label" htmlFor="dwa-listen">监听地址</label>
          <select id="dwa-listen" className="dwa-input" value={listenPick}
            disabled={listenBusy || options.length === 0}
            onChange={(e) => setListenPick(e.target.value)}>
            {options.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </div>
        <div className="dwa-actions">
          <button className="dwa-btn" disabled={listenBusy || listenPick.length === 0 || host === listenPick}
            onClick={() => void applyListen()}>
            应用监听地址
          </button>
        </div>
        <p className="dwa-hint">
          列表是本机网卡上的具体地址。dsh 0.2.1-alpha.2 起不再接受 0.0.0.0 / ::（通配符会在解析配置阶段直接让
          dsh 启动失败），需要局域网或反代访问请选择对应网卡地址，并优先在本机放一层反代指向 127.0.0.1。
          注意：绑定具体网卡地址后 127.0.0.1 不再监听，本机也需改用该地址访问；若通过局域网 IP 访问，切回
          127.0.0.1 后只能在本机访问。
        </p>
        {needsMigration && (
          <p className="dwa-msg" data-kind="err" role="alert">
            当前配置的监听地址不是本插件可写入的具体地址（例如历史遗留的 0.0.0.0）。请改选一个网卡地址后应用。
          </p>
        )}
        {listenMsg !== null && <p className="dwa-msg" data-kind={listenMsg.kind} role="alert">{listenMsg.text}</p>}
      </div>
    </div>
  )
}

/**
 * Client plugin body: register the settings page.
 *
 * The page needs only the slot ledger — it reads and writes the password and
 * the listen address through the plugin's own REST routes
 * (/api/web-auth/{status,password,listen}). It deliberately does NOT bind the
 * browser settings transport: dsh >= 0.2.1-alpha.2 removed the
 * `settingsScope` client service (its settings plane is now the schema-driven
 * SettingsForms on the host), so a page that waited for it would never
 * register — the 访问认证 entry would silently vanish from Settings.
 *
 * @param ctx - the client cordis context.
 */
export function apply(ctx: Context): void {
  ctx.inject(['slots'], (raw: unknown) => {
    const c = raw as { slots: Slots }
    injectStyle()
    c.slots.inject('settings.section', () =>
      c.slots.register(
        {
          name: 'settings.section',
          id: WEB_AUTH_NS,
          order: 120,
          label: '访问认证',
          inject: () => ({})
        },
        WebAuthSettingsSection
      )
    )
  })
}
