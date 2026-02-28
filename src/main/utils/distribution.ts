/*
 * Copyright 2026 Grabtaxi Holdings Pte Ltd (GRAB), All rights reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be found in the LICENSE file
 */

export type DistributionChannel = 'direct' | 'mas' | 'msix';

export interface UpdateCapabilities {
  channel: DistributionChannel;
  canCheckForUpdates: boolean;
  managedByStore: boolean;
}

export function getDistributionChannel(): DistributionChannel {
  if (process.mas) {
    return 'mas';
  }

  if (process.windowsStore) {
    return 'msix';
  }

  return 'direct';
}

export function getUpdateCapabilities(): UpdateCapabilities {
  const channel = getDistributionChannel();
  const canCheckForUpdates = channel === 'direct';

  return {
    channel,
    canCheckForUpdates,
    managedByStore: !canCheckForUpdates,
  };
}
