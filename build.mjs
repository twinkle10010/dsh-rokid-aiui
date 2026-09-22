/**
 * Build `src/aiui-dev-console.ts` into `lib/aiui-dev-console.js`.
 *
 * The output is ESM with every bare import left external — the host resolves
 * `@yodaos-pkg/aix-cli`, `@deepseek-ai/schemastery`, and node builtins from
 * this package's own `node_modules`.
 *
 * esbuild is resolved from this package first. When the local install is
 * missing, set `AIUI_ESBUILD` to an esbuild entry file (for example a copy in a
 * pnpm store) to use that instead:
 *
 *   AIUI_ESBUILD=/path/to/node_modules/esbuild/lib/main.js node build.mjs
 *
 * The build also asserts that the browser asset the host reads at activation
 * (`client/injected.js`) still carries its placeholder tokens.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

async function loadEsbuild() {
  try {
    return await import('esbuild')
  } catch { /* not installed here: fall back to AIUI_ESBUILD below */ }
  const override = process.env.AIUI_ESBUILD
  if (override !== undefined && override.trim().length > 0) {
    return await import(pathToFileURL(override.trim()).href)
  }
  throw new Error('esbuild not found: run `npm i -D esbuild` here, or point AIUI_ESBUILD at an esbuild entry file')
}

const esbuild = await loadEsbuild()

const result = await esbuild.build({
  entryPoints: [join(here, 'src', 'aiui-dev-console.ts')],
  outfile: join(here, 'lib', 'aiui-dev-console.js'),
  bundle: false,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  sourcemap: false,
  logLevel: 'info',
})

if (result.errors.length > 0) process.exit(1)

// Cheap post-build sanity check: the asset the host reads at activation must
// survive into the package next to lib/.
const clientPath = join(here, 'client', 'injected.js')
const client = readFileSync(clientPath, 'utf-8')
if (!client.includes('__AIUI_PRESET_LABEL__')) {
  throw new Error(`client/injected.js is missing the __AIUI_PRESET_LABEL__ placeholder`)
}
console.log(`built lib/aiui-dev-console.js (client/injected.js: ${client.length} bytes)`)
