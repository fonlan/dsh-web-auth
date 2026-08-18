/**
 * dsh-web-auth — client half: the plugin's own Settings Card.
 *
 * Registers into the `settings.plugin.item` slot keyed by the `web-auth`
 * settings namespace (the same string the host half registers), so the card
 * appears inside 设置 → 插件配置, paired with the namespace by the tab.
 * The card shows whether the password gate is configured, changes the
 * password (old + new, via the host's POST /api/web-auth/password — which
 * rotates the signing secret and invalidates every session, including this
 * one), and switches the listen host: the bind host is written through the
 * client settings scope (revision-fenced, one source of truth), the host
 * half applies it to the patch layer, and HMR rebinds the webserver — the
 * card polls /api/web-auth/status until the new host is live.
 *
 * Deps resolved from the browser module table: react only. The slots and
 * settingsScope services are reached through the cordis context; types come
 * from devDependencies and are erased at build time.
 */
import { useEffect, useState, useSyncExternalStore } from 'react'
import type { Context } from '@deepseek-ai/cordis'

/** Services provided by other browser plugins before this one mounts.
 *
 * `connection` and `remote` are required by `settingsScope.bind` (it resolves
 * the settings transport and the forwarded-invalidation subscription through
 * `ctx.get`), so the fiber must wait for them — exactly like
 * dsh-client-ui-settings-plugins does for its own cards.
 */
export const inject: string[] = ['slots', 'settingsScope', 'connection', 'remote']

/** The settings namespace this card edits (must match the host half). */
const WEB_AUTH_NS = 'web-auth'

interface SlotEntry {
  name: string
  id?: string
  key?: string
  order?: number
  label?: string | (() => string)
  inject?: () => unknown
}

interface Slots {
  inject(name: string, register: () => unknown): unknown
  register(def: SlotEntry, component: unknown): unknown
}

/** Client settings scope face (subset of @deepseek-ai/dsh-client-runtime). */
interface SettingsScopeFace {
  getSnapshot(): {
    status: 'loading' | 'ready' | 'unavailable'
    value?: { listenHost?: string }
    writable: boolean
  }
  subscribe(listener: () => void): () => void
  set(field: string, value: unknown): Promise<void>
  unset(field: string): Promise<void>
}

interface CardProps {
  /** The bound `web-auth` settings scope (from the slot entry's inject face). */
  scope: SettingsScopeFace
}

const CSS = `
.dwa-card {
  border: 1px solid var(--dsw-alias-border-l2, #2a3346);
  background: var(--dsw-alias-bg-layer-3, #0d1017);
  border-radius: 12px;
  list-style: none;
  transition: border-color .16s, background .16s;
}
.dwa-card:hover { border-color: var(--dsw-alias-label-dimmed, #4a5468); }
.dwa-card[data-open] {
  background: var(--dsw-alias-bg-layer-2, #141a26);
  border-color: var(--dsw-alias-label-dimmed, #4a5468);
}
.dwa-head {
  appearance: none; width: 100%; font: inherit; color: inherit; text-align: left; cursor: pointer;
  background: transparent; border: 0; border-radius: 12px;
  align-items: center; gap: 12px; padding: 14px 16px; display: flex;
}
.dwa-head:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #4f8cff); outline-offset: -2px; }
.dwa-headText { flex-direction: column; flex: 1; gap: 4px; min-width: 0; display: flex; }
.dwa-title { color: var(--dsw-alias-label-primary, #e6e6e6); font-size: 15px; font-weight: 600; line-height: 1.4; }
.dwa-sub { color: var(--dsw-alias-label-tertiary, #8b93a7); font-size: 13px; line-height: 1.5; }
.dwa-chevron {
  color: var(--dsw-alias-label-tertiary, #8b93a7); flex: none;
  transition: transform .16s; display: flex; align-items: center; justify-content: center;
}
.dwa-chevron[data-open] { transform: rotate(180deg); }
.dwa-body { border-top: 1px solid var(--dsw-alias-border-l2, #2a3346); margin: 0 16px; padding: 12px 0 8px; display: flex; flex-direction: column; gap: 12px; }
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
  const id = 'dsh-web-auth/card.css'
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

type ListenHost = '127.0.0.1' | '0.0.0.0'

const LISTEN_OPTIONS: { value: ListenHost; label: string }[] = [
  { value: '127.0.0.1', label: '127.0.0.1（仅本机）' },
  { value: '0.0.0.0', label: '0.0.0.0（所有网卡，局域网可访问）' }
]

function isListenHost(value: unknown): value is ListenHost {
  return value === '127.0.0.1' || value === '0.0.0.0'
}

/** Fetch the auth status (configured + runtime bind host). */
async function fetchStatus(): Promise<{ configured: boolean; host?: ListenHost } | null> {
  try {
    const response = await fetch('/api/web-auth/status')
    if (!response.ok) return null
    const data = (await response.json()) as { configured?: boolean; host?: unknown }
    return { configured: data.configured === true, host: isListenHost(data.host) ? data.host : undefined }
  } catch {
    return null
  }
}

function AuthCard(props: CardProps): JSX.Element | null {
  const { scope } = props
  // Bind the methods: React invokes getSnapshot/subscribe as bare functions,
  // and SettingsScopeController's methods depend on `this`.
  const snapshot = useSyncExternalStore(
    (listener) => scope.subscribe(listener),
    () => scope.getSnapshot()
  )
  const [configured, setConfigured] = useState<boolean | null>(null)
  const [host, setHost] = useState<ListenHost | null>(null)
  const [oldPassword, setOldPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [listenPick, setListenPick] = useState<ListenHost>('127.0.0.1')
  const [listenBusy, setListenBusy] = useState(false)
  const [listenMsg, setListenMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  // Card-local disclosure: collapsed by default, like the built-in plugin cards.
  const [open, setOpen] = useState(false)

  useEffect(() => {
    let alive = true
    void fetchStatus().then((status) => {
      if (!alive || status === null) return
      setConfigured(status.configured)
      if (status.host !== undefined) {
        setHost(status.host)
        setListenPick(status.host)
      }
    })
    return () => {
      alive = false
    }
  }, [])

  // The namespace is served by the host once the scope is ready. While it is
  // merely loading, keep the card mounted (the tab already dispatched it);
  // if it is unavailable (deployment without the host half), render nothing.
  if (snapshot.status === 'unavailable') return null

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
    if (host === listenPick) return
    setListenBusy(true)
    setListenMsg(null)
    try {
      // Write through the settings namespace (the host half applies the
      // patch and HMR rebinds the webserver; the connection drops briefly).
      await scope.set('listenHost', listenPick)
      setListenMsg({ kind: 'ok', text: '已切换，正在重新绑定监听端口，页面将短暂断连…' })
      // Poll until the new bind host is reported (the connection drops in
      // between; fetch retries once the listener is back).
      for (let i = 0; i < 15; i++) {
        await new Promise((resolve) => setTimeout(resolve, 600))
        const status = await fetchStatus()
        if (status?.host === listenPick) {
          setHost(listenPick)
          setListenMsg({ kind: 'ok', text: '已生效：监听地址为 ' + listenPick + '。' })
          return
        }
      }
      setListenMsg({ kind: 'ok', text: '已应用，若页面连接中断请稍候刷新（监听地址：' + listenPick + '）。' })
    } catch {
      setListenMsg({ kind: 'err', text: '写入失败，请重试。' })
    } finally {
      setListenBusy(false)
    }
  }

  return (
    <div className="dwa-card" data-open={open ? '' : undefined}>
      <button type="button" className="dwa-head" aria-expanded={open}
        aria-label={(open ? '收起' : '展开') + '：访问认证'} onClick={() => setOpen(!open)}>
        <span className="dwa-headText">
          <span className="dwa-title">访问认证</span>
          <span className="dwa-sub">Web 访问密码与监听地址</span>
        </span>
        <span className="dwa-chevron" data-open={open ? '' : undefined} aria-hidden="true">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M3.5 5.25L7 8.75L10.5 5.25" stroke="currentColor" strokeWidth="1.5"
              strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      </button>
      {open && (
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
              disabled={listenBusy || host === null || !snapshot.writable}
              onChange={(e) => setListenPick(e.target.value as ListenHost)}>
              {LISTEN_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </div>
          <div className="dwa-actions">
            <button className="dwa-btn" disabled={listenBusy || host === null || host === listenPick || !snapshot.writable}
              onClick={() => void applyListen()}>
              应用监听地址
            </button>
          </div>
          <p className="dwa-hint">
            切换后 dsh 会立即重新绑定监听端口（WebSocket 短暂断连后自动重连）。注意：若当前通过局域网 IP 访问，切回 127.0.0.1 后只能在本机访问。
          </p>
          {listenMsg !== null && <p className="dwa-msg" data-kind={listenMsg.kind} role="alert">{listenMsg.text}</p>}
        </div>
      )}
    </div>
  )
}

/**
 * Client plugin body: register the settings card. The shell's declaration
 * may not be on the ledger yet, so the registration waits via slots.inject.
 * @param ctx - the client cordis context.
 */
export function apply(ctx: Context): void {
  injectStyle()
  const services = ctx as unknown as {
    slots: Slots
    settingsScope: { bind(spec: { namespace: string }): SettingsScopeFace }
  }
  const scope = services.settingsScope.bind({ namespace: WEB_AUTH_NS })
  services.slots.inject('settings.plugin.item', () =>
    services.slots.register(
      {
        name: 'settings.plugin.item',
        key: WEB_AUTH_NS,
        inject: () => ({ scope })
      },
      AuthCard
    )
  )
}
