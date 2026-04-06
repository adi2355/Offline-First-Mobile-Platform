import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { healthProjectionKeys } from './queryKeys';
import { useAuthReady, isAuthReadyForFetch } from './useAuthReady';
import { useAppContext } from '../providers/AppProvider';
import { shouldRetryHydration, MAX_HYDRATION_RETRIES, HYDRATION_RETRY_BASE_MS, HYDRATION_RETRY_JITTER_MS } from '../domain/health/types';
import type { LocalSleepNightSummary } from '../repositories/health/LocalSleepNightSummaryRepository';
import type { StalenessEvaluation } from '../services/health/HealthProjectionRefreshService';
import type { ProjectionServerState } from '../services/health/HealthProjectionHydrationClient';
import { logger, toLogError } from '../utils/logger';
import { extractUserMessage } from '../utils/frontend-error-handler';
export interface UseSleepSummariesOptions {
  startDate: string;
  endDate: string;
  enabled?: boolean;
}
export interface UseSleepSummariesReturn {
  readonly data: LocalSleepNightSummary[];
  readonly isLoading: boolean;
  readonly isHydrating: boolean;
  readonly isTruncated: boolean;
  readonly staleness: StalenessEvaluation;
  readonly serverState: ProjectionServerState;
  readonly hydrationError: string | null;
  readonly error: Error | null;
  readonly refetch: () => Promise<void>;
}
const EMPTY_DATA: LocalSleepNightSummary[] = [];
const TABLES_NOT_READY_STALENESS: StalenessEvaluation = {
  isStale: false,
  reason: 'tables_not_ready',
  oldestAgeMs: null,
};
export function useSleepSummaries(options: UseSleepSummariesOptions): UseSleepSummariesReturn {
  const { startDate, endDate, enabled = true } = options;
  const authState = useAuthReady();
  const queryClient = useQueryClient();
  const { databaseManager, healthProjectionRefreshService } = useAppContext() as ReturnType<typeof useAppContext> & {
    healthProjectionRefreshService?: import('../services/health/HealthProjectionRefreshService').HealthProjectionRefreshService | null;
  };
  const isHydratingRef = useRef(false);
  const [isHydrating, setIsHydrating] = useState(false);
  const hydrationTriggeredRef = useRef(false);
  const retryCountRef = useRef(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [retryTick, setRetryTick] = useState(0);
  const [serverState, setServerState] = useState<ProjectionServerState>('UNKNOWN');
  const [hydrationError, setHydrationError] = useState<string | null>(null);
  const [isTruncated, setIsTruncated] = useState(false);
  const isAuthReady = isAuthReadyForFetch(authState);
  const tablesReady = databaseManager.healthProjectionTablesReady;
  const queryEnabled = enabled && isAuthReady && tablesReady;
  useEffect(() => {
    if (retryTimerRef.current !== null) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
    retryCountRef.current = 0;
    setRetryTick(0);
    hydrationTriggeredRef.current = false;
    setServerState('UNKNOWN');
    setHydrationError(null);
    setIsTruncated(false);
  }, [startDate, endDate]);
  useEffect(() => {
    return () => {
      if (retryTimerRef.current !== null) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
    };
  }, []);
  const query = useQuery({
    queryKey: healthProjectionKeys.sleepByRange(startDate, endDate),
    queryFn: async (): Promise<LocalSleepNightSummary[]> => {
      if (!isAuthReady || !tablesReady) return EMPTY_DATA;
      const sleepRepo = new (await import('../repositories/health/LocalSleepNightSummaryRepository')).LocalSleepNightSummaryRepository(
        databaseManager.getDrizzle(),
      );
      return sleepRepo.queryByDateRange(
        authState.userId!,
        startDate,
        endDate,
      );
    },
    enabled: queryEnabled,
    staleTime: 5 * 60_000, 
    gcTime: 10 * 60_000, 
  });
  const data = query.data ?? EMPTY_DATA;
  const staleness = useMemo<StalenessEvaluation>(() => {
    if (!tablesReady || !healthProjectionRefreshService) {
      return TABLES_NOT_READY_STALENESS;
    }
    return healthProjectionRefreshService.evaluateSleepStaleness(data, startDate, endDate);
  }, [data, startDate, endDate, tablesReady, healthProjectionRefreshService]);
  useEffect(() => {
    if (
      !staleness.isStale ||
      !isAuthReady ||
      !healthProjectionRefreshService ||
      hydrationTriggeredRef.current ||
      isHydratingRef.current ||
      !queryEnabled
    ) {
      return;
    }
    hydrationTriggeredRef.current = true;
    isHydratingRef.current = true;
    setIsHydrating(true);
    healthProjectionRefreshService
      .hydrateSleepIfNeeded(authState.userId!, startDate, endDate)
      .then((outcome) => {
        setServerState(outcome.serverState);
        setHydrationError(outcome.error);
        setIsTruncated(outcome.truncated);
        if (outcome.success) {
          queryClient.invalidateQueries({
            queryKey: healthProjectionKeys.sleepByRange(startDate, endDate),
          });
        }
        if (shouldRetryHydration(outcome.success, outcome.serverState, outcome.statusCounts) && retryCountRef.current < MAX_HYDRATION_RETRIES) {
          const delay = HYDRATION_RETRY_BASE_MS * Math.pow(2, retryCountRef.current)
            + Math.floor(Math.random() * HYDRATION_RETRY_JITTER_MS);
          retryCountRef.current += 1;
          retryTimerRef.current = setTimeout(() => {
            retryTimerRef.current = null;
            hydrationTriggeredRef.current = false;
            setRetryTick(prev => prev + 1);
          }, delay);
        }
      })
      .catch((err: unknown) => {
        const message = extractUserMessage(err, 'Sleep summary hydration failed.');
        setServerState('UNKNOWN');
        setHydrationError(message);
        setIsTruncated(false);
        logger.error('[useSleepSummaries] Background hydration error', {
          error: toLogError(err),
        });
        if (retryCountRef.current < MAX_HYDRATION_RETRIES) {
          const delay = HYDRATION_RETRY_BASE_MS * Math.pow(2, retryCountRef.current)
            + Math.floor(Math.random() * HYDRATION_RETRY_JITTER_MS);
          retryCountRef.current += 1;
          retryTimerRef.current = setTimeout(() => {
            retryTimerRef.current = null;
            hydrationTriggeredRef.current = false;
            setRetryTick(prev => prev + 1);
          }, delay);
        }
      })
      .finally(() => {
        isHydratingRef.current = false;
        setIsHydrating(false);
      });
  }, [staleness.isStale, retryTick, isAuthReady, authState.userId, startDate, endDate, healthProjectionRefreshService, queryClient, queryEnabled]);
  const refetch = useCallback(async () => {
    if (!queryEnabled || !isAuthReady || !healthProjectionRefreshService) return;
    isHydratingRef.current = true;
    setIsHydrating(true);
    try {
      const outcome = await healthProjectionRefreshService.hydrateSleepIfNeeded(
        authState.userId!,
        startDate,
        endDate,
      );
      setServerState(outcome.serverState);
      setHydrationError(outcome.error);
      setIsTruncated(outcome.truncated);
      if (outcome.success) {
        await queryClient.invalidateQueries({
          queryKey: healthProjectionKeys.sleepByRange(startDate, endDate),
        });
      }
    } catch (err: unknown) {
      const message = extractUserMessage(err, 'Sleep summary refresh failed.');
      setServerState('UNKNOWN');
      setHydrationError(message);
      setIsTruncated(false);
    } finally {
      isHydratingRef.current = false;
      setIsHydrating(false);
      hydrationTriggeredRef.current = false;
      if (retryTimerRef.current !== null) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
      retryCountRef.current = 0;
    }
  }, [queryEnabled, isAuthReady, authState.userId, startDate, endDate, healthProjectionRefreshService, queryClient]);
  return {
    data,
    isLoading: query.isLoading,
    isHydrating,
    isTruncated,
    staleness,
    serverState,
    hydrationError,
    error: query.error instanceof Error ? query.error : null,
    refetch,
  };
}
