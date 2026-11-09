import { open, readdir, stat } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-subprocess'
import type { Config } from './config.ts'

/** Complete external files selected for one local llama.cpp server. */
export interface ResolvedPaths {
  executablePath: string
  runtimeDirectory: string
  modelPath: string
  mmprojPath?: string
}

const pathKeys = ['rootDirectory', 'runtimeDirectory', 'executablePath', 'modelDirectory', 'modelPath', 'mmprojPath'] as const
const executableName = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server'

/**
 * Validate path configuration without filesystem access or PATH resolution.
 * @param config - Validated plugin configuration; empty paths are unset.
 * @returns Nothing; throws when a supplied path is relative or no model discovery base exists.
 */
export function validatePaths(config: Config): void {
  for (const key of pathKeys) {
    const value = config[key]
    if (value && !isAbsolute(value)) throw new Error(`llama.cpp ${key} must be an absolute path: ${value}`)
  }
  if (!config.modelPath && !config.modelDirectory && !config.rootDirectory) {
    throw new Error('llama.cpp needs rootDirectory, modelDirectory, or an explicit modelPath; models cannot be discovered from PATH.')
  }
}

function runtimeRoot(executablePath: string): string {
  const directory = dirname(executablePath)
  return basename(directory).toLowerCase() === 'bin' ? dirname(directory) : directory
}

function missing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

async function requirePath(path: string, kind: 'file' | 'directory', label: string): Promise<void> {
  let info
  try { info = await stat(path) } catch (error) {
    if (!missing(error)) throw error
    throw new Error(`llama.cpp ${label} does not exist: ${path}`, { cause: error })
  }
  if (kind === 'file' ? !info.isFile() : !info.isDirectory()) {
    throw new Error(`llama.cpp ${label} must be a regular ${kind}: ${path}`)
  }
}

async function directories(path: string, optional = false): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true })
    return entries.filter(entry => entry.isDirectory()).map(entry => join(path, entry.name)).sort()
  } catch (error) {
    if (optional && missing(error)) return []
    throw error
  }
}

async function executableIn(directory: string): Promise<string | undefined> {
  const found: string[] = []
  for (const candidate of [join(directory, executableName), join(directory, 'bin', executableName)]) {
    try {
      if ((await stat(candidate)).isFile()) found.push(candidate)
    } catch (error) { if (!missing(error)) throw error }
  }
  if (found.length > 1) throw new Error(`Multiple llama.cpp executables in ${directory}; set executablePath explicitly: ${found.join(', ')}`)
  return found[0]
}

async function runtimePaths(config: Config, subprocess: Context['subprocess']): Promise<Pick<ResolvedPaths, 'executablePath' | 'runtimeDirectory'>> {
  if (config.runtimeDirectory) await requirePath(config.runtimeDirectory, 'directory', 'runtimeDirectory')
  if (config.executablePath) {
    await requirePath(config.executablePath, 'file', 'executablePath')
    return { executablePath: config.executablePath, runtimeDirectory: config.runtimeDirectory || runtimeRoot(config.executablePath) }
  }
  if (config.runtimeDirectory) {
    const executablePath = await executableIn(config.runtimeDirectory)
    if (!executablePath) throw new Error(`No ${executableName} in runtimeDirectory or its bin directory: ${config.runtimeDirectory}; set executablePath or select a complete runtime.`)
    return { executablePath, runtimeDirectory: config.runtimeDirectory }
  }
  if (config.rootDirectory) {
    const runtimeRoot = join(config.rootDirectory, 'runtime')
    const groups = await directories(runtimeRoot, true)
    const candidates: Array<{ executablePath: string; runtimeDirectory: string }> = []
    for (const runtimeDirectory of groups) {
      const executablePath = await executableIn(runtimeDirectory)
      if (executablePath) candidates.push({ executablePath, runtimeDirectory })
    }
    if (candidates.length > 1) throw new Error(`Multiple llama.cpp runtime groups; set runtimeDirectory or executablePath explicitly: ${candidates.map(candidate => candidate.runtimeDirectory).join(', ')}`)
    if (candidates[0]) return candidates[0]
  }
  let executablePath: string
  try { executablePath = await subprocess.resolveExecutable(executableName) } catch (error) {
    throw new Error(`No llama.cpp runtime found. Set runtimeDirectory or executablePath, place one release under rootDirectory/runtime/<build>, or add ${executableName} to PATH.`, { cause: error })
  }
  if (!isAbsolute(executablePath)) throw new Error(`PATH resolved ${executableName} to a non-absolute path: ${executablePath}`)
  await requirePath(executablePath, 'file', 'PATH executable')
  return { executablePath, runtimeDirectory: runtimeRoot(executablePath) }
}

/**
 * Read only GGUF metadata, never tensors. Positional reads skip numeric arrays (including large tokenizer
 * tables); the byte budget bounds string-array traversal. Architecture comes from the file, not its name.
 */
async function architecture(path: string): Promise<string | undefined> {
  const file = await open(path, 'r')
  let position = 0
  let budget = 1024 * 1024
  const read = async (size: number): Promise<Buffer> => {
    if (size > budget) throw new Error(`GGUF metadata inspection exceeds 1 MiB: ${path}; use a GGUF with accessible general.architecture metadata.`)
    budget -= size
    const buffer = Buffer.alloc(size)
    const { bytesRead } = await file.read(buffer, 0, size, position)
    if (bytesRead !== size) throw new Error(`Truncated GGUF metadata: ${path}`)
    position += size
    return buffer
  }
  const u32 = async () => (await read(4)).readUInt32LE()
  const u64 = async () => {
    const value = (await read(8)).readBigUInt64LE()
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`Invalid GGUF metadata length: ${path}`)
    return Number(value)
  }
  const string = async () => (await read(await u64())).toString('utf8')
  const sizes: Record<number, number> = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 }
  const skip = async (type: number): Promise<void> => {
    if (type === 8) { const length = await u64(); position += length; return }
    if (type === 9) {
      const element = await u32()
      const count = await u64()
      if (sizes[element]) { position += count * sizes[element]; return }
      if (element !== 8) throw new Error(`Unsupported GGUF metadata array type ${element}: ${path}`)
      for (let index = 0; index < count; index++) { const length = await u64(); position += length }
      return
    }
    if (!sizes[type]) throw new Error(`Unsupported GGUF metadata type ${type}: ${path}`)
    position += sizes[type]
  }
  try {
    const header = await read(24)
    if (header.toString('ascii', 0, 4) !== 'GGUF' || ![2, 3].includes(header.readUInt32LE(4))) {
      throw new Error(`Expected a GGUF v2/v3 model header: ${path}`)
    }
    const count = header.readBigUInt64LE(16)
    for (let index = 0n; index < count; index++) {
      const key = await string()
      const type = await u32()
      if (key === 'general.architecture') {
        if (type !== 8) throw new Error(`GGUF general.architecture must be a string: ${path}`)
        return await string()
      }
      await skip(type)
    }
    return undefined
  } finally { await file.close() }
}

interface ModelFile { path: string; architecture?: string; projector: boolean }

async function ggufFiles(directory: string): Promise<ModelFile[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files: ModelFile[] = []
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile() || extname(entry.name).toLowerCase() !== '.gguf') continue
    const path = join(directory, entry.name)
    const arch = await architecture(path)
    files.push({ path, architecture: arch, projector: arch === 'clip' || /^(?:mmproj|projector)(?:[._-]|$)/i.test(basename(entry.name, extname(entry.name))) })
  }
  return files
}

function projectorMatches(decoder: string, projector: string): boolean {
  const stem = (path: string) => basename(path, extname(path)).toLowerCase()
  const suffix = stem(projector).replace(/^(?:mmproj|projector)[._-]?/, '')
  return suffix === stem(decoder)
}

async function modelPaths(config: Config): Promise<Pick<ResolvedPaths, 'modelPath' | 'mmprojPath'>> {
  if (!config.modelPath && config.modelDirectory) await requirePath(config.modelDirectory, 'directory', 'modelDirectory')
  if (config.mmprojPath) await requirePath(config.mmprojPath, 'file', 'mmprojPath')
  let modelPath = config.modelPath
  let siblings: ModelFile[]
  let modelArchitecture: string | undefined
  if (modelPath) {
    await requirePath(modelPath, 'file', 'modelPath')
    modelArchitecture = await architecture(modelPath)
    siblings = config.mmprojPath ? [] : await ggufFiles(dirname(modelPath))
  } else {
    const groups: ModelFile[][] = []
    if (config.modelDirectory) groups.push(await ggufFiles(config.modelDirectory))
    else {
      const modelsRoot = join(config.rootDirectory, 'models')
      for (const modelDirectory of await directories(modelsRoot, true)) {
        for (const revision of await directories(modelDirectory)) groups.push(await ggufFiles(revision))
      }
    }
    const decoders = groups.flatMap(group => group.filter(file => !file.projector))
    if (!decoders.length) throw new Error('No llama.cpp decoder GGUF found; set modelPath/modelDirectory, or place one model group at rootDirectory/models/<model-id>/<revision-or-quant>.')
    if (decoders.length > 1) throw new Error(`Multiple decoder GGUF candidates; set modelPath or modelDirectory explicitly: ${decoders.map(file => file.path).join(', ')}`)
    modelPath = decoders[0].path
    modelArchitecture = decoders[0].architecture
    siblings = groups.find(group => group.some(file => file.path === modelPath))!
  }
  if (modelArchitecture === 'clip') throw new Error(`modelPath is a projector (general.architecture=clip), not a decoder: ${modelPath}`)
  let mmprojPath = config.mmprojPath || undefined
  if (mmprojPath) {
    if (mmprojPath === modelPath) throw new Error('modelPath and mmprojPath must select different files.')
    const projectorArchitecture = await architecture(mmprojPath)
    if (projectorArchitecture !== 'clip') throw new Error(`mmprojPath must select a llama.cpp projector (general.architecture=clip), found ${projectorArchitecture ?? 'unset'}: ${mmprojPath}`)
  } else {
    const projectors = siblings.filter(file => file.projector)
    const matches = projectors.filter(file => projectorMatches(modelPath, file.path))
    if (matches.length > 1) throw new Error(`Ambiguous projector files for ${modelPath}; set mmprojPath explicitly: ${projectors.map(file => file.path).join(', ')}`)
    if (projectors.length && !matches.length) throw new Error(`Cannot pair projector with ${modelPath}; set mmprojPath explicitly after checking the model's required projector: ${projectors[0].path}`)
    if (matches[0]) {
      if (matches[0].architecture !== 'clip') throw new Error(`Projector candidate has incompatible general.architecture=${matches[0].architecture ?? 'unset'}: ${matches[0].path}; set mmprojPath to the matching projector.`)
      mmprojPath = matches[0].path
    }
  }
  // llama.cpp represents Qwen's separate audio/vision encoder with this decoder architecture.
  // Other architectures remain the server's responsibility, including unsupported architecture errors.
  if (modelArchitecture === 'qwen3vl' && !mmprojPath) throw new Error(`Decoder general.architecture=qwen3vl requires its matching projector; set mmprojPath or place mmproj-<decoder-name>.gguf beside ${modelPath}.`)
  return { modelPath, ...(mmprojPath ? { mmprojPath } : {}) }
}

/**
 * Resolve explicit files, unique documented runtime/model groups, then the Host's executable PATH.
 * @param config - Validated plugin configuration; no files are downloaded.
 * @param subprocess - Host service used only for executable lookup when directory discovery has no runtime.
 * @returns Selected regular files and the release directory used for child-only library lookup.
 */
export async function resolvePaths(config: Config, subprocess: Context['subprocess']): Promise<ResolvedPaths> {
  validatePaths(config)
  if (config.rootDirectory && !config.modelPath && !config.modelDirectory) {
    await requirePath(config.rootDirectory, 'directory', 'rootDirectory')
  }
  const runtime = await runtimePaths(config, subprocess)
  const model = await modelPaths(config)
  return { ...runtime, ...model }
}
