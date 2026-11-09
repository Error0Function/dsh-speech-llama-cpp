# dsh-speech-llama-cpp development instructions

- Build with this repository's locked dependencies; do not require a DSH source checkout or personal paths.
- The provider must register through the documented `speechToText` service and own every llama-server process through the Host `subprocess` service.
- Preserve the official voice-input flow: the provider returns a final transcript and never sends an Agent message.
- Keep paths, language hints, decoder context, deadlines, and idle retention in validated Config; leave hardware/output choices to llama.cpp and do not add audio, response, or queue caps.
- Run `pnpm run check` and `pnpm run verify:package` for build or package changes. Keep fixtures independent of installed models and user profiles.
- Install into a user's profile, run real model requests, or publish only when authorized for that operation.
