/**
 * Build the browser half: bundle src/client/index.tsx with esbuild (externals
 * resolved from the browser module table at runtime) and wrap the output in
 * the ModuleLoader.load({ id, factory }) format the dsh web shell expects.
 *
 * The factory receives the kernel's require; esbuild's external require()
 * calls resolve against it. The bundle is assigned to a function-scoped
 * globalName variable, which the wrapper returns as the plugin module.
 */
import { build } from 'esbuild'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { rmSync, readFileSync } from 'node:fs'

const TMP = 'lib/.client-bundle.js'
const OUT = 'lib/client.js'
const ID = JSON.parse(readFileSync('package.json', 'utf8')).name

await build({
  entryPoints: ['src/client/index.tsx'],
  bundle: true,
  format: 'iife',
  globalName: 'dshWebAuthModule',
  external: ['react', 'react/jsx-runtime'],
  jsx: 'automatic',
  target: ['es2020'],
  outfile: TMP,
  minify: false,
  sourcemap: false,
  logLevel: 'warning'
})

// tsc also emits lib/client/index.js (declaration build); the browser half
// is owned by esbuild below, so drop the dead JS twin.
rmSync('lib/client/index.js', { force: true })

const body = await readFile(TMP, 'utf8')
const wrapped = `window.__ModuleLoader__.load({
\tid: ${JSON.stringify(ID)},
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
${body}
\t\treturn typeof dshWebAuthModule !== "undefined" ? dshWebAuthModule : module.exports;
\t}
});
`
await writeFile(OUT, wrapped)
await rm(TMP)
console.log('built ' + OUT)
