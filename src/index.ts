/** Host adapter for llama.cpp's audio-transcription API. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-experimental-speech-to-text'
import type {} from '@deepseek-ai/dsh-subprocess'
import type { SpeechProviderId } from '@deepseek-ai/dsh-experimental-speech-to-text/types'
import { Config } from './config.ts'
import { validatePaths } from './discovery.ts'
import { LlamaWorker } from './worker.ts'

export { Config } from './config.ts'
export { buildServerArguments, stripAsrText, wavDurationSeconds } from './worker.ts'
export { resolvePaths, validatePaths } from './discovery.ts'
export const name = 'dsh-speech-llama-cpp'
export const inject = ['speechToText', 'subprocess']

/** Register a configurable provider; registration itself does not load a model. */
export function apply(ctx: Context, config: Config): void {
  validatePaths(config)
  ctx.effect(() => {
    const worker = new LlamaWorker(ctx, config)
    const unregister = ctx.speechToText.register({
      info: {
        id: config.providerId as SpeechProviderId,
        name: 'llama.cpp (local ASR)',
        location: 'host-local',
        languages: config.languages,
      },
      preparation: worker,
      transcribe: async (input, signal) => await worker.transcribe(input, signal),
    })
    return async () => {
      const removing = unregister()
      const results = await Promise.allSettled([worker.dispose(), removing])
      const failures = results.filter(result => result.status === 'rejected').map(result => result.reason)
      if (failures.length) throw new AggregateError(failures, 'llama.cpp provider cleanup failed')
    }
  })
}
