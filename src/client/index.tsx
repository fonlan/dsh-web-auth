/**
 * dsh-web-auth — client half: the "访问认证" settings section.
 *
 * Registers into the settings.section slot; the card shows whether the
 * password gate is configured, changes the password (old + new, via the
 * host's POST /api/web-auth/password — which rotates the signing secret and
 * invalidates every session, including this one), and offers a logout
 * button.
 *
 * Deps resolved from the browser module table: react only. The slots API is
 * reached through the cordis context; types come from devDependencies and
 * are erased at build time.
 */
import { useEffect, useState } from 'react'
import type { Context } from '@deepseek-ai/cordis'

/** Services provided by other browser plugins before this one mounts. */
export const inject: string[] = ['slots']

interface SlotEntry {
  name: string
  id?: string
  order?: number
  label?: string | (() => string)
  inject?: () => unknown
}

interface Slots {
  inject(name: string, register: () => unknown): unknown
  register(def: SlotEntry, component: unknown): unknown
}

interface CardProps {
  close?: () => void
}

const CSS = `
.dwa-card { display: flex; flex-direction: column; gap: 12px; padding: 16px; }
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

function PasswordSection(_props: CardProps): JSX.Element {
  const [configured, setConfigured] = useState<boolean | null>(null)
  const [oldPassword, setOldPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [listenHost, setListenHost] = useState<ListenHost | null>(null)
  const [listenPick, setListenPick] = useState<ListenHost>('127.0.0.1')
  const [listenBusy, setListenBusy] = useState(false)
  const [listenMsg, setListenMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)

  useEffect(() => {
    let alive = true
    void fetch('/api/web-auth/status')
      .then((response) => (response.ok ? response.json() : null))
      .then((data: { configured?: boolean; host?: unknown } | null) => {
        if (!alive) return
        setConfigured(data?.configured === true)
        if (isListenHost(data?.host)) {
          setListenHost(data.host)
          setListenPick(data.host)
        }
      })
      .catch(() => {
        if (alive) setConfigured(null)
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
    if (listenHost === listenPick) return
    setListenBusy(true)
    setListenMsg(null)
    try {
      const response = await fetch('/api/web-auth/listen', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ host: listenPick })
      })
      const data = (await response.json()) as { ok?: boolean; error?: string; applying?: boolean }
      if (response.ok && data.ok === true) {
        if (data.applying === true) {
          setListenMsg({ kind: 'ok', text: '已切换，正在重新绑定监听端口，页面将短暂断连…' })
          // The webserver reloads itself from the patch layer: poll until the
          // new bind host is reported (the connection drops in between).
          for (let i = 0; i < 15; i++) {
            await new Promise((resolve) => setTimeout(resolve, 600))
            try {
              const check = await fetch('/api/web-auth/status')
              const status = (await check.json()) as { host?: unknown }
              if (isListenHost(status.host) && status.host === listenPick) {
                setListenHost(listenPick)
                setListenMsg({ kind: 'ok', text: '已生效：监听地址为 ' + listenPick + '。' })
                return
              }
            } catch {
              /* server is rebinding — retry */
            }
          }
          setListenMsg({ kind: 'ok', text: '已应用，若页面连接中断请稍候刷新（监听地址：' + listenPick + '）。' })
        } else {
          setListenHost(listenPick)
          setListenMsg({ kind: 'ok', text: '监听地址未变化。' })
        }
      } else {
        const text = data.error === 'invalid-host'
          ? '无效的监听地址。'
          : data.error === 'unsupported'
            ? '当前环境不支持修改监听地址。'
            : '切换失败：' + String(data.error ?? response.status)
        setListenMsg({ kind: 'err', text })
      }
    } catch {
      setListenMsg({ kind: 'err', text: '网络错误，请重试。' })
    } finally {
      setListenBusy(false)
    }
  }

  if (configured === null) {
    return (
      <div className="dwa-card">
        <p className="dwa-hint">加载中…</p>
      </div>
    )
  }

  return (
    <div className="dwa-card">
      <div className="dwa-row">
        <p className="dwa-status" data-on={configured ? undefined : ''} data-off={configured ? '' : undefined}>
          {configured ? '访问认证：已启用' : '访问认证：未设置密码（当前未启用）'}
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
          disabled={listenBusy || listenHost === null}
          onChange={(e) => setListenPick(e.target.value as ListenHost)}>
          {LISTEN_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      </div>
      <div className="dwa-actions">
        <button className="dwa-btn" disabled={listenBusy || listenHost === null || listenHost === listenPick}
          onClick={() => void applyListen()}>
          应用监听地址
        </button>
      </div>
      <p className="dwa-hint">
        切换后 dsh 会立即重新绑定监听端口（WebSocket 短暂断连后自动重连）。注意：若当前通过局域网 IP 访问，切回 127.0.0.1 后只能在本机访问。
      </p>
      {listenMsg !== null && <p className="dwa-msg" data-kind={listenMsg.kind} role="alert">{listenMsg.text}</p>}
    </div>
  )
}

/**
 * Client plugin body: register the settings section. The shell's declaration
 * may not be on the ledger yet, so the registration waits via slots.inject.
 * @param ctx - the client cordis context.
 */
export function apply(ctx: Context): void {
  injectStyle()
  const slots = (ctx as unknown as { slots: Slots }).slots
  slots.inject('settings.section', () =>
    slots.register(
      {
        name: 'settings.section',
        id: 'web-auth',
        order: 120,
        label: () => '访问认证'
      },
      PasswordSection
    )
  )
}
