# TalkToFigma Local Ollama Agent v1 - Manual QA Checklist

## Scope
- Default model policy: `gemma4:e4b`
- Guide mode only setup (no auto-install, no auto-pull)
- Navigation order: `Assistant -> Terminal -> Settings -> Help`
- Tool safety policy: `read auto`, `write approval required`

## Environment Matrix
- macOS build
- Windows build
- Store-restricted environment (MAS/MSIX equivalent constraints)

## Navigation & Entry
1. Launch app and verify initial page is `Terminal`.
2. Open sidebar and verify menu order is:
   - Assistant
   - Terminal
   - Settings
   - Help
3. Open tray menu and verify same page order appears.
4. Open app menu View section and verify shortcuts:
   - Assistant: `CmdOrCtrl+1`
   - Terminal: `CmdOrCtrl+2`
   - Settings: `CmdOrCtrl+3`
   - Help: `CmdOrCtrl+4`

## Setup States
1. Stop Ollama daemon and open Assistant:
   - `Needs Setup` badge appears.
   - Setup guide card appears.
   - Copy command button copies default pull command.
2. Start daemon with no models installed:
   - `Needs Model Selection` badge appears.
   - Model selection dialog opens automatically.
   - Dialog cannot be closed until a model is selected.
3. Pull default model `gemma4:e4b` and refresh Assistant:
   - Status changes to `Ready`.
   - Default model text shows `gemma4:e4b`.

## Model Selection Rules
1. With `gemma4:e4b` missing and other models installed:
   - Sending message is blocked.
   - Model selection dialog is shown.
2. Select a non-default installed model:
   - Send message works with selected model.
3. Restart app:
   - Last opened thread restores.
   - Active model for restored thread remains selected.

## Chat & Streaming
1. Send a long prompt and verify token streaming appears incrementally.
2. Click `Cancel` during streaming:
   - Run ends with cancelled response.
   - UI returns to idle input state.
3. Start a new thread and verify title auto-updates from first user message.

## Tool Execution Policy
1. Trigger a read tool:
   - Tool call/result appears automatically in stream.
   - No approval dialog appears.
2. Trigger a write tool:
   - Approval dialog appears with tool name, safety, args.
   - `Reject` returns tool rejection result and run continues safely.
   - `Approve` executes tool and returns result.
3. Trigger unknown tool (if available):
   - Must be treated as `write` and require approval.

## Figma Connectivity Fallback
1. Disconnect Figma plugin and trigger Figma-dependent tool:
   - Assistant returns status payload indicating plugin disconnected.
   - User-facing guidance includes server/plugin reconnect actions.

## Persistence & Limits
1. Create over 100 threads:
   - Oldest threads are pruned automatically.
2. In one thread, exceed 400 messages:
   - Oldest messages are pruned in that thread.
3. Restart app and verify:
   - Last opened thread is restored.
   - No orphan messages remain for pruned threads.

## Safety Regression Checks
1. Search code for auto-install/auto-pull behavior:
   - No runtime logic should execute install/pull automatically.
2. Verify all setup actions are user-guided via commands and links only.

