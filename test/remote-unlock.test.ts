/**
 * Unit tests for the remote settings unlock: the ownsHost injection into
 * rendered index HTML (placement, idempotency, missing-body fallback) and
 * the script's runtime semantics (create-or-merge, no clobbering of an
 * existing transport), plus the composition-config schema contract.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { runInNewContext } from 'node:vm'
import { OWNS_HOST_MARKER, OWNS_HOST_SCRIPT, injectOwnsHost } from '../lib/remote-unlock.js'
import { Config } from '../lib/index.js'

/** Minimal served boot page (dsh-web-frontend dist shape). */
const PAGE = [
  '<!doctype html>',
  '<html lang="en">',
  '  <head>',
  '    <script type="module" crossorigin src="./assets/index-f1v6Ie_B.js"></script>',
  '  </head>',
  '  <body>',
  '    <div id="root"></div>',
  '  </body>',
  '</html>'
].join('\n')

/** Strip the script tags, keep the JS body. */
function scriptBody(): string {
  const match = /^<script[^>]*>(.*)<\/script>$/.exec(OWNS_HOST_SCRIPT)
  assert.ok(match)
  return match[1]
}

describe('injectOwnsHost', () => {
  it('inserts the script immediately before </body>', () => {
    const out = injectOwnsHost(PAGE)
    assert.ok(out.includes(OWNS_HOST_SCRIPT))
    const at = out.indexOf(OWNS_HOST_SCRIPT)
    assert.ok(out.slice(at).replace(OWNS_HOST_SCRIPT, '').trimStart().startsWith('</body>'))
    // Before the injection point the page is untouched.
    assert.ok(PAGE.startsWith(out.slice(0, at)))
  })

  it('is idempotent — a page already carrying the marker is unchanged', () => {
    const once = injectOwnsHost(PAGE)
    assert.equal(injectOwnsHost(once), once)
    assert.equal([...once.matchAll(new RegExp(OWNS_HOST_MARKER, 'g'))].length, 1)
  })

  it('falls back to appending when the body tag is missing', () => {
    const headless = '<!doctype html><html><head></head></html>'
    assert.ok(injectOwnsHost(headless).endsWith(OWNS_HOST_SCRIPT))
  })

  it('keeps the served page otherwise byte-identical', () => {
    const out = injectOwnsHost(PAGE)
    assert.equal(out.length, PAGE.length + OWNS_HOST_SCRIPT.length)
  })
})

describe('ownsHost script semantics', () => {
  it('creates the transport when the page carries none', () => {
    const window: { __DSH_TRANSPORT__?: Record<string, unknown> } = {}
    runInNewContext(scriptBody(), { window })
    assert.equal(window.__DSH_TRANSPORT__?.ownsHost, true)
  })

  it('merges into an existing carrier without clobbering its members', () => {
    const loadBundle = (): void => {}
    const window = { __DSH_TRANSPORT__: { loadBundle, fetch: 'x', ownsHost: false } }
    runInNewContext(scriptBody(), { window })
    const transport = window.__DSH_TRANSPORT__ as Record<string, unknown>
    assert.equal(transport.ownsHost, true)
    assert.equal(transport.loadBundle, loadBundle)
    assert.equal(transport.fetch, 'x')
  })
})

describe('Config schema', () => {
  type StdResult = { issues?: unknown[]; value?: unknown }
  const validate = (input: unknown): StdResult => {
    const result = Config['~standard'].validate(input) as StdResult | Promise<StdResult>
    assert.ok(!(result instanceof Promise))
    return result
  }

  it('defaults to off when the patch row spells no config', () => {
    assert.deepEqual(validate(undefined).value, { unlockRemoteSettings: false })
    assert.deepEqual(validate({}).value, { unlockRemoteSettings: false })
  })

  it('accepts the explicit unlock and rejects invalid shapes', () => {
    assert.deepEqual(validate({ unlockRemoteSettings: true }).value, { unlockRemoteSettings: true })
    assert.ok(validate({ unlockRemoteSettings: 'yes' }).issues)
  })
})
