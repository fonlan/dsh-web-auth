/**
 * Unit tests for the profile-patch rewrite (bind-host switching).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ALLOWED_LISTEN_HOSTS, isAllowedListenHost, prepareWebserverHostPatch, readPatchOrEmpty, resolveListenPatchPath, setWebserverHost, writeWebserverHostPatch } from '../lib/profile-patch.js';
describe('setWebserverHost', () => {
    it('replaces the host value in an existing entry, preserving everything else', () => {
        const input = [
            '# Your patch layer for this dsh profile, applied after every bundle layer:',
            '- id: webserver',
            '  config:',
            '    host: 127.0.0.1',
            '    port: !!js ctx.webStartup.port ?? 3080',
            ''
        ].join('\n');
        const out = setWebserverHost(input, '0.0.0.0');
        assert.match(out, /^- id: webserver\n  config:\n    host: 0\.0\.0\.0\n    port: !!js ctx\.webStartup\.port \?\? 3080/m);
        assert.match(out, /^# Your patch layer/m);
        // the !!js port expression survives byte-for-byte
        assert.ok(out.includes('port: !!js ctx.webStartup.port ?? 3080'));
    });
    it('switches back to the loopback literal', () => {
        const input = [
            '- id: webserver',
            '  config:',
            '    host: 0.0.0.0',
            '    port: !!js ctx.webStartup.port ?? 3080',
            ''
        ].join('\n');
        assert.ok(setWebserverHost(input, '127.0.0.1').includes('host: 127.0.0.1'));
    });
    it('handles a quoted id and trailing comments', () => {
        const input = "- id: 'webserver'  # transport\n  config:\n    host: 127.0.0.1\n";
        assert.ok(setWebserverHost(input, '0.0.0.0').includes('host: 0.0.0.0'));
    });
    it('inserts a host line under config when the entry lacks one', () => {
        const input = [
            '- id: webserver',
            '  config:',
            '    port: !!js ctx.webStartup.port ?? 3080',
            ''
        ].join('\n');
        const out = setWebserverHost(input, '0.0.0.0');
        assert.ok(out.includes('  config:\n    host: 0.0.0.0\n    port: !!js ctx.webStartup.port ?? 3080'));
    });
    it('appends a config block when the entry has none', () => {
        const input = "- id: webserver\n  name: '@deepseek-ai/dsh-host-webserver'\n";
        const out = setWebserverHost(input, '0.0.0.0');
        assert.ok(out.includes("  name: '@deepseek-ai/dsh-host-webserver'"));
        assert.ok(out.includes('  config:\n    host: 0.0.0.0\n    port: !!js ctx.webStartup.port ?? 3080'));
    });
    it('appends a complete row when no layer spells webserver', () => {
        const input = '- id: something-else\n  config:\n    foo: bar\n';
        const out = setWebserverHost(input, '0.0.0.0');
        assert.ok(out.includes('- id: webserver\n  name: "@deepseek-ai/dsh-host-webserver"\n  inject: [webStartup]\n  config:\n    host: 0.0.0.0\n    port: !!js ctx.webStartup.port ?? 3080'));
        // the untouched entry is preserved
        assert.ok(out.includes('- id: something-else\n  config:\n    foo: bar\n'));
    });
    it('appends into an empty document', () => {
        const out = setWebserverHost('', '0.0.0.0');
        assert.ok(out.startsWith('- id: webserver'));
        assert.ok(out.endsWith('port: !!js ctx.webStartup.port ?? 3080\n'));
    });
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
        ].join('\n');
        const out = setWebserverHost(input, '0.0.0.0');
        assert.ok(out.includes('- id: other-row\n  config:\n    host: 10.0.0.5\n'));
        assert.ok(out.includes('- id: webserver\n  config:\n    host: 0.0.0.0\n'));
    });
});
describe('patch layer resolution', () => {
    it('prefers the home patch when it spells the webserver row', () => {
        const dir = mkdtempSync(join(tmpdir(), 'dwa-patch-'));
        try {
            const profile = join(dir, 'cordis.patch.yml');
            const home = join(dir, 'home.yml');
            writeFileSync(home, '- id: webserver\n  config:\n    host: 127.0.0.1\n');
            writeFileSync(profile, '- id: something-else\n');
            assert.equal(resolveListenPatchPath(profile, home), home);
        }
        finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
    it('falls back to the profile patch when the home layer is silent', () => {
        const dir = mkdtempSync(join(tmpdir(), 'dwa-patch-'));
        try {
            const profile = join(dir, 'cordis.patch.yml');
            const home = join(dir, 'home.yml');
            writeFileSync(profile, '- id: webserver\n  config:\n    host: 127.0.0.1\n');
            writeFileSync(home, '- id: other\n');
            assert.equal(resolveListenPatchPath(profile, home), profile);
        }
        finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
    it('targets the profile patch when neither layer spells webserver', () => {
        const dir = mkdtempSync(join(tmpdir(), 'dwa-patch-'));
        try {
            const profile = join(dir, 'cordis.patch.yml');
            const home = join(dir, 'home.yml');
            writeFileSync(home, '- id: other\n');
            assert.equal(resolveListenPatchPath(profile, home), profile);
            assert.equal(resolveListenPatchPath(profile, join(dir, 'missing.yml')), profile);
        }
        finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
describe('patch file round-trip', () => {
    it('prepares and atomically writes the transformed layer', () => {
        const dir = mkdtempSync(join(tmpdir(), 'dwa-patch-'));
        try {
            const patch = join(dir, 'cordis.patch.yml');
            writeFileSync(patch, [
                '- id: webserver',
                '  config:',
                '    host: 127.0.0.1',
                '    port: !!js ctx.webStartup.port ?? 3080',
                ''
            ].join('\n'));
            const next = prepareWebserverHostPatch(patch, '0.0.0.0');
            assert.ok(next.includes('host: 0.0.0.0'));
            writeWebserverHostPatch(patch, next);
            assert.ok(readFileSync(patch, 'utf8').includes('host: 0.0.0.0'));
            // the file holds exactly the prepared content; no temp files remain
            assert.equal(readFileSync(patch, 'utf8'), next);
            assert.deepEqual(readdirSync(dir), ['cordis.patch.yml']);
        }
        finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
    it('reads a missing file as empty and creates the layer', () => {
        const dir = mkdtempSync(join(tmpdir(), 'dwa-patch-'));
        try {
            const patch = join(dir, 'cordis.patch.yml');
            assert.equal(readPatchOrEmpty(patch), '');
            const next = prepareWebserverHostPatch(patch, '0.0.0.0');
            writeWebserverHostPatch(patch, next);
            assert.ok(readFileSync(patch, 'utf8').includes('- id: webserver'));
        }
        finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
describe('listen host validation', () => {
    it('accepts exactly the two webserver literals', () => {
        assert.deepEqual(ALLOWED_LISTEN_HOSTS, ['127.0.0.1', '0.0.0.0']);
        for (const host of ALLOWED_LISTEN_HOSTS)
            assert.equal(isAllowedListenHost(host), true);
        for (const bad of ['localhost', '0.0.0.1', '', '::', 0, undefined, null]) {
            assert.equal(isAllowedListenHost(bad), false);
        }
    });
});
