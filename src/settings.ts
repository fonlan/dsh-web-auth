/**
 * dsh-web-auth — the `web-auth` settings namespace.
 *
 * The namespace exists so the plugin's browser half can register its own
 * Settings Card: the settings section ("插件配置" tab) dispatches
 * `settings.plugin.item` for every namespace the Host serves, keyed by the
 * namespace string, and the client registers its card under the same key.
 * The namespace carries the one genuine configuration value the plugin owns:
 * the web server's bind host (`listenHost`). The password is deliberately
 * NOT here — it is a secret stored hashed under `$DSH_HOME/web-auth/` and
 * changed through a dedicated API, never through the settings document.
 *
 * Applying `listenHost` still goes through the profile patch layer (the
 * webserver's bind host is composition config; the patch is how it is
 * changed, and HMR hot-applies it). The settings document is the user-facing
 * source of intent; this module translates a committed change into the same
 * prepare → deferred-commit path the REST API used before.
 */
import z from '@deepseek-ai/schemastery'
import {
  isAllowedListenHost,
  type ListenHost
} from './profile-patch.ts'
import type { ListenController } from './handlers.ts'

/** The settings namespace string (the card's dispatch key, spelled the same client-side). */
export const WEB_AUTH_NS = 'web-auth'

/** Branded namespace for the settings provider. */
export const NS = WEB_AUTH_NS

/** The namespace's resolved shape. */
export interface WebAuthSettings {
  /** The web server's bind host. */
  listenHost: ListenHost
}

/** Schema resolving the namespace (schemastery, matching the webserver's own).
 *
 * Deliberately NO `.default(...)`: an invalid user-layer value (e.g. `null`
 * written by an out-of-band client) must REJECT the write — keeping the last
 * good resolved value — rather than silently resolving to the default. A
 * default would look like a genuine user change to the watch below and could
 * rebind the webserver off a value nobody actually chose.
 */
export const WebAuthSettingsSchema: z<WebAuthSettings> = z.object({
  listenHost: z.union([z.const('127.0.0.1'), z.const('0.0.0.0')])
})

/** Owner handle face: the one member this module consumes. */
interface SettingsScopeFace<T> {
  /** Observe committed changes; returns the disposer. */
  watch(callback: (next: T, prev: T) => void | Promise<void>): () => void
}

/** The settings service face (subset of @deepseek-ai/dsh-settings). */
interface SettingsServiceFace {
  register<T>(ns: unknown, schema: unknown, options?: { base?: Partial<T> }): SettingsScopeFace<T>
}

/** The injected sub-context: the plugin context plus the settings service. */
type SettingsSubContext = import('./context-types.ts').PluginContext & {
  settings: SettingsServiceFace
}

/**
 * Register the `web-auth` settings namespace and translate committed
 * `listenHost` changes into the live bind-host switch.
 *
 * The registration rides the plugin fiber and attaches only when a settings
 * service exists (`ctx.inject(['settings'])`), so CLI/headless profiles —
 * which have no web surface and no card — keep working without one. The
 * composition `base` is the webserver's host at boot: the patch layer IS the
 * deployment's composition, and seeding it this way makes the resolved value
 * match reality with no user layer and no settings-document write.
 *
 * The watch callback applies a changed host through the same
 * prepare → deferred-commit controller the REST API uses; a change that is a
 * no-op against the current runtime host is skipped, and a commit that did
 * not actually change the resolved value (invalid writes keep the last good
 * value; document reloads re-resolve) never touches the webserver. This also
 * makes the initial attach harmless — the resolved value equals the runtime
 * host.
 *
 * @param ctx - the plugin context (must expose `settings` when available).
 * @param listen - the live listen-host controller (prepare/commit).
 */
export function installWebAuthSettings(
  ctx: import('./context-types.ts').PluginContext,
  listen: ListenController
): void {
  ctx.inject(['settings'], (sctx) => {
    const current = listen.current()
    const base: WebAuthSettings = {
      listenHost: isAllowedListenHost(current) ? current : '127.0.0.1'
    }
    const scope = (sctx as SettingsSubContext).settings.register<WebAuthSettings>(NS, WebAuthSettingsSchema, { base })
    const dispose = scope.watch((next, prev) => {
      const desired = next.listenHost
      // Only a real resolved-value change is a user gesture worth applying:
      // a commit that re-resolves to the same value (document reloads, a
      // rejected patch keeping the last good value) must not touch the
      // webserver. Combined with the no-default schema, an invalid write
      // cannot masquerade as a change.
      if (desired === prev.listenHost) return
      if (desired === listen.current()) return
      try {
        listen.commit(listen.prepare(desired))
      } catch (error) {
        // The settings document already committed; the apply is best-effort
        // (failures logged, never thrown — the client was already confirmed).
        console.error('[dsh-web-auth] failed to apply listenHost from settings:', error)
      }
    })
    sctx.effect(() => dispose, 'web-auth: listen host settings watcher')
  })
}
