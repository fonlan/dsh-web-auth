/**
 * Unit tests for the bind-address domain: literal/wildcard classification,
 * the selectable option list, and local-peer trust.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { networkInterfaces } from 'node:os'
import {
  LOOPBACK_LISTEN_HOST,
  isConcreteListenHost,
  isIpLiteral,
  isLocalListenHost,
  isLocalPeerAddress,
  isLoopbackListenHost,
  isWildcardListenHost,
  listListenHosts,
  resetLocalAddressCache,
  stripZoneId
} from '../lib/listen-addresses.js'

/**
 * A real non-loopback address of THIS machine, or undefined on a host with no
 * such interface (a bare container). Tests that need one skip without it —
 * hardcoding an address would pass here and fail on CI.
 */
const ALT_HOST = listListenHosts().find((option) => !option.loopback)?.value

describe('isIpLiteral', () => {
  it('accepts IPv4/IPv6 literals, zoned IPv6 included', () => {
    for (const value of ['127.0.0.1', '0.0.0.0', '192.168.123.39', '::1', '::', '2001:db8::1', 'fe80::1%en0']) {
      assert.equal(isIpLiteral(value), true, value)
    }
  })

  it('rejects hostnames and non-strings', () => {
    for (const value of ['localhost', 'example.com', 'dsh.local', '', 7, null, undefined]) {
      assert.equal(isIpLiteral(value), false, String(value))
    }
  })
})

describe('isWildcardListenHost', () => {
  it('recognizes every all-zero spelling', () => {
    for (const value of ['0.0.0.0', '::', '0:0:0:0:0:0:0:0', '::0', '0::0', '::ffff:0.0.0.0', '::ffff:0:0']) {
      assert.equal(isWildcardListenHost(value), true, value)
    }
  })

  it('does not flag concrete addresses', () => {
    for (const value of ['127.0.0.1', '0.0.0.1', '192.168.123.39', '::1', '::ffff:127.0.0.1', '2001:db8::1']) {
      assert.equal(isWildcardListenHost(value), false, value)
    }
  })

  it('does not flag non-literals', () => {
    for (const value of ['localhost', '', 0, null, undefined]) {
      assert.equal(isWildcardListenHost(value), false, String(value))
    }
  })
})

describe('isConcreteListenHost', () => {
  it('joins literal-ness and non-wildcard-ness', () => {
    assert.equal(isConcreteListenHost('127.0.0.1'), true)
    assert.equal(isConcreteListenHost('192.168.123.39'), true)
    assert.equal(isConcreteListenHost('::1'), true)
    assert.equal(isConcreteListenHost('0.0.0.0'), false)
    assert.equal(isConcreteListenHost('::'), false)
    assert.equal(isConcreteListenHost('localhost'), false)
  })
})

describe('isLocalListenHost (the write domain)', () => {
  it('accepts loopback and the machine\'s own interface addresses', (t) => {
    resetLocalAddressCache()
    assert.equal(isLocalListenHost('127.0.0.1'), true)
    assert.equal(isLocalListenHost('::1'), true)
    if (ALT_HOST === undefined) return t.skip('no non-loopback interface on this host')
    assert.equal(isLocalListenHost(ALT_HOST), true, ALT_HOST)
  })

  it('refuses the wildcard, hostnames and addresses this machine does not own', () => {
    resetLocalAddressCache()
    const offered = new Set(listListenHosts().map((option) => option.value))
    for (const value of [
      '0.0.0.0',
      '::',
      '::ffff:0.0.0.0',
      'localhost',
      '',
      // A concrete literal is not enough: the address must be assigned here.
      // 127.0.0.2 is the classic trap — bindable on Linux, EADDRNOTAVAIL on macOS.
      '127.0.0.2',
      '10.99.99.99',      // RFC1918 but not assigned here
      '203.0.113.7',      // TEST-NET-3
      '2001:db8::1',      // documentation prefix
      0,
      null,
      undefined
    ]) {
      // paranoia: skip anything this host genuinely has (e.g. a machine whose
      // loopback really does carry 127.0.0.2)
      if (offered.has(value as string)) continue
      assert.equal(isLocalListenHost(value), false, `expected ${String(value)} to be refused`)
    }
  })
})

describe('isLoopbackListenHost', () => {
  it('covers 127/8, ::1 and mapped forms', () => {
    for (const value of ['127.0.0.1', '127.13.9.2', '::1', '::ffff:127.0.0.1']) {
      assert.equal(isLoopbackListenHost(value), true, value)
    }
  })

  it('excludes everything else', () => {
    for (const value of ['192.168.123.39', '0.0.0.0', '::', '10.0.0.1', 'localhost', undefined]) {
      assert.equal(isLoopbackListenHost(value), false, String(value))
    }
  })
})

describe('stripZoneId', () => {
  it('drops the interface suffix', () => {
    assert.equal(stripZoneId('fe80::1%en0'), 'fe80::1')
    assert.equal(stripZoneId('127.0.0.1'), '127.0.0.1')
  })
})

describe('listListenHosts', () => {
  it('always offers loopback first and never a wildcard', () => {
    const options = listListenHosts()
    assert.equal(options[0]?.value, LOOPBACK_LISTEN_HOST)
    assert.equal(options[0]?.loopback, true)
    for (const option of options) {
      assert.equal(isConcreteListenHost(option.value), true, option.value)
      assert.ok(option.label.length > 0)
    }
    // values are unique
    assert.equal(new Set(options.map((o) => o.value)).size, options.length)
  })

  it('offers only addresses that the write path accepts', () => {
    resetLocalAddressCache()
    for (const option of listListenHosts()) {
      assert.equal(isLocalListenHost(option.value), true, `offered but not writable: ${option.value}`)
    }
  })

  it('offers this machine\'s addresses', () => {
    const expected = new Set<string>()
    for (const entry of Object.values(networkInterfaces())) {
      for (const address of entry ?? []) if (!address.internal) expected.add(stripZoneId(address.address))
    }
    const offered = new Set(listListenHosts().map((o) => o.value))
    for (const value of expected) {
      if (!isConcreteListenHost(value)) continue
      // link-local IPv6 is deliberately not offered (needs a zone to bind)
      if (/^fe[89ab]/i.test(value)) continue
      assert.ok(offered.has(value), `expected ${value} to be offered`)
    }
  })
})

describe('isLocalPeerAddress', () => {
  it('trusts loopback spellings', () => {
    for (const value of ['127.0.0.1', '127.0.0.2', '::1', '::ffff:127.0.0.1']) {
      assert.equal(isLocalPeerAddress(value), true, value)
    }
  })

  it('trusts this machine\'s own interface addresses', () => {
    resetLocalAddressCache()
    for (const entry of Object.values(networkInterfaces())) {
      for (const address of entry ?? []) {
        assert.equal(isLocalPeerAddress(stripZoneId(address.address)), true, address.address)
      }
    }
  })

  it('does not trust a foreign address or a missing one', () => {
    assert.equal(isLocalPeerAddress('203.0.113.7'), false)
    assert.equal(isLocalPeerAddress('2001:db8::5'), false)
    assert.equal(isLocalPeerAddress(undefined), false)
    assert.equal(isLocalPeerAddress(''), false)
  })
})
