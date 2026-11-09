---
description: "Local voice transcription with an on-demand llama.cpp server and idle model release."
kind: "package-bundle"
---

# dsh-speech-llama-cpp

English | [中文](README.zh.md)

## Summary

Transcribe recordings locally through llama.cpp and return the text to DSH's existing voice-input draft flow. The first preparation or recording starts the server; idle sleep releases its model, and longer inactivity closes the process. Supply a compatible runtime and model group separately. The bundled profile patch starts disabled.

## Table of Contents

- [Use this package](#use-this-package)
- [Configuration](#configuration)
- [Understand the implementation](#understand-the-implementation)
- [Development](#development)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The package supplies one Host provider, `llama-cpp`, through the existing speech service. It reuses the official recorder and draft insertion. The target DSH composition must provide the official voice-input frontend, `speechToText`, and `subprocess` services. Use Node 24.9 or newer and DSH 0.2.2-rc.1; compatibility with later DSH releases needs verification.

Build an installable archive from this repository with Node 24 and pnpm 11.28.5:

```sh
git clone https://github.com/Error0Function/dsh-speech-llama-cpp.git
cd dsh-speech-llama-cpp
pnpm install --frozen-lockfile --ignore-scripts
pnpm run check
pnpm run verify:package
dsh plugin --profile web add .artifacts/dsh-speech-llama-cpp-0.1.0-dev.0.tgz --ignore-scripts
```

Here `web` is an example; choose the profile serving your DSH client. Install a tagged release archive with the same `dsh plugin ... add` command when one is available. The archive does not contain the server or model.

Enable the package's initially disabled entry in that profile's `cordis.patch.yml`:

```yaml
- id: dsh-speech-llama-cpp
  disabled: false
```

Configure any explicit asset paths under this entry's `config`, or populate the default layout below. Reload the profile, select `llama-cpp` as the speech-to-text default provider in DSH shared configuration, and use the official voice-input page to prepare the local server and record. Preparation currently loads existing assets; automatic downloads are planned.

Provide a complete llama.cpp release with its matching libraries and a compatible decoder GGUF plus any required projector. The adapter uses Node and the external server; it has no Python, PyTorch, FFmpeg, or CUDA compilation-toolkit dependency. A GPU release still requires its system driver and runtime libraries.

The disabled [bundle patch](cordis.patch.yml) supplies `rootDirectory` through `dshHomePath('speech-to-text', 'llama-cpp')`. The default layout is:

```text
<rootDirectory>/
  runtime/<build-os-arch-backend>/llama-server[.exe]
  runtime/<build-os-arch-backend>/<matching libraries>
  models/<model-id>/<revision-or-quant>/<decoder>.gguf
  models/<model-id>/<revision-or-quant>/mmproj-<decoder>.gguf
```

A runtime may place the executable in `bin`. Explicit paths take priority. Otherwise discovery accepts one runtime group and one model group; the runtime can finally resolve from PATH. Missing or ambiguous files produce a selection error. Discovery never downloads files, scans an entire disk, or picks the newest build.

<a id="configuration"></a>
## Configuration

The configuration schema validates loopback addresses, absolute paths, timer ranges, and language hints. Empty path fields mean unset.

| Field | Default | Meaning |
|---|---|---|
| `providerId` | `llama-cpp` | Speech-provider identity |
| `rootDirectory` | Loader expression above | Root for documented discovery groups |
| `runtimeDirectory`, `executablePath` | unset | Explicit release directory or executable |
| `modelDirectory`, `modelPath`, `mmprojPath` | unset | Model group or individual file overrides |
| `modelAlias` | `llama-asr` | Local HTTP model alias |
| `contextSize` | `4096` | Shared decoder context for audio, prompt, and generated transcript |
| `languages` | `[auto]` | Advertised hints; actual support belongs to the model |
| `host`, `port` | `127.0.0.1`, `0` | Loopback address; zero selects an available port |
| `startupTimeoutMs` | `180000` | Discovery, launch, and initial readiness deadline |
| `requestTimeoutMs` | `120000` | Response deadline, including wake and any interrupted-request retry |
| `sleepIdleSeconds` | `30` | Native sleep; process exit after twice this period of queue inactivity |
| `graceMs` | `1000` | Managed termination grace and exit-observation interval |
| `maxLogBytes` | `65536` | Retained subprocess diagnostics only |

The adapter passes `--ctx-size` from `contextSize`, defaulting to 4096. Audio embeddings, the prompt, and the generated transcript share this budget; increase it for a model or recording that needs more. Device, GPU layers, threads, projector placement, and output-token arguments remain omitted, as does HTTP `max_tokens`. llama.cpp controls those choices through its defaults and upstream configuration.

Requests run serially without another queue, recording-size, duration, or response-size cap. The official input service retains its own limits. Setting `sleepIdleSeconds` to zero disables both native sleep and the adapter's derived idle exit.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Server ownership and failure handling</summary>

The Host entry registers through an effect. Its worker starts a Host-managed subprocess only when needed, waits for initial HTTP readiness, and sends multipart WAV requests to `/v1/audio/transcriptions`. Final text returns to the caller; the provider sends no Agent message.

Native sleep preserves HTTP while destroying the model/context/KV. A later request reloads them under the response deadline. After the last accepted operation completes and the queue stays empty for twice the sleep period, the adapter terminates the process and waits for managed cleanup. New work cancels idle reclamation. Health alone does not indicate model residency.

Caller cancellation abandons that caller's wait without killing startup needed by other accepted work. A transport failure permits one retry only after process exit and cleanup are confirmed. HTTP and JSON errors are returned directly. Disposal closes admission, cancels and drains accepted work, and joins owned processes. Launch diagnostics retain actual arguments and relevant environment-variable names, without recording their values or changing the global environment.

</details>

<a id="development"></a>
## Development

Dependencies are declared here and pinned in the lockfile. No DSH source checkout, global SDK links, or local model installation is needed for the portable checks:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm run check
pnpm run verify:package
```

The checks build with the project's esbuild, typecheck against the published DSH SDK, and exercise configuration, discovery, protocol, registration, and worker lifetime using fixtures. Package verification packs the archive, checks its file list, extracts it, and imports the installed entry with native Node.

GitHub Actions runs these checks on Windows, Linux, and macOS, each on x64 and arm64. The matrix covers build and package portability; it does not run a real ASR model or GPU. A matching `v<package-version>` tag releases the archive to GitHub after the matrix passes. This workflow does not publish to npm.

<a id="model-experience"></a>
## Model Experience

Indirect: the provider supplies transcript text to the existing voice-input flow. It adds no tool or prompt and does not submit an Agent message.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

The server must support the selected model architecture and audio-transcription endpoint. Automatic projector selection requires one matching `mmproj-`/`projector-` filename stem and compatible metadata. Explicit projector paths resolve filename ambiguity; the server still checks tensor-level compatibility. Unsupported architectures remain server errors.

Sleep is not GPU-to-RAM weight migration or a guaranteed RAM cache. The package contains neither runtime binaries nor model weights. Real-model integration has been verified on Windows x64 with NVIDIA CUDA, llama.cpp b12110, and Qwen3-ASR-1.7B Q8. The defaults are 4096 context tokens, 30 seconds before native sleep, and 60 seconds of queue inactivity before process exit. Other operating systems, devices, and model architectures still need real-model validation.

One-click preparation is planned to reuse the official preparation UI and the reusable parts of its download implementation. Platform-specific runtime archives, backend components, and model installation are not implemented yet. llama.cpp remains responsible for device selection; no adapter-specific backend ranking or benchmark selection is planned.

<a id="dev-note"></a>
## Dev Note

None.
