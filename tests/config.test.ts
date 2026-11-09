import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Config } from '../src/config.ts'

test('configuration defaults keep model discovery and upstream placement automatic', () => {
  const config = Config({})
  assert.equal(config.providerId, 'llama-cpp')
  assert.deepEqual(config.languages, ['auto'])
  assert.equal(config.sleepIdleSeconds, 30)
  assert.equal(config.contextSize, 4096)
  assert.equal(config.startupTimeoutMs, 180000)
  assert.equal(config.requestTimeoutMs, 120000)
  for (const key of ['rootDirectory', 'modelPath', 'mmprojPath', 'runtimeDirectory', 'executablePath', 'modelDirectory'] as const) assert.equal(config[key], '')
  for (const key of ['gpuDevice', 'gpuLayers', 'threads', 'maxTokens', 'maxPending', 'maxAudioBytes', 'maxResponseBytes']) assert.ok(!(key in config))
})

test('configuration accepts absolute deployment overrides and both loopback families', () => {
  assert.equal(Config({ rootDirectory: 'C:/models', modelPath: '/models/decoder.gguf', host: '::1', sleepIdleSeconds: 0 }).host, '::1')
  assert.deepEqual(Config({ languages: ['auto', 'zh', 'en'] }).languages, ['auto', 'zh', 'en'])
  assert.equal(Config({ contextSize: 8192 }).contextSize, 8192)
})

for (const [name, patch] of Object.entries({
  'relative model path': { modelPath: 'models/decoder.gguf' },
  'relative runtime path': { runtimeDirectory: './runtime' },
  'non-loopback host': { host: '0.0.0.0' },
  'negative port': { port: -1 },
  'out-of-range port': { port: 65536 },
  'fractional port': { port: 1.5 },
  'zero startup deadline': { startupTimeoutMs: 0 },
  'negative request deadline': { requestTimeoutMs: -1 },
  'overflowing deadline': { requestTimeoutMs: 2147483648 },
  'overflowing derived idle timer': { sleepIdleSeconds: 1073742 },
  'negative sleep': { sleepIdleSeconds: -1 },
  'zero context': { contextSize: 0 },
  'negative context': { contextSize: -1 },
  'fractional context': { contextSize: 4096.5 },
  'zero grace': { graceMs: 0 },
  'zero log retention': { maxLogBytes: 0 },
  'empty language list': { languages: [] },
  'empty language': { languages: [''] },
  'whitespace language': { languages: ['two words'] },
  'whitespace provider id': { providerId: 'two words' },
  'empty alias': { modelAlias: '' },
})) test(`configuration rejects ${name}`, () => assert.throws(() => Config(patch as never)))
