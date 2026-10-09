/**
 * dsh-web-auth — the bind-address domain: which `host` values the webserver
 * accepts, which local interfaces can be offered to the user, and whether a
 * TCP peer is local.
 *
 * dsh >= 0.2.1-alpha.2 validates the webserver's `host` as a CONCRETE
 * IPv4/IPv6 literal and rejects the unspecified (wildcard) address outright:
 *
 *   webserver: host "0.0.0.0" is an unspecified (wildcard) address, which is
 *   not supported: binding every interface would expose remote code execution
 *   to the network; bind one concrete IPv4 or IPv6 address of a local
 *   interface instead
 *
 * The rejection happens while the loader RESOLVES CONFIG — before any plugin
 * fiber activates. A wildcard written into the profile patch therefore bricks
 * the whole boot (webserver never activates, every dependent plugin waits
 * forever) and NOTHING can self-repair it: this plugin does not load either.
 * That is why every write path in this plugin runs {@link isConcreteListenHost}
 * and refuses a wildcard instead of writing it.
 *
 * `dsh web --host` is validated by the same rule (`isWildcardHost`), and
 * `parseIpLiteral` rejects hostnames, so only IP literals are ever written.
 */
import { isIP } from 'node:net'
import { networkInterfaces } from 'node:os'

/** The always-offered loopback bind (this plugin's default and the safe choice). */
export const LOOPBACK_LISTEN_HOST = '127.0.0.1'

/** Normalized IPv6 forms whose bits are all zero (the IPv4-any-mapped form included). */
const WILDCARD_IPV6_FORMS = new Set(['[::]', '[::ffff:0:0]'])

/** Direct peers always considered local, whichever spelling the socket reports. */
const LOOPBACK_PEERS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

/** Strip an IPv6 zone id (`fe80::1%en0` → `fe80::1`). */
export function stripZoneId(value: string): string {
  const at = value.indexOf('%')
  return at === -1 ? value : value.slice(0, at)
}

/**
 * Whether a value is an IPv4/IPv6 literal (hostnames are rejected by the
 * webserver's own `parseIpLiteral`, so they are rejected here too).
 */
export function isIpLiteral(value: unknown): value is string {
  return typeof value === 'string' && isIP(stripZoneId(value)) !== 0
}

/**
 * Whether a literal is the unspecified (wildcard) address: `0.0.0.0`, any
 * spelling of IPv6 `::`, and their IPv4-mapped forms (`::ffff:0.0.0.0`).
 * Non-literals are not wildcards — {@link isConcreteListenHost} rejects them.
 *
 * IPv6 is normalized through the WHATWG URL parser, which collapses every
 * all-zero spelling to `[::]` and renders IPv4-mapped forms as hex groups, so
 * `0:0:0:0:0:0:0:0`, `::0` and `::ffff:0.0.0.0` are all recognized.
 */
export function isWildcardListenHost(value: unknown): boolean {
  if (typeof value !== 'string') return false
  const bare = stripZoneId(value)
  const family = isIP(bare)
  if (family === 4) return bare.split('.').every((octet) => octet === '0')
  if (family !== 6) return false
  try {
    return WILDCARD_IPV6_FORMS.has(new URL('http://[' + bare + ']').hostname)
  } catch {
    return false
  }
}

/**
 * Whether a value is a bind host the webserver's config schema accepts: a
 * concrete IPv4/IPv6 literal that is not the wildcard.
 *
 * This is the SCHEMA's domain, not this plugin's write domain — see
 * {@link isLocalListenHost}, which every write path actually runs (the schema
 * also accepts literals the machine does not own, and writing one of those
 * breaks the next boot at bind time).
 */
export function isConcreteListenHost(value: unknown): value is string {
  return isIpLiteral(value) && !isWildcardListenHost(value)
}

/** One selectable bind host for the settings page. */
export interface ListenHostOption {
  /** The literal written into the patch layer. */
  value: string
  /** Human-facing label (address + interface name). */
  label: string
  /** Whether this option keeps the service unreachable from the network. */
  loopback: boolean
}

/** Whether a literal is in the loopback range (127/8 or `::1`, mapped forms included). */
export function isLoopbackListenHost(value: unknown): boolean {
  if (typeof value !== 'string') return false
  const bare = stripZoneId(value)
  if (isIP(bare) === 4 && bare.startsWith('127.')) return true
  if (isIP(bare) !== 6) return false
  try {
    const hostname = new URL('http://[' + bare + ']').hostname
    // `[::1]` and the `::ffff:127.0.0.0/104` mapped range (`[::ffff:7f00:1]`).
    return hostname === '[::1]' || hostname.startsWith('[::ffff:7f')
  } catch {
    return false
  }
}

/**
 * Link-local addresses need a zone id to bind and are never the intended
 * choice (`169.254.0.0/16`, `fe80::/10`), so they are not offered.
 */
function isLinkLocal(value: string): boolean {
  if (isIP(value) === 4) return value.startsWith('169.254.')
  return /^fe[89ab]/i.test(value)
}

/**
 * The bind hosts offered by the settings page: loopback first, then every
 * concrete address of a local interface (labelled with the interface name).
 * Every entry is writable — see {@link isLocalListenHost}, which is the write
 * domain this list is drawn from.
 *
 * @returns The ordered options; always at least the loopback default.
 */
export function listListenHosts(): ListenHostOption[] {
  const options: ListenHostOption[] = [
    { value: LOOPBACK_LISTEN_HOST, label: '127.0.0.1（仅本机）', loopback: true }
  ]
  const seen = new Set([LOOPBACK_LISTEN_HOST])
  for (const [name, addresses] of Object.entries(networkInterfaces())) {
    for (const entry of addresses ?? []) {
      const value = stripZoneId(entry.address)
      if (entry.internal || isLinkLocal(value)) continue
      if (!isConcreteListenHost(value) || seen.has(value)) continue
      seen.add(value)
      const family = isIP(value) === 6 ? 'IPv6' : 'IPv4'
      options.push({
        value,
        label: `${value}（${name}，${family}，局域网可访问）`,
        loopback: false
      })
    }
  }
  return options
}

/** Cached interface-address sets (interfaces change rarely; a TTL bounds staleness). */
let interfaceCache: { expires: number; owned: Set<string>; peers: Set<string> } | undefined
const INTERFACE_CACHE_TTL_MS = 10_000

/**
 * The addresses this machine actually has, from `os.networkInterfaces()`.
 *
 * `owned` is the set a bind may use: exactly the assigned addresses, plus
 * `127.0.0.1`, which every platform assigns to its loopback interface (the
 * explicit seed keeps the write domain usable even if enumeration reports an
 * empty loopback entry). Note the set is NOT "any 127/8": on macOS only
 * `127.0.0.1` is assigned, so `127.0.0.2` fails to bind with EADDRNOTAVAIL.
 *
 * `peers` additionally carries the IPv4-mapped IPv6 spelling of every IPv4
 * address, because a dual-stack socket reports the mapped form as
 * `remoteAddress`.
 */
function interfaceAddresses(now: number): { owned: Set<string>; peers: Set<string> } {
  if (interfaceCache !== undefined && interfaceCache.expires > now) return interfaceCache
  const owned = new Set<string>([LOOPBACK_LISTEN_HOST])
  const peers = new Set<string>(LOOPBACK_PEERS)
  for (const entry of Object.values(networkInterfaces())) {
    for (const address of entry ?? []) {
      const value = stripZoneId(address.address)
      owned.add(value)
      peers.add(value)
      // The mapped spelling is the same socket peer on a dual-stack listener.
      if (isIP(value) === 4) peers.add('::ffff:' + value)
    }
  }
  interfaceCache = { expires: now + INTERFACE_CACHE_TTL_MS, owned, peers }
  return interfaceCache
}

/**
 * Whether a value is a bind host this plugin may WRITE: a concrete literal
 * naming an address this machine actually has.
 *
 * Stricter than {@link isConcreteListenHost}, and deliberately so. A literal
 * the machine does not own (`127.0.0.2` on macOS, `10.99.99.99`, a stale DHCP
 * lease) passes the webserver's schema and is written happily — then fails at
 * bind time with EADDRNOTAVAIL, so the NEXT boot dies the same way the
 * wildcard does, with this plugin unable to help. Restricting writes to
 * addresses the machine has turns that into an immediate 400.
 *
 * @param value - the requested bind host.
 * @param now - clock injection for the interface-cache TTL (tests).
 * @returns Whether the value may be written to the patch layer.
 */
export function isLocalListenHost(value: unknown, now: number = Date.now()): boolean {
  if (!isConcreteListenHost(value)) return false
  return interfaceAddresses(now).owned.has(stripZoneId(value))
}

/**
 * Whether a TCP peer address belongs to this machine (loopback or any local
 * interface address).
 *
 * This replaced a hard loopback test: with a concrete LAN address bound,
 * `127.0.0.1` is not listening at all, so the server's own re-entry (the DSH
 * cookie mint) and a same-host reverse proxy both arrive FROM the bound
 * address. An off-host client cannot present a local address as its source
 * (that needs L2 spoofing on the same segment), so treating the machine's own
 * addresses as trusted keeps the X-Forwarded-For fence and the mint marker as
 * tight as the loopback-only version on a loopback bind. Any 127/8 spelling
 * counts — a peer claiming that range is by definition on this host.
 *
 * @param address - `socket.remoteAddress` (undefined before a socket exists).
 * @param now - clock injection for the cache TTL (tests).
 * @returns Whether the peer is this machine.
 */
export function isLocalPeerAddress(address: string | undefined, now: number = Date.now()): boolean {
  if (address === undefined || address.length === 0) return false
  const bare = stripZoneId(address)
  if (LOOPBACK_PEERS.has(bare)) return true
  if (isLoopbackListenHost(bare)) return true
  return interfaceAddresses(now).peers.has(bare)
}

/** Drop the cached interface sets (tests, and after a listen-address change). */
export function resetLocalAddressCache(): void {
  interfaceCache = undefined
}
