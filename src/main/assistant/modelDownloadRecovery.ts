/*
 * Copyright 2026 Grabtaxi Holdings Pte Ltd (GRAB), All rights reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be found in the LICENSE file
 */

export interface ResumePreparation {
  resetPart: boolean;
  nextPartBytes: number;
  rangeHeader: string | null;
}

export function resolveResumePreparation(existingPartBytes: number, expectedSizeBytes: number): ResumePreparation {
  if (existingPartBytes >= expectedSizeBytes) {
    return {
      resetPart: true,
      nextPartBytes: 0,
      rangeHeader: null,
    };
  }

  return {
    resetPart: false,
    nextPartBytes: existingPartBytes,
    rangeHeader: existingPartBytes > 0 ? `bytes=${existingPartBytes}-` : null,
  };
}

export function isResumeNotSatisfiable(status: number): boolean {
  return status === 416;
}

export function resolveCorruptedArtifactCleanupPaths(partPath: string, destinationPath: string): string[] {
  return Array.from(new Set([partPath, destinationPath]));
}
