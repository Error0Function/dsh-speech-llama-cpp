---
description: "通过按需启动的 llama.cpp 服务进行本地语音转写，并在闲置时释放模型。"
kind: "package-bundle"
---

# dsh-speech-llama-cpp

[English](README.md) | 中文

## 概述

通过 llama.cpp 在本地转写录音，并把文本交给 DSH 现有的语音输入草稿流程。首次准备或录音启动服务；闲置休眠释放模型，更长时间闲置后退出进程。运行时和配套模型需要单独提供。随包的 profile patch 默认禁用。

## 目录

- [使用本包](#use-this-package)
- [配置](#configuration)
- [实现说明](#understand-the-implementation)
- [开发检查](#development)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

本包通过现有语音服务提供一个 Host 端的 `llama-cpp` provider，复用官方录音和草稿插入功能。目标 DSH 组合需要官方语音输入前端、`speechToText` 和 `subprocess` 服务。使用 Node 24.9 或更新版本及 DSH 0.2.2-rc.1；后续 DSH 版本的兼容性需要验证。

使用 Node 24 和 pnpm 11.28.5，从本仓库构建安装包：

```sh
git clone https://github.com/Error0Function/dsh-speech-llama-cpp.git
cd dsh-speech-llama-cpp
pnpm install --frozen-lockfile --ignore-scripts
pnpm run check
pnpm run verify:package
dsh plugin --profile web add .artifacts/dsh-speech-llama-cpp-0.1.0-dev.0.tgz --ignore-scripts
```

其中 `web` 仅为示例，请选服务于你的 DSH 客户端的 profile。有带版本标签的 release 安装包后，可使用相同的 `dsh plugin ... add` 命令安装。安装包不包含服务程序或模型。

在该 profile 的 `cordis.patch.yml` 中启用默认禁用的条目：

```yaml
- id: dsh-speech-llama-cpp
  disabled: false
```

在此条目的 `config` 中指定资源绝对路径，或按下面的默认布局放置资源。重新加载 profile 后，在 DSH 共享配置中将语音转写的默认 provider 设为 `llama-cpp`，再通过官方语音输入页面准备本地服务并录音。当前准备操作只加载已有资源；自动下载尚待实现。

提供包含配套动态库的完整 llama.cpp 发行目录，以及兼容的 decoder GGUF 和该架构需要的 projector。适配器使用 Node 和外部服务，不依赖 Python、PyTorch、FFmpeg 或 CUDA 编译工具链。GPU 发行版仍需要相应系统驱动和运行库。

默认禁用的 [bundle patch](cordis.patch.yml) 通过 `dshHomePath('speech-to-text', 'llama-cpp')` 提供 `rootDirectory`。默认布局为：

```text
<rootDirectory>/
  runtime/<build-os-arch-backend>/llama-server[.exe]
  runtime/<build-os-arch-backend>/<matching libraries>
  models/<model-id>/<revision-or-quant>/<decoder>.gguf
  models/<model-id>/<revision-or-quant>/mmproj-<decoder>.gguf
```

运行时可以把可执行文件放在 `bin` 中。显式路径优先；否则发现过程要求唯一运行时组和唯一模型组，运行时最后可以从 PATH 解析。文件缺失或候选不明确会报出选择错误。发现过程不会下载文件、扫描整个磁盘或选择最新版本。

<a id="configuration"></a>
## 配置

配置 schema 校验回环地址、绝对路径、计时范围和语言提示。空路径字段表示未指定。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `providerId` | `llama-cpp` | 语音 provider 标识 |
| `rootDirectory` | 上述 Loader 表达式 | 约定发现目录的根路径 |
| `runtimeDirectory`, `executablePath` | 未指定 | 显式发行目录或可执行文件 |
| `modelDirectory`, `modelPath`, `mmprojPath` | 未指定 | 模型组或单个文件覆盖 |
| `modelAlias` | `llama-asr` | 本地 HTTP 模型别名 |
| `contextSize` | `4096` | 音频、提示和生成转写共用的 decoder 上下文 |
| `languages` | `[auto]` | 对外声明的提示；实际支持取决于模型 |
| `host`, `port` | `127.0.0.1`, `0` | 回环地址；零表示选择可用端口 |
| `startupTimeoutMs` | `180000` | 发现、启动和首次就绪的期限 |
| `requestTimeoutMs` | `120000` | 响应期限，包含唤醒及进程中断后的重试 |
| `sleepIdleSeconds` | `30` | 原生休眠；队列持续闲置两倍时间后退出进程 |
| `graceMs` | `1000` | 托管终止宽限及进程退出观察时间 |
| `maxLogBytes` | `65536` | 仅限制保留的子进程诊断 |

适配器按 `contextSize` 传入 `--ctx-size`，默认 4096。音频嵌入、提示和生成转写共用这份预算；模型或录音需要更多空间时可调大。设备、GPU 层数、线程、projector 放置和输出 token 参数仍省略，HTTP 也不传 `max_tokens`，由 llama.cpp 的默认策略与上游配置控制。

请求串行执行，不再增加队列、录音大小、时长或响应大小上限；官方输入服务保留自己的限制。将 `sleepIdleSeconds` 设为零会同时禁用原生休眠及适配器推导出的闲置退出。

<a id="understand-the-implementation"></a>
## 实现说明

<details>
<summary>服务所有权与故障处理</summary>

Host 入口通过 effect 注册，worker 仅在需要时启动 Host 托管子进程，等待首次 HTTP 就绪，再向 `/v1/audio/transcriptions` 发送 multipart WAV 请求。最终文本返回给调用方；provider 不发送 Agent 消息。

原生休眠保留 HTTP，但销毁模型、上下文和 KV。后续请求在响应期限内重新加载它们。最后一个已接收操作完成，且队列持续为空达到两倍休眠时间后，适配器终止进程并等待托管清理完成。新任务会撤销闲置回收。health 单独不能说明模型是否驻留。

调用方取消只放弃该调用方的等待，不会终止其他已接收任务仍需要的共享启动。传输失败仅在确认进程退出且清理完成后允许重试一次；HTTP 和 JSON 错误直接返回。卸载先停止接收任务，取消并等待已接收任务，再等待所有自有进程结束。启动诊断保留实际参数和相关环境变量名，不记录变量值，也不修改全局环境。

</details>

<a id="development"></a>
## 开发检查

依赖由本项目声明并通过 lockfile 固定。可移植检查不需要 DSH 源码 checkout、全局 SDK 链接或本机模型：

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm run check
pnpm run verify:package
```

检查使用本项目的 esbuild 构建，针对公开发布的 DSH SDK 做类型检查，并用 fixture 验证配置、发现、协议、注册和 worker 生命周期。包验证会打包、核对文件清单、解压，再以原生 Node 导入包内入口。

GitHub Actions 在 Windows、Linux、macOS 的 x64 和 arm64 上运行这些检查。矩阵验证构建和包的可移植性，不运行真实 ASR 模型或 GPU。与包版本匹配的 `v<package-version>` 标签会在矩阵通过后将安装包发布到 GitHub；此工作流不发布 npm。

<a id="model-experience"></a>
## 模型体验

间接影响：provider 向既有语音输入流程提供转写文本，不增加工具或提示词，也不提交 Agent 消息。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

服务必须支持所选模型架构及音频转写端点。自动 projector 选择要求唯一匹配的 `mmproj-`/`projector-` 文件名主干和兼容元数据。显式 projector 路径用于解决文件名歧义；张量层面的兼容性仍由服务检查。未支持的架构由服务报错。

休眠不等于 GPU→RAM 权重迁移，也不保证 RAM 缓存。包中不包含运行时二进制或模型权重。真实模型集成已在 Windows x64、NVIDIA CUDA、llama.cpp b12110 和 Qwen3-ASR-1.7B Q8 上验证。默认上下文为 4096 token，30 秒原生休眠，队列持续闲置 60 秒后退出进程。其他操作系统、设备及模型架构仍需真实模型验证。

计划中的一键准备会复用官方准备页面与下载实现的通用部分。平台运行时归档、后端组件及模型安装尚未实现。设备选择继续交给 llama.cpp，不计划维护适配器自己的后端优先级或测速选择。

<a id="dev-note"></a>
## 开发备注

无。
