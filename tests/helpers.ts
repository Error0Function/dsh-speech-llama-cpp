import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { TestContext } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import type { SubprocessHandle, SubprocessOutcome, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { Config } from '../src/config.ts'
import { LlamaWorker } from '../src/worker.ts'

export function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

export class Calls<T> {
  readonly items: T[] = []
  private readonly waiting = new Map<number, ReturnType<typeof deferred<T>>>()

  push(value: T): void {
    const index = this.items.push(value) - 1
    this.waiting.get(index)?.resolve(value)
    this.waiting.delete(index)
  }

  at(index: number): Promise<T> {
    if (index < this.items.length) return Promise.resolve(this.items[index]!)
    let pending = this.waiting.get(index)
    if (!pending) { pending = deferred<T>(); this.waiting.set(index, pending) }
    return pending.promise
  }
}

export class FakeProcess implements SubprocessHandle {
  readonly stdin = undefined
  readonly stdout = undefined
  readonly stderr = undefined
  readonly control = undefined
  readonly collected = { stderr: { readFrom: () => ({ text: 'fixture stderr', nextOffset: 14, lossy: false }) } }
  private readonly outcome = deferred<SubprocessOutcome>()
  private readonly quiescence = deferred<boolean>()
  readonly done = this.outcome.promise
  readonly terminated = deferred<void>()
  readonly waited = deferred<void>()
  terminateCalls = 0
  waitCalls = 0
  exited = false
  autoExitOnTerminate = true

  constructor(readonly spec: SubprocessSpawnSpec) {
    if (spec.signal?.aborted) this.terminate()
    else spec.signal?.addEventListener('abort', this.onAbort, { once: true })
  }

  private readonly onAbort = (): void => { this.terminate() }

  terminate(): void {
    this.terminateCalls++
    this.terminated.resolve()
    if (this.autoExitOnTerminate) this.exit()
  }

  async waitForExit(signal?: AbortSignal): Promise<boolean> {
    this.waitCalls++
    this.waited.resolve()
    if (!signal) return await this.quiescence.promise
    if (signal.aborted) return false
    return await new Promise<boolean>((resolve, reject) => {
      const abort = (): void => resolve(false)
      signal.addEventListener('abort', abort, { once: true })
      void this.quiescence.promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
    })
  }

  reportExit(outcome: SubprocessOutcome = { exitCode: 0, signal: null }): void {
    this.exited = true
    this.outcome.resolve(outcome)
  }

  rejectDone(error: unknown): void {
    this.outcome.reject(error)
  }

  finishExit(): void {
    this.spec.signal?.removeEventListener('abort', this.onAbort)
    this.quiescence.resolve(true)
  }

  exit(outcome: SubprocessOutcome = { exitCode: 0, signal: null }): void {
    this.reportExit(outcome)
    this.finishExit()
  }
}

export interface FetchCall {
  readonly url: string
  readonly init: RequestInit
  readonly signal: AbortSignal
}

export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    void promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

export function response(text = 'recognized'): Response { return Response.json({ text }) }

export function wav(): Uint8Array {
  const audio = Buffer.alloc(44 + 32_000)
  audio.write('RIFF', 0)
  audio.writeUInt32LE(audio.length - 8, 4)
  audio.write('WAVE', 8)
  audio.write('fmt ', 12)
  audio.writeUInt32LE(16, 16)
  audio.writeUInt16LE(1, 20)
  audio.writeUInt16LE(1, 22)
  audio.writeUInt32LE(16_000, 24)
  audio.writeUInt32LE(32_000, 28)
  audio.writeUInt16LE(2, 32)
  audio.writeUInt16LE(16, 34)
  audio.write('data', 36)
  audio.writeUInt32LE(32_000, 40)
  return audio
}

function gguf(): Buffer {
  const key = Buffer.from('general.architecture')
  const value = Buffer.from('whisper')
  const bytes = Buffer.alloc(24 + 8 + key.length + 4 + 8 + value.length)
  bytes.write('GGUF')
  bytes.writeUInt32LE(3, 4)
  bytes.writeBigUInt64LE(0n, 8)
  bytes.writeBigUInt64LE(1n, 16)
  let offset = 24
  bytes.writeBigUInt64LE(BigInt(key.length), offset); offset += 8
  key.copy(bytes, offset); offset += key.length
  bytes.writeUInt32LE(8, offset); offset += 4
  bytes.writeBigUInt64LE(BigInt(value.length), offset); offset += 8
  value.copy(bytes, offset)
  return bytes
}

export interface HarnessOptions {
  readonly config?: Partial<Config>
  readonly health?: (call: FetchCall) => Response | Promise<Response>
  readonly post?: (call: FetchCall, index: number) => Response | Promise<Response>
  readonly spawn?: (process: FakeProcess, index: number) => void
}

export async function harness(t: TestContext, options: HarnessOptions = {}) {
  const fixtureRoot = fileURLToPath(new URL('../.test-tmp/', import.meta.url))
  await mkdir(fixtureRoot, { recursive: true })
  const root = await mkdtemp(join(fixtureRoot, 'lifecycle-'))
  let cleanup = async (): Promise<void> => {}
  t.after(async () => { await cleanup(); await rm(root, { recursive: true, force: true }) })
  const runtime = join(root, 'runtime')
  const executable = join(runtime, process.platform === 'win32' ? 'llama-server.exe' : 'llama-server')
  const model = join(root, 'models', 'decoder.gguf')
  await mkdir(runtime)
  await mkdir(dirname(model))
  await writeFile(executable, 'fixture executable; never launched')
  await writeFile(model, gguf())
  const config = Config({ executablePath: executable, runtimeDirectory: runtime, modelPath: model, ...options.config })
  const spawned = new Calls<FakeProcess>()
  const posts = new Calls<FetchCall>()
  const health = new Calls<FetchCall>()
  const fetchMock: typeof fetch = async (input, init = {}) => {
    const call: FetchCall = { url: String(input), init, signal: init.signal ?? new AbortController().signal }
    if (call.url.endsWith('/health')) {
      health.push(call)
      return await abortable(Promise.resolve(options.health?.(call) ?? new Response('', { status: 200 })), call.signal)
    }
    if (!call.url.endsWith('/v1/audio/transcriptions')) throw new Error(`Unexpected fixture URL: ${call.url}`)
    const index = posts.items.length
    posts.push(call)
    return await abortable(Promise.resolve(options.post?.(call, index) ?? response()), call.signal)
  }
  const ctx = {
    subprocess: {
      spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
        const child = new FakeProcess(spec)
        options.spawn?.(child, spawned.items.length)
        spawned.push(child)
        return child
      },
      resolveExecutable() { throw new Error('Explicit fixture executable must not search PATH') },
    },
  } as unknown as Context
  const deadlines: AbortSignal[] = []
  const worker = new LlamaWorker(ctx, config, {
    fetch: fetchMock,
    timeoutSignal(milliseconds: number): AbortSignal {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(new DOMException('Fixture deadline exceeded', 'TimeoutError')), milliseconds)
      timer.unref()
      deadlines.push(controller.signal)
      return controller.signal
    },
  })
  cleanup = async () => {
    for (const child of spawned.items) child.autoExitOnTerminate = true
    const disposing = worker.dispose()
    for (const child of spawned.items) child.exit()
    await disposing
  }
  const input = { audio: wav(), language: 'auto' }
  return { worker, config, spawned, posts, health, deadlines, input, root }
}

export function phase(worker: LlamaWorker, expected: ReturnType<LlamaWorker['snapshot']>['phase']): Promise<void> {
  if (worker.snapshot().phase === expected) return Promise.resolve()
  const ready = deferred<void>()
  const unsubscribe = worker.subscribe(() => {
    if (worker.snapshot().phase === expected) { unsubscribe(); ready.resolve() }
  })
  return ready.promise
}

export async function turn(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve))
}
