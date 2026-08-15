/**
 * dsh-web-auth — request handlers: the gate decision (whitelist + session
 * check), the /login page + form processing (including first-password setup),
 * /logout, and the JSON change-password API for the settings card.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  COOKIE_NAME,
  MIN_PASSWORD_LENGTH,
  SESSION_TTL_SECONDS,
  hashPassword,
  needsSessionRefresh,
  sanitizeNext,
  signSession,
  verifyPassword,
  verifySession,
  type RateLimiter
} from './auth-core.ts'
import { renderLoginPage } from './login-page.ts'
import {
  ALLOWED_LISTEN_HOSTS,
  isAllowedListenHost,
  type ListenHost
} from './profile-patch.ts'

/** Maximum accepted request body for the login form / API. */
export const MAX_BODY_BYTES = 16 * 1024

export interface AuthState {
  /** Current session-signing secret (rotated on password change). */
  secret: Buffer
  /** Current password hash (re-read per attempt so GUI changes apply live). */
  readHash(): string | undefined
  writeHash(hash: string): void
  /** Replace the signing secret; returns the new secret. */
  rotateSecret(): Buffer
}

export interface HandlerEnv {
  state: AuthState
  limiter: RateLimiter
  now?: () => number
  /**
   * Loopback authority ("127.0.0.1:<port>") used to rewrite the Host/Origin
   * of AUTHENTICATED requests (any path prefix).
   * The /api gateway pins its privileged methods (settings.*, credentials.*,
   * llm.discoverModels, agentPreset.*, host.*) to loopback because its
   * trustedHosts fence is DNS-rebinding defense, NOT authentication — the
   * upstream comment says the plane stays loopback "until a real
   * authentication layer exists". Plugin surfaces that mirror the /api fence
   * (dsh-better-sidebar's /sidebar routes) behave the same way. This plugin
   * IS that layer: a request carrying a valid session cookie is same-origin
   * by construction (SameSite=Lax), so it may present as loopback. Requests
   * without a session never reach the fences (the gate rejects them first).
   */
  loopbackAuthority?: string
  /**
   * Listen-address controller (bound by the host half when the profile
   * patch layer is reachable). Absent = the settings card cannot change
   * the bind host.
   */
  listen?: ListenController
}

/**
 * Live listen-host switching: the webserver's bind host is composition
 * config, so the change is written into the owning patch layer (profile or
 * home cordis.patch.yml) and HMR hot-applies it — the webserver row
 * reloads, closes its listener, and rebinds. The controller is split into
 * prepare (reportable failures) and commit (after the response flushed,
 * failures logged) because the reload tears down every connection,
 * including the one carrying the confirmation.
 */
export interface ListenController {
  /** The currently resolved bind host (the webserver's runtime config). */
  current(): string | undefined
  /**
   * Read + transform the owning patch layer for `host`, returning the next
   * file content. Throws when the patch file cannot be prepared — the
   * change is refused before anything is written.
   */
  prepare(host: ListenHost): string
  /**
   * Write the prepared content (typically deferred a beat after the
   * response). Failures are logged, never thrown: the caller already
   * confirmed the change to the client.
   */
  commit(content: string): void
}

// ── small request helpers ───────────────────────────────────────────────────

export function pathnameOf(req: IncomingMessage): string {
  return new URL(req.url ?? '/', 'http://x').pathname
}

/** Read one cookie by name from the Cookie header. */
export function cookieValue(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq <= 0) continue
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim()
  }
  return undefined
}

/**
 * The client address for rate limiting. X-Forwarded-For is honored ONLY when
 * the direct peer is loopback (the reverse proxy sits on the same host), so
 * a remote attacker hitting dsh directly cannot forge a fresh identity.
 */
export function clientIp(req: IncomingMessage): string {
  const direct = req.socket.remoteAddress ?? 'unknown'
  const loopback = direct === '127.0.0.1' || direct === '::1' || direct === '::ffff:127.0.0.1'
  if (loopback) {
    const xff = req.headers['x-forwarded-for']
    if (typeof xff === 'string') {
      const first = xff.split(',')[0]?.trim()
      if (first !== undefined && first.length > 0) return first
    }
  }
  return direct
}

/** Whether the browser's connection is HTTPS (reverse-proxied or direct). */
export function isSecureRequest(req: IncomingMessage): boolean {
  return String(req.headers['x-forwarded-proto']).split(',')[0]?.trim() === 'https'
}

/** Collect the request body; undefined when it exceeds the cap (413). */
export async function readBody(req: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<string | undefined> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    total += (chunk as Buffer).length
    if (total > maxBytes) return undefined
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** Parse application/x-www-form-urlencoded. */
export function parseUrlEncoded(body: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const pair of body.split('&')) {
    if (pair.length === 0) continue
    const eq = pair.indexOf('=')
    const key = eq === -1 ? pair : pair.slice(0, eq)
    const value = eq === -1 ? '' : pair.slice(eq + 1)
    try {
      out[decodeURIComponent(key.replace(/\+/g, ' '))] = decodeURIComponent(value.replace(/\+/g, ' '))
    } catch {
      /* malformed pair — ignore */
    }
  }
  return out
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  })
  res.end(text)
}

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(302, { location, 'cache-control': 'no-store' })
  res.end()
}

/** Set (or refresh) the session cookie on a response. */
export function setSessionCookie(res: ServerResponse, secret: Buffer, now: number, secure: boolean): void {
  const exp = Math.floor(now / 1000) + SESSION_TTL_SECONDS
  const value = signSession(secret, exp)
  const parts = [
    COOKIE_NAME + '=' + value,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=' + String(SESSION_TTL_SECONDS)
  ]
  if (secure) parts.push('Secure')
  res.setHeader('set-cookie', parts.join('; '))
}

function clearCookie(res: ServerResponse, secure: boolean): void {
  const parts = [COOKIE_NAME + '=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0']
  if (secure) parts.push('Secure')
  res.setHeader('set-cookie', parts.join('; '))
}

// ── the gate ────────────────────────────────────────────────────────────────

export interface Gate {
  allow(req: IncomingMessage, res: ServerResponse): boolean
  allowUpgrade(req: IncomingMessage): boolean
}

/**
 * Build the gate used to wrap the HTTP server listeners. Whitelisted paths
 * (login page/form, logout) pass through; everything else requires a valid
 * session cookie. Page requests (GET/HEAD) are redirected to /login with the
 * original URL as `next`; other methods get a plain 401 JSON. WebSocket
 * upgrades without a session are rejected at the handshake.
 */
export function createGate(env: HandlerEnv): Gate {
  const now = env.now ?? Date.now
  const whitelisted = (method: string, pathname: string): boolean => {
    if (pathname === '/login') return method === 'GET' || method === 'HEAD' || method === 'POST'
    if (pathname === '/logout') return method === 'GET' || method === 'POST'
    return false
  }

  const sessionOf = (req: IncomingMessage): ReturnType<typeof verifySession> =>
    verifySession(cookieValue(req.headers.cookie, COOKIE_NAME), env.state.secret, now())

  /**
   * Present AUTHENTICATED traffic as loopback to every downstream
   * browser-trust fence, without tracking plugin path prefixes. The /api
   * gateway (dsh-client-connection) and any plugin surface that mirrors its
   * fence (dsh-better-sidebar's /sidebar/* today, whatever prefix the next
   * plugin picks) decide admission from the Host/Origin pair: loopback or
   * the deployment's --trusted-host list. Rather than enumerating prefixes
   * here, ANY request that passed the session check (whitelisted /login,
   * /logout never reach this point) is presented as loopback: SameSite=Lax
   * makes a valid session cookie same-origin by construction, so this is
   * exactly the trust decision the /api rewrite already made, and the gate
   * still refuses unauthenticated traffic before any fence is consulted
   * (401/302). No dsh surface generates content or URLs from the request
   * Host, and the browser builds its own URLs from window.location, so the
   * rewrite is invisible to real behavior. The sec-fetch-site marker is
   * deliberately NOT rewritten: cross-site requests stay refused by the
   * fences even with a session.
   */
  const rewriteAsLoopback = (req: IncomingMessage): void => {
    const authority = env.loopbackAuthority
    if (authority === undefined) return
    req.headers.host = authority
    if (req.headers.origin !== undefined) {
      req.headers.origin = 'http://' + authority
    }
  }

  return {
    allow(req, res) {
      const pathname = pathnameOf(req)
      const method = req.method ?? 'GET'
      if (whitelisted(method, pathname)) return true
      const session = sessionOf(req)
      if (session !== undefined) {
        if (needsSessionRefresh(session, now())) {
          setSessionCookie(res, env.state.secret, now(), isSecureRequest(req))
        }
        rewriteAsLoopback(req)
        return true
      }
      if (method === 'GET' || method === 'HEAD') {
        const next = sanitizeNext(req.url) ?? '/'
        redirect(res, '/login?next=' + encodeURIComponent(next))
      } else {
        writeJson(res, 401, { error: 'unauthorized' })
      }
      return false
    },
    allowUpgrade(req) {
      if (sessionOf(req) === undefined) return false
      rewriteAsLoopback(req)
      return true
    }
  }
}

// ── /login GET — the page ───────────────────────────────────────────────────

export function handleLoginPage(req: IncomingMessage, res: ServerResponse, env: HandlerEnv): void {
  const now = env.now ?? Date.now
  const params = new URL(req.url ?? '/login', 'http://x').searchParams
  const next = sanitizeNext(params.get('next')) ?? undefined
  const error = params.get('error')
  // Already authenticated? Send them where they were going.
  if (verifySession(cookieValue(req.headers.cookie, COOKIE_NAME), env.state.secret, now()) !== undefined) {
    redirect(res, next ?? '/')
    return
  }
  const setup = env.state.readHash() === undefined
  const errorText = error === 'rate-limited'
    ? '尝试过于频繁，请稍后再试。'
    : error === 'setup-failed'
      ? '设置失败：请确认两次输入一致且不少于 8 位。'
      : error === 'wrong-password'
        ? '密码错误。'
        : undefined
  const html = renderLoginPage({ setup, next, error: errorText, loggedOut: params.get('loggedOut') === '1' })
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'",
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer'
  })
  res.end(html)
}

// ── /login POST — form processing ───────────────────────────────────────────

export async function handleLoginPost(req: IncomingMessage, res: ServerResponse, env: HandlerEnv): Promise<void> {
  const now = env.now ?? Date.now
  const secure = isSecureRequest(req)
  const ip = clientIp(req)
  const key = 'login:' + ip

  const blocked = env.limiter.check(key, now())
  if (!blocked.allowed) {
    redirect(res, '/login?error=rate-limited&next=' + encodeURIComponent(sanitizeNext(queryNext(req)) ?? ''))
    return
  }

  const body = await readBody(req)
  if (body === undefined) {
    writeJson(res, 413, { error: 'payload-too-large' })
    return
  }
  const fields = parseUrlEncoded(body)
  const password = fields.password ?? ''
  const next = sanitizeNext(fields.next) ?? '/'

  const hash = env.state.readHash()
  if (hash === undefined) {
    // First-password setup (bootstrap): anyone may claim it until set —
    // the boot log warns about this window.
    const confirm = fields.confirm ?? ''
    if (password.length < MIN_PASSWORD_LENGTH || password !== confirm) {
      env.limiter.recordFailure(key, now())
      redirect(res, '/login?error=setup-failed&next=' + encodeURIComponent(next))
      return
    }
    env.state.writeHash(hashPassword(password))
    const secret = env.state.rotateSecret()
    env.limiter.reset(key)
    setSessionCookie(res, secret, now(), secure)
    redirect(res, next)
    return
  }

  if (!verifyPassword(password, hash)) {
    env.limiter.recordFailure(key, now())
    redirect(res, '/login?error=wrong-password&next=' + encodeURIComponent(next))
    return
  }
  env.limiter.reset(key)
  setSessionCookie(res, env.state.secret, now(), secure)
  redirect(res, next)
}

function queryNext(req: IncomingMessage): string | undefined {
  try {
    return new URL(req.url ?? '/login', 'http://x').searchParams.get('next') ?? undefined
  } catch {
    return undefined
  }
}

// ── /logout ─────────────────────────────────────────────────────────────────

export function handleLogout(req: IncomingMessage, res: ServerResponse, env: HandlerEnv): void {
  clearCookie(res, isSecureRequest(req))
  redirect(res, '/login?loggedOut=1')
}

// ── GET /api/web-auth/status — settings-card state ─────────────────────────

export function handleStatus(req: IncomingMessage, res: ServerResponse, env: HandlerEnv): void {
  const body: { configured: boolean; host?: string } = { configured: env.state.readHash() !== undefined }
  const current = env.listen?.current()
  if (current !== undefined) body.host = current
  writeJson(res, 200, body)
}

// ── POST /api/web-auth/password — settings-card change ──────────────────────

export interface ChangePasswordBody {
  oldPassword?: string
  newPassword?: string
}

export async function handleChangePassword(req: IncomingMessage, res: ServerResponse, env: HandlerEnv): Promise<void> {
  const now = env.now ?? Date.now
  const ip = clientIp(req)
  const key = 'change:' + ip

  const blocked = env.limiter.check(key, now())
  if (!blocked.allowed) {
    writeJson(res, 429, { error: 'rate-limited', retryAfterSeconds: blocked.retryAfterSeconds })
    return
  }

  const body = await readBody(req)
  if (body === undefined) {
    writeJson(res, 413, { error: 'payload-too-large' })
    return
  }
  let parsed: ChangePasswordBody
  try {
    parsed = JSON.parse(body) as ChangePasswordBody
  } catch {
    writeJson(res, 400, { error: 'invalid-json' })
    return
  }
  const oldPassword = parsed.oldPassword ?? ''
  const newPassword = parsed.newPassword ?? ''

  const hash = env.state.readHash()
  if (hash === undefined) {
    writeJson(res, 409, { error: 'not-configured' })
    return
  }
  if (!verifyPassword(oldPassword, hash)) {
    env.limiter.recordFailure(key, now())
    writeJson(res, 401, { error: 'wrong-password' })
    return
  }
  if (newPassword.length < MIN_PASSWORD_LENGTH) {
    writeJson(res, 400, { error: 'password-too-short', minLength: MIN_PASSWORD_LENGTH })
    return
  }
  env.state.writeHash(hashPassword(newPassword))
  env.state.rotateSecret()
  env.limiter.reset(key)
  writeJson(res, 200, { ok: true, sessionsInvalidated: true })
}

// ── POST /api/web-auth/listen — settings-card bind-host switch ──────────────

export interface ListenChangeBody {
  host?: unknown
}

/**
 * Switch the web server's bind host between '127.0.0.1' and '0.0.0.0'.
 *
 * The change is applied to the owning patch layer (profile or home
 * cordis.patch.yml); HMR then reloads the webserver row, which closes and
 * rebinds the listener. The response is written BEFORE the patch file is
 * committed — the reload tears down every connection, including this one —
 * so the client gets its confirmation first and the write lands a beat
 * later (see {@link ListenController}).
 */
export async function handleListenChange(req: IncomingMessage, res: ServerResponse, env: HandlerEnv): Promise<void> {
  const body = await readBody(req)
  if (body === undefined) {
    writeJson(res, 413, { error: 'payload-too-large' })
    return
  }
  let parsed: ListenChangeBody
  try {
    parsed = JSON.parse(body) as ListenChangeBody
  } catch {
    writeJson(res, 400, { error: 'invalid-json' })
    return
  }
  if (!isAllowedListenHost(parsed.host)) {
    writeJson(res, 400, { error: 'invalid-host', allowed: [...ALLOWED_LISTEN_HOSTS] })
    return
  }
  const listen = env.listen
  if (listen === undefined) {
    writeJson(res, 501, { error: 'unsupported' })
    return
  }
  const host = parsed.host
  if (listen.current() === host) {
    writeJson(res, 200, { ok: true, host, unchanged: true })
    return
  }
  let next: string
  try {
    next = listen.prepare(host)
  } catch (error) {
    writeJson(res, 500, {
      error: 'patch-prepare-failed',
      message: error instanceof Error ? error.message : String(error)
    })
    return
  }
  writeJson(res, 200, { ok: true, host, applying: true })
  listen.commit(next)
}
