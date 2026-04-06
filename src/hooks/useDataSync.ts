import { useState, useEffect, useCallback, useRef } from 'react';
import NetInfo from '@react-native-community/netinfo';
import { SyncState, SyncStatus } from '../services/sync/DataSyncService';
import { useDataSyncService } from '../providers/AppProvider';
import { useAuth } from '../contexts/AuthContext';
import { logger } from '../utils/logger';
export interface UseSyncReturn {
  syncState: SyncState;
  isOnline: boolean;
  isSyncing: boolean;
  performSync: () => Promise<void>;
  cancelSync: () => void;
  hasPendingChanges: boolean;
  hasConflicts: boolean;
  checkPendingChanges: () => Promise<boolean>;
  enableAutoSync: boolean;
  setEnableAutoSync: (enabled: boolean) => void;
  lastError?: string;
  clearError: () => void;
}
export const useDataSync = (): UseSyncReturn => {
  const dataSyncService = useDataSyncService();
  const { isAuthenticated } = useAuth();
  const [syncState, setSyncState] = useState<SyncState>({
    status: SyncStatus.IDLE,
    pendingCommands: 0,
    pendingTombstones: 0,
    pendingUploads: 0,
    entitiesSyncing: [],
    totalConflicts: 0
  });
  const [isOnline, setIsOnline] = useState(true);
  const [enableAutoSync, setEnableAutoSync] = useState(true);
  const [lastError, setLastError] = useState<string>();
  const syncInProgressRef = useRef(false);
  const networkUnsubscribeRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (!isAuthenticated) {
      return;
    }
    const initializeSync = async () => {
      try {
        logger.info('useDataSync: Initializing sync service');
        await dataSyncService.initialize();
        const initialState = dataSyncService.getSyncState();
        setSyncState(initialState);
        logger.info('useDataSync: Sync service initialized', { initialState });
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const errorObj = error instanceof Error ? error : new Error(String(error));
        logger.error('useDataSync: Failed to initialize sync service', { 
          error: {
            name: errorObj.name,
            message: errorObj.message,
            stack: errorObj.stack
          }
        });
        setLastError(errorMessage);
      }
    };
    initializeSync();
  }, [isAuthenticated]);
  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener(state => {
      const isCurrentlyOnline = state.isConnected === true;
      setIsOnline(isCurrentlyOnline);
    });
    networkUnsubscribeRef.current = unsubscribe;
    return () => {
      if (networkUnsubscribeRef.current) {
        networkUnsubscribeRef.current();
        networkUnsubscribeRef.current = null;
      }
    };
  }, []);
  useEffect(() => {
    if (!isAuthenticated) {
      return;
    }
    const interval = setInterval(() => {
      const currentState = dataSyncService.getSyncState();
      setSyncState(currentState);
    }, 5000); 
    return () => clearInterval(interval);
  }, [isAuthenticated]);
  const performSync = useCallback(async () => {
    if (!isAuthenticated) {
      logger.warn('useDataSync: Cannot sync - user not authenticated');
      return;
    }
    if (!isOnline) {
      logger.warn('useDataSync: Cannot sync - device offline');
      setLastError('Cannot sync while offline');
      return;
    }
    if (syncInProgressRef.current) {
      logger.warn('useDataSync: Sync already in progress, skipping');
      return;
    }
    try {
      syncInProgressRef.current = true;
      setLastError(undefined);
      logger.info('useDataSync: Starting manual sync');
      setSyncState(prev => ({ ...prev, status: SyncStatus.SYNCING }));
      await dataSyncService.performFullSync({ force: true, source: 'MANUAL_REFRESH' });
      const updatedState = dataSyncService.getSyncState();
      setSyncState(updatedState);
      logger.info('useDataSync: Manual sync completed successfully', { updatedState });
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorObj = error instanceof Error ? error : new Error(String(error));
      logger.error('useDataSync: Manual sync failed', { 
        error: {
          name: errorObj.name,
          message: errorObj.message,
          stack: errorObj.stack
        }
      });
      setLastError(errorMessage);
      setSyncState(prev => ({ 
        ...prev, 
        status: SyncStatus.ERROR, 
        errorMessage 
      }));
    } finally {
      syncInProgressRef.current = false;
    }
  }, [isAuthenticated, isOnline]);
  const cancelSync = useCallback(() => {
    if (syncInProgressRef.current) {
      logger.info('useDataSync: Sync cancellation requested');
      syncInProgressRef.current = false;
      setSyncState(prev => ({ 
        ...prev, 
        status: SyncStatus.IDLE,
        errorMessage: 'Sync cancelled by user'
      }));
    }
  }, []);
  const clearError = useCallback(() => {
    setLastError(undefined);
    setSyncState(prev => ({ ...prev, errorMessage: undefined }));
  }, []);
  const checkPendingChanges = useCallback(async (): Promise<boolean> => {
    try {
      return await dataSyncService.hasLocalChanges();
    } catch (error: unknown) {
      const errorObj = error instanceof Error ? error : new Error(String(error));
      logger.error('useDataSync: Failed to check pending changes', {
        error: {
          name: errorObj.name,
          message: errorObj.message,
          stack: errorObj.stack
        }
      });
      return true;
    }
  }, [dataSyncService]);
  const triggerAutoSync = useCallback(
    debounce(() => {
      if (enableAutoSync && isOnline && isAuthenticated && !syncInProgressRef.current) {
        logger.info('useDataSync: Auto-sync triggered by data change');
        performSync();
      }
    }, 30000), 
    [enableAutoSync, isOnline, isAuthenticated, performSync]
  );
  const hasPendingChanges = syncState.pendingCommands > 0 || syncState.pendingTombstones > 0;
  const hasConflicts = syncState.totalConflicts > 0;
  const isSyncing = syncState.status === SyncStatus.SYNCING || syncInProgressRef.current;
  return {
    syncState,
    isOnline,
    isSyncing,
    performSync,
    cancelSync,
    hasPendingChanges,
    hasConflicts,
    checkPendingChanges,
    enableAutoSync,
    setEnableAutoSync,
    lastError,
    clearError,
  };
};
function debounce<TArgs extends unknown[], TReturn = void>(
  func: (...args: TArgs) => TReturn,
  wait: number
): (...args: TArgs) => void {
  let timeout: NodeJS.Timeout | null = null;
  return (...args: TArgs) => {
    if (timeout) {
      clearTimeout(timeout);
    }
    timeout = setTimeout(() => {
      func(...args);
      timeout = null;
    }, wait);
  };
}
export const useSyncStatus = () => {
  const { syncState, isOnline, hasPendingChanges, hasConflicts, isSyncing } = useDataSync();
  const getSyncStatusText = useCallback(() => {
    if (!isOnline) {
      return 'Offline';
    }
    const pendingCount = syncState.pendingCommands + syncState.pendingTombstones;
    switch (syncState.status) {
      case SyncStatus.SYNCING:
        return 'Syncing...';
      case SyncStatus.SUCCESS:
        if (hasPendingChanges) {
          return `${pendingCount} pending`;
        }
        return syncState.lastSyncTime
          ? `Last sync: ${formatSyncTime(syncState.lastSyncTime)}`
          : 'Synced';
      case SyncStatus.ERROR:
        return 'Sync failed';
      case SyncStatus.OFFLINE:
        return 'Offline';
      default:
        return hasPendingChanges ? `${pendingCount} pending` : 'Ready';
    }
  }, [syncState, isOnline, hasPendingChanges]);
  const getSyncStatusColor = useCallback(() => {
    if (!isOnline) return '#999';
    switch (syncState.status) {
      case SyncStatus.SYNCING:
        return '#007AFF';
      case SyncStatus.SUCCESS:
        return hasPendingChanges ? '#FF9500' : '#34C759';
      case SyncStatus.ERROR:
        return '#FF3B30';
      case SyncStatus.OFFLINE:
        return '#999';
      default:
        return hasPendingChanges ? '#FF9500' : '#34C759';
    }
  }, [syncState, isOnline, hasPendingChanges]);
  return {
    statusText: getSyncStatusText(),
    statusColor: getSyncStatusColor(),
    hasPendingChanges,
    hasConflicts,
    isOnline,
    isSyncing,
  };
};
export interface UsePullToRefreshSyncOptions {
  onComplete?: () => void | Promise<void>;
}
export interface UsePullToRefreshSyncReturn {
  refreshing: boolean;
  onRefresh: () => Promise<void>;
  statusText: string;
  isOnline: boolean;
  syncState: SyncState;
}
export const usePullToRefreshSync = (
  options: UsePullToRefreshSyncOptions = {}
): UsePullToRefreshSyncReturn => {
  const { onComplete } = options;
  const { performSync, syncState, isOnline, isSyncing } = useDataSync();
  const { statusText } = useSyncStatus();
  const [localRefreshing, setLocalRefreshing] = useState(false);
  const onRefresh = useCallback(async () => {
    if (!isOnline) {
      logger.warn('[usePullToRefreshSync] Skipping refresh - device offline');
      return;
    }
    setLocalRefreshing(true);
    try {
      logger.info('[usePullToRefreshSync] Starting pull-to-refresh sync');
      await performSync();
      if (onComplete) {
        await onComplete();
      }
      logger.info('[usePullToRefreshSync] Pull-to-refresh sync completed');
    } catch (error: unknown) {
      const errorObj = error instanceof Error ? error : new Error(String(error));
      logger.error('[usePullToRefreshSync] Pull-to-refresh sync failed', {
        error: {
          name: errorObj.name,
          message: errorObj.message,
          stack: errorObj.stack,
        },
      });
    } finally {
      setLocalRefreshing(false);
    }
  }, [isOnline, performSync, onComplete]);
  return {
    refreshing: localRefreshing || isSyncing,
    onRefresh,
    statusText,
    isOnline,
    syncState,
  };
};
function formatSyncTime(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;
  if (diff < 60000) { 
    return 'just now';
  } else if (diff < 3600000) { 
    const minutes = Math.floor(diff / 60000);
    return `${minutes}m ago`;
  } else if (diff < 86400000) { 
    const hours = Math.floor(diff / 3600000);
    return `${hours}h ago`;
  } else {
    const days = Math.floor(diff / 86400000);
    return `${days}d ago`;
  }
}
