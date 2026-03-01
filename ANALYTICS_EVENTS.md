# Analytics Events Documentation

This document describes the analytics events tracked in TalkToFigma Desktop.

## Overview

The app uses two analytics services:
- **Aptabase** (primary): Privacy-focused analytics
- **Google Analytics 4** (GA4): Backward compatibility with existing dashboards

All events include these common properties:
- `distribution_channel`: `app_store` | `direct` | `development`
- `app_version`: Current app version

## Event Reference

### App Lifecycle Events

#### `app_start`
Triggered when the app starts.

| Property | Type | Description |
|----------|------|-------------|
| platform | string | Operating system (darwin, win32, linux) |
| arch | string | CPU architecture (x64, arm64) |
| version | string | App version |

#### `app_quit`
Triggered when the app quits. No additional properties.

#### `first_open`
Triggered once per installation (first launch only).

| Property | Type | Description |
|----------|------|-------------|
| platform | string | Always "desktop" |

---

### Server Events

#### `server_action`
Unified event for all server actions.

| Property | Type | Description |
|----------|------|-------------|
| action | string | `start` \| `stop` \| `restart` |
| server_type | string | `all` \| `websocket` \| `mcp` |
| success | boolean | Whether the action succeeded |
| port | number | (optional) Server port |
| startup_time_ms | number | (optional) Time to start in ms |
| error_message | string | (optional) Error description if failed |

---

### MCP Tool Events

#### `mcp_tool_call`
Triggered when an MCP tool is invoked.

| Property | Type | Description |
|----------|------|-------------|
| tool_name | string | Name of the tool (e.g., `create_rectangle`) |
| success | boolean | Whether the tool call succeeded |
| duration_ms | number | (optional) Time in ms from request received to response returned |
| error_message | string | (optional) Error description if failed |
| batched | boolean | (optional) `true` when this event contains a success batch |
| batch_size | number | (optional) Number of successful tool calls included in the batch |
| idle_window_sec | number | (optional) Idle window used before flushing successful calls (default 60) |
| batch_reason | string | (optional) `idle_timeout` \| `before_failure` \| `app_quit` |
| duration_total_ms | number | (optional) Sum of known durations in a batch |
| batch_id | string | (optional) Batch identifier shared across chunked events |
| batch_chunk_index | number | (optional) 1-based index when a batch is split into multiple events |
| batch_chunk_count | number | (optional) Total number of chunked events for the batch |
| `<tool_name>` | number | (optional) Dynamic property where key is tool name and value is accumulated duration in ms (example: `join_channel: 120`) |

Notes:
- Failed or timed-out tool calls are still tracked immediately with `success=false`.
- Batched success events reuse the same event name and use `tool_name="__batch__"` for compatibility.
- If a batch would exceed the configured property count, it is flushed as multiple chunked events (`batch_chunk_*`) with the same `batch_id`.
- Dynamic tool keys are normalized to lowercase snake_case and capped at 40 chars; if two tools collide after normalization/truncation, suffixes (`_2`, `_3`, ...) are appended.

---

### OAuth Events

#### `oauth_action`
Unified event for all OAuth actions.

| Property | Type | Description |
|----------|------|-------------|
| action | string | `start` \| `success` \| `error` \| `logout` |

---

### Figma Plugin Events

#### `figma_plugin_connected`
Triggered when a Figma plugin connects.

| Property | Type | Description |
|----------|------|-------------|
| channel | string | Channel name or "unknown" |

#### `figma_plugin_disconnected`
Triggered when a Figma plugin disconnects. No additional properties.

---

### Tutorial Events

#### `tutorial_shown`
Triggered when the tutorial is displayed. No additional properties.

#### `tutorial_completed`
Triggered when the user completes the tutorial. No additional properties.

#### `tutorial_skipped`
Triggered when the user skips the tutorial. No additional properties.

---

### Settings Events

#### `theme_changed`
Triggered when the user changes the theme.

| Property | Type | Description |
|----------|------|-------------|
| theme | string | `light` \| `dark` \| `system` |

---

### Error Events

#### `error_occurred`
Triggered when an error occurs.

| Property | Type | Description |
|----------|------|-------------|
| error_type | string | Category of error |
| error_message | string | Error description (max 100 chars) |

#### `app_exception`
Triggered for app crashes/exceptions.

| Property | Type | Description |
|----------|------|-------------|
| fatal | boolean | Whether the exception was fatal |
| exception_type | string | Type of exception (max 100 chars) |
| exception_message | string | (optional) Error message (max 150 chars) |
| thread_name | string | (optional) Thread name (max 80 chars) |
| top_stack_frame | string | (optional) Top stack frame (max 180 chars) |

---

### User Engagement Events

#### `page_view`
Triggered on navigation/view changes.

| Property | Type | Description |
|----------|------|-------------|
| page_title | string | Title of the page/view |
| page_location | string | Location identifier |
| page_path | string | (optional) Path to the view |

#### `user_engagement`
Triggered for engagement tracking.

| Property | Type | Description |
|----------|------|-------------|
| engagement_time_msec | number | Engagement time in milliseconds |

#### `user_action`
Generic user interaction event.

| Property | Type | Description |
|----------|------|-------------|
| action | string | Action performed |
| category | string | Action category |
| label | string | (optional) Action label |
| value | number | (optional) Action value |

---

## Analytics Configuration

### Aptabase
- App Key: Configured in `aptabase-service.ts`
- Privacy-focused, GDPR compliant
- Automatically enriches events with `distribution_channel`

### Google Analytics 4
- Measurement ID and API Secret: Set via environment variables or build-time constants
- Environment variables: `GOOGLE_ANALYTICS_ID`, `GOOGLE_ANALYTICS_API_SECRET`
- Events include device info, session ID, and user properties

---

## Verification

To verify analytics events are working:

1. Start the app with `npm start`
2. Perform actions (start server, use MCP tools, etc.)
3. Check Aptabase Live View for events
4. For GA4, check DebugView in Google Analytics console
