/**
 * Unit tests for the profile-patch rewrite (bind-host switching).
 *
 * The value domain is a concrete IPv4/IPv6 literal: the wildcard is refused
 * because dsh >= 0.2.1-alpha.2 rejects it while resolving the loader config,
 * which fails the entire startup before any plugin activates.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { listListenHosts } from '../lib/listen-addresses.js'
import {
  isAllowedListenHost,
  prepareWebserverHostPatch,
  readPatchOrEmpty,
  resolveListenPatchPath,
  setWebserverHost,
  writeWebserverHostPatch
} from '../lib/profile-patch.js'

/**
 * A writable non-loopback address of THIS machine. Hardcoding one would pass
 * locally and fail on CI (where the machine does not own it), so it is
 * derived; a host with only loopback falls back to the loopback literal, which
 * every text-transform assertion below still satisfies.
 */
const LAN = (listListenHosts().find((option) => !option.loopback)?.value) ?? '127.0.0.1'

/**
 * The patch format carries dsh's `!!js` expression tag, which a stock parser
 * rejects as an unknown tag; resolve it to its source text so a document can
 * be parsed fully. Anything else that fails to parse is a real defect — a
 * patch file the next boot cannot read fails the whole startup.
 */
const JS_TAG = { tag: 'tag:yaml.org,2002:js', resolve: (value: unknown) => String(value) }

/** Parse a patch document and return its top-level entries. */
function parsePatch(content: string): Record<string, unknown>[] {
  const parsed = parseYaml(content, { customTags: [JS_TAG] }) as unknown
  assert.ok(Array.isArray(parsed), 'patch document must parse as a YAML sequence')
  return parsed as Record<string, unknown>[]
}

/** The dsh-generated template for a profile with no local overrides yet. */
const TEMPLATE = [
  '# Your patch layer for this dsh profile, applied after every bundle layer:',
  '# a top-level YAML array of loader patch entries (id-targeted config',
  '# overrides, disables, and insert lists; `!!js` expressions allowed).',
  '[]',
  ''
].join('\n')

describe('setWebserverHost', () => {
  it('replaces the host value in an existing entry, preserving everything else', () => {
    const input = [
      '# Your patch layer for this dsh profile, applied after every bundle layer:',
      '- id: webserver',
      '  config:',
      '    host: 127.0.0.1',
      '    port: !!js ctx.webStartup.port ?? 3080',
      ''
    ].join('\n')
    const out = setWebserverHost(input, LAN)
    assert.match(out, new RegExp(`^- id: webserver\\n  config:\\n    host: ${LAN.replace(/\./g, '\\.')}\\n    port: !!js ctx\\.webStartup\\.port \\?\\? 3080`, 'm'))
    assert.match(out, /^# Your patch layer/m)
    // the !!js port expression survives byte-for-byte
    assert.ok(out.includes('port: !!js ctx.webStartup.port ?? 3080'))
  })

  it('switches back to the loopback literal', () => {
    const input = [
      '- id: webserver',
      '  config:',
      `    host: ${LAN}`,
      '    port: !!js ctx.webStartup.port ?? 3080',
      ''
    ].join('\n')
    assert.ok(setWebserverHost(input, '127.0.0.1').includes('host: 127.0.0.1'))
  })

  it('accepts a concrete IPv6 literal', () => {
    const input = '- id: webserver\n  config:\n    host: 127.0.0.1\n'
    assert.ok(setWebserverHost(input, '::1').includes('host: ::1'))
  })

  it('handles a quoted id and trailing comments', () => {
    const input = "- id: 'webserver'  # transport\n  config:\n    host: 127.0.0.1\n"
    assert.ok(setWebserverHost(input, LAN).includes(`host: ${LAN}`))
  })

  it('inserts a host line under config when the entry lacks one', () => {
    const input = [
      '- id: webserver',
      '  config:',
      '    port: !!js ctx.webStartup.port ?? 3080',
      ''
    ].join('\n')
    const out = setWebserverHost(input, LAN)
    assert.ok(out.includes(`  config:\n    host: ${LAN}\n    port: !!js ctx.webStartup.port ?? 3080`))
  })

  it('appends a config block when the entry has none', () => {
    const input = "- id: webserver\n  name: '@deepseek-ai/dsh-host-webserver'\n"
    const out = setWebserverHost(input, LAN)
    assert.ok(out.includes("  name: '@deepseek-ai/dsh-host-webserver'"))
    assert.ok(out.includes(`  config:\n    host: ${LAN}\n    port: !!js ctx.webStartup.port ?? 3080`))
  })

  it('appends a complete row when no layer spells webserver', () => {
    const input = '- id: something-else\n  config:\n    foo: bar\n'
    const out = setWebserverHost(input, LAN)
    assert.ok(out.includes(`- id: webserver\n  name: "@deepseek-ai/dsh-host-webserver"\n  inject: [webStartup]\n  config:\n    host: ${LAN}\n    port: !!js ctx.webStartup.port ?? 3080`))
    // the untouched entry is preserved
    assert.ok(out.includes('- id: something-else\n  config:\n    foo: bar\n'))
  })

  it('appends into an empty document', () => {
    const out = setWebserverHost('', LAN)
    assert.ok(out.startsWith('- id: webserver'))
    assert.ok(out.endsWith('port: !!js ctx.webStartup.port ?? 3080\n'))
  })

  it('does not touch host keys outside the webserver entry', () => {
    const input = [
      '- id: other-row',
      '  config:',
      '    host: 10.0.0.5',
      '- id: webserver',
      '  config:',
      '    host: 127.0.0.1',
      '    port: !!js ctx.webStartup.port ?? 3080',
      ''
    ].join('\n')
    const out = setWebserverHost(input, LAN)
    assert.ok(out.includes('- id: other-row\n  config:\n    host: 10.0.0.5\n'))
    assert.ok(out.includes(`- id: webserver\n  config:\n    host: ${LAN}\n`))
  })

  // ── YAML validity: an unparseable patch fails the next boot ───────────────

  it('replaces the template empty-sequence marker instead of appending after it', () => {
    // Regression: appending to the generated template produced `[]` followed
    // by `- id: webserver`, which dsh rejects with "failed to parse overlay
    // …: end of the stream or a document separator is expected" — an
    // unbootable profile, exactly like the wildcard.
    const out = setWebserverHost(TEMPLATE, LAN)
    assert.doesNotMatch(out, /^\s*\[\]\s*$/m)
    assert.match(out, /^# Your patch layer/m)
    const entries = parsePatch(out)
    assert.equal(entries.length, 1)
    assert.equal(entries[0]?.id, 'webserver')
    assert.deepEqual((entries[0]?.config as Record<string, unknown>).host, LAN)
  })

  it('refuses a non-empty flow-style document instead of writing invalid YAML', () => {
    const flow = '[{ id: something-else, config: { foo: bar } }]\n'
    assert.throws(() => setWebserverHost(flow, LAN), /flow-style patch document/)
  })

  it('emits YAML that parses back for every write shape', () => {
    const inputs = [
      TEMPLATE,
      '',
      '- id: something-else\n  config:\n    foo: bar\n',
      '- id: webserver\n  config:\n    port: !!js ctx.webStartup.port ?? 3080\n',
      "- id: 'webserver'  # transport\n  config:\n    host: 127.0.0.1\n",
      '- id: webserver\n  name: "@deepseek-ai/dsh-host-webserver"\n',
      '- id: webserver\n  config:\n    host: 127.0.0.1\n    port: !!js ctx.webStartup.port ?? 3080\n'
    ]
    for (const input of inputs) {
      const out = setWebserverHost(input, LAN)
      const entries = parsePatch(out)
      const webserver = entries.find((entry) => entry.id === 'webserver')
      assert.ok(webserver !== undefined, `no webserver entry for input: ${JSON.stringify(input)}`)
      assert.equal((webserver.config as Record<string, unknown>).host, LAN)
      // the port expression is a !!js leaf, preserved as source text
      if (webserver.config !== undefined && 'port' in (webserver.config as object)) {
        assert.equal((webserver.config as Record<string, unknown>).port, 'ctx.webStartup.port ?? 3080')
      }
    }
  })

  // ── the brick guard ───────────────────────────────────────────────────────
  it('refuses every wildcard spelling and leaves the document untouched', () => {
    const input = '- id: webserver\n  config:\n    host: 10.0.0.5\n'
    for (const wildcard of ['0.0.0.0', '::', '0:0:0:0:0:0:0:0', '::ffff:0.0.0.0', '0::0']) {
      assert.throws(
        () => setWebserverHost(input, wildcard),
        /wildcard|unspecified/i,
        `expected ${wildcard} to be refused`
      )
    }
  })

  it('refuses a non-literal host', () => {
    for (const bad of ['localhost', '', 'not an address', '3080']) {
      assert.throws(() => setWebserverHost('- id: webserver\n', bad), /not an address of this machine/)
    }
  })

  it('refuses a concrete literal this machine does not own', () => {
    // EADDRNOTAVAIL at bind time and, because the value is already in the
    // patch, an unbootable profile on the next start — so it never gets written.
    for (const unowned of ['127.0.0.2', '10.99.99.99', '203.0.113.7', '2001:db8::1']) {
      assert.throws(() => setWebserverHost('- id: webserver\n', unowned), /not an address of this machine/)
    }
  })

  it('runs the guard before reading the file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dwa-patch-guard-'))
    try {
      const patch = join(dir, 'cordis.patch.yml')
      // no such file: the refusal must not be masked by a read error
      assert.throws(() => prepareWebserverHostPatch(patch, '0.0.0.0'), /wildcard|unspecified/i)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('patch layer resolution', () => {
  it('prefers the home patch when it spells the webserver row', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dwa-patch-'))
    try {
      const profile = join(dir, 'cordis.patch.yml')
      const home = join(dir, 'home.yml')
      writeFileSync(home, '- id: webserver\n  config:\n    host: 127.0.0.1\n')
      writeFileSync(profile, '- id: something-else\n')
      assert.equal(resolveListenPatchPath(profile, home), home)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('falls back to the profile patch when the home layer is silent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dwa-patch-'))
    try {
      const profile = join(dir, 'cordis.patch.yml')
      const home = join(dir, 'home.yml')
      writeFileSync(profile, '- id: webserver\n  config:\n    host: 127.0.0.1\n')
      writeFileSync(home, '- id: other\n')
      assert.equal(resolveListenPatchPath(profile, home), profile)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('targets the profile patch when neither layer spells webserver', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dwa-patch-'))
    try {
      const profile = join(dir, 'cordis.patch.yml')
      const home = join(dir, 'home.yml')
      writeFileSync(home, '- id: other\n')
      assert.equal(resolveListenPatchPath(profile, home), profile)
      assert.equal(resolveListenPatchPath(profile, join(dir, 'missing.yml')), profile)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('patch file round-trip', () => {
  it('prepares and atomically writes the transformed layer', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dwa-patch-'))
    try {
      const patch = join(dir, 'cordis.patch.yml')
      writeFileSync(patch, [
        '- id: webserver',
        '  config:',
        '    host: 127.0.0.1',
        '    port: !!js ctx.webStartup.port ?? 3080',
        ''
      ].join('\n'))
      const next = prepareWebserverHostPatch(patch, LAN)
      assert.ok(next.includes(`host: ${LAN}`))
      writeWebserverHostPatch(patch, next)
      assert.ok(readFileSync(patch, 'utf8').includes(`host: ${LAN}`))
      // the file holds exactly the prepared content; no temp files remain
      assert.equal(readFileSync(patch, 'utf8'), next)
      assert.deepEqual(readdirSync(dir), ['cordis.patch.yml'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reads a missing file as empty and creates the layer', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dwa-patch-'))
    try {
      const patch = join(dir, 'cordis.patch.yml')
      assert.equal(readPatchOrEmpty(patch), '')
      const next = prepareWebserverHostPatch(patch, LAN)
      writeWebserverHostPatch(patch, next)
      assert.ok(readFileSync(patch, 'utf8').includes('- id: webserver'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('isAllowedListenHost', () => {
  it('accepts loopback and this machine\'s own addresses', () => {
    assert.equal(isAllowedListenHost('127.0.0.1'), true)
    assert.equal(isAllowedListenHost('::1'), true)
    if (LAN !== '127.0.0.1') assert.equal(isAllowedListenHost(LAN), true, LAN)
  })

  it('refuses the wildcard, non-literals, unowned addresses and non-strings', () => {
    for (const bad of [
      '0.0.0.0', '::', '::ffff:0.0.0.0',
      'localhost', '',
      '127.0.0.2', '10.99.99.99', '203.0.113.7', '2001:db8::1',
      0, undefined, null, 42
    ]) {
      assert.equal(isAllowedListenHost(bad), false, `expected ${String(bad)} to be refused`)
    }
  })
})
