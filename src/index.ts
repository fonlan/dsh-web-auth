/**
 * dsh-web-auth — password gate for the dsh web surface.
 *
 * Host half: wraps the webserver's HTTP/upgrade listeners so every request
 * (routes, static fallback, WebSocket upgrades) must carry a valid session
 * cookie, serves the /login page (including first-password setup), /logout,
 * and the JSON change-password API used by the settings card (client half).
 *
 * State lives under $DSH_HOME/web-auth/ (password.hash, secret) — see
 * state.ts. Until a password is configured the gate is OPEN and a boot
 * warning is logged; the login page then offers first-password setup.
 *
 * Install (bundle layer):  dsh plugin --profile web add ./dsh-web-auth
 */
import { installGate } from './gate.ts'
import { RateLimiter } from './auth-core.ts'
import { readSecret, readPasswordHash, resolveDshHome, rotateSecret, writePasswordHash } from './state.ts'
import {
  createGate,
  handleChangePassword,
  handleListenChange,
  handleLoginPage,
  handleLoginPost,
  handleLogout,
  handleStatus
} from './handlers.ts'
import {
  LISTEN_APPLY_DELAY_MS,
  prepareWebserverHostPatch,
  resolveListenPatchPath,
  writeWebserverHostPatch,
  type ListenHost
} from './profile-patch.ts'
import type { PluginContext } from './context-types.ts'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

/** Stable Cordis plugin name. */
export const name = 'web-auth'
/** Services required before the gate can be installed. */
export const inject = ['webServer']

/**
 * Mount the auth gate and its routes.
 * @param ctx - plugin context carrying the webServer service (listening).
 */
export function apply(ctx: PluginContext): void {
  const dshHome = resolveDshHome()
  const state = {
    secret: readSecret(dshHome),
    readHash: () => readPasswordHash(dshHome),
    writeHash: (hash: string) => writePasswordHash(dshHome, hash),
    rotateSecret: () => {
      const next = rotateSecret(dshHome)
      state.secret = next
      return next
    }
  }
  const env = {
    state,
    limiter: new RateLimiter(),
    // Authenticated /api requests are presented to the gateway's trust fence
    // as loopback, so the privileged-method pinning (settings.*, credentials.*,
    // discoverModels, …) passes through the reverse proxy. See handlers.ts.
    loopbackAuthority: '127.0.0.1:' + String(ctx.webServer.port),
    // Live listen-host switching: the webserver's bind host is composition
    // config owned by the profile patch layer (or the home patch when it
    // spells the webserver row), so the change is written there and the HMR
    // watcher tails it — the webserver row reloads and rebinds. ctx.baseUrl
    // is the profile directory the boot anchored on. commit() is deferred
    // after the HTTP response so the reload (which destroys every
    // connection, including the confirmation's) cannot tear the response
    // away; failures are logged, never thrown — the client was confirmed.
    listen: buildListenController(ctx)
  }

  if (state.readHash() === undefined) {
    // console.error, not ctx.logger.warn: the cordis default logger level
    // suppresses warn (level 2) unless the deployment raises it, and this
    // warning matters — the first-password window is open to anyone.
    console.error(
      '[dsh-web-auth] WARNING: no password configured — web access is currently OPEN. ' +
        'Anyone reaching this server can claim a password from the /login page. ' +
        'Set one before exposing the service publicly.'
    )
  }

  // ── the gate: wrap the server listeners once the socket is bound ──────────
  const server = ctx.webServer.server
  const gate = createGate(env)
  let disposeGate: (() => void) | undefined
  const install = (): void => {
    disposeGate = installGate(server, gate)
  }
  if (server.listening) install()
  else server.once('listening', install)
  ctx.effect(() => {
    return () => disposeGate?.()
  }, 'web-auth: auth gate')

  // ── routes (exact table; /api/web-auth/password wins over the /api prefix) ─
  const routes = [
    {
      path: '/login',
      handler: (req: Parameters<typeof handleLoginPage>[0], res: Parameters<typeof handleLoginPage>[1]) => {
        const method = req.method ?? 'GET'
        if (method === 'POST') {
          void handleLoginPost(req, res, env)
          return
        }
        if (method === 'GET' || method === 'HEAD') {
          handleLoginPage(req, res, env)
          return
        }
        res.writeHead(405, { allow: 'GET, HEAD, POST' })
        res.end()
      }
    },
    {
      path: '/logout',
      handler: (req: Parameters<typeof handleLogout>[0], res: Parameters<typeof handleLogout>[1]) => {
        void handleLogout(req, res, env)
      }
    },
    {
      path: '/api/web-auth/password',
      handler: (req: Parameters<typeof handleChangePassword>[0], res: Parameters<typeof handleChangePassword>[1]) => {
        void handleChangePassword(req, res, env)
      }
    },
    {
      path: '/api/web-auth/status',
      handler: (req: Parameters<typeof handleStatus>[0], res: Parameters<typeof handleStatus>[1]) => {
        handleStatus(req, res, env)
      }
    },
    {
      path: '/api/web-auth/listen',
      handler: (req: Parameters<typeof handleListenChange>[0], res: Parameters<typeof handleListenChange>[1]) => {
        void handleListenChange(req, res, env)
      }
    }
  ]
  for (const route of routes) {
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: route.path, handler: route.handler }), `web-auth: ${route.path} route`)
  }
}

/**
 * Bind the live listen-host controller to this deployment's patch layer.
 * Resolves which layer owns the webserver row (home outranks the profile),
 * then prepares/commits the host override there. Undefined baseUrl (an
 * unusual embedding) yields a controller whose prepare refuses loudly —
 * callers surface that as 501/500.
 */
function buildListenController(ctx: PluginContext) {
  const resolvePatch = (): string => {
    const profilePatch = join(fileURLToPath(ctx.baseUrl), 'cordis.patch.yml')
    const homePatch = join(resolveDshHome(), 'cordis.patch.yml')
    return resolveListenPatchPath(profilePatch, homePatch)
  }
  return {
    current: () => ctx.webServer.host,
    prepare: (host: ListenHost) => prepareWebserverHostPatch(resolvePatch(), host),
    commit: (content: string) => {
      // Everything below runs after the HTTP response was written; failures
      // are logged, never thrown (the client was already confirmed).
      let patchPath: string
      try {
        patchPath = resolvePatch()
      } catch (error) {
        console.error('[dsh-web-auth] listen patch path unresolvable:', error)
        return
      }
      setTimeout(() => {
        try {
          writeWebserverHostPatch(patchPath, content)
        } catch (error) {
          console.error('[dsh-web-auth] failed to apply listen address:', error)
        }
      }, LISTEN_APPLY_DELAY_MS)
    }
  }
}
