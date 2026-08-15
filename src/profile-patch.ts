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
 * This module only ever touches the `host` value inside the `webserver`
 * entry. Everything else — comments, other entries, and especially the
 * `!!js` port expression — is preserved byte-for-byte, which a YAML
 * round-trip could never guarantee. A fresh entry (when no layer spells the
 * webserver row) restates `name`/`inject` and the port expression,
 * because a patch entry replaces the targeted row's whole `config`.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'

/** The two bind hosts the webserver config schema accepts. */
export const ALLOWED_LISTEN_HOSTS = ['127.0.0.1', '0.0.0.0'] as const
export type ListenHost = (typeof ALLOWED_LISTEN_HOSTS)[number]

/**
 * Delay between confirming the change to the browser and writing the patch
 * file. The HMR watcher fires within milliseconds of the write and the
 * webserver teardown destroys every connection — including the one carrying
 * the confirmation — so the write lands a beat AFTER the response flushed.
 */
export const LISTEN_APPLY_DELAY_MS = 300

/** Whether a value is one of the two allowed bind-host literals. */
export function isAllowedListenHost(value: unknown): value is ListenHost {
  return value === '127.0.0.1' || value === '0.0.0.0'
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
 * - no entry at all → a complete row is appended (name/inject/port restated).
 *
 * @param content - the patch file's current text.
 * @param host - the target bind host literal.
 * @returns the next file text; every other byte is untouched.
 */
export function setWebserverHost(content: string, host: ListenHost): string {
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
    ].join('\n')
    return content.length === 0 || content.endsWith('\n') ? content + block + '\n' : content + '\n' + block + '\n'
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
 * file content. Throws when the file cannot be read.
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
