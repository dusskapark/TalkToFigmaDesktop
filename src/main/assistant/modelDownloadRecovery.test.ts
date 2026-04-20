/*
 * Copyright 2026 Grabtaxi Holdings Pte Ltd (GRAB), All rights reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be found in the LICENSE file
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isResumeNotSatisfiable,
  resolveCorruptedArtifactCleanupPaths,
  resolveResumePreparation,
} from './modelDownloadRecovery';

test('resolveResumePreparation keeps resumable partial downloads', () => {
  const result = resolveResumePreparation(1024, 4096);
  assert.equal(result.resetPart, false);
  assert.equal(result.nextPartBytes, 1024);
  assert.equal(result.rangeHeader, 'bytes=1024-');
});

test('resolveResumePreparation resets oversized or complete partial files', () => {
  const equalSize = resolveResumePreparation(4096, 4096);
  assert.equal(equalSize.resetPart, true);
  assert.equal(equalSize.nextPartBytes, 0);
  assert.equal(equalSize.rangeHeader, null);

  const oversized = resolveResumePreparation(8192, 4096);
  assert.equal(oversized.resetPart, true);
  assert.equal(oversized.nextPartBytes, 0);
  assert.equal(oversized.rangeHeader, null);
});

test('isResumeNotSatisfiable only matches HTTP 416', () => {
  assert.equal(isResumeNotSatisfiable(416), true);
  assert.equal(isResumeNotSatisfiable(206), false);
  assert.equal(isResumeNotSatisfiable(500), false);
});

test('resolveCorruptedArtifactCleanupPaths deduplicates paths', () => {
  const paths = resolveCorruptedArtifactCleanupPaths('/tmp/a.part', '/tmp/a.part');
  assert.deepEqual(paths, ['/tmp/a.part']);
});
