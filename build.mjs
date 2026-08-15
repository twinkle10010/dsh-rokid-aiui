// Transpiles src/aiui-dev-console.ts -> lib/aiui-dev-console.js (ESM, node20).
// Run: node build.mjs   (requires esbuild on PATH / in node_modules)
import { build } from 'esbuild'
import { mkdirSync } from 'node:fs'

mkdirSync('lib', { recursive: true })

await build({
  entryPoints: ['src/aiui-dev-console.ts'],
  outfile: 'lib/aiui-dev-console.js',
  bundle: false,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  sourcemap: false,
})

console.log('built lib/aiui-dev-console.js')
