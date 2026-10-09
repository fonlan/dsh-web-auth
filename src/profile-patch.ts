/**
 * dsh-web-auth — profile patch editing for the web server bind host.
 *
 * The webserver's `host` is composition config: the dsh-web-app bundle row
 * defaults to `ctx.webStartup.host ?? '127.0.0.1'`, and a later patch layer
 * (the profile's cordis.patch.yml, or the home-level patch) overrides it.
 * The boot process tails those patch files with HMR, so rewriting the
 * override entry in place hot-applies the change: the webserver row reloads,
 * closes its listener, and rebinds on the new host — no process restart.
 *
 * The value domain is defined by listen-addresses.ts: a concrete IPv4/IPv6
 * literal that is an address of THIS MACHINE. Two classes of value are refused
 * because both leave a profile that cannot boot, and in both cases this plugin
 * is not running afterwards to repair it:
 *
 *  - the wildcard (`0.0.0.0`/`::`), which dsh >= 0.2.1-alpha.2 rejects while
 *    resolving the loader config — before any plugin fiber activates;
 *  - a literal the machine does not own (a stale DHCP address, `127.0.0.2` on
 *    macOS), which fails at bind time with EADDRNOTAVAIL on the next start.
 *
 * {@link setWebserverHost} therefore validates and throws, so no caller can
 * write either even if a stale client asks.
 *
 * This module only ever touches the `host` value inside the `webserver`
 * entry. Everything else — comments, other entries, and especially the
 * `!!js` port expression — is preserved byte-for-byte, which a YAML
 * round-trip could never guarantee. A fresh entry (when no layer spells the
 * webserver row) restates `name`/`inject` and the port expression,
 * because a patch entry replaces the targeted row's whole `config`.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { isLocalListenHost, isWildcardListenHost } from './listen-addresses.ts'

/**
 * A writable bind host: a concrete literal naming an address this machine
 * has. A plain alias rather than a closed union — the domain is machine
 * dependent, enforced at runtime by {@link isAllowedListenHost} and offered to
 * the UI by listen-addresses.ts.
 */
export type ListenHost = string

/**
 * Delay between confirming the change to the browser and writing the patch
 * file. The HMR watcher fires within milliseconds of the write and the
 * webserver teardown destroys every connection — including the one carrying
 * the confirmation — so the write lands a beat AFTER the response flushed.
 */
export const LISTEN_APPLY_DELAY_MS = 300

/**
 * Whether a value is a bind host that is safe (and accepted) to write: a
 * concrete literal naming an address of this machine. See isLocalListenHost
 * for why the wildcard AND non-local literals are both refused.
 */
export function isAllowedListenHost(value: unknown): value is ListenHost {
  return isLocalListenHost(value)
}

/**
 * Throw the refusal for a host that must never reach the patch layer. Each
 * case gets its own message: the wildcard and a non-local literal both leave
 * a profile that cannot boot, but for different reasons and with different
 * fixes.
 */
function refuseListenHost(value: unknown): never {
  const shown = JSON.stringify(value)
  if (isWildcardListenHost(value)) {
    throw new Error(
      `refusing to write ${shown}: the unspecified (wildcard) bind address is rejected by ` +
        'dsh >= 0.2.1-alpha.2 while resolving config, which fails the entire startup ' +
        '(the webserver never activates). Bind one concrete local interface address instead.'
    )
  }
  throw new Error(
    `refusing to write ${shown}: not an address of this machine. Bind one concrete IPv4/IPv6 ` +
      'address that a local interface actually has (or 127.0.0.1) — an address the machine ' +
      'does not own fails to bind with EADDRNOTAVAIL and leaves the next startup broken.'
  )
}

/** The patch row id owning the web transport. */
const WEBSERVER_ROW_ID = 'webserver'
/** The bundle's port expression, restated when inserting a fresh row. */
const WEBSERVER_PORT_EXPRESSION = 'ctx.webStartup.port ?? 3080'
/** The webserver's package name, restated when inserting a fresh row. */
const WEBSERVER_PACKAGE = '@deepseek-ai/dsh-host-webserver'

const ENTRY_LINE = /^- id:\s*['"]?webserver['"]?\s*(?:#.*)?$/
const LIST_ITEM = /^-\s/
const CONFIG_LINE = /^(\s*)config:\s*(?:#.*)?$/
const HOST_LINE = /^(\s*)host:\s*(.*)$/

/** Whether a patch document already spells the webserver row. */
export function patchHasWebserverEntry(content: string): boolean {
  for (const line of content.split('\n')) if (ENTRY_LINE.test(line)) return true
  return false
}

/**
 * Pure text transform: set the `host` of the `webserver` patch entry.
 *
 * - entry present with a `host:` under `config:` → the value is replaced;
 * - entry present without `host:` → the line is inserted under `config:`;
 * - entry present without `config:` → a config block is appended;
 * - no entry at all → a complete row is written (name/inject/port restated):
 *   replacing the generated template's `[]` marker when present, otherwise
 *   appended as a new block item.
 *
 * @param content - the patch file's current text.
 * @param host - the target bind host (an address this machine owns).
 * @returns the next file text; every other byte is untouched.
 * @throws When `host` is not an address this machine owns, or the document is
 *   flow-style and cannot be extended as valid YAML — see refuseListenHost.
 */
export function setWebserverHost(content: string, host: ListenHost): string {
  if (!isAllowedListenHost(host)) refuseListenHost(host)
  const lines = content.split('\n')
  let entryStart = -1
  for (let i = 0; i < lines.length; i++) {
    if (ENTRY_LINE.test(lines[i])) {
      entryStart = i
      break
    }
  }
  if (entryStart === -1) {
    const block = [
      '- id: ' + WEBSERVER_ROW_ID,
      '  name: ' + JSON.stringify(WEBSERVER_PACKAGE),
      '  inject: [webStartup]',
      '  config:',
      '    host: ' + host,
      '    port: !!js ' + WEBSERVER_PORT_EXPRESSION
    ]
    // The dsh-generated template for a fresh profile is a comment header
    // followed by `[]` (the valid empty-sequence document). Appending a block
    // item after `[]` yields `[]\n- id: …`, which is NOT valid YAML — the boot
    // then dies with "failed to parse overlay …: end of the stream or a
    // document separator is expected", i.e. the same class of unbootable
    // state as the wildcard. Replace the empty marker instead of appending.
    const marker = lines.findIndex((line) => line.trim() === '[]')
    if (marker !== -1) {
      lines.splice(marker, 1, ...block)
      return lines.join('\n')
    }
    // Any other flow-style document (e.g. `[{ id: webserver }]`) cannot be
    // extended textually without producing invalid YAML; refuse loudly rather
    // than write a file the next boot cannot parse.
    const firstContent = lines.find((line) => {
      const trimmed = line.trim()
      return trimmed.length > 0 && !trimmed.startsWith('#')
    })
    if (firstContent !== undefined && firstContent.trimStart().startsWith('[')) {
      throw new Error(
        'refusing to edit a flow-style patch document (' + firstContent.trim() + '): ' +
          'convert it to block style (a `- id:` list) first — appending a block item ' +
          'after a flow sequence produces YAML the next boot cannot parse.'
      )
    }
    const text = content.length === 0 || content.endsWith('\n') ? content + block.join('\n') + '\n' : content + '\n' + block.join('\n') + '\n'
    return text
  }

  // The entry block ends at the next top-level list item or EOF.
  let entryEnd = lines.length
  for (let i = entryStart + 1; i < lines.length; i++) {
    if (LIST_ITEM.test(lines[i])) {
      entryEnd = i
      break
    }
  }

  let configIndex = -1
  let configIndent = 0
  for (let i = entryStart; i < entryEnd; i++) {
    const match = CONFIG_LINE.exec(lines[i])
    if (match !== null) {
      configIndex = i
      configIndent = match[1].length
      break
    }
  }
  if (configIndex === -1) {
    // No config block: append one (2-space entry indent, as the template).
    lines.splice(entryEnd, 0, '  config:', '    host: ' + host, '    port: !!js ' + WEBSERVER_PORT_EXPRESSION)
    return lines.join('\n')
  }

  for (let i = configIndex + 1; i < entryEnd; i++) {
    const match = HOST_LINE.exec(lines[i])
    if (match !== null && match[1].length > configIndent) {
      lines[i] = match[1] + 'host: ' + host
      return lines.join('\n')
    }
  }

  // Config block present but no host key: insert right after `config:`.
  lines.splice(configIndex + 1, 0, ' '.repeat(configIndent + 2) + 'host: ' + host)
  return lines.join('\n')
}

/** Read a patch file as text; a missing file reads as the empty document. */
export function readPatchOrEmpty(patchPath: string): string {
  try {
    return readFileSync(patchPath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw error
  }
}

/**
 * Which patch layer owns the webserver override: the highest layer that
 * spells the row (home outranks the profile, the same order the boot
 * applies them); when no layer spells it, the profile patch is where the
 * row will be created.
 */
export function resolveListenPatchPath(profilePatch: string, homePatch: string): string {
  if (patchHasWebserverEntry(readPatchOrEmpty(homePatch))) return homePatch
  return profilePatch
}

/**
 * Read + transform the owning patch layer for `host`, returning the next
 * file content. Throws when the file cannot be read, or when `host` is not a
 * concrete address (the wildcard refusal runs before any read).
 */
export function prepareWebserverHostPatch(patchPath: string, host: ListenHost): string {
  return setWebserverHost(readPatchOrEmpty(patchPath), host)
}

/** Atomic write of prepared patch content (tmp + rename, like the state files). */
export function writeWebserverHostPatch(patchPath: string, content: string): void {
  const tmp = patchPath + '.tmp-' + randomBytes(4).toString('hex')
  writeFileSync(tmp, content)
  renameSync(tmp, patchPath)
}

/** Whether a path exists on disk (guards the home-patch resolution). */
export function patchExists(patchPath: string): boolean {
  return existsSync(patchPath)
}
