/*
 * Copyright 2026 Grabtaxi Holdings Pte Ltd (GRAB), All rights reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be found in the LICENSE file
 */

import type { AssistantToolSafety } from '../../shared/types';

const READ_PATTERNS: RegExp[] = [
  /^get_/,
  /^read_/,
  /^list_/,
  /^find_/,
  /^search_/,
  /^connection_diagnostics$/,
  /^get_active_channels$/,
  /^figma_get_/,
];

const WRITE_PATTERNS: RegExp[] = [
  /^create_/,
  /^set_/,
  /^update_/,
  /^delete_/,
  /^remove_/,
  /^move_/,
  /^clone_/,
  /^apply_/,
  /^join_channel$/,
  /^figma_post_/,
  /^figma_delete_/,
  /^figma_set_/,
  /^send_notification$/,
];

export function classifyToolSafety(toolName: string): AssistantToolSafety {
  for (const pattern of READ_PATTERNS) {
    if (pattern.test(toolName)) {
      return 'read';
    }
  }

  for (const pattern of WRITE_PATTERNS) {
    if (pattern.test(toolName)) {
      return 'write';
    }
  }

  // Unknown tools default to write for safety.
  return 'write';
}
