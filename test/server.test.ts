/**
 * Integration tests: a real node:http server shaped like the dsh webserver
 * (route table + fallback + upgrade listeners), with the auth gate wrapped
 * around its listeners — exercising the full login/setup/logout/change
 * password flows over HTTP, plus WebSocket upgrade rejection and cookie
 * sliding refresh.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { connect } from 'node:net'
import { randomBytes } from 'node:crypto'
import { installGate } from '../lib/gate.js'
import {
  createGate,
  handleChangePassword,
  handleListenChange,
  handleLoginPage,
  handleLoginPost,
  handleLogout,
  handleStatus,
  type HandlerEnv,
  type ListenController
} from '../lib/handlers.js'
import { RateLimiter, SESSION_TTL_SECONDS, hashPassword } from '../lib/auth-core.js'

const PASSWORD = 'correct-horse-battery'

interface Harness {
  base: string
  env: HandlerEnv
  server: Server
  port: number
  /** Resolves once the server is actually listening (raw sockets need it). */
  ready(): Promise<void>
  advance(ms: number): void
  close(): Promise<void>
  request(path: string, init?: RequestInit & { headers?: Record<string, string> }): Promise<Response>
  cookieOf(response: Response): string | undefined
  login(password: string, extraHeaders?: Record<string, string>): Promise<string | undefined>
}

/**
 * Build a server that mirrors the webserver composition: route table +
 * fallback request handler + upgrade listener, then the auth gate installed
 * over the captured listeners (exactly what the plugin does).
 */
function createHarness(
  withPassword: boolean,
  beforeGate?: (server: Server) => void,
  listen?: ListenController
): Harness {
  let now = Date.now()
  let port = 0
  let secret = randomBytes(32)
  let hash: string | undefined = withPassword ? hashPassword(PASSWORD) : undefined
  const state = {
    get secret(): Buffer {
      return secret
    },
    readHash: () => hash,
    writeHash: (h: string) => {
      hash = h
    },
    rotateSecret: () => {
      secret = randomBytes(32)
      return secret
    }
  }
  const env: HandlerEnv = {
    state,
    limiter: new RateLimiter(),
    now: () => now,
    get loopbackAuthority() {
      return port === 0 ? undefined : '127.0.0.1:' + port
    },
    ...(listen === undefined ? {} : { listen })
  }

  const routes = new Map<string, (req: IncomingMessage, res: ServerResponse) => void>()

  // A faithful mirror of the /api browser-trust fence (dsh-client-connection):
  // Host must be loopback or trusted; privileged methods are pinned to
  // loopback (empty trust list); sec-fetch-site:cross-site and Origin
  // mismatches are rejected.
  const privileged = new Set(['settings.describe', 'credentials.describe'])
  const isTrustedApiRequest = (req: IncomingMessage, trusted: string[]): boolean => {
    const host = String(req.headers.host ?? '')
    const hostname = host.split(':')[0]
    const loopback = hostname === '127.0.0.1' || hostname === '::1' || hostname === 'localhost'
    if (!loopback && !trusted.includes(host) && !trusted.includes(hostname)) return false
    if (req.headers['sec-fetch-site'] === 'cross-site') return false
    const origin = req.headers.origin
    if (origin === undefined) return true
    try {
      return new URL(String(origin)).host === host
    } catch {
      return false
    }
  }
  const fence = (req: IncomingMessage): boolean => {
    const pathname = new URL(req.url ?? '/', 'http://x').pathname
    if (pathname.startsWith('/api/')) {
      const method = pathname.slice(5)
      if (privileged.has(method)) return isTrustedApiRequest(req, [])
      return isTrustedApiRequest(req, [])
    }
    return true
  }

  const server = createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://x').pathname
    const handler = routes.get(pathname)
    if (handler !== undefined) {
      handler(req, res)
      return
    }
    if (pathname.startsWith('/api/')) {
      if (!fence(req)) {
        res.writeHead(403, { 'content-type': 'text/plain' })
        res.end('forbidden')
        return
      }
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('rpc:' + pathname.slice(5))
      return
    }
    if (pathname.startsWith('/sidebar/') || pathname.startsWith('/custom-panel/')) {
      // Plugin surfaces mirroring the /api fence with an EMPTY trust list
      // (dsh-better-sidebar's trustedHosts lookup never resolves — it
      // matches the connection row by plugin name — so in practice it only
      // accepts loopback Hosts). Only the auth gate's loopback rewrite can
      // let a proxy-domain request through, and it must do so for ANY
      // plugin prefix, not a maintained list.
      if (!isTrustedApiRequest(req, [])) {
        res.writeHead(403, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: { code: 'forbidden', message: 'forbidden' } }))
        return
      }
      const label = pathname.startsWith('/sidebar/') ? 'sidebar' : 'custom-panel'
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('rpc:' + label + ':' + pathname.slice(pathname.indexOf('/', 1) + 1))
      return
    }
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('fallback:' + pathname)
  })
  server.on('upgrade', (req, socket, head) => {
    const pathname = new URL(req.url ?? '/', 'http://x').pathname
    if (pathname === '/api/mux/events') {
      if (!fence(req)) {
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\nforbidden')
        return
      }
      socket.end(
        'HTTP/1.1 101 Switching Protocols\r\n' +
        'Connection: Upgrade\r\nUpgrade: websocket\r\n\r\n'
      )
      return
    }
    if (pathname === '/sidebar/ws/agent-terminals') {
      // Same empty-trust-list fence as the request mirror above.
      if (!isTrustedApiRequest(req, [])) {
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\nforbidden')
        return
      }
      socket.end(
        'HTTP/1.1 101 Switching Protocols\r\n' +
        'Connection: Upgrade\r\nUpgrade: websocket\r\n\r\n'
      )
      return
    }
    socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
  })

  beforeGate?.(server)

  // The plugin's own routes (as index.ts registers them against webServer).
  routes.set('/login', (req, res) => {
    const method = req.method ?? 'GET'
    if (method === 'POST') {
      void handleLoginPost(req, res, env)
    } else if (method === 'GET' || method === 'HEAD') {
      handleLoginPage(req, res, env)
    } else {
      res.writeHead(405, { allow: 'GET, HEAD, POST' })
      res.end()
    }
  })
  routes.set('/logout', (req, res) => handleLogout(req, res, env))
  routes.set('/api/web-auth/password', (req, res) => void handleChangePassword(req, res, env))
  routes.set('/api/web-auth/status', (req, res) => handleStatus(req, res, env))
  routes.set('/api/web-auth/listen', (req, res) => void handleListenChange(req, res, env))

  // The auth gate wraps the listeners AFTER they exist, exactly like the
  // plugin does once webServer reports listening.
  installGate(server, createGate(env))

  const listening = new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      port = (server.address() as { port: number }).port
      resolve()
    })
  })

  const harness: Harness = {
    get base() {
      return 'http://127.0.0.1:' + port
    },
    get port() {
      return port
    },
    ready: () => listening,
    env,
    server,
    advance: (ms: number) => {
      now += ms
    },
    close: () => new Promise((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    }),
    async request(path, init = {}) {
      await listening
      return fetch(harness.base + path, {
        ...init,
        redirect: 'manual',
        headers: { ...(init.headers ?? {}) }
      })
    },
    cookieOf(response) {
      const setCookie = response.headers.get('set-cookie')
      if (setCookie === null) return undefined
      return setCookie.split(';')[0]
    },
    async login(password, extraHeaders = {}) {
      const r = await harness.request('/login', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', ...extraHeaders },
        body: 'password=' + encodeURIComponent(password) + '&next=%2F'
      })
      const cookie = harness.cookieOf(r)
      await r.arrayBuffer()
      return cookie
    }
  }
  return harness
}

function cookieHeader(cookie: string | undefined): Record<string, string> {
  return cookie === undefined ? {} : { cookie }
}

async function rawUpgrade(port: number, cookie?: string, host?: string, path = '/api/mux/events'): Promise<string> {
  // One retry: macOS can transiently fail a fresh loopback connect with
  // EADDRNOTAVAIL right after a burst of socket churn in the same process.
  for (let attempt = 0; ; attempt++) {
    try {
      return await new Promise((resolve, reject) => {
        const socket = connect(port, '127.0.0.1')
        let data = ''
        socket.on('data', (chunk) => {
          data += chunk.toString()
        })
        socket.on('close', () => resolve(data))
        socket.on('error', reject)
        socket.write(
          'GET ' + path + ' HTTP/1.1\r\n' +
          'Host: ' + (host ?? '127.0.0.1') + '\r\n' +
          (cookie === undefined ? '' : 'Cookie: ' + cookie + '\r\n') +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
          'Sec-WebSocket-Version: 13\r\n\r\n'
        )
      })
    } catch (error) {
      if (attempt === 1 || (error as NodeJS.ErrnoException).code !== 'EADDRNOTAVAIL') throw error
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
}

describe('gate: unauthenticated access', () => {
  it('redirects page requests to /login with next preserved', async () => {
    const h = createHarness(true)
    const r = await h.request('/')
    assert.equal(r.status, 302)
    assert.equal(r.headers.get('location'), '/login?next=%2F')
    await r.arrayBuffer()

    const r2 = await h.request('/settings?tab=web-auth')
    assert.equal(r2.status, 302)
    assert.equal(r2.headers.get('location'), '/login?next=%2Fsettings%3Ftab%3Dweb-auth')
    await r2.arrayBuffer()
    await h.close()
  })

  it('rejects API requests with 401 JSON', async () => {
    const h = createHarness(true)
    const r = await h.request('/api/foo', { method: 'POST', body: '{}' })
    assert.equal(r.status, 401)
    assert.deepEqual(await r.json(), { error: 'unauthorized' })
    await h.close()
  })

  it('rejects WebSocket upgrades without a session', async () => {
    const h = createHarness(true)
    await h.ready()
    const data = await rawUpgrade(h.port)
    assert.match(data, /^HTTP\/1\.1 401/)
    assert.match(data, /unauthorized/)
    await h.close()
  })

  it('lets whitelisted /login through and serves a hardened page', async () => {
    const h = createHarness(true)
    const page = await h.request('/login')
    assert.equal(page.status, 200)
    const html = await page.text()
    assert.match(html, /访问认证/)
    assert.equal(page.headers.get('content-security-policy')?.includes("form-action 'self'"), true)
    assert.equal(page.headers.get('cache-control'), 'no-store')
    await h.close()
  })
})

describe('first-password setup (bootstrap)', () => {
  it('opens the setup form when no password is configured', async () => {
    const h = createHarness(false)
    const html = await (await h.request('/login')).text()
    assert.match(html, /设置访问密码/)
    assert.match(html, /确认密码/)
    await h.close()
  })

  it('rejects short or mismatched setup passwords', async () => {
    const h = createHarness(false)
    const short = await h.request('/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'password=short&confirm=short&next=%2F'
    })
    assert.equal(short.status, 302)
    assert.match(short.headers.get('location') ?? '', /error=setup-failed/)
    await short.arrayBuffer()

    const mismatch = await h.request('/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'password=' + encodeURIComponent(PASSWORD) + '&confirm=other&next=%2F'
    })
    assert.equal(mismatch.status, 302)
    assert.match(mismatch.headers.get('location') ?? '', /error=setup-failed/)
    await mismatch.arrayBuffer()
    assert.equal(h.env.state.readHash(), undefined)
    await h.close()
  })

  it('sets the first password, issues a session, and the gate closes', async () => {
    const h = createHarness(false)
    const ok = await h.request('/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'password=' + encodeURIComponent(PASSWORD) + '&confirm=' + encodeURIComponent(PASSWORD) + '&next=%2Fsettings'
    })
    assert.equal(ok.status, 302)
    assert.equal(ok.headers.get('location'), '/settings')
    const cookie = h.cookieOf(ok)
    assert.ok(cookie?.startsWith('dsh_web_auth='))
    assert.match(ok.headers.get('set-cookie') ?? '', /HttpOnly/)
    assert.match(ok.headers.get('set-cookie') ?? '', /SameSite=Lax/)
    await ok.arrayBuffer()

    // The gate is now closed: no cookie → redirected.
    const denied = await h.request('/')
    assert.equal(denied.status, 302)
    await denied.arrayBuffer()
    // With the session → through to the fallback.
    const allowed = await h.request('/', { headers: cookieHeader(cookie) })
    assert.equal(allowed.status, 200)
    assert.equal(await allowed.text(), 'fallback:/')
    await h.close()
  })
})

describe('login flow', () => {
  it('rejects a wrong password and redirects back with error', async () => {
    const h = createHarness(true)
    const r = await h.request('/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'password=wrong-password&next=%2F'
    })
    assert.equal(r.status, 302)
    assert.match(r.headers.get('location') ?? '', /error=wrong-password/)
    await r.arrayBuffer()
    await h.close()
  })

  it('rate-limits repeated failures per client and clears on success', async () => {
    const h = createHarness(true)
    const post = () =>
      h.request('/login', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'password=wrong-password&next=%2F'
      })
    for (let i = 0; i < 5; i++) {
      const r = await post()
      assert.equal(r.status, 302)
      await r.arrayBuffer()
    }
    // 6th attempt: blocked — even the correct password is refused
    for (let i = 0; i < 2; i++) {
      const r = await post()
      assert.match(r.headers.get('location') ?? '', /error=rate-limited/)
      await r.arrayBuffer()
    }
    const correctWhileBlocked = await h.request('/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'password=' + encodeURIComponent(PASSWORD) + '&next=%2F'
    })
    assert.match(correctWhileBlocked.headers.get('location') ?? '', /error=rate-limited/)
    await correctWhileBlocked.arrayBuffer()

    // after the block window, a correct password succeeds and resets the bucket
    h.advance(61_000)
    const good = await h.request('/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'password=' + encodeURIComponent(PASSWORD) + '&next=%2F'
    })
    assert.equal(good.status, 302)
    assert.equal(good.headers.get('location'), '/')
    const cookie = h.cookieOf(good)
    assert.ok(cookie)
    await good.arrayBuffer()

    // bucket was reset: a fresh wrong attempt is allowed again
    const afterReset = await post()
    assert.match(afterReset.headers.get('location') ?? '', /error=wrong-password/)
    await afterReset.arrayBuffer()
    await h.close()
  })

  it('honors X-Forwarded-For from a loopback peer for rate-limit identity', async () => {
    const h = createHarness(true)
    const fail = (xff: string) =>
      h.request('/login', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': xff },
        body: 'password=wrong-password&next=%2F'
      })
    for (let i = 0; i < 5; i++) {
      const r = await fail('203.0.113.7')
      assert.equal(r.status, 302)
      await r.arrayBuffer()
    }
    // The XFF identity is blocked; a different XFF is a different bucket.
    const blocked = await fail('203.0.113.7')
    assert.match(blocked.headers.get('location') ?? '', /error=rate-limited/)
    await blocked.arrayBuffer()
    const other = await fail('203.0.113.8')
    assert.match(other.headers.get('location') ?? '', /error=wrong-password/)
    await other.arrayBuffer()
    await h.close()
  })

  it('signs in, then the session passes the gate and slides when old', async () => {
    const h = createHarness(true)
    const cookie = await h.login(PASSWORD)
    assert.ok(cookie)

    const allowed = await h.request('/', { headers: cookieHeader(cookie) })
    assert.equal(allowed.status, 200)
    assert.equal(await allowed.text(), 'fallback:/')

    // Age the session to just under the refresh threshold: the next request
    // carries a refreshed Set-Cookie with a full lifetime.
    h.advance((SESSION_TTL_SECONDS - 60) * 1000)
    const refresh = await h.request('/', { headers: cookieHeader(cookie) })
    assert.equal(refresh.status, 200)
    const refreshedCookie = refresh.headers.get('set-cookie')
    assert.match(refreshedCookie ?? '', /Max-Age=604800/)
    await refresh.arrayBuffer()

    // A second request carrying the REFRESHED cookie (what the browser now
    // holds) gets no new Set-Cookie — the session has a full lifetime again.
    const freshValue = (refreshedCookie ?? '').split(';')[0]
    const noRefresh = await h.request('/', { headers: cookieHeader(freshValue) })
    assert.equal(noRefresh.status, 200)
    assert.equal(noRefresh.headers.get('set-cookie'), null)
    await noRefresh.arrayBuffer()
    await h.close()
  })
})

describe('logout', () => {
  it('clears the cookie and redirects to /login', async () => {
    const h = createHarness(true)
    const cookie = await h.login(PASSWORD)

    const out = await h.request('/logout', { headers: cookieHeader(cookie) })
    assert.equal(out.status, 302)
    assert.equal(out.headers.get('location'), '/login?loggedOut=1')
    assert.match(out.headers.get('set-cookie') ?? '', /Max-Age=0/)
    await out.arrayBuffer()

    // A real browser drops the cookie (Max-Age=0); a request without it is
    // redirected again. (Re-sending the old cookie value would still verify —
    // the HMAC session is stateless and logout is client-side.)
    const denied = await h.request('/')
    assert.equal(denied.status, 302)
    await denied.arrayBuffer()
    await h.close()
  })
})

describe('change password API', () => {
  it('requires an authenticated session', async () => {
    const h = createHarness(true)
    const r = await h.request('/api/web-auth/password', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ oldPassword: PASSWORD, newPassword: 'new-password-123' })
    })
    assert.equal(r.status, 401)
    await h.close()
  })

  it('rejects a wrong old password and rate-limits hammering', async () => {
    const h = createHarness(true)
    const cookie = await h.login(PASSWORD)

    const attempt = () =>
      h.request('/api/web-auth/password', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...cookieHeader(cookie) },
        body: JSON.stringify({ oldPassword: 'nope', newPassword: 'new-password-123' })
      })
    for (let i = 0; i < 5; i++) {
      const r = await attempt()
      assert.equal(r.status, 401)
      assert.deepEqual(await r.json(), { error: 'wrong-password' })
    }
    const blocked = await attempt()
    assert.equal(blocked.status, 429)
    await h.close()
  })

  it('changes the password, rotates the secret, and kills every session', async () => {
    const h = createHarness(true)
    const cookie = await h.login(PASSWORD)

    const r = await h.request('/api/web-auth/password', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...cookieHeader(cookie) },
      body: JSON.stringify({ oldPassword: PASSWORD, newPassword: 'new-password-123' })
    })
    assert.equal(r.status, 200)
    assert.deepEqual(await r.json(), { ok: true, sessionsInvalidated: true })

    // The old session is dead (secret rotated).
    const denied = await h.request('/', { headers: cookieHeader(cookie) })
    assert.equal(denied.status, 302)
    await denied.arrayBuffer()

    // The old password no longer works; the new one does.
    const oldPw = await h.request('/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'password=' + encodeURIComponent(PASSWORD) + '&next=%2F'
    })
    assert.match(oldPw.headers.get('location') ?? '', /error=wrong-password/)
    await oldPw.arrayBuffer()

    const newPw = await h.request('/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'password=' + encodeURIComponent('new-password-123') + '&next=%2F'
    })
    assert.equal(newPw.status, 302)
    assert.equal(newPw.headers.get('location'), '/')
    await newPw.arrayBuffer()
    await h.close()
  })

  it('rejects short new passwords', async () => {
    const h = createHarness(true)
    const cookie = await h.login(PASSWORD)
    const r = await h.request('/api/web-auth/password', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...cookieHeader(cookie) },
      body: JSON.stringify({ oldPassword: PASSWORD, newPassword: 'short' })
    })
    assert.equal(r.status, 400)
    assert.deepEqual(await r.json(), { error: 'password-too-short', minLength: 8 })
    await h.close()
  })
})

describe('status API and authenticated upgrades', () => {
  it('reports configuration state to the authenticated settings card', async () => {
    const h = createHarness(true)
    const cookie = await h.login(PASSWORD)
    const r = await h.request('/api/web-auth/status', { headers: cookieHeader(cookie) })
    assert.equal(r.status, 200)
    assert.deepEqual(await r.json(), { configured: true })
    await h.close()
  })

  it('reports the current bind host when a listen controller is bound', async () => {
    const h = createHarness(true, undefined, {
      current: () => '0.0.0.0',
      prepare: () => '',
      commit: () => {}
    })
    const cookie = await h.login(PASSWORD)
    const r = await h.request('/api/web-auth/status', { headers: cookieHeader(cookie) })
    assert.equal(r.status, 200)
    assert.deepEqual(await r.json(), { configured: true, host: '0.0.0.0' })
    await h.close()
  })

  it('passes authenticated WebSocket upgrades to the original listener', async () => {
    const h = createHarness(true)
    const cookie = await h.login(PASSWORD)
    await h.ready()
    const data = await rawUpgrade(h.port, cookie)
    assert.match(data, /^HTTP\/1\.1 101/)
    await h.close()
  })
})

describe('listen change API', () => {
  it('requires an authenticated session', async () => {
    const h = createHarness(true, undefined, {
      current: () => '127.0.0.1',
      prepare: () => '',
      commit: () => {}
    })
    const r = await h.request('/api/web-auth/listen', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ host: '0.0.0.0' })
    })
    assert.equal(r.status, 401)
    assert.deepEqual(await r.json(), { error: 'unauthorized' })
    await h.close()
  })

  it('rejects hosts outside the two allowed literals', async () => {
    let prepared = 0
    const h = createHarness(true, undefined, {
      current: () => '127.0.0.1',
      prepare: () => {
        prepared += 1
        return ''
      },
      commit: () => {}
    })
    const cookie = await h.login(PASSWORD)
    for (const host of ['localhost', '10.0.0.5', 42, null, undefined]) {
      const r = await h.request('/api/web-auth/listen', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...cookieHeader(cookie) },
        body: JSON.stringify({ host })
      })
      assert.equal(r.status, 400)
      const body = (await r.json()) as { error: string; allowed?: string[] }
      assert.equal(body.error, 'invalid-host')
      assert.deepEqual(body.allowed, ['127.0.0.1', '0.0.0.0'])
    }
    assert.equal(prepared, 0)
    await h.close()
  })

  it('answers 501 when no listen controller is bound', async () => {
    const h = createHarness(true)
    const cookie = await h.login(PASSWORD)
    const r = await h.request('/api/web-auth/listen', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...cookieHeader(cookie) },
      body: JSON.stringify({ host: '0.0.0.0' })
    })
    assert.equal(r.status, 501)
    assert.deepEqual(await r.json(), { error: 'unsupported' })
    await h.close()
  })

  it('prepares then commits the patch for a real switch', async () => {
    let current = '127.0.0.1'
    const calls: { phase: string; host: string }[] = []
    const h = createHarness(true, undefined, {
      current: () => current,
      prepare: (host) => {
        calls.push({ phase: 'prepare', host })
        return '# next patch\n'
      },
      commit: (content) => {
        calls.push({ phase: 'commit', host: content })
        current = '0.0.0.0'
      }
    })
    const cookie = await h.login(PASSWORD)
    const r = await h.request('/api/web-auth/listen', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...cookieHeader(cookie) },
      body: JSON.stringify({ host: '0.0.0.0' })
    })
    assert.equal(r.status, 200)
    assert.deepEqual(await r.json(), { ok: true, host: '0.0.0.0', applying: true })
    assert.deepEqual(calls, [
      { phase: 'prepare', host: '0.0.0.0' },
      { phase: 'commit', host: '# next patch\n' }
    ])
    // the controller's own state moved, and status reflects it
    const status = await h.request('/api/web-auth/status', { headers: cookieHeader(cookie) })
    assert.deepEqual(await status.json(), { configured: true, host: '0.0.0.0' })
    await h.close()
  })

  it('short-circuits when the requested host is already active', async () => {
    let calls = 0
    const h = createHarness(true, undefined, {
      current: () => '0.0.0.0',
      prepare: () => {
        calls += 1
        return ''
      },
      commit: () => {
        calls += 1
      }
    })
    const cookie = await h.login(PASSWORD)
    const r = await h.request('/api/web-auth/listen', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...cookieHeader(cookie) },
      body: JSON.stringify({ host: '0.0.0.0' })
    })
    assert.equal(r.status, 200)
    assert.deepEqual(await r.json(), { ok: true, host: '0.0.0.0', unchanged: true })
    assert.equal(calls, 0)
    await h.close()
  })

  it('refuses with 500 and never commits when preparation fails', async () => {
    let commits = 0
    const h = createHarness(true, undefined, {
      current: () => '127.0.0.1',
      prepare: () => {
        throw new Error('boom')
      },
      commit: () => {
        commits += 1
      }
    })
    const cookie = await h.login(PASSWORD)
    const r = await h.request('/api/web-auth/listen', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...cookieHeader(cookie) },
      body: JSON.stringify({ host: '0.0.0.0' })
    })
    assert.equal(r.status, 500)
    const body = (await r.json()) as { error: string; message: string }
    assert.equal(body.error, 'patch-prepare-failed')
    assert.equal(body.message, 'boom')
    assert.equal(commits, 0)
    await h.close()
  })
})

describe('cookie hygiene', () => {
  it('sets Secure only when the request arrives over https (x-forwarded-proto)', async () => {
    const h = createHarness(true)
    const viaHttps = await h.request('/login', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-forwarded-proto': 'https'
      },
      body: 'password=' + encodeURIComponent(PASSWORD) + '&next=%2F'
    })
    assert.match(viaHttps.headers.get('set-cookie') ?? '', /Secure/)
    await viaHttps.arrayBuffer()

    const viaHttp = await h.request('/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'password=' + encodeURIComponent(PASSWORD) + '&next=%2F'
    })
    assert.doesNotMatch(viaHttp.headers.get('set-cookie') ?? '', /Secure/)
    await viaHttp.arrayBuffer()
    await h.close()
  })

  it('never reflects a session through the fallback without one', async () => {
    const h = createHarness(false)
    const r = await h.request('/assets/app.js')
    assert.equal(r.status, 302)
    await r.arrayBuffer()
    await h.close()
  })
})

describe('reverse proxy (privileged /api fence relaxation)', () => {
  it('lets authenticated privileged RPCs through a proxy Host without --trusted-host', async () => {
    const h = createHarness(true)
    const cookie = await h.login(PASSWORD)
    assert.ok(cookie)

    // Through the proxy the Host is the public domain; no --trusted-host was
    // given. The gate rewrites the request as loopback for the fence, so the
    // loopback-pinned settings.describe still dispatches.
    const rpc = await h.request('/api/settings.describe', {
      headers: { ...cookieHeader(cookie), host: 'dsh.fonlan.top' }
    })
    assert.equal(rpc.status, 200)
    assert.equal(await rpc.text(), 'rpc:settings.describe')

    // Same for the ordinary (non-privileged) path and for credentialed calls.
    const cred = await h.request('/api/credentials.describe', {
      headers: { ...cookieHeader(cookie), host: 'dsh.fonlan.top' }
    })
    assert.equal(cred.status, 200)
    await cred.arrayBuffer()
    await h.close()
  })

  it('still rejects cross-site requests even with a session (fence preserved)', async () => {
    const h = createHarness(true)
    const cookie = await h.login(PASSWORD)
    const rpc = await h.request('/api/settings.describe', {
      headers: {
        ...cookieHeader(cookie),
        host: 'dsh.fonlan.top',
        'sec-fetch-site': 'cross-site'
      }
    })
    assert.equal(rpc.status, 403)
    await rpc.arrayBuffer()
    await h.close()
  })

  it('never relaxes the fence for unauthenticated traffic', async () => {
    const h = createHarness(true)
    // No cookie: our gate answers before the fence is ever consulted —
    // page requests (GET) are redirected to /login, others get 401 JSON.
    const page = await h.request('/api/settings.describe', {
      headers: { host: 'dsh.fonlan.top' }
    })
    assert.equal(page.status, 302)
    assert.match(page.headers.get('location') ?? '', /^\/login\?next=/)
    await page.arrayBuffer()

    const rpc = await h.request('/api/settings.describe', {
      method: 'POST',
      headers: { host: 'dsh.fonlan.top' }
    })
    assert.equal(rpc.status, 401)
    await rpc.arrayBuffer()
    await h.close()
  })

  it('passes authenticated WebSocket upgrades through a proxy Host', async () => {
    const h = createHarness(true)
    const cookie = await h.login(PASSWORD)
    await h.ready()
    const data = await rawUpgrade(h.port, cookie, 'dsh.fonlan.top')
    assert.match(data, /^HTTP\/1\.1 101/)
    await h.close()
  })

  it('leaves unauthenticated upgrades rejected through a proxy Host', async () => {
    const h = createHarness(true)
    await h.ready()
    const data = await rawUpgrade(h.port, undefined, 'dsh.fonlan.top')
    assert.match(data, /^HTTP\/1\.1 401/)
    await h.close()
  })

  it('presents authenticated /sidebar traffic as loopback (empty-trust plugin fence)', async () => {
    const h = createHarness(true)
    const cookie = await h.login(PASSWORD)
    // dsh-better-sidebar mounts /sidebar/* behind a copy of the /api fence
    // whose trust list never resolves; only the gate's loopback rewrite can
    // carry a proxy-domain request through.
    const rpc = await h.request('/sidebar/api/fs.tree', {
      method: 'POST',
      headers: { ...cookieHeader(cookie), host: 'dsh.fonlan.top' }
    })
    assert.equal(rpc.status, 200)
    assert.equal(await rpc.text(), 'rpc:sidebar:api/fs.tree')
    await h.close()
  })

  it('keeps unauthenticated /sidebar traffic gated before the plugin fence', async () => {
    const h = createHarness(true)
    const rpc = await h.request('/sidebar/api/fs.tree', {
      method: 'POST',
      headers: { host: 'dsh.fonlan.top' }
    })
    assert.equal(rpc.status, 401)
    await rpc.arrayBuffer()
    await h.close()
  })

  it('passes authenticated /sidebar WebSocket upgrades through a proxy Host', async () => {
    const h = createHarness(true)
    const cookie = await h.login(PASSWORD)
    await h.ready()
    const data = await rawUpgrade(h.port, cookie, 'dsh.fonlan.top', '/sidebar/ws/agent-terminals?sessionId=s1')
    assert.match(data, /^HTTP\/1\.1 101/)
    await h.close()
  })

  it('covers any future plugin prefix, not a maintained list', async () => {
    const h = createHarness(true)
    const cookie = await h.login(PASSWORD)
    // A prefix this plugin has never heard of: the gate must still present
    // it as loopback so an arbitrary fence-mirroring plugin passes.
    const rpc = await h.request('/custom-panel/api/items.list', {
      method: 'POST',
      headers: { ...cookieHeader(cookie), host: 'dsh.fonlan.top' }
    })
    assert.equal(rpc.status, 200)
    assert.equal(await rpc.text(), 'rpc:custom-panel:api/items.list')
    await h.close()
  })

  it('still gates unauthenticated traffic under arbitrary prefixes', async () => {
    const h = createHarness(true)
    const rpc = await h.request('/custom-panel/api/items.list', {
      method: 'POST',
      headers: { host: 'dsh.fonlan.top' }
    })
    assert.equal(rpc.status, 401)
    await rpc.arrayBuffer()
    await h.close()
  })
})
