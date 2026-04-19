/*
 * Copyright 2026 Grabtaxi Holdings Pte Ltd (GRAB), All rights reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be found in the LICENSE file
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyToolSafety } from './ToolSafetyPolicy';

test('classifyToolSafety marks read tools correctly', () => {
  assert.equal(classifyToolSafety('get_nodes'), 'read');
  assert.equal(classifyToolSafety('read_file'), 'read');
  assert.equal(classifyToolSafety('connection_diagnostics'), 'read');
});

test('classifyToolSafety marks write tools correctly', () => {
  assert.equal(classifyToolSafety('create_frame'), 'write');
  assert.equal(classifyToolSafety('set_fill_color'), 'write');
  assert.equal(classifyToolSafety('join_channel'), 'write');
});

test('classifyToolSafety defaults unknown tools to write', () => {
  assert.equal(classifyToolSafety('custom_experimental_tool'), 'write');
});
