import { useCallback, useState, useEffect } from 'react';
import { useHealthSyncService } from '../providers/AppProvider';
import type {
  FullSyncResult,
  HealthSyncServiceState,
} from '../services/health/HealthSyncService';
import type { HealthSyncResult } from '../services/health/HealthSyncCoordinationState';
export interface ResetVitalSignCursorsResult {
  readonly cursorsReset: number;
  readonly syncTriggered: boolean;
  readonly syncResult?: FullSyncResult | null;
}
export interface UseHealthSyncReturn {
  readonly isInitialized: boolean;
  readonly isEnginesReady: boolean;
  readonly isSyncing: boolean;
  readonly syncState: HealthSyncServiceState;
  readonly lastError: string | null;
  readonly triggerSync: () => Promise<FullSyncResult | null>;
  readonly triggerUploadOnly: () => Promise<HealthSyncResult | null>;
  readonly resetVitalSignCursors: (triggerImmediateSync?: boolean) => Promise<ResetVitalSignCursorsResult | null>;
  readonly getPendingSamplesCount: () => Promise<number>;
  readonly getDebugSnapshot: () => Record<string, unknown>;
}
const DEFAULT_SYNC_STATE: HealthSyncServiceState = {
  initialized: false,
  enginesReady: false,
  isSyncing: false,
  isColdRunning: false,
  isChangeRunning: false,
  lastIngestTime: null,
  lastUploadTime: null,
  currentUserId: null,
  permissionStatus: 'not_determined',
};
export function useHealthSync(): UseHealthSyncReturn {
  const healthSyncService = useHealthSyncService();
  const [syncState, setSyncState] = useState<HealthSyncServiceState>(
    () => healthSyncService?.getSyncState() ?? DEFAULT_SYNC_STATE
  );
  const [lastError, setLastError] = useState<string | null>(null);
  useEffect(() => {
    if (!healthSyncService) {
      setSyncState(DEFAULT_SYNC_STATE);
      return;
    }
    const unsubscribe = healthSyncService.subscribeToStateChanges((newState) => {
      setSyncState(newState);
    });
    return unsubscribe;
  }, [healthSyncService]);
  const triggerSync = useCallback(async (): Promise<FullSyncResult | null> => {
    if (!healthSyncService) {
      return null;
    }
    setLastError(null);
    try {
      const result = await healthSyncService.triggerSync('MANUAL_REFRESH');
      if (result && !result.success && result.errorMessage) {
        setLastError(result.errorMessage);
      }
      return result;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      setLastError(errorMsg);
      return null;
    }
  }, [healthSyncService]);
  const triggerUploadOnly = useCallback(async (): Promise<HealthSyncResult | null> => {
    if (!healthSyncService) {
      return null;
    }
    setLastError(null);
    try {
      const result = await healthSyncService.triggerUploadOnly('MANUAL_REFRESH');
      if (result && !result.success) {
        setLastError('Upload failed');
      }
      return result;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      setLastError(errorMsg);
      return null;
    }
  }, [healthSyncService]);
  const getPendingSamplesCount = useCallback(async (): Promise<number> => {
    if (!healthSyncService) {
      return 0;
    }
    return healthSyncService.getPendingSamplesCount();
  }, [healthSyncService]);
  const getDebugSnapshot = useCallback((): Record<string, unknown> => {
    if (!healthSyncService) {
      return { serviceAvailable: false, platform: 'non-iOS (Health Connect deferred)' };
    }
    return healthSyncService.getDebugSnapshot();
  }, [healthSyncService]);
  const resetVitalSignCursors = useCallback(
    async (triggerImmediateSync = true): Promise<ResetVitalSignCursorsResult | null> => {
      if (!healthSyncService) {
        return null;
      }
      setLastError(null);
      try {
        const result = await healthSyncService.resetVitalSignCursors(triggerImmediateSync);
        if (result.syncResult && !result.syncResult.success && result.syncResult.errorMessage) {
          setLastError(result.syncResult.errorMessage);
        }
        return result;
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        setLastError(errorMsg);
        return null;
      }
    },
    [healthSyncService]
  );
  return {
    isInitialized: syncState.initialized,
    isEnginesReady: syncState.enginesReady,
    isSyncing: syncState.isSyncing,
    syncState,
    lastError,
    triggerSync,
    triggerUploadOnly,
    resetVitalSignCursors,
    getPendingSamplesCount,
    getDebugSnapshot,
  };
}
