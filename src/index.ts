/**
 * dsh-web-auth — password gate for the dsh web surface.
 *
 * Host half: wraps the webserver's HTTP/upgrade listeners so every request
 * (routes, static fallback, WebSocket upgrades) must carry a valid session
 * cookie, serves the /login page (including first-password setup), /logout,
 * and the JSON change-password API used by the settings page (client half).
 *
 * State lives under $DSH_HOME/web-auth/ (password.hash, secret) — see
 * state.ts. Until a password is configured the gate is OPEN and a boot
 * warning is logged; the login page then offers first-password setup.
 *
 * Opt-in composition config (`unlockRemoteSettings`, Config schema below)
 * injects the `__DSH_TRANSPORT__.ownsHost` flag into the served boot page
 * (webServer.tapIndex) so pages reached through a reverse proxy/domain can
 * load the host settings document — see remote-unlock.ts.
 *
 * Install (bundle layer):  dsh plugin --profile web add ./dsh-web-auth
 */
import { installGate } from './gate.ts'
import { RateLimiter } from './auth-core.ts'
import { readSecret, readPasswordHash, resolveDshHome, rotateSecret, writePasswordHash } from './state.ts'
import {
  MINT_REENTRY_HEADER,
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
import { installWebAuthSettings } from './settings.ts'
import { injectOwnsHost } from './remote-unlock.ts'
import type { PluginContext } from './context-types.ts'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import z from '@deepseek-ai/schemastery'

/** Stable Cordis plugin name. */
export const name = 'web-auth'
/** Services required before the gate can be installed. */
export const inject = ['webServer']

/** The plugin's composition config (patch-layer `config:` overrides). */
export interface WebAuthConfig {
  /**
   * Inject the `__DSH_TRANSPORT__.ownsHost` flag into the served boot page
   * so pages reached through a reverse proxy/domain load the host settings
   * document and the settings plane works remotely. Default off: the flag
   * is a dsh security boundary, and turning it over lets every
   * session-authenticated browser read and write the host settings document
   * from wherever the domain is reachable. See remote-unlock.ts.
   */
  unlockRemoteSettings: boolean
}

/**
 * One `volatile()` config field as the loader hands it to `apply()`: a live
 * handle, not the value it currently holds. Spelled structurally rather than as
 * cosmokit's `Volatile<T>` — cosmokit is a transitive dependency here, and
 * importing it would put a second cosmokit/schemastery pair into the emitted
 * declaration.
 */
export interface LiveSettingsField<T> {
  get(): T
}

/** Hand-written entry config (profile patch / test fixture): the field is optional. */
export interface WebAuthConfigInput {
  unlockRemoteSettings?: boolean | null
}

/** The resolved entry config `apply()` receives: the field is a live handle. */
export interface ResolvedWebAuthConfig {
  unlockRemoteSettings: LiveSettingsField<boolean>
}

/**
 * Composition config schema (cordis Standard-Schema path).
 *
 * `.volatile()` is REQUIRED here, not cosmetic: dsh >= 0.1.7 derives the
 * plugin's settings page from this schema, and `dsh-settings` SKIPS an entry
 * whose schema declares no volatile field (`volatileForm(schema)` is undefined)
 * while refusing every write to a non-volatile path — so without it this
 * plugin's page disappears from Settings entirely, whichever page renders it.
 *
 * The schema is annotated through the package's own default export with locally
 * declared type arguments: schemastery >= 3.18.3 carries a third `Mode` type
 * parameter, so a `volatile()` field's OUTPUT type is `Volatile<T>` and the
 * old `z<WebAuthConfig>` annotation no longer compiles; naming it here also
 * keeps the declaration build portable (TS2742 otherwise).
 */
export type WebAuthConfigSchema = z<WebAuthConfigInput, ResolvedWebAuthConfig>

/** Resolved schema for the loader and the settings plane. */
export const Config: WebAuthConfigSchema = z.object({
  unlockRemoteSettings: z.boolean().default(false).volatile()
})

/**
 * Read a config field that may be a plain value or a live (`.volatile()`) node.
 *
 * The loader resolves a volatile field to a cosmokit cell (`{ get() }`), which
 * is an object and therefore always truthy — reading it directly would turn the
 * opt-in flag on everywhere. Hand-written configs (patch fixtures, tests) pass
 * plain values, so both shapes are accepted here.
 */
function liveValue<T>(node: unknown, fallback: T): T {
  if (node === undefined || node === null) return fallback
  const getter = (node as { get?: unknown }).get
  if (typeof getter === 'function') {
    const value = (getter as () => unknown).call(node)
    return value === undefined ? fallback : (value as T)
  }
  return node as T
}

/**
 * Mount the auth gate and its routes.
 * @param ctx - plugin context carrying the webServer service (listening).
 * @param config - validated composition config (Config schema defaults when
 *   the patch row spells none); `unlockRemoteSettings` may arrive as a live
 *   volatile handle and is unwrapped below.
 */
export function apply(ctx: PluginContext, config: WebAuthConfig | ResolvedWebAuthConfig): void {
  const unlockRemoteSettings = liveValue<boolean>(
    (config as { unlockRemoteSettings?: unknown }).unlockRemoteSettings,
    false
  )
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
    // Server-side mint of DSH's own browser-session cookie: relayed to the
    // browser on allowed responses so DSH's launch-token auth no longer
    // requires opening the printed ?token= URL per browser. Bound lazily —
    // a headless/CLI profile without the connection service simply never
    // mints (each request then fails DSH auth silently, as before).
    mintDshCookie: buildDshCookieMinter(ctx),
    // Authenticated /api requests are presented to the gateway's trust fence
    // as loopback, so the privileged-method pinning (settings.*, credentials.*,
    // discoverModels, …) passes through the reverse proxy. See handlers.ts.
    // Read per request, never captured: `webServer.port` is the *bound* port
    // and plugins load concurrently with the webserver's bind, so it is still
    // unassigned while this plugin applies (evaluating it here would freeze
    // the authority into an unparseable "127.0.0.1:undefined" that every
    // downstream fence then rejects). No port yet means no rewrite — the
    // request's own Host is already a valid authority, which is also how a
    // profile whose webserver is not listening at all stays consistent.
    get loopbackAuthority(): string | undefined {
      const port = ctx.webServer.port
      return port === undefined ? undefined : '127.0.0.1:' + String(port)
    },
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

  // The plugin's own settings page (设置 → 侧栏「访问认证」) rides the
  // `web-auth` settings namespace: binding the namespace is how the page reads
  // and writes it, and committed listenHost changes are applied here. Attaches
  // only when a settings service exists (CLI/headless profiles skip it).
  installWebAuthSettings(ctx, env.listen)

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

  // ── remote settings unlock (opt-in): inject ownsHost into the boot page ───
  // A config-only patch change restarts this fiber (cordis update →
  // dispose + re-apply), so the tap flips live with the composition.
  if (unlockRemoteSettings) {
    ctx.effect(() => ctx.webServer.tapIndex(injectOwnsHost), 'web-auth: remote settings unlock tap')
  }

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
 * Server-side DSH browser-session cookie mint.
 *
 * dsh-client-connection exposes the process launch-token URL through its
 * `connection` service (authenticatedUrl — the same call dsh-web-app uses to
 * print the startup URL). This minter fetches that URL over the server's own
 * loopback: the gate's token-exchange branch forwards it (still rewriting
 * Host to loopback), DSH validates the token and answers a 303 with the
 * signed `dsh-auth-<sha256(loopback)>` cookie — exactly the cookie every
 * authenticated request needs after the Host rewrite. The Set-Cookie value is
 * returned so the gate can relay it to the user's browser on ordinary
 * responses, meaning new browsers/endpoints no longer need the printed token
 * (and DSH's 30-day cookie is refreshed continuously).
 *
 * Returns undefined when the exchange cannot run (no connection service,
 * non-loopback-only bind, fetch failure) — the caller degrades to the old
 * behavior where the cookie must arrive via the printed token URL.
 */
function buildDshCookieMinter(ctx: PluginContext): () => Promise<string | undefined> {
  let connection: { authenticatedUrl(baseUrl: string): string } | undefined
  ctx.inject(['connection'], (cctx) => {
    connection = (cctx as unknown as {
      connection?: { authenticatedUrl(baseUrl: string): string }
    }).connection
  })
  return async () => {
    if (connection === undefined) return undefined
    const host = ctx.webServer.host === '0.0.0.0' || ctx.webServer.host === '::' ? '127.0.0.1' : ctx.webServer.host
    try {
      const url = connection.authenticatedUrl(`http://${host}:${String(ctx.webServer.port)}`)
      // The marker header is what the gate's token branch keys on to forward
      // this re-entry without a plugin session; without it the loopback
      // tokened GET would be redirected to /login like any stale bookmark.
      const response = await fetch(url, { redirect: 'manual', headers: { [MINT_REENTRY_HEADER]: '1' } })
      const cookies = response.headers.getSetCookie?.() ?? []
      const all = cookies.length > 0
        ? cookies
        : (response.headers.get('set-cookie') ?? '').length > 0
          ? [response.headers.get('set-cookie') ?? '']
          : []
      return all.find((cookie) => cookie.startsWith('dsh-auth-')) ?? all[0]
    } catch (error) {
      console.error('[dsh-web-auth] could not mint DSH browser-session cookie:', error instanceof Error ? error.message : String(error))
      return undefined
    }
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
