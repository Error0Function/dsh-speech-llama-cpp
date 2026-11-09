/** Serial ASR requests and Host-owned llama-server lifetime. */
import { createServer } from 'node:net'
import { delimiter, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { SubprocessHandle, SubprocessOutcome } from '@deepseek-ai/dsh-subprocess'
import type { SpeechPreparation, SpeechPreparationOptions, SpeechPreparationState, SpeechInput, Transcript } from '@deepseek-ai/dsh-experimental-speech-to-text/types'
import type { Config } from './config.ts'
import { resolvePaths, type ResolvedPaths } from './discovery.ts'

export interface WorkerDependencies {
  fetch?: typeof globalThis.fetch
  timeoutSignal?: (milliseconds: number) => AbortSignal
}

interface WorkerProcess {
  readonly handle: SubprocessHandle
  readonly url: string
  readonly exited: AbortController
  closed: boolean
  outcome?: SubprocessOutcome
  failure?: { reason: unknown }
  closing?: Promise<void>
}

interface LaunchDiagnostics {
  argv: readonly string[]
  environmentOverrides: string[]
  upstreamConfiguration: string
  rawText?: string
  exit?: SubprocessOutcome & { stderr: string; stderrLossy: boolean; failure?: string }
}

function parseTranscript(value: string): string {
  const parsed: unknown = JSON.parse(value)
  if (typeof parsed !== 'object' || parsed === null || !('text' in parsed) || typeof parsed.text !== 'string') {
    throw new Error('llama.cpp transcription response did not contain text')
  }
  return parsed.text
}

/** Strip the optional ASR prompt marker without changing ordinary model output. */
export function stripAsrText(value: string): string {
  const marker = '<asr_text>'
  const index = value.indexOf(marker)
  return (index < 0 ? value : value.slice(index + marker.length)).trim()
}

/** Read PCM/IEEE-float WAV duration without imposing another audio limit. */
export function wavDurationSeconds(audio: Uint8Array): number {
  if (audio.byteLength < 12) throw new Error('llama.cpp provider received a truncated WAV')
  const view = new DataView(audio.buffer, audio.byteOffset, audio.byteLength)
  const ascii = (offset: number, length: number): string => String.fromCharCode(...audio.subarray(offset, offset + length))
  if (ascii(0, 4) !== 'RIFF' || ascii(8, 4) !== 'WAVE') throw new Error('llama.cpp provider requires a RIFF/WAVE recording')
  if (view.getUint32(4, true) + 8 !== audio.byteLength) throw new Error('llama.cpp provider received an inconsistent WAV length')
  let byteRate = 0
  let blockAlign = 0
  let dataBytes = 0
  let offset = 12
  while (offset + 8 <= audio.byteLength) {
    const id = ascii(offset, 4)
    const size = view.getUint32(offset + 4, true)
    const body = offset + 8
    if (body + size > audio.byteLength) throw new Error('llama.cpp provider received a truncated WAV chunk')
    if (id === 'fmt ') {
      if (size < 16) throw new Error('llama.cpp provider received an invalid WAV format chunk')
      const format = view.getUint16(body, true)
      const channels = view.getUint16(body + 2, true)
      const rate = view.getUint32(body + 4, true)
      const bits = view.getUint16(body + 14, true)
      byteRate = view.getUint32(body + 8, true)
      blockAlign = view.getUint16(body + 12, true)
      if (![1, 3].includes(format) || !channels || !rate || !bits || bits % 8 || blockAlign !== channels * bits / 8 || byteRate !== rate * blockAlign) {
        throw new Error('llama.cpp provider requires a valid PCM or IEEE-float WAV')
      }
    } else if (id === 'data') dataBytes += size
    offset = body + size + (size & 1)
  }
  if (offset !== audio.byteLength || !byteRate || !dataBytes || dataBytes % blockAlign) throw new Error('llama.cpp provider received a WAV without usable sample data')
  return dataBytes / byteRate
}

/** Set the configured decoder context; leave device, layers, threads, and output budget upstream. */
export function buildServerArguments(config: Config, paths: ResolvedPaths, port: number): readonly string[] {
  const args = [paths.executablePath, '-m', paths.modelPath]
  if (paths.mmprojPath) args.push('--mmproj', paths.mmprojPath)
  args.push('--ctx-size', String(config.contextSize), '--parallel', '1', '--no-warmup', '--host', config.host, '--port', String(port), '--alias', config.modelAlias, '--no-webui')
  if (config.sleepIdleSeconds > 0) args.push('--sleep-idle-seconds', String(config.sleepIdleSeconds))
  return args
}

async function reservePort(host: string): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, host, resolve) })
  const address = server.address()
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  if (!address || typeof address === 'string') throw new Error('llama.cpp could not reserve a loopback port')
  return address.port
}

function waitFor<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const abort = (): void => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    void promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const finish = (): void => { signal.removeEventListener('abort', abort); resolve() }
    const timer = setTimeout(finish, milliseconds)
    const abort = (): void => { clearTimeout(timer); reject(signal.reason) }
    signal.addEventListener('abort', abort, { once: true })
  })
}

/** Own one serial server; native sleep releases the model before the later process exit. */
export class LlamaWorker implements SpeechPreparation {
  private readonly lifetime = new AbortController()
  private readonly listeners = new Set<() => void>()
  private readonly processes = new Set<WorkerProcess>()
  private readonly fetch: typeof globalThis.fetch
  private readonly timeoutSignal: (milliseconds: number) => AbortSignal
  private state: SpeechPreparationState = { phase: 'unprepared' }
  private worker: WorkerProcess | undefined
  private tail: Promise<void> = Promise.resolve()
  private starting: { promise: Promise<WorkerProcess>; abort: AbortController } | undefined
  private stopping: Promise<void> | undefined
  private preparing: { abort: AbortController; settled: Promise<void> } | undefined
  private disposing: Promise<void> | undefined
  private idleTimer: ReturnType<typeof setTimeout> | undefined
  private pending = 0
  private lastLaunch: LaunchDiagnostics | undefined

  constructor(private readonly ctx: Context, private readonly config: Config, dependencies: WorkerDependencies = {}) {
    this.fetch = dependencies.fetch ?? globalThis.fetch
    this.timeoutSignal = dependencies.timeoutSignal ?? (milliseconds => AbortSignal.timeout(milliseconds))
  }

  snapshot(): SpeechPreparationState { return this.state }

  /** Actual launch arguments and relevant environment names; never environment values. */
  diagnostics(): typeof this.lastLaunch { return this.lastLaunch }

  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }

  private publish(state: SpeechPreparationState): void {
    this.state = state
    for (const listener of this.listeners) listener()
  }

  prepare(options: SpeechPreparationOptions = {}): void {
    this.lifetime.signal.throwIfAborted()
    if (options.downloadSource !== undefined) throw new Error('llama.cpp has no downloadable preparation source')
    if (this.preparing || (this.worker && !this.worker.closed)) return
    const task = { abort: new AbortController(), settled: Promise.resolve() }
    task.settled = this.enqueue(async signal => { await this.start(signal) }, task.abort.signal).catch(error => {
      if (!task.abort.signal.aborted && !this.lifetime.signal.aborted) this.publish({ phase: 'failed', message: error instanceof Error ? error.message : String(error) })
    }).finally(() => { if (this.preparing === task) this.preparing = undefined })
    this.preparing = task
  }

  async cancel(): Promise<void> {
    const task = this.preparing
    if (!task) return
    task.abort.abort(new Error('llama.cpp preparation cancelled'))
    await task.settled
    if (!this.pending && this.starting) await this.starting.promise.catch(() => {})
  }

  transcribe(input: SpeechInput, signal: AbortSignal): Promise<Transcript> {
    return this.enqueue(async combined => {
      const audioSeconds = wavDurationSeconds(input.audio)
      return await this.execute(input, audioSeconds, combined)
    }, signal)
  }

  private enqueue<T>(run: (signal: AbortSignal) => Promise<T>, signal: AbortSignal): Promise<T> {
    this.lifetime.signal.throwIfAborted()
    signal.throwIfAborted()
    this.clearIdle()
    const combined = AbortSignal.any([signal, this.lifetime.signal])
    this.pending++
    let running = false
    const job = this.tail.then(async () => { combined.throwIfAborted(); running = true; return await run(combined) }).finally(() => {
      this.pending--
      if (!this.pending && this.starting) this.starting.abort.abort(new Error('llama.cpp startup has no waiting requests'))
      this.armIdle()
    })
    this.tail = job.then(() => {}, () => {})
    return new Promise<T>((resolve, reject) => {
      const abort = (): void => { if (!running) reject(combined.reason) }
      combined.addEventListener('abort', abort, { once: true })
      void job.then(resolve, reject).finally(() => combined.removeEventListener('abort', abort))
      if (combined.aborted) abort()
    })
  }

  private clearIdle(): void { if (this.idleTimer) clearTimeout(this.idleTimer); this.idleTimer = undefined }

  private armIdle(): void {
    this.clearIdle()
    const worker = this.worker
    if (!this.config.sleepIdleSeconds || this.pending || this.starting || !worker || worker.closed || this.lifetime.signal.aborted) return
    const timer = setTimeout(() => {
      if (this.idleTimer !== timer) return
      this.idleTimer = undefined
      if (this.pending || this.starting || this.worker !== worker || worker.closed) return
      void this.stop(worker).catch(error => { this.publish({ phase: 'failed', message: String(error) }) })
    }, this.config.sleepIdleSeconds * 2000)
    timer.unref()
    this.idleTimer = timer
  }

  private async start(signal: AbortSignal): Promise<WorkerProcess> {
    signal.throwIfAborted()
    if (this.stopping) await waitFor(this.stopping, signal)
    if (this.starting) {
      const previous = this.starting
      if (!previous.abort.signal.aborted) return await waitFor(previous.promise, signal)
      await waitFor(previous.promise.then(() => {}, () => {}), signal)
      return await this.start(signal)
    }
    if (this.worker && !this.worker.closed) return this.worker
    for (const retired of this.processes) await waitFor(this.close(retired), signal)
    const abort = new AbortController()
    const task = { abort, promise: this.launch(AbortSignal.any([abort.signal, this.lifetime.signal])) }
    this.starting = task
    const settled = (): void => { if (this.starting === task) this.starting = undefined; this.armIdle() }
    void task.promise.then(settled, error => {
      if (!this.lifetime.signal.aborted) {
        if (abort.signal.aborted) this.publish({ phase: 'standby' })
        else this.publish({ phase: 'failed', message: error instanceof Error ? error.message : String(error) })
      }
      settled()
    })
    return await waitFor(task.promise, signal)
  }

  private async launch(signal: AbortSignal): Promise<WorkerProcess> {
    this.publish({ phase: 'loading', startedAt: Date.now() })
    const deadline = AbortSignal.any([signal, this.timeoutSignal(this.config.startupTimeoutMs)])
    const paths = await waitFor(resolvePaths(this.config, this.ctx.subprocess), deadline)
    const port = this.config.port || await waitFor(reservePort(this.config.host), deadline)
    deadline.throwIfAborted()
    const argv = buildServerArguments(this.config, paths, port)
    const parent = process.env
    const pathKey = Object.keys(parent).find(key => key.toUpperCase() === 'PATH') ?? 'PATH'
    const env = { [pathKey]: [paths.runtimeDirectory, join(paths.runtimeDirectory, 'bin'), join(paths.runtimeDirectory, 'lib'), parent[pathKey] ?? ''].join(delimiter) }
    const diagnostics: LaunchDiagnostics = { argv, environmentOverrides: Object.keys(parent).filter(key => key.startsWith('LLAMA_ARG_') || key.startsWith('MTMD_')).sort(), upstreamConfiguration: 'llama.cpp user/system config.ini and inherited environment may override upstream defaults' }
    this.lastLaunch = diagnostics
    const handle = this.ctx.subprocess.spawn({ argv, cwd: paths.runtimeDirectory, env, graceMs: this.config.graceMs, stdio: { stdin: 'ignore', stdout: { maxBytes: this.config.maxLogBytes }, stderr: { maxBytes: this.config.maxLogBytes } } })
    const worker: WorkerProcess = { handle, url: `http://${this.config.host === '::1' ? '[::1]' : this.config.host}:${port}`, exited: new AbortController(), closed: false }
    this.processes.add(worker)
    const onExit = (outcome?: SubprocessOutcome, failure?: unknown): void => {
      const unexpected = !worker.closed
      if (outcome) worker.outcome = outcome
      else worker.failure = { reason: failure }
      const stderr = handle.collected.stderr?.readFrom(0)
      diagnostics.exit = { exitCode: outcome?.exitCode ?? null, signal: outcome?.signal ?? null, stderr: stderr?.text ?? '', stderrLossy: stderr?.lossy ?? false, ...(failure === undefined ? {} : { failure: String(failure) }) }
      worker.closed = true
      worker.exited.abort(new Error(`llama.cpp server process exited (code ${outcome?.exitCode ?? 'unknown'}, signal ${outcome?.signal ?? 'none'})`))
      if (this.worker === worker) { this.worker = undefined; this.clearIdle(); this.publish({ phase: 'standby' }) }
      if (unexpected) void this.stop(worker).catch(error => { this.publish({ phase: 'failed', message: String(error) }) })
    }
    void handle.done.then(outcome => onExit(outcome), error => onExit(undefined, error))
    const readySignal = AbortSignal.any([deadline, worker.exited.signal])
    try {
      for (;;) {
        readySignal.throwIfAborted()
        let response: Response | undefined
        try { response = await this.fetch(`${worker.url}/health`, { signal: readySignal }) } catch { readySignal.throwIfAborted() }
        if (response) {
          await response.text()
          if (response.status === 200) {
            readySignal.throwIfAborted()
            this.worker = worker
            this.publish({ phase: 'ready' })
            return worker
          }
          if (response.status !== 503) throw new Error(`llama.cpp startup health returned HTTP ${response.status}`)
        }
        await delay(25, readySignal)
      }
    } catch (error) {
      await this.close(worker)
      if (!this.lifetime.signal.aborted) this.publish({ phase: 'standby' })
      throw error
    }
  }

  private async interrupted(worker: WorkerProcess, signal: AbortSignal): Promise<boolean> {
    const probe = AbortSignal.any([signal, this.timeoutSignal(this.config.graceMs)])
    if (!worker.outcome && !worker.failure) {
      const empty = await worker.handle.waitForExit(probe)
      signal.throwIfAborted()
      if (empty) await waitFor(worker.handle.done, signal)
    }
    signal.throwIfAborted()
    if (worker.failure) {
      await waitFor(this.close(worker), signal)
      throw worker.failure.reason
    }
    if (!worker.outcome) return false
    // A resolved command outcome proves exit; cleanup must also finish before retry.
    await waitFor(this.close(worker), signal)
    return true
  }

  private async execute(input: SpeechInput, audioSeconds: number, signal: AbortSignal): Promise<Transcript> {
    let worker = await this.start(signal)
    const deadline = AbortSignal.any([signal, this.timeoutSignal(this.config.requestTimeoutMs)])
    const started = performance.now()
    for (let attempt = 0; attempt < 2; attempt++) {
      deadline.throwIfAborted()
      if (attempt) worker = await this.start(deadline)
      const form = new FormData()
      form.append('model', this.config.modelAlias)
      form.append('response_format', 'json')
      form.append('temperature', '0')
      form.append('stream', 'false')
      if (input.language !== 'auto') form.append('language', input.language)
      form.append('file', new Blob([new Uint8Array(input.audio)], { type: 'audio/wav' }), 'recording.wav')
      let response: Response
      let body: string
      try {
        response = await this.fetch(`${worker.url}/v1/audio/transcriptions`, { method: 'POST', body: form, signal: AbortSignal.any([deadline, worker.exited.signal]) })
        body = await response.text()
      } catch (error) {
        deadline.throwIfAborted()
        if (await this.interrupted(worker, deadline) && attempt === 0) continue
        throw error
      }
      if (!response.ok) throw new Error(`llama.cpp transcription returned HTTP ${response.status}: ${body}`)
      const rawText = parseTranscript(body)
      if (this.lastLaunch) this.lastLaunch.rawText = rawText
      const text = stripAsrText(rawText)
      deadline.throwIfAborted()
      return { text, audioSeconds, inferenceSeconds: (performance.now() - started) / 1000 }
    }
    throw new Error('llama.cpp server was interrupted twice')
  }

  private close(worker: WorkerProcess): Promise<void> {
    if (worker.closing) return worker.closing
    worker.closed = true
    if (this.worker === worker) this.worker = undefined
    worker.closing = (async () => {
      worker.handle.terminate()
      if (!await worker.handle.waitForExit()) throw new Error('llama.cpp process exit could not be confirmed')
      this.processes.delete(worker)
    })()
    return worker.closing
  }

  private async stop(worker = this.worker): Promise<void> {
    if (this.stopping) return await this.stopping
    if (!worker) return
    this.clearIdle()
    if (this.worker === worker) this.worker = undefined
    const closing = this.close(worker)
    this.stopping = closing
    try { await closing; if (!this.lifetime.signal.aborted) this.publish({ phase: 'standby' }) } finally { if (this.stopping === closing) this.stopping = undefined }
  }

  /** Reject new work, drain accepted work, and join every owned process before returning. */
  dispose(): Promise<void> {
    if (this.disposing) return this.disposing
    this.lifetime.abort(new Error('llama.cpp provider disposed'))
    this.clearIdle()
    this.disposing = (async () => {
      await Promise.allSettled([this.tail, this.starting?.promise, this.preparing?.settled])
      if (this.stopping) await this.stopping
      for (const worker of this.processes) await this.stop(worker)
      this.listeners.clear()
    })()
    return this.disposing
  }
}
