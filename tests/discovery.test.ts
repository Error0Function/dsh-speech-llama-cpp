import assert from 'node:assert/strict'
import { mkdir, mkdtemp, open, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, type TestContext } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import { Config } from '../src/config.ts'
import { resolvePaths, validatePaths } from '../src/discovery.ts'

const pluginDirectory = fileURLToPath(new URL('../', import.meta.url))
const executableName = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server'
const u32 = (value: number) => { const buffer = Buffer.alloc(4); buffer.writeUInt32LE(value); return buffer }
const u64 = (value: number) => { const buffer = Buffer.alloc(8); buffer.writeBigUInt64LE(BigInt(value)); return buffer }
const text = (value: string) => Buffer.concat([u64(Buffer.byteLength(value)), Buffer.from(value)])
const entry = (key: string, value: string) => Buffer.concat([text(key), u32(8), text(value)])

function gguf(architecture: string, before: Buffer[] = []): Buffer {
  return Buffer.concat([Buffer.from('GGUF'), u32(3), u64(0), u64(before.length + 1), ...before, entry('general.architecture', architecture)])
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(pluginDirectory, '.discovery-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const file = async (relative: string, contents: Buffer | string = '') => {
    const path = join(root, relative)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, contents)
    return path
  }
  const decoder = (relative = 'selected/voice.gguf', architecture = 'whisper') => file(relative, gguf(architecture))
  const executable = (relative = `selected/runtime/${executableName}`) => file(relative, 'fixture; never executed')
  const config = (values: Partial<Config> = {}): Config => Config({ rootDirectory: root, ...values })
  const calls: string[] = []
  let pathExecutable: string | undefined
  const subprocess = {
    resolveExecutable: async (command: string) => {
      calls.push(command)
      if (!pathExecutable) throw new Error('fixture PATH has no executable')
      return pathExecutable
    },
  } as Context['subprocess']
  return { root, file, decoder, executable, config, calls, subprocess, path: (value: string) => { pathExecutable = value } }
}

test('validates absolute paths synchronously and allows explicit model with PATH fallback', async t => {
  const f = await fixture(t)
  for (const key of ['rootDirectory', 'runtimeDirectory', 'executablePath', 'modelDirectory', 'modelPath', 'mmprojPath'] as const) {
    assert.throws(() => validatePaths({ ...f.config(), [key]: 'relative/path' }), new RegExp(`${key} must be an absolute path`))
  }
  assert.throws(() => validatePaths(f.config({ rootDirectory: '' })), /needs rootDirectory, modelDirectory, or an explicit modelPath/)
  assert.doesNotThrow(() => validatePaths(f.config({ rootDirectory: '', modelPath: join(f.root, 'not-yet-created.gguf') })))
})

test('explicit files outrank root groups and absent lower-priority discovery directories', async t => {
  const f = await fixture(t)
  const executablePath = await f.executable()
  const modelPath = await f.decoder('selected/voice.gguf', 'qwen3vl')
  const mmprojPath = await f.file('selected/hand-selected.gguf', gguf('clip'))
  await f.executable(`runtime/a/${executableName}`)
  await f.executable(`runtime/b/${executableName}`)
  await f.decoder('models/a/one/extra.gguf')
  const result = await resolvePaths(f.config({ executablePath, modelPath, mmprojPath }), f.subprocess)
  assert.deepEqual(result, { executablePath, runtimeDirectory: dirname(executablePath), modelPath, mmprojPath })
  const absentRoot = join(f.root, 'absent')
  assert.deepEqual(await resolvePaths(f.config({ rootDirectory: absentRoot, modelDirectory: absentRoot, executablePath, modelPath, mmprojPath }), f.subprocess), result)
  assert.deepEqual(f.calls, [])
})

test('discovers the exact root model depth and a release root/bin layout', async t => {
  const f = await fixture(t)
  const executablePath = await f.executable(`runtime/release/bin/${executableName}`)
  const modelPath = await f.decoder('models/audio/quant/voice.gguf', 'qwen3vl')
  const mmprojPath = await f.file('models/audio/quant/mmproj-voice.gguf', gguf('clip'))
  await f.decoder('models/ignored.gguf')
  await f.decoder('models/audio/too-shallow.gguf')
  await f.decoder('models/audio/quant/too-deep/ignored.gguf')
  assert.deepEqual(await resolvePaths(f.config(), f.subprocess), { executablePath, runtimeDirectory: join(f.root, 'runtime', 'release'), modelPath, mmprojPath })
  assert.deepEqual(f.calls, [])
})

test('runtimeDirectory accepts release root and bin directly; executable bin path infers release root', async t => {
  const f = await fixture(t)
  const executablePath = await f.executable(`release/bin/${executableName}`)
  const modelPath = await f.decoder()
  const runtimeDirectory = join(f.root, 'release')
  const result = await resolvePaths(f.config({ runtimeDirectory, modelPath }), f.subprocess)
  assert.equal(result.executablePath, executablePath)
  assert.equal(result.runtimeDirectory, runtimeDirectory)
  assert.equal((await resolvePaths(f.config({ runtimeDirectory: join(runtimeDirectory, 'bin'), modelPath }), f.subprocess)).runtimeDirectory, join(runtimeDirectory, 'bin'))
  assert.equal((await resolvePaths(f.config({ executablePath, modelPath }), f.subprocess)).runtimeDirectory, runtimeDirectory)
})

test('explicit modelDirectory scans only its own files', async t => {
  const f = await fixture(t)
  const executablePath = await f.executable()
  const modelPath = await f.decoder('chosen/voice.gguf')
  await f.decoder('chosen/nested/ignored.gguf')
  await f.decoder('models/other/revision/ignored.gguf')
  const result = await resolvePaths(f.config({ executablePath, modelDirectory: dirname(modelPath) }), f.subprocess)
  assert.equal(result.modelPath, modelPath)
  assert.equal(result.mmprojPath, undefined)
})

test('PATH is consulted only after no runtime group is found and modelPath alone is viable', async t => {
  const f = await fixture(t)
  const executablePath = await f.executable(`path/bin/${executableName}`)
  const modelPath = await f.decoder()
  f.path(executablePath)
  const expected = { executablePath, runtimeDirectory: join(f.root, 'path'), modelPath }
  assert.deepEqual(await resolvePaths(f.config({ rootDirectory: '', modelPath }), f.subprocess), expected)
  assert.deepEqual(await resolvePaths(f.config({ rootDirectory: join(f.root, 'absent-root'), modelPath }), f.subprocess), expected)
  assert.deepEqual(f.calls, [executableName, executableName])
})

test('missing runtime produces actionable PATH failure and preserves lookup cause', async t => {
  const f = await fixture(t)
  const modelPath = await f.decoder()
  await assert.rejects(resolvePaths(f.config({ modelPath }), f.subprocess), error => {
    assert.ok(error instanceof Error)
    assert.match(error.message, /Set runtimeDirectory or executablePath/)
    assert.equal((error.cause as Error).message, 'fixture PATH has no executable')
    return true
  })
})

test('configured missing paths and wrong file kinds fail without PATH fallback', async t => {
  const f = await fixture(t)
  const executablePath = await f.executable()
  const modelPath = await f.decoder()
  await assert.rejects(resolvePaths(f.config({ executablePath: join(f.root, 'absent'), modelPath }), f.subprocess), /executablePath does not exist/)
  await assert.rejects(resolvePaths(f.config({ executablePath: f.root, modelPath }), f.subprocess), /executablePath must be a regular file/)
  await assert.rejects(resolvePaths(f.config({ executablePath, runtimeDirectory: modelPath, modelPath }), f.subprocess), /runtimeDirectory must be a regular directory/)
  await assert.rejects(resolvePaths(f.config({ executablePath, modelPath: join(f.root, 'absent') }), f.subprocess), /modelPath does not exist/)
  await assert.rejects(resolvePaths(f.config({ executablePath, modelPath: f.root }), f.subprocess), /modelPath must be a regular file/)
  await assert.rejects(resolvePaths(f.config({ executablePath, modelPath, mmprojPath: f.root }), f.subprocess), /mmprojPath must be a regular file/)
  assert.deepEqual(f.calls, [])
})

test('missing decoder and multiple model groups require explicit selection', async t => {
  const f = await fixture(t)
  const executablePath = await f.executable()
  await assert.rejects(resolvePaths(f.config({ executablePath }), f.subprocess), /No llama.cpp decoder GGUF/)
  await f.decoder('models/one/quant/one.gguf')
  await f.decoder('models/two/quant/two.gguf')
  await assert.rejects(resolvePaths(f.config({ executablePath }), f.subprocess), /Multiple decoder GGUF candidates; set modelPath or modelDirectory/)
})

test('multiple runtime releases and root/bin duplicate executables fail rather than selecting newest', async t => {
  const f = await fixture(t)
  const modelPath = await f.decoder()
  await f.executable(`runtime/old/${executableName}`)
  await f.executable(`runtime/new/${executableName}`)
  await assert.rejects(resolvePaths(f.config({ modelPath }), f.subprocess), /Multiple llama.cpp runtime groups/)
  const runtimeDirectory = join(f.root, 'release')
  await f.executable(`release/${executableName}`)
  await f.executable(`release/bin/${executableName}`)
  await assert.rejects(resolvePaths(f.config({ runtimeDirectory, modelPath }), f.subprocess), /Multiple llama.cpp executables/)
  assert.deepEqual(f.calls, [])
})

test('qwen3vl metadata requires projector even with an unrelated decoder filename', async t => {
  const f = await fixture(t)
  const executablePath = await f.executable()
  const modelPath = await f.decoder('chosen/arbitrary-name.gguf', 'qwen3vl')
  await assert.rejects(resolvePaths(f.config({ executablePath, modelPath }), f.subprocess), /general.architecture=qwen3vl requires its matching projector/)
})

test('unknown decoder architecture is preserved for llama.cpp to report', async t => {
  const f = await fixture(t)
  const executablePath = await f.executable()
  const modelPath = await f.decoder('chosen/unknown.gguf', 'future_audio_architecture')
  assert.equal((await resolvePaths(f.config({ executablePath, modelPath }), f.subprocess)).modelPath, modelPath)
})

test('unique same-name projector is paired; multiple possible matches and mismatches fail', async t => {
  const f = await fixture(t)
  const executablePath = await f.executable()
  const modelPath = await f.decoder('chosen/voice.gguf', 'qwen3vl')
  const unrelated = await f.file('chosen/mmproj-other.gguf', gguf('clip'))
  await assert.rejects(resolvePaths(f.config({ executablePath, modelPath }), f.subprocess), /Cannot pair projector.*set mmprojPath/)
  const paired = await f.file('chosen/mmproj-voice.gguf', gguf('clip'))
  assert.equal((await resolvePaths(f.config({ executablePath, modelPath }), f.subprocess)).mmprojPath, paired)
  await f.file('chosen/projector-voice.gguf', gguf('clip'))
  await assert.rejects(resolvePaths(f.config({ executablePath, modelPath }), f.subprocess), /Ambiguous projector files/)
  assert.equal((await resolvePaths(f.config({ executablePath, modelPath, mmprojPath: unrelated }), f.subprocess)).mmprojPath, unrelated)
})

test('projector cannot be decoder, same file, or a decoder architecture pretending to be projector', async t => {
  const f = await fixture(t)
  const executablePath = await f.executable()
  const modelPath = await f.decoder()
  const projector = await f.file('projectors/encoder.gguf', gguf('clip'))
  await assert.rejects(resolvePaths(f.config({ executablePath, modelPath: projector }), f.subprocess), /modelPath is a projector/)
  await assert.rejects(resolvePaths(f.config({ executablePath, modelPath, mmprojPath: modelPath }), f.subprocess), /must select different files/)
  await assert.rejects(resolvePaths(f.config({ executablePath, modelPath, mmprojPath: modelPath + '.gguf' }), f.subprocess), /mmprojPath does not exist/)
  const wrong = await f.file('projectors/wrong.gguf', gguf('llama'))
  await assert.rejects(resolvePaths(f.config({ executablePath, modelPath, mmprojPath: wrong }), f.subprocess), /mmprojPath must select a llama.cpp projector/)
})

test('metadata reader skips preceding strings and arrays without reading model tensors', async t => {
  const f = await fixture(t)
  const executablePath = await f.executable()
  const values = Buffer.concat([text('tokenizer.tokens'), u32(9), u32(8), u64(2), text('first'), text('second')])
  const numeric = Buffer.concat([text('tokenizer.scores'), u32(9), u32(6), u64(3), Buffer.alloc(12)])
  const boolean = Buffer.concat([text('general.flag'), u32(7), Buffer.from([1])])
  const header = gguf('qwen3vl', [entry('general.name', 'fixture decoder'), values, numeric, boolean])
  const modelPath = await f.file('chosen/voice.gguf', header)
  const handle = await open(modelPath, 'r+')
  try { await handle.truncate(8 * 1024 * 1024) } finally { await handle.close() }
  await assert.rejects(resolvePaths(f.config({ executablePath, modelPath }), f.subprocess), /requires its matching projector/)
})

test('malformed or oversized architecture metadata fails with bounded actionable errors', async t => {
  const f = await fixture(t)
  const executablePath = await f.executable()
  const invalid = await f.file('invalid/not-gguf.gguf', Buffer.alloc(24))
  await assert.rejects(resolvePaths(f.config({ executablePath, modelPath: invalid }), f.subprocess), /Expected a GGUF v2\/v3 model header/)
  const truncated = await f.file('truncated/decoder.gguf', Buffer.from('GGUF'))
  await assert.rejects(resolvePaths(f.config({ executablePath, modelPath: truncated }), f.subprocess), /Truncated GGUF metadata/)
  const oversized = Buffer.concat([Buffer.from('GGUF'), u32(3), u64(0), u64(1), u64(2 * 1024 * 1024)])
  const huge = await f.file('oversized/decoder.gguf', oversized)
  await assert.rejects(resolvePaths(f.config({ executablePath, modelPath: huge }), f.subprocess), /metadata inspection exceeds 1 MiB/)
})
