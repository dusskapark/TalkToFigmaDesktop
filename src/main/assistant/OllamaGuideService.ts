/*
 * Copyright 2026 Grabtaxi Holdings Pte Ltd (GRAB), All rights reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be found in the LICENSE file
 */

import type { OllamaSetupGuide } from '../../shared/types';
import { ASSISTANT_DEFAULT_MODEL } from './constants';

function getInstallStepByPlatform(): string {
  switch (process.platform) {
    case 'darwin':
      return 'Install Ollama (if not installed): `brew install --cask ollama` or download from ollama.com';
    case 'win32':
      return 'Install Ollama (if not installed) from https://ollama.com/download/windows';
    default:
      return 'Install Ollama (if not installed) from https://ollama.com/download';
  }
}

export class OllamaGuideService {
  getSetupGuide(): OllamaSetupGuide {
    return {
      title: 'Set up Ollama for Local Assistant',
      defaultModel: ASSISTANT_DEFAULT_MODEL,
      steps: [
        getInstallStepByPlatform(),
        'Start the Ollama daemon: `ollama serve`',
        `Pull the default model: \`ollama pull ${ASSISTANT_DEFAULT_MODEL}\``,
        'Verify model list: `ollama list`',
      ],
      installUrl: 'https://ollama.com/download',
      serveCommand: 'ollama serve',
      pullCommand: `ollama pull ${ASSISTANT_DEFAULT_MODEL}`,
      verifyCommand: 'ollama list',
    };
  }
}
