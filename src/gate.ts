/**
 * dsh-web-auth — HTTP gate: wraps the node:http server's request/upgrade
 * listeners so EVERY request (routes, static fallback, WebSocket upgrades)
 * passes the auth check before the original dispatch sees it.
 *
 * The webserver package registers exactly one 'request' listener (its route
 * dispatcher) and one 'upgrade' listener. The gate captures them, removes
 * them, and re-installs a single wrapper: denied requests are answered by
 * the gate itself; allowed requests are forwarded to the captured listeners
 * in original order. Disposal restores the originals.
 *
 * Installation is deferred until the server is actually listening, so the
 * captured listener set is the final one. A WeakSet guard makes re-entry
 * (HMR re-mount) a no-op.
 */
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'

export interface GateHandlers {
  /** Decide whether one request may proceed; false = gate answers it. */
  allow(req: IncomingMessage, res: ServerResponse): boolean
  /**
   * Hook after an allowed request (cookie refresh / DSH cookie mint).
   * May be async: the gate awaits it BEFORE forwarding, so response
   * headers it appends reach the client; it must never throw, and a
   * rejection must not prevent the downstream dispatch.
   */
  passed?(req: IncomingMessage, res: ServerResponse): void | Promise<void>
  /** Decide whether one WebSocket upgrade may proceed. */
  allowUpgrade(req: IncomingMessage): boolean
}

const gated = new WeakSet<Server>()

/** Standard HTTP rejection for a denied WebSocket upgrade. */
export function rejectUpgrade(socket: Duplex, status = 401, body = 'unauthorized'): void {
  socket.end([
    `HTTP/1.1 ${status} ${status === 401 ? 'Unauthorized' : 'Forbidden'}`,
    'Connection: close',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Length: ' + Buffer.byteLength(body),
    '',
    body
  ].join('\r\n'))
}

/**
 * Install the auth gate on a listening HTTP server. Returns the disposer
 * restoring the original listeners (idempotent).
 */
export function installGate(server: Server, handlers: GateHandlers): () => void {
  if (gated.has(server)) return () => {}
  gated.add(server)

  const requestListeners = server.listeners('request')
  const upgradeListeners = server.listeners('upgrade')

  server.removeAllListeners('request')
  server.removeAllListeners('upgrade')

  server.on('request', async (req: IncomingMessage, res: ServerResponse) => {
    if (!handlers.allow(req, res)) return
    try {
      await handlers.passed?.(req, res)
    } catch {
      // A failing passed() hook must never block the downstream dispatch
      // (response headers it could not attach are a soft failure).
    }
    for (const listener of requestListeners) {
      ;(listener as (req: IncomingMessage, res: ServerResponse) => void)(req, res)
    }
  })

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (!handlers.allowUpgrade(req)) {
      rejectUpgrade(socket)
      return
    }
    for (const listener of upgradeListeners) {
      ;(listener as (req: IncomingMessage, socket: Duplex, head: Buffer) => void)(req, socket, head)
    }
  })

  return () => {
    if (!gated.has(server)) return
    gated.delete(server)
    server.removeAllListeners('request')
    server.removeAllListeners('upgrade')
    for (const listener of requestListeners) server.on('request', listener as never)
    for (const listener of upgradeListeners) server.on('upgrade', listener as never)
  }
}
