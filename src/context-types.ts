/**
 * Structural cordis Context for the host half. A third-party plugin resolves
 * outside the DSH monorepo's single cordis instance, so the upstream
 * `declare module` augmentations do not reach this Context. The members
 * below mirror the runtime shapes this plugin touches.
 */
import type { IncomingMessage, Server, ServerResponse } from 'node:http'

/** The webServer service face (subset of @deepseek-ai/dsh-host-webserver). */
export interface WebServerService {
  /** The underlying node:http server (gated by wrapping its listeners). */
  server: Server
  /** The listening port (the OS-assigned value when config.port is 0). */
  port: number
  /** The configured bind host ('127.0.0.1' or '0.0.0.0'). */
  host: string
  /** Register an exact-path route; returns the disposer. */
  register(route: {
    kind: 'exact'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void
  }): () => void
}

/** The plugin context members this plugin consumes. */
export interface PluginContext {
  webServer: WebServerService
  logger: {
    warn(message: string): void
    error(message: string): void
  }
  /** Register a setup that returns a disposer, tied to this fiber. */
  effect(setup: () => unknown, label?: string): void
  /**
   * The composition root directory as a file URL (the profile directory the
   * boot anchors on — the loader inherits it down the whole tree).
   */
  baseUrl: string
}
