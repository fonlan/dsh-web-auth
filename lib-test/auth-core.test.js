/**
 * Unit tests for the pure auth core: password hashing, session cookies,
 * rate limiting, redirect-target validation.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { COOKIE_NAME, MIN_PASSWORD_LENGTH, RATE_LIMIT, RateLimiter, SESSION_TTL_SECONDS, hashPassword, needsSessionRefresh, sanitizeNext, signSession, verifyPassword, verifySession } from '../lib/auth-core.js';
describe('password hashing', () => {
    it('round-trips a password and rejects a wrong one', () => {
        const stored = hashPassword('correct horse battery');
        assert.ok(verifyPassword('correct horse battery', stored));
        assert.ok(!verifyPassword('wrong', stored));
        // Same password with a fresh salt yields a different hash each time.
        assert.notEqual(stored, hashPassword('correct horse battery'));
    });
    it('handles malformed stored hashes safely', () => {
        assert.ok(!verifyPassword('x', 'garbage'));
        assert.ok(!verifyPassword('x', 'scrypt$bad$8$1$c2FsdA==$aGFzaA=='));
        assert.ok(!verifyPassword('x', 'scrypt$16384$8$1$c2FsdA=='));
        assert.ok(!verifyPassword('x', ''));
        assert.ok(!verifyPassword('x', 'pbkdf2$1$1$1$c2FsdA==$aGFzaA=='));
    });
    it('supports deterministic salt injection for tests', () => {
        const stored = hashPassword('pw', { randomBytes: () => new Uint8Array(16).fill(7) });
        const again = hashPassword('pw', { randomBytes: () => new Uint8Array(16).fill(7) });
        assert.equal(stored, again);
        assert.ok(verifyPassword('pw', stored));
    });
});
describe('session cookies', () => {
    const secret = Buffer.from('0123456789abcdef0123456789abcdef');
    const now = 1_800_000_000_000;
    it('signs and verifies a session', () => {
        const cookie = signSession(secret, Math.floor(now / 1000) + SESSION_TTL_SECONDS);
        const session = verifySession(cookie, secret, now);
        assert.ok(session);
        assert.equal(session.v, 1);
    });
    it('rejects expired sessions', () => {
        const cookie = signSession(secret, Math.floor(now / 1000) - 1);
        assert.equal(verifySession(cookie, secret, now), undefined);
    });
    it('rejects tampered payloads and signatures', () => {
        const cookie = signSession(secret, Math.floor(now / 1000) + 60);
        const [payload, sig] = cookie.split('.');
        // flip one payload character
        const flippedPayload = (payload[0] === 'A' ? 'B' : 'A') + payload.slice(1);
        assert.equal(verifySession(flippedPayload + '.' + sig, secret, now), undefined);
        // wrong signature
        assert.equal(verifySession(payload + '.' + 'AAAA', secret, now), undefined);
        // wrong secret
        assert.equal(verifySession(cookie, Buffer.alloc(32, 1), now), undefined);
        // garbage
        assert.equal(verifySession('garbage', secret, now), undefined);
        assert.equal(verifySession(undefined, secret, now), undefined);
    });
    it('reports when a session needs a sliding refresh', () => {
        const exp = Math.floor(now / 1000) + 60; // 1 minute left
        const session = verifySession(signSession(secret, exp), secret, now);
        assert.ok(needsSessionRefresh(session, now));
        const farExp = Math.floor(now / 1000) + SESSION_TTL_SECONDS;
        const fresh = verifySession(signSession(secret, farExp), secret, now);
        assert.ok(!needsSessionRefresh(fresh, now));
    });
});
describe('rate limiter', () => {
    const now = () => Date.now();
    it('allows until the failure threshold, then blocks with backoff', () => {
        const limiter = new RateLimiter();
        const t0 = now();
        for (let i = 0; i < RATE_LIMIT.maxFails - 1; i++) {
            assert.ok(limiter.check('ip:1.2.3.4', t0).allowed);
            limiter.recordFailure('ip:1.2.3.4', t0);
        }
        // 5th fail → blocked for initialBlockMs
        const { blockedUntil } = limiter.recordFailure('ip:1.2.3.4', t0);
        assert.equal(blockedUntil, t0 + RATE_LIMIT.initialBlockMs);
        assert.ok(!limiter.check('ip:1.2.3.4', t0).allowed);
        // backoff doubles for continued failures after the window
        const later = t0 + RATE_LIMIT.initialBlockMs + 1;
        limiter.recordFailure('ip:1.2.3.4', later);
        const after = limiter.check('ip:1.2.3.4', later);
        assert.ok(!after.allowed);
        assert.equal(after.retryAfterSeconds, Math.ceil(RATE_LIMIT.initialBlockMs * 2 / 1000));
        // other keys unaffected
        assert.ok(limiter.check('ip:5.6.7.8', t0).allowed);
    });
    it('resets on success and prunes idle buckets', () => {
        const limiter = new RateLimiter();
        const t0 = now();
        limiter.recordFailure('ip:1.2.3.4', t0);
        limiter.recordFailure('ip:1.2.3.4', t0);
        limiter.reset('ip:1.2.3.4');
        assert.ok(limiter.check('ip:1.2.3.4', t0).allowed);
        assert.equal(limiter.size, 0);
        // a bucket with recent failures survives checks (failures accumulate)
        limiter.recordFailure('ip:9.9.9.9', t0);
        limiter.recordFailure('ip:9.9.9.9', t0);
        assert.equal(limiter.check('ip:9.9.9.9', t0 + 10_000).allowed, true);
        assert.equal(limiter.size, 1);
        // failures older than the window stop counting
        limiter.recordFailure('ip:9.9.9.9', t0 + RATE_LIMIT.windowMs + 1);
        assert.equal(limiter.check('ip:9.9.9.9', t0 + RATE_LIMIT.windowMs + 1).allowed, true);
        assert.equal(limiter.size, 1);
        // idle past the TTL, the bucket is pruned on the next check
        limiter.check('ip:9.9.9.9', t0 + RATE_LIMIT.idleTtlMs + RATE_LIMIT.windowMs + 2);
        assert.equal(limiter.size, 0);
    });
});
describe('sanitizeNext', () => {
    it('accepts same-origin paths', () => {
        assert.equal(sanitizeNext('/'), '/');
        assert.equal(sanitizeNext('/settings'), '/settings');
        assert.equal(sanitizeNext('/a/b?x=1&y=2'), '/a/b?x=1&y=2');
        assert.equal(sanitizeNext('/api/conversations/abc'), '/api/conversations/abc');
    });
    it('rejects absolute URLs and traversal tricks', () => {
        assert.equal(sanitizeNext('https://evil.example/'), undefined);
        assert.equal(sanitizeNext('//evil.example/'), undefined);
        assert.equal(sanitizeNext('/\\evil.example/'), undefined);
        assert.equal(sanitizeNext('javascript:alert(1)'), undefined);
        assert.equal(sanitizeNext(''), undefined);
        assert.equal(sanitizeNext('/a\nb'), undefined);
        assert.equal(sanitizeNext('/a\u0000b'), undefined);
        assert.equal(sanitizeNext(42), undefined);
        assert.equal(sanitizeNext(undefined), undefined);
        assert.equal(sanitizeNext('x'.repeat(2049)), undefined);
    });
});
describe('constants', () => {
    it('cookie name and password floor are stable', () => {
        assert.equal(COOKIE_NAME, 'dsh_web_auth');
        assert.equal(MIN_PASSWORD_LENGTH, 8);
    });
});
