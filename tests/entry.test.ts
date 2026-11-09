import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import type { SpeechProvider } from '@deepseek-ai/dsh-experimental-speech-to-text/types'
import { Config, apply } from '../src/index.ts'
import { deferred } from './helpers.ts'

test('provider entry is lazy, configurable, and its effect joins unregister', async () => {
  const registered: SpeechProvider[] = []
  const disposers: Array<() => Promise<void>> = []
  const removing = deferred<void>()
  let unregisters = 0
  const ctx = {
    speechToText: { register(provider: SpeechProvider) { registered.push(provider); return async () => { unregisters++; await removing.promise } } },
    effect(run: () => () => Promise<void>) { disposers.push(run()) },
    subprocess: { spawn() { assert.fail('Registration must not spawn a model') }, resolveExecutable() { assert.fail('Registration must not resolve PATH') } },
  } as unknown as Context
  const config = Config({ modelPath: '/test-model/decoder.gguf', languages: ['auto', 'zh'] })
  apply(ctx, config)
  assert.equal(registered.length, 1)
  assert.equal(registered[0]!.info.name, 'llama.cpp (local ASR)')
  assert.deepEqual(registered[0]!.info.languages, ['auto', 'zh'])
  assert.equal(registered[0]!.preparation!.snapshot().phase, 'unprepared')
  let complete = false
  const disposing = disposers[0]!().then(() => { complete = true })
  await Promise.resolve()
  assert.equal(unregisters, 1)
  assert.equal(complete, false)
  removing.resolve()
  await disposing
  // Re-application gets a distinct worker, including after old lifetime disposal.
  apply(ctx, config)
  assert.notEqual(registered[0]!.preparation, registered[1]!.preparation)
  assert.equal(registered[1]!.preparation!.snapshot().phase, 'unprepared')
  await disposers[1]!()
})

test('built entry imports with declared DSH peers and exports configuration', async () => {
  const artifactUrl = new URL('../lib/index.js', import.meta.url).href
  const artifact = await import(artifactUrl)
  assert.equal(artifact.name, 'dsh-speech-llama-cpp')
  assert.deepEqual(artifact.inject, ['speechToText', 'subprocess'])
  assert.equal(artifact.Config({}).sleepIdleSeconds, 30)
  assert.equal(artifact.Config({}).contextSize, 4096)
  assert.equal(typeof artifact.apply, 'function')
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(manifest.exports['.'], './lib/index.js')
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  assert.match(patch, /disabled: true/)
  assert.ok(patch.includes("rootDirectory: !!js dshHomePath('speech-to-text', 'llama-cpp')"))
})
