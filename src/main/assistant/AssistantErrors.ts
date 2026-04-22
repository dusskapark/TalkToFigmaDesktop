/*
 * Copyright 2026 Grabtaxi Holdings Pte Ltd (GRAB), All rights reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be found in the LICENSE file
 */

export class ExceedContextSizeError extends Error {
  readonly promptTokens: number;
  readonly currentContext: number;

  constructor(message: string, promptTokens: number, currentContext: number) {
    super(message);
    this.name = 'ExceedContextSizeError';
    this.promptTokens = promptTokens;
    this.currentContext = currentContext;
  }
}
