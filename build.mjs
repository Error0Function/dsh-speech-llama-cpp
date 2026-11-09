/** Bundle the Host entry while leaving DSH peer dependencies external. */
import { build } from 'esbuild'

await build({
  entryPoints: ['src/index.ts'],
  outdir: 'lib',
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node24',
  packages: 'external',
  sourcemap: true,
})
console.log('Built dsh-speech-llama-cpp')
