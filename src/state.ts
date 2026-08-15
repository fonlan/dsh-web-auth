/**
 * dsh-web-auth — persistent state under the harness home.
 *
 * All state lives under `$DSH_HOME/web-auth/` (0600 files, 0700 dir):
 *   password.hash — one scrypt line (GUI-maintained; absent = auth disabled)
 *   secret        — 32 random bytes signing session cookies (rotated on
 *                   password change, which logs every session out)
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { randomBytes } from 'node:crypto'

/** Resolve the harness home the same way dsh does: $DSH_HOME, else ~/.dsh. */
export function resolveDshHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.DSH_HOME?.trim() || join(homedir(), '.dsh')
}

/** Directory holding web-auth state; created on first use (0700). */
export function stateDir(dshHome: string): string {
  const dir = join(dshHome, 'web-auth')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}

/** The stored password hash, or undefined when auth is not yet configured. */
export function readPasswordHash(dshHome: string): string | undefined {
  const file = join(stateDir(dshHome), 'password.hash')
  if (!existsSync(file)) return undefined
  const line = readFileSync(file, 'utf8').trim()
  return line.length === 0 ? undefined : line
}

/** Persist a new password hash (atomic replace, 0600). */
export function writePasswordHash(dshHome: string, hash: string): void {
  const file = join(stateDir(dshHome), 'password.hash')
  const tmp = file + '.tmp-' + randomBytes(4).toString('hex')
  writeFileSync(tmp, hash + '\n', { mode: 0o600 })
  renameSync(tmp, file)
  try {
    chmodSync(file, 0o600)
  } catch {
    /* best effort on filesystems without chmod */
  }
}

/** The session-signing secret, minted and persisted on first use. */
export function readSecret(dshHome: string): Buffer {
  const file = join(stateDir(dshHome), 'secret')
  if (existsSync(file)) {
    const raw = readFileSync(file)
    if (raw.length >= 32) return raw
  }
  const secret = randomBytes(32)
  const tmp = file + '.tmp-' + randomBytes(4).toString('hex')
  writeFileSync(tmp, secret, { mode: 0o600 })
  renameSync(tmp, file)
  try {
    chmodSync(file, 0o600)
  } catch {
    /* best effort */
  }
  return secret
}

/** Replace the signing secret (password change): every session dies. */
export function rotateSecret(dshHome: string): Buffer {
  const file = join(stateDir(dshHome), 'secret')
  const secret = randomBytes(32)
  const tmp = file + '.tmp-' + randomBytes(4).toString('hex')
  writeFileSync(tmp, secret, { mode: 0o600 })
  renameSync(tmp, file)
  try {
    chmodSync(file, 0o600)
  } catch {
    /* best effort */
  }
  return secret
}
