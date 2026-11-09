import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import { Config } from '../src/config.ts'
import { LlamaWorker, buildServerArguments, stripAsrText, wavDurationSeconds } from '../src/worker.ts'
import { wav } from './helpers.ts'

const paths = { executablePath: 'C:/llama/llama-server.exe', runtimeDirectory: 'C:/llama', modelPath: 'C:/models/decoder.gguf', mmprojPath: 'C:/models/mmproj.gguf' }

test('argv sets a small decoder context and preserves hardware/output defaults', () => {
  const args = buildServerArguments(Config({}), paths, 39123)
  assert.deepEqual(args, [paths.executablePath, '-m', paths.modelPath, '--mmproj', paths.mmprojPath, '--ctx-size', '4096', '--parallel', '1', '--no-warmup', '--host', '127.0.0.1', '--port', '39123', '--alias', 'llama-asr', '--no-webui', '--sleep-idle-seconds', '30'])
  for (const flag of ['--device', '--gpu-layers', '--threads', '--n-predict', '--mmproj-device', '--mmproj-offload', '--fit']) assert.ok(!args.includes(flag))
})

test('configured context overrides the default without adding an output cap', () => {
  const args = buildServerArguments(Config({ contextSize: 8192 }), paths, 12345)
  assert.equal(args[args.indexOf('--ctx-size') + 1], '8192')
  assert.ok(!args.includes('--n-predict'))
})

test('projector is optional and zero disables native sleep', () => {
  const { mmprojPath, ...decoderOnly } = paths
  const args = buildServerArguments(Config({ sleepIdleSeconds: 0 }), decoderOnly, 12345)
  assert.ok(!args.includes('--mmproj'))
  assert.ok(!args.includes('--sleep-idle-seconds'))
})

test('optional ASR marker and ordinary transcripts', () => {
  assert.equal(stripAsrText('language Chinese<asr_text> 你好  '), '你好')
  assert.equal(stripAsrText('无标记'), '无标记')
})

test('PCM WAV duration and malformed chunk rejection', () => {
  assert.equal(wavDurationSeconds(wav()), 1)
  assert.throws(() => wavDurationSeconds(new Uint8Array(3)), /truncated/)
  const truncated = wav().slice(0, -2)
  assert.throws(() => wavDurationSeconds(truncated), /length|truncated/)
  const invalid = wav()
  new DataView(invalid.buffer, invalid.byteOffset).setUint32(28, 1, true)
  assert.throws(() => wavDurationSeconds(invalid), /PCM/)
})

test('failed dependency discovery leaves a failed preparation state', async () => {
  const ctx = { subprocess: { resolveExecutable: async () => { throw new Error('fixture PATH empty') }, spawn: () => assert.fail('Missing runtime must not spawn') } } as unknown as Context
  const worker = new LlamaWorker(ctx, Config({ modelPath: '/fixture/decoder.gguf' }))
  await assert.rejects(async () => await worker.transcribe({ audio: wav(), language: 'auto' }, new AbortController().signal), /No llama.cpp runtime found/)
  assert.equal(worker.snapshot().phase, 'failed')
  await worker.dispose()
})

test('does not impose a second recording size or duration limit', () => {
  const audio = Buffer.alloc(44 + 16000 * 2 * 180)
  Buffer.from(wav()).copy(audio, 0, 0, 44)
  audio.writeUInt32LE(audio.length - 8, 4)
  audio.writeUInt32LE(audio.length - 44, 40)
  assert.equal(wavDurationSeconds(audio), 180)
})
