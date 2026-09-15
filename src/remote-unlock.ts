/**
 * dsh-web-auth — remote settings unlock (opt-in composition config).
 *
 * dsh decides "is this page the operator's local browser?" on the CLIENT,
 * once per page load: dsh-client-connection computes `isLoopback` from the
 * page's location hostname (or the transport's `ownsHost` flag), and the
 * settings UI keeps its describe mirror process-local unless the page counts
 * as loopback — every settings surface (models directory, plugin config, …)
 * then answers "settings are unavailable in this browser". Pages reached
 * through a reverse proxy/domain can never pass the hostname check, so the
 * settings plane stays unreachable there EVEN THOUGH this plugin already
 * presents every session-authenticated request to the server-side fences as
 * loopback (the Host rewrite in handlers.ts): the two trust decisions are
 * read on opposite sides of the wire.
 *
 * This module closes that gap with the one server-side signal the client
 * honors: the webserver renders the boot page through a tap chain
 * (`webServer.tapIndex`, the raw-HTML escape hatch DSH exposes for exactly
 * this), and the client entry reads `globalThis.__DSH_TRANSPORT__.ownsHost`
 * as the "this transport owns the host" flag. A tap that appends a tiny
 * inline script setting the flag makes a proxied page present as a
 * host-owned page: the settings mirror loads over the (already
 * authenticated, already loopback-presented) /api plane and the settings
 * UI works remotely.
 *
 * Deliberate scope:
 * - Runs ONLY on rendered index responses. Unauthenticated requests are
 *   answered by the gate (302 /login) or DSH's own index auth before any
 *   render, so a proxied page receives the script only after passing both
 *   the plugin session and DSH's browser-session cookie.
 * - Only ADDS the flag: an existing `__DSH_TRANSPORT__` carrier (fetch /
 *   openStream / loadBundle on an embedding platform) is merged, never
 *   replaced.
 * - Off unless the composition opts in (`unlockRemoteSettings: true`):
 *   the flag IS the security boundary dsh drew — enabling it lets every
 *   authenticated browser read and write the host settings document from
 *   wherever the domain is reachable. The deployment owner makes that
 *   call, in the patch layer, next to the listen host it extends.
 */

/** Marker attribute on the injected script tag (also the idempotency key). */
export const OWNS_HOST_MARKER = 'data-dsh-web-auth="owns-host"'

/**
 * The injected script: set `ownsHost` on the page transport, creating the
 * transport object only when the page carries none. A classic (non-module)
 * inline script — parsed before the deferred module entry executes, which is
 * where dsh-client-connection reads the flag once.
 */
export const OWNS_HOST_SCRIPT =
  `<script ${OWNS_HOST_MARKER}>window.__DSH_TRANSPORT__ = window.__DSH_TRANSPORT__ || {}; window.__DSH_TRANSPORT__.ownsHost = true;</script>`

/**
 * Append the ownsHost script to a rendered index.html body, before
 * `</body>` (falling back to the end when the body tag is missing — the
 * html-to-html contract of `webServer.tapIndex` expects a pure transform).
 * Idempotent: a body that already carries the marker is returned as-is, so
 * double registration across an HMR reload can never double-inject.
 * @param html - the rendered index.html body.
 * @returns the body with the script in place.
 */
export function injectOwnsHost(html: string): string {
  if (html.includes(OWNS_HOST_MARKER)) return html
  const closeBody = /<\/body\b[^>]*>/i.exec(html)
  if (closeBody === null) return html + OWNS_HOST_SCRIPT
  return html.slice(0, closeBody.index) + OWNS_HOST_SCRIPT + html.slice(closeBody.index)
}
