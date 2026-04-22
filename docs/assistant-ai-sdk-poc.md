# Assistant AI SDK / AI Elements PoC

## Current runtime

The default Assistant runtime remains the embedded `llama-server` path:

- `EmbeddedLlamaRuntimeService` starts the bundled llama.cpp server.
- `AssistantRunExecutor` owns run lifecycle, token events, tool-call steps, cancellation, and context resize retry.
- `AssistantToolExecutor` owns Figma tool approval, duplicate blocking, safety classification, and WebSocket execution.

This keeps the offline-first behavior and existing IPC/store contracts unchanged.

## AI SDK PoC path

`AiSdkLlamaRuntimeAdapter` is an off-by-default adapter around the same embedded runtime. Enable it only for local comparison with:

```bash
TALK_TO_FIGMA_ASSISTANT_RUNTIME=ai-sdk npm start
```

The adapter uses `@ai-sdk/openai-compatible` against the local `/v1` endpoint and `streamText` to normalize text deltas and tool-call chunks back into the existing llama-shaped response. It intentionally does not execute AI SDK tools automatically. Tool execution, approval, duplicate blocking, and Figma side effects stay in `AssistantToolExecutor`.

The default runtime is unchanged when the environment variable is absent.

## Dependency policy

- Keep `ai` because the PoC imports `streamText`, `tool`, and `jsonSchema`.
- Keep `@ai-sdk/openai-compatible` for the local OpenAI-compatible provider PoC.
- Remove `ai-sdk-ollama`; Ollama is no longer part of the runtime path.
- Do not add AI Gateway, provider API keys, `@ai-sdk/react`, assistant-ui, or AI Elements dependencies until a follow-up product decision explicitly opts into them.

## Prompt-kit and AI Elements

`src/components/prompt-kit` is the canonical Assistant UI component surface for now. The old standalone assistant prompt input was removed because `Assistant.tsx` already uses the prompt-kit composer.

AI Elements remains a comparison candidate, not the default UI. If we evaluate it later, start with the smallest useful components:

- `message` for streaming-aware markdown rendering.
- `tool` for tool-call state display.
- `reasoning` for reasoning/progress disclosure.

Do not install the full AI Elements registry during the PoC.

## Computer Use smoke checklist

After `npm start`, verify the actual desktop UI with Computer Use:

- Call `mcp__computer_use__.list_apps` first and use the discovered app name.
- Before every click or key action, call `mcp__computer_use__.get_app_state({ app })`.
- Navigate to `Terminal`, `Settings`, `Assistant`, and `Help`.
- Confirm Terminal logs and clear/copy controls do not break layout.
- Confirm Settings model card, MCP Client Configuration, Server Information, SSE Migration preview, and runtime sliders render.
- Confirm Assistant thread drawer, new chat, model/setup dialogs, model selector, and permission dropdown open and close.
- Confirm prompt-kit markdown, reasoning, streaming placeholder, and tool cards render.
- If testing the AI SDK adapter, repeat the Assistant smoke with `TALK_TO_FIGMA_ASSISTANT_RUNTIME=ai-sdk`.
- Quit the app and confirm there are no assistant runtime shutdown, llama-server stop, or IPC unregister errors in the terminal.
