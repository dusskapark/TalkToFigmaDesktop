/*
 * Copyright 2026 Grabtaxi Holdings Pte Ltd (GRAB), All rights reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be found in the LICENSE file
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { OllamaGuideService } from './OllamaGuideService';
import { ASSISTANT_DEFAULT_MODEL } from './constants';

test('OllamaGuideService returns guide-mode setup with default model commands', () => {
  const service = new OllamaGuideService();
  const guide = service.getSetupGuide();

  assert.equal(guide.defaultModel, ASSISTANT_DEFAULT_MODEL);
  assert.equal(guide.serveCommand, 'ollama serve');
  assert.equal(guide.verifyCommand, 'ollama list');
  assert.equal(guide.pullCommand, `ollama pull ${ASSISTANT_DEFAULT_MODEL}`);
  assert.match(guide.installUrl, /^https:\/\/ollama\.com\/download/);
  assert.ok(guide.steps.length >= 4);
});
