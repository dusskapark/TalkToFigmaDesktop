# Embedded GGUF vs Ollama Performance Investigation

## Summary

For Mac App Store (MAS) distribution, the Assistant should keep the embedded GGUF runtime as the primary path. The app currently runs a bundled `llama-server` directly against local GGUF files, which avoids depending on an external Ollama daemon in sandboxed store environments.

Observed performance or quality differences between the embedded GGUF path and Ollama are expected even when the apparent model is the same. "Same model" usually means the same GGUF weights, but it does not guarantee the same runtime build, launch flags, prompt template behavior, context settings, cache policy, sampler configuration, or GPU offload behavior.

This document captures the current state, the likely causes of divergence, and the recommended follow-up order. It intentionally does not add dependencies, runtime adapters, UI, or product behavior.

## Current Runtime State

The current embedded path is implemented by `EmbeddedLlamaRuntimeService`. It starts the bundled `llama-server` with a minimal argument set:

```text
--host 127.0.0.1
--port <runtime port>
-m <model gguf path>
-c <configured context length>
--jinja
--mmproj <mmproj gguf path>   # only when the installed model has one
```

The bundled runtime manifest currently points at `ggml-org/llama.cpp` release `b8855`, published on 2026-04-20. On macOS arm64, the packaged runtime includes `libggml-metal`, `libggml-blas`, `libggml-cpu`, and `libllama`, so Metal support is present in the binary set.

The runtime settings exposed by the app currently focus on context length and tool-result context limits. The app does not explicitly configure these `llama-server` performance and generation options:

- GPU layer policy: `--gpu-layers auto/all/<n>`
- prompt and decode batching: `--batch-size`, `--ubatch-size`
- Flash Attention: `--flash-attn`
- CPU scheduling: `--threads`, `--threads-batch`
- memory residency and mapping: `--mlock`, `--mmap`
- server concurrency: `--parallel`
- max output tokens: `--predict`
- sampler values: `--temp`, `--top-k`, `--top-p`, `--min-p`, `--repeat-penalty`, and related options
- prompt cache behavior beyond the `llama-server` default: `--cache-prompt`

Because those options are left to `llama-server` defaults, the embedded path is not guaranteed to match Ollama's defaults or a model-specific Ollama Modelfile.

## Why Ollama Can Differ

Ollama and the embedded runtime may diverge in several places:

- Runtime build: Ollama ships and updates its own llama.cpp-derived runtime. The app bundles a specific upstream `llama.cpp` release.
- Launch options: Ollama may apply model-specific defaults for context, GPU offload, parallelism, batching, keep-alive, and sampler parameters.
- Modelfile parameters: an Ollama tag can include template, system prompt, stop tokens, context, and sampler settings that are not represented by the raw GGUF upload.
- Prompt template handling: the app passes `--jinja` and relies on the GGUF template. Ollama may use its Modelfile template or additional model metadata handling.
- Model lifecycle: Ollama keeps models loaded by default for a period of time, while the embedded app starts and stops `llama-server` based on selected model and context length.
- Cache behavior: `llama-server` supports prompt caching and slot behavior, but app-level configuration is not currently tuned to mirror Ollama.
- Vision path: the embedded path passes `--mmproj` when available. Ollama's vision model packaging may use different projector defaults or image preprocessing behavior.

The most likely first-order causes of perceived performance differences are launch option mismatches, model warmness/keep-alive behavior, prompt template differences, and batching/GPU offload defaults.

## Recommended Follow-Up Order

1. Keep Embedded as the product default.
   - MAS should not require a user-installed Ollama daemon.
   - Continue to treat Ollama as a comparison target, not as the default runtime.

2. Add a reproducible benchmark before tuning.
   - Use the same model artifact where possible.
   - Use the same prompt, attachment set, context length, and tool definitions.
   - Measure startup time, first token latency, prompt eval tok/s, generation tok/s, tool-call success rate, peak memory, and memory pressure.
   - Record whether the model was cold or already loaded.

3. Compare runtime configuration explicitly.
   - Capture the embedded `llama-server` command line from logs.
   - Capture Ollama model configuration with `ollama show <model> --modelfile`.
   - Compare context length, template, stop tokens, sampler values, GPU offload, batching, and keep-alive behavior.

4. Tune embedded `llama-server` before adding another provider.
   - Evaluate explicit `--gpu-layers auto` or `all` on Apple Silicon.
   - Evaluate `--batch-size` and `--ubatch-size` for prompt processing speed.
   - Evaluate `--flash-attn auto/on`, `--threads`, and `--threads-batch`.
   - Consider `--mlock` carefully for MAS and low-memory systems, because it can improve residency but increase pressure.
   - Add settings only after benchmark data shows a stable improvement.

5. Keep `ai-sdk-ollama` as a later option.
   - `ai-sdk-ollama@3.8.3` is compatible with AI SDK v6 and uses the official `ollama` package.
   - It currently declares `node >=22`, while this app declares `node >=20.0.0`.
   - Adding it would also reintroduce an external daemon dependency for non-MAS paths, so it should wait until embedded tuning has been measured.

## Benchmark Checklist

Use this checklist when a machine has both the embedded runtime and Ollama available.

1. Confirm runtime details.

```bash
./runtime/llama/bin/darwin-arm64/llama-server --help
otool -L runtime/llama/bin/darwin-arm64/llama-server
npm view ai-sdk-ollama name version engines dependencies --json
ollama --version
ollama show <model> --modelfile
```

2. Run cold-start comparisons.

- Quit the app and stop any existing embedded `llama-server`.
- Stop and restart Ollama, or unload the model if using Ollama's unload path.
- Send the same first prompt to each runtime.
- Record startup time, first token latency, prompt eval tok/s, generation tok/s, and peak memory.

3. Run warm comparisons.

- Send the same prompt a second time without unloading the model.
- Record the same metrics.
- Keep the prompt, context length, and tool set identical.

4. Run tool-call comparisons.

- Use one read-only tool prompt and one write-tool prompt that requires approval.
- Record whether the model emits valid tool calls, whether arguments parse correctly, and whether it synthesizes useful text after tool results.

5. Run long-context comparisons.

- Use a prompt that approaches the configured context length.
- Record prompt eval speed, whether context errors occur, and whether the embedded auto-resize retry changes the result.

## Verification Notes

The following checks were used to ground this investigation on 2026-04-22:

- `EmbeddedLlamaRuntimeService` starts `llama-server` with only host, port, model path, context length, `--jinja`, and optional `--mmproj`.
- `runtime/llama/runtime-manifest.json` identifies the bundled release as `ggml-org/llama.cpp` `b8855`.
- `otool -L runtime/llama/bin/darwin-arm64/llama-server` shows `libggml-metal`, `libggml-blas`, `libggml-cpu`, and `libllama`.
- `llama-server --help` exposes the relevant tuning flags listed above, including GPU layers, batching, flash attention, thread counts, memory mapping, sampler settings, parallel slots, prompt cache, Jinja, and multimodal projector options.
- `npm view ai-sdk-ollama ...` reports `ai-sdk-ollama@3.8.3` with `node >=22`.

## Decision

Do not add Ollama or `ai-sdk-ollama` support in this pass. The next implementation work should first make embedded GGUF benchmarking and tuning explicit, then use that data to decide whether a dual-runtime non-MAS path is worth the extra product and support surface.
