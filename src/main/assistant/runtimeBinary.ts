/*
 * Copyright 2026 Grabtaxi Holdings Pte Ltd (GRAB), All rights reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be found in the LICENSE file
 */

import path from 'node:path';

export type RuntimeBinarySource = 'bundled' | 'missing';
export type RuntimePlatformKey = 'darwin-arm64' | 'darwin-x64' | 'windows-x64' | 'windows-arm64';

export interface BundledRuntimeCandidateInput {
  appPath: string;
  resourcesPath: string;
  platformKey: RuntimePlatformKey;
  binaryFileName: string;
}

export function resolveRuntimePlatformKey(platform: NodeJS.Platform, arch: string): RuntimePlatformKey {
  if (platform === 'darwin') {
    return arch === 'x64' ? 'darwin-x64' : 'darwin-arm64';
  }

  if (platform === 'win32') {
    return arch === 'arm64' ? 'windows-arm64' : 'windows-x64';
  }

  // For unsupported runtime hosts, default to desktop-friendly binaries.
  return 'darwin-arm64';
}

export function getRuntimeBinaryFileName(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'llama-server.exe' : 'llama-server';
}

export function buildBundledRuntimeCandidates(input: BundledRuntimeCandidateInput): string[] {
  const { appPath, resourcesPath, platformKey, binaryFileName } = input;
  return [
    path.join(resourcesPath, 'llama', 'bin', platformKey, binaryFileName),
    path.join(appPath, 'runtime', 'llama', 'bin', platformKey, binaryFileName),
  ];
}
