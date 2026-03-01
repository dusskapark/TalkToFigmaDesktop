/*
 * Copyright 2026 Grabtaxi Holdings Pte Ltd (GRAB), All rights reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be found in the LICENSE file
 */

/**
 * Analytics Service
 *
 * Unified analytics tracking for both Aptabase and GA4.
 * Tracks events to both services simultaneously.
 */

import { trackAptabaseEvent, AptabaseEvents } from './aptabase-service';
import { trackGA4Event, GA4Events } from './ga4-service';
import { createLogger } from '../utils/logger';
import { getStore } from '../utils/store';
import { STORE_KEYS } from '@/shared/constants';

const logger = createLogger('Analytics');
const MCP_SUCCESS_IDLE_WINDOW_MS = 60_000;
const MAX_PROP_KEY_LENGTH = 40;
const MAX_PROPS_PER_BATCH_EVENT = 25;

type AnalyticsPropertyValue = string | number | boolean;
type AnalyticsProperties = Record<string, AnalyticsPropertyValue>;
export type MCPToolBatchFlushReason = 'idle_timeout' | 'before_failure' | 'app_quit';

interface McpToolSuccessEvent {
  tool_name: string;
  duration_ms?: number;
  ts: number;
}

class McpToolSuccessBuffer {
  private buffer: McpToolSuccessEvent[] = [];
  private lastSuccessAt: number | null = null;
  private idleTimer: NodeJS.Timeout | null = null;

  recordSuccess(toolName: string, durationMs?: number): void {
    this.buffer.push({
      tool_name: toolName,
      ...(durationMs !== undefined && { duration_ms: durationMs }),
      ts: Date.now(),
    });
    this.lastSuccessAt = Date.now();
    this.resetIdleTimer();
  }

  flush(reason: MCPToolBatchFlushReason): void {
    if (this.buffer.length === 0) {
      this.clearIdleTimer();
      return;
    }

    this.clearIdleTimer();

    const durationValues = this.buffer
      .map((event) => event.duration_ms)
      .filter((value): value is number => value !== undefined);
    const durationTotalMs = durationValues.reduce((acc, value) => acc + value, 0);
    const batchId = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

    const toolDurationTotals = new Map<string, number>();
    for (const event of this.buffer) {
      const toolName = event.tool_name || 'unknown_tool';
      const value = event.duration_ms ?? 0;
      toolDurationTotals.set(toolName, (toolDurationTotals.get(toolName) ?? 0) + value);
    }

    const baseParams: AnalyticsProperties = {
      tool_name: '__batch__',
      success: true,
      batched: true,
      batch_size: this.buffer.length,
      idle_window_sec: MCP_SUCCESS_IDLE_WINDOW_MS / 1000,
      batch_reason: reason,
      batch_id: batchId,
    };

    if (this.lastSuccessAt !== null) {
      baseParams.last_success_at_ts = this.lastSuccessAt;
    }

    if (durationValues.length > 0) {
      baseParams.duration_total_ms = durationTotalMs;
    }

    const maxToolPropsPerChunk = Math.max(
      1,
      MAX_PROPS_PER_BATCH_EVENT - Object.keys(baseParams).length - 2 // chunk index + count
    );
    const entries = this.buildUniqueToolDurationEntries(toolDurationTotals);
    const chunks = this.chunkEntries(entries, maxToolPropsPerChunk);

    chunks.forEach((chunk, index) => {
      const params: AnalyticsProperties = {
        ...baseParams,
        batch_chunk_index: index + 1,
        batch_chunk_count: chunks.length,
      };

      for (const [toolKey, totalMs] of chunk) {
        params[toolKey] = Math.round(totalMs);
      }

      trackAptabaseEvent(AnalyticsEvents.MCP_TOOL_CALL, params);
    });

    logger.debug(
      `Flushed MCP success batch (${reason}) with ${this.buffer.length} events (${chunks.length} chunk(s))`
    );

    this.buffer = [];
    this.lastSuccessAt = null;
  }

  private buildUniqueToolDurationEntries(
    durationTotalsByToolName: Map<string, number>
  ): Array<[string, number]> {
    const collisionCountByBaseKey = new Map<string, number>();
    const entries: Array<[string, number]> = [];

    const sortedByToolName = Array.from(durationTotalsByToolName.entries())
      .sort((a, b) => a[0].localeCompare(b[0]));

    for (const [toolName, totalDurationMs] of sortedByToolName) {
      const baseKey = this.toToolDurationBaseKey(toolName);
      const collisionIndex = (collisionCountByBaseKey.get(baseKey) ?? 0) + 1;
      collisionCountByBaseKey.set(baseKey, collisionIndex);

      const resolvedKey = collisionIndex === 1
        ? baseKey
        : this.withCollisionSuffix(baseKey, collisionIndex);

      entries.push([resolvedKey, totalDurationMs]);
    }

    return entries;
  }

  private toToolDurationBaseKey(toolName: string): string {
    const normalized = toolName
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '');

    const key = normalized || 'unknown_tool';
    const reservedKeys = new Set([
      'tool_name',
      'success',
      'batched',
      'batch_size',
      'idle_window_sec',
      'batch_reason',
      'batch_id',
      'last_success_at_ts',
      'duration_total_ms',
      'batch_chunk_index',
      'batch_chunk_count',
      'distribution_channel',
    ]);

    const safeKey = reservedKeys.has(key) ? `tool_${key}` : key;
    return safeKey.slice(0, MAX_PROP_KEY_LENGTH);
  }

  private withCollisionSuffix(baseKey: string, collisionIndex: number): string {
    const suffix = `_${collisionIndex}`;
    const maxBaseLength = Math.max(1, MAX_PROP_KEY_LENGTH - suffix.length);
    const trimmedBase = baseKey.slice(0, maxBaseLength).replace(/_+$/g, '');
    return `${trimmedBase}${suffix}`;
  }

  private chunkEntries(
    entries: Array<[string, number]>,
    chunkSize: number
  ): Array<Array<[string, number]>> {
    if (entries.length === 0) {
      return [[]];
    }

    const chunks: Array<Array<[string, number]>> = [];
    for (let i = 0; i < entries.length; i += chunkSize) {
      chunks.push(entries.slice(i, i + chunkSize));
    }
    return chunks;
  }

  private resetIdleTimer(): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      this.flush('idle_timeout');
    }, MCP_SUCCESS_IDLE_WINDOW_MS);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }
}

const mcpToolSuccessBuffer = new McpToolSuccessBuffer();

/**
 * Track event to both analytics services
 */
export function trackEvent(
  eventName: string,
  properties?: Record<string, string | number | boolean>
): void {
  // Track to Aptabase (privacy-focused, primary)
  trackAptabaseEvent(eventName, properties);

  // Track to GA4 (backward compatibility)
  trackGA4Event(eventName, properties);
}

/**
 * Analytics Events (unified from both services)
 */
export const AnalyticsEvents = {
  ...AptabaseEvents,
  ...GA4Events,
};

/**
 * Track app start
 */
export function trackAppStart(): void {
  trackEvent(AnalyticsEvents.APP_START, {
    platform: process.platform,
    arch: process.arch,
    version: process.env.npm_package_version || '1.0.0',
  });
}

/**
 * Track app quit
 */
export function trackAppQuit(): void {
  trackEvent(AnalyticsEvents.APP_QUIT);
}

/**
 * Track server action (unified event)
 * All server actions use 'server_action' event with action property for consistency
 */
export function trackServerAction(
  action: 'start' | 'stop' | 'restart',
  serverType: 'websocket' | 'mcp' | 'all',
  port?: number,
  startupTimeMs?: number,
  success = true,
  errorMessage?: string
): void {
  const params: Record<string, string | number | boolean> = {
    action,
    server_type: serverType,
    success,
  };

  if (port !== undefined) {
    params.port = port;
  }

  if (startupTimeMs !== undefined) {
    params.startup_time_ms = startupTimeMs;
  }

  if (errorMessage) {
    params.error_message = errorMessage;
  }

  trackEvent(AnalyticsEvents.SERVER_ACTION, params);
}

/**
 * Track MCP tool call (Kotlin-compatible)
 * Uses single event name with success parameter
 */
export function trackMCPToolCall(
  toolName: string,
  success: boolean,
  errorMessage?: string,
  durationMs?: number
): void {
  const params: AnalyticsProperties = {
    tool_name: toolName,
    success: success,
  };

  if (errorMessage) {
    params.error_message = errorMessage;
  }

  if (durationMs !== undefined) {
    params.duration_ms = durationMs;
  }

  if (success) {
    mcpToolSuccessBuffer.recordSuccess(toolName, durationMs);
    trackGA4Event(AnalyticsEvents.MCP_TOOL_CALL, params);
    return;
  }

  // Keep failure/timeout events immediate and flush pending successes first.
  mcpToolSuccessBuffer.flush('before_failure');
  trackAptabaseEvent(AnalyticsEvents.MCP_TOOL_CALL, params);
  trackGA4Event(AnalyticsEvents.MCP_TOOL_CALL, params);
}

/**
 * Flush buffered successful MCP tool events to Aptabase.
 */
export function flushMCPToolSuccessBatch(reason: MCPToolBatchFlushReason): void {
  mcpToolSuccessBuffer.flush(reason);
}

/**
 * Track Figma plugin connection
 */
export function trackFigmaConnection(connected: boolean, channelName?: string): void {
  if (connected) {
    trackEvent(AnalyticsEvents.FIGMA_PLUGIN_CONNECTED, {
      channel: channelName || 'unknown',
    });
  } else {
    trackEvent(AnalyticsEvents.FIGMA_PLUGIN_DISCONNECTED);
  }
}

/**
 * Track OAuth action (unified event pattern)
 * Uses single 'oauth_action' event with action property for consistency with server_action
 */
export function trackOAuthAction(action: 'start' | 'success' | 'error' | 'logout'): void {
  trackEvent(AnalyticsEvents.OAUTH_ACTION, { action });
}

/**
 * Track tutorial action
 */
export function trackTutorialAction(action: 'shown' | 'completed' | 'skipped'): void {
  const eventMap = {
    shown: AnalyticsEvents.TUTORIAL_SHOWN,
    completed: AnalyticsEvents.TUTORIAL_COMPLETED,
    skipped: AnalyticsEvents.TUTORIAL_SKIPPED,
  };

  trackEvent(eventMap[action]);
}

/**
 * Track theme change
 */
export function trackThemeChange(theme: 'light' | 'dark' | 'system'): void {
  trackEvent(AnalyticsEvents.THEME_CHANGED, { theme });
}

/**
 * Track error
 */
export function trackError(errorType: string, errorMessage: string): void {
  trackEvent(AnalyticsEvents.ERROR_OCCURRED, {
    error_type: errorType,
    error_message: errorMessage.substring(0, 100), // Limit length
  });
}

/**
 * Track page view (for window/view navigation)
 * Kotlin-compatible event
 */
export function trackPageView(
  pageTitle: string,
  pageLocation: string,
  pagePath?: string
): void {
  trackEvent(AnalyticsEvents.PAGE_VIEW, {
    page_title: pageTitle,
    page_location: pageLocation,
    ...(pagePath && { page_path: pagePath }),
  });
}

/**
 * Track user engagement
 * Kotlin-compatible event
 */
export function trackUserEngagement(engagementTimeMs = 1000): void {
  trackEvent(AnalyticsEvents.USER_ENGAGEMENT, {
    engagement_time_msec: engagementTimeMs,
  });
}

/**
 * Track first open for new users
 * Only sends once, then sets a flag to prevent duplicate sends
 * Kotlin-compatible event
 */
export function trackFirstOpenIfNeeded(): void {
  const store = getStore();
  const firstOpenSent = store.get(STORE_KEYS.ANALYTICS_FIRST_OPEN_SENT) as boolean | undefined;

  if (!firstOpenSent) {
    trackEvent(AnalyticsEvents.FIRST_OPEN, {
      platform: 'desktop',
    });
    store.set(STORE_KEYS.ANALYTICS_FIRST_OPEN_SENT, true);
    logger.debug('First open event sent and flag set');
  }
}

/**
 * Track user action (generic user interaction event)
 * Kotlin-compatible event
 */
export function trackUserAction(
  action: string,
  category: string,
  label?: string,
  value?: number
): void {
  const params: Record<string, string | number> = {
    action,
    category,
  };

  if (label !== undefined) {
    params.label = label;
  }

  if (value !== undefined) {
    params.value = value;
  }

  trackEvent(AnalyticsEvents.USER_ACTION, params);
}

/**
 * Track app exception (for crash reporting)
 * Kotlin-compatible event
 */
export function trackAppException(
  fatal: boolean,
  exceptionType: string,
  exceptionMessage?: string,
  threadName?: string,
  stacktraceTop?: string
): void {
  const params: Record<string, string | number | boolean> = {
    fatal,
    exception_type: exceptionType.substring(0, 100),
  };

  if (exceptionMessage) {
    params.exception_message = exceptionMessage.substring(0, 150);
  }

  if (threadName) {
    params.thread_name = threadName.substring(0, 80);
  }

  if (stacktraceTop) {
    params.top_stack_frame = stacktraceTop.substring(0, 180);
  }

  trackEvent(AnalyticsEvents.APP_EXCEPTION, params);
}
