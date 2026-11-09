/** Deployment configuration for a managed local llama.cpp ASR server. */
import z from '@deepseek-ai/schemastery'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'

/** Paths, language hints, and process lifetime; inference placement belongs to llama.cpp. */
export interface Config {
  providerId: string
  /** Loader supplies dshHomePath('speech-to-text', 'llama-cpp') in the bundled patch. */
  rootDirectory: string
  runtimeDirectory: string
  executablePath: string
  modelDirectory: string
  modelPath: string
  mmprojPath: string
  modelAlias: string
  /** Shared decoder budget for audio embeddings, prompt, and generated transcript. */
  contextSize: number
  /** Advertised hints, not a claim that every model supports these languages. */
  languages: string[]
  host: '127.0.0.1' | '::1'
  /** Zero reserves an ephemeral loopback port before spawning. */
  port: number
  startupTimeoutMs: number
  /** Includes a sleeping server's model reload and the complete transcription response. */
  requestTimeoutMs: number
  /** Zero disables both native sleep and the derived two-times-idle process exit. */
  sleepIdleSeconds: number
  graceMs: number
  /** Diagnostic retention only; not an audio, transcript, or pending-work limit. */
  maxLogBytes: number
}

const absoluteOrUnset = (): z<string> => z.string().pattern(/^(?:$|[A-Za-z]:[\\/]|\\\\|\/)/).default('')

/** Validate local paths, decoder context, and lifetime without fixing GPU placement or output tokens. */
export const Config: z<Partial<Config>, Config> = z.object({
  providerId: z.string().pattern(/^\S+$/).default('llama-cpp'),
  rootDirectory: absoluteOrUnset(),
  runtimeDirectory: absoluteOrUnset(),
  executablePath: absoluteOrUnset(),
  modelDirectory: absoluteOrUnset(),
  modelPath: absoluteOrUnset(),
  mmprojPath: absoluteOrUnset(),
  modelAlias: z.string().min(1).default('llama-asr'),
  contextSize: z.natural().min(1).default(4096),
  languages: z.array(z.string().pattern(/^\S+$/)).min(1).default(['auto']),
  host: z.union(['127.0.0.1', '::1']).default('127.0.0.1'),
  port: z.natural().max(65535).default(0),
  startupTimeoutMs: z.natural().min(1).max(MAX_TIMER_DELAY_MS).default(180_000),
  requestTimeoutMs: z.natural().min(1).max(MAX_TIMER_DELAY_MS).default(120_000),
  sleepIdleSeconds: z.natural().max(Math.floor(MAX_TIMER_DELAY_MS / 2000)).default(30),
  graceMs: z.natural().min(1).max(MAX_TIMER_DELAY_MS).default(1000),
  maxLogBytes: z.natural().min(1).default(64 * 1024),
})
