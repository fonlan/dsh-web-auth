/**
 * dsh-web-auth — authentication core (pure logic, no cordis/harness deps).
 *
 * Password hashing (scrypt + salt), session cookie signing (HMAC-SHA256),
 * per-peer rate limiting with exponential backoff, and same-origin
 * redirect-target validation. Everything here is a pure function of its
 * inputs so the test tree can exercise it without a server.
 */
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

/** Cookie name carrying the signed session. */
export const COOKIE_NAME = 'dsh_web_auth'
/** Session lifetime: 7 days (sliding — refreshed on activity). */
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60
/** Refresh the cookie only when less than this much lifetime remains. */
export const SESSION_REFRESH_THRESHOLD_SECONDS = 24 * 60 * 60
/** Minimum password length accepted by the login/setup forms. */
export const MIN_PASSWORD_LENGTH = 8

// ── password hashing ────────────────────────────────────────────────────────

export interface PasswordHashOptions {
  /** scrypt cost N (must be a power of two). */
  N?: number
  r?: number
  p?: number
  keylen?: number
  randomBytes?: (size: number) => Uint8Array
}

export interface ParsedPasswordHash {
  N: number
  r: number
  p: number
  salt: Buffer
  hash: Buffer
}

/** Hash a password with a fresh random salt. */
export function hashPassword(password: string, options: PasswordHashOptions = {}): string {
  const N = options.N ?? 16384
  const r = options.r ?? 8
  const p = options.p ?? 1
  const keylen = options.keylen ?? 32
  const salt = Buffer.from(options.randomBytes ? Array.from(options.randomBytes(16)) : randomBytes(16))
  const derived = scryptSync(password, salt, keylen, { N, r, p })
  return ['scrypt', String(N), String(r), String(p), salt.toString('base64url'), derived.toString('base64url')].join('$')
}

/** Parse a hash produced by {@link hashPassword}; undefined when malformed. */
export function parsePasswordHash(stored: string): ParsedPasswordHash | undefined {
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return undefined
  const N = Number(parts[1])
  const r = Number(parts[2])
  const p = Number(parts[3])
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return undefined
  let salt: Buffer
  let hash: Buffer
  try {
    salt = Buffer.from(parts[4], 'base64url')
    hash = Buffer.from(parts[5], 'base64url')
  } catch {
    return undefined
  }
  if (salt.length === 0 || hash.length === 0) return undefined
  return { N, r, p, salt, hash }
}

/** Timing-safe password check against a stored hash. */
export function verifyPassword(password: string, stored: string): boolean {
  const parsed = parsePasswordHash(stored)
  if (parsed === undefined) return false
  try {
    const derived = scryptSync(password, parsed.salt, parsed.hash.length, { N: parsed.N, r: parsed.r, p: parsed.p })
    return timingSafeEqual(derived, parsed.hash)
  } catch {
    return false
  }
}

// ── session cookie ──────────────────────────────────────────────────────────

export interface SessionPayload {
  v: 1
  /** Expiry as epoch seconds. */
  exp: number
}

/** Sign a cookie value for the given secret (32+ random bytes). */
export function signSession(secret: Buffer, exp: number): string {
  const payload = Buffer.from(JSON.stringify({ v: 1, exp }), 'utf8').toString('base64url')
  const sig = createHmac('sha256', secret).update(payload).digest('base64url')
  return payload + '.' + sig
}

/** Verify and decode a cookie value; undefined when invalid or expired. */
export function verifySession(value: string | undefined, secret: Buffer, now = Date.now()): SessionPayload | undefined {
  if (value === undefined) return undefined
  const dot = value.indexOf('.')
  if (dot <= 0) return undefined
  const payload = value.slice(0, dot)
  const sig = value.slice(dot + 1)
  const expected = createHmac('sha256', secret).update(payload).digest('base64url')
  const sigBuf = Buffer.from(sig, 'base64url')
  const expBuf = Buffer.from(expected, 'base64url')
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  } catch {
    return undefined
  }
  const session = parsed as Partial<SessionPayload>
  if (session.v !== 1 || typeof session.exp !== 'number') return undefined
  if (session.exp * 1000 <= now) return undefined
  return { v: 1, exp: session.exp }
}

/** Whether a live session still has enough runway that no refresh is needed. */
export function needsSessionRefresh(session: SessionPayload, now = Date.now()): boolean {
  return session.exp * 1000 - now < SESSION_REFRESH_THRESHOLD_SECONDS * 1000
}

// ── rate limiting ───────────────────────────────────────────────────────────

interface RateBucket {
  fails: number
  blockedUntil: number
  lastFailureAt: number
}

/** Exponential backoff policy: 5 fails → 1 min, doubling, 30 min cap. */
export const RATE_LIMIT = {
  maxFails: 5,
  initialBlockMs: 60 * 1000,
  maxBlockMs: 30 * 60 * 1000,
  /** Failures older than this no longer count toward the next block. */
  windowMs: 15 * 60 * 1000,
  /** Idle buckets are dropped after this long without activity. */
  idleTtlMs: 60 * 60 * 1000
} as const

export class RateLimiter {
  private buckets = new Map<string, RateBucket>()

  /**
   * Whether the key may attempt now. When blocked, the returned
   * retryAfterSeconds tells the caller how long to wait.
   */
  check(key: string, now = Date.now()): { allowed: boolean; retryAfterSeconds?: number } {
    this.prune(now)
    const bucket = this.buckets.get(key)
    if (bucket === undefined) return { allowed: true }
    if (bucket.blockedUntil > now) {
      return { allowed: false, retryAfterSeconds: Math.ceil((bucket.blockedUntil - now) / 1000) }
    }
    return { allowed: true }
  }

  /** Record one failure; returns the block state for the key. */
  recordFailure(key: string, now = Date.now()): { blockedUntil: number } {
    const bucket = this.buckets.get(key)
    const stale = bucket !== undefined && now - bucket.lastFailureAt > RATE_LIMIT.windowMs
    const fails = bucket === undefined || stale ? 1 : bucket.fails + 1
    const blockedUntil = fails >= RATE_LIMIT.maxFails
      ? now + Math.min(RATE_LIMIT.initialBlockMs * 2 ** (fails - RATE_LIMIT.maxFails), RATE_LIMIT.maxBlockMs)
      : 0
    this.buckets.set(key, { fails, blockedUntil, lastFailureAt: now })
    return { blockedUntil }
  }

  /** Clear a key's history (successful login). */
  reset(key: string): void {
    this.buckets.delete(key)
  }

  /** Drop buckets idle for the TTL (blocked buckets stay until they expire). */
  private prune(now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (bucket.blockedUntil <= now && now - bucket.lastFailureAt > RATE_LIMIT.idleTtlMs) {
        this.buckets.delete(key)
      }
    }
  }

  /** Test seam: number of tracked keys. */
  get size(): number {
    return this.buckets.size
  }
}

// ── redirect target validation ──────────────────────────────────────────────

/**
 * Accept only same-origin absolute paths as a `next` redirect target: must
 * start with a single "/", not with "//" (protocol-relative), and contain no
 * backslash or control characters. Everything else (absolute URLs, scheme
 * tricks) is rejected, preventing open-redirect through the login page.
 */
export function sanitizeNext(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  if (raw.length === 0 || raw.length > 2048) return undefined
  if (!raw.startsWith('/') || raw.startsWith('//')) return undefined
  if (/[\\\u0000-\u001f]/.test(raw)) return undefined
  if (/[\s?]*:/.test(raw)) return undefined
  return raw
}
