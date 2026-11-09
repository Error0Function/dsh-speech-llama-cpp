/** Verify the distributable archive with the project's published DSH peers. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const artifacts = join(root, '.artifacts')
mkdirSync(artifacts, { recursive: true })

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', ...options })
  if (result.error) throw result.error
  assert.equal(result.status, 0, `${command} failed: ${result.stderr || result.stdout}`)
  return result.stdout
}

assert.ok(process.env.npm_execpath, 'Run this check with pnpm run verify:package')
run(process.execPath, [process.env.npm_execpath, 'pack', '--pack-destination', artifacts])
const filename = `${manifest.name.replace(/^@/, '').replaceAll('/', '-')}-${manifest.version}.tgz`
const archive = join(artifacts, filename)
const entries = run('tar', ['-tzf', archive]).trim().split(/\r?\n/).sort()
assert.deepEqual(entries, [
  'package/AGENTS.md', 'package/LICENSE', 'package/README.md', 'package/README.zh.md',
  'package/cordis.patch.yml', 'package/lib/index.js', 'package/lib/index.js.map', 'package/package.json',
].sort())

const consumer = mkdtempSync(join(artifacts, 'consumer-'))
run('tar', ['-xzf', archive, '-C', consumer])
const packageRoot = join(consumer, 'package')
const packed = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
assert.equal(packed.name, manifest.name)
assert.equal(packed.version, manifest.version)
assert.equal(packed.exports['.'], './lib/index.js')
assert.equal(packed.dsh.bundle.patch, './cordis.patch.yml')
const patch = readFileSync(join(packageRoot, 'cordis.patch.yml'), 'utf8')
assert.match(patch, /disabled: true/)
assert.ok(patch.includes("dshHomePath('speech-to-text', 'llama-cpp')"))

for (const filename of ['README.md', 'README.zh.md']) {
  const body = readFileSync(join(packageRoot, filename), 'utf8')
  const anchors = new Set([...body.matchAll(/<a id="([^"]+)"><\/a>/g)].map(match => match[1]))
  for (const match of body.matchAll(/\[[^\]\n]*\]\(([^)]+)\)/g)) {
    const target = match[1]
    if (/^https?:/.test(target)) continue
    if (target.startsWith('#')) assert.ok(anchors.has(target.slice(1)), `Missing anchor ${target}`)
    else assert.ok(existsSync(resolve(dirname(join(packageRoot, filename)), target.split('#')[0])), `Missing package link ${target}`)
  }
}

const check = `
import assert from 'node:assert/strict'
const entry = await import(process.argv[1])
assert.equal(entry.name, 'dsh-speech-llama-cpp')
assert.deepEqual(entry.inject, ['speechToText', 'subprocess'])
assert.equal(entry.Config({}).contextSize, 4096)
assert.equal(entry.Config({}).sleepIdleSeconds, 30)
assert.equal(typeof entry.apply, 'function')
`
run(process.execPath, ['--input-type=module', '--eval', check, pathToFileURL(join(packageRoot, 'lib/index.js')).href], { cwd: consumer })
const sha256 = createHash('sha256').update(readFileSync(archive)).digest('hex')
console.log(JSON.stringify({ archive: filename, files: entries.length, nativeImport: true, sha256 }))
