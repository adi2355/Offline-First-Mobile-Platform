import { logger, toLogError } from '../../utils/logger';
import { isTerminalSuccessState, EMPTY_STATUS_COUNTS } from './projection-state-classification';
import type { StatusCounts } from './projection-state-classification';
import type { HealthProjectionHydrationClient } from './HealthProjectionHydrationClient';
import type { ProjectionServerState } from './HealthProjectionHydrationClient';
import type { LocalRollupDirtyKeyRepository, DirtyRollupKey } from '../../repositories/health/LocalRollupDirtyKeyRepository';
import type { LocalSleepDirtyNightRepository } from '../../repositories/health/LocalSleepDirtyNightRepository';
import type { LocalHealthRollupRepository, LocalHealthRollup } from '../../repositories/health/LocalHealthRollupRepository';
import type { LocalSleepNightSummaryRepository, LocalSleepNightSummary } from '../../repositories/health/LocalSleepNightSummaryRepository';
import type { LocalSessionImpactRepository, LocalSessionImpact } from '../../repositories/health/LocalSessionImpactRepository';
import type { LocalProductImpactRepository, LocalProductImpact } from '../../repositories/health/LocalProductImpactRepository';
import type { LocalHealthInsightRepository, LocalHealthInsight } from '../../repositories/health/LocalHealthInsightRepository';
const MAX_DIRTY_KEYS_PER_PASS = 50;
const STALE_THRESHOLD_MS = 60 * 60 * 1000;
const LOG_PREFIX = '[HealthProjectionRefreshService]';
const PRODUCT_IMPACT_PERIOD_DAYS = [7, 30, 90] as const;
export interface StalenessEvaluation {
  readonly isStale: boolean;
  readonly reason:
    | 'no_data'
    | 'age_exceeded'
    | 'fresh'
    | 'tables_not_ready'
    | 'server_stale'
    | 'server_computing'
    | 'server_failed';
  readonly oldestAgeMs: number | null;
}
export interface HydrationOutcome {
  readonly success: boolean;
  readonly truncated: boolean;
  readonly serverState: ProjectionServerState;
  readonly error: string | null;
  readonly statusCounts: StatusCounts;
}
export interface RepairPassResult {
  readonly rollupKeysProcessed: number;
  readonly sleepNightsProcessed: number;
  readonly rollupKeysCleared: number;
  readonly sleepNightsCleared: number;
  readonly productImpactHydrations: number;
  readonly errors: string[];
}
export interface HealthProjectionRefreshServicePorts {
  readonly hydrationClient: HealthProjectionHydrationClient;
  readonly rollupDirtyKeyRepository: LocalRollupDirtyKeyRepository;
  readonly sleepDirtyNightRepository: LocalSleepDirtyNightRepository;
  readonly rollupRepository: LocalHealthRollupRepository;
  readonly sleepRepository: LocalSleepNightSummaryRepository;
  readonly sessionImpactRepository: LocalSessionImpactRepository;
  readonly productImpactRepository?: LocalProductImpactRepository;
  readonly insightRepository?: LocalHealthInsightRepository;
  readonly isOnline: () => boolean;
  readonly isTablesReady: () => boolean;
}
export function evaluateServerFreshnessStatus(
  rows: ReadonlyArray<{ readonly freshnessStatus: string }>,
  oldestAgeMs: number | null,
): StalenessEvaluation | null {
  let hasFailed = false;
  let hasStale = false;
  let hasComputing = false;
  for (const row of rows) {
    switch (row.freshnessStatus) {
      case 'FAILED': hasFailed = true; break;
      case 'STALE': hasStale = true; break;
      case 'COMPUTING': hasComputing = true; break;
    }
  }
  if (hasFailed) return { isStale: true, reason: 'server_failed', oldestAgeMs };
  if (hasStale) return { isStale: true, reason: 'server_stale', oldestAgeMs };
  if (hasComputing) return { isStale: true, reason: 'server_computing', oldestAgeMs };
  return null;
}
export function groupDirtyKeysByMetric(
  keys: ReadonlyArray<DirtyRollupKey>,
): Map<string, DirtyRollupKey[]> {
  const grouped = new Map<string, DirtyRollupKey[]>();
  for (const key of keys) {
    const existing = grouped.get(key.metricCode);
    if (existing) {
      existing.push(key);
    } else {
      grouped.set(key.metricCode, [key]);
    }
  }
  return grouped;
}
export function computeBoundingDateRange(
  dates: ReadonlyArray<string>,
): { minDate: string; maxDate: string } | null {
  if (dates.length === 0) return null;
  let minDate = dates[0]!;
  let maxDate = dates[0]!;
  for (let i = 1; i < dates.length; i++) {
    const d = dates[i]!;
    if (d < minDate) minDate = d;
    if (d > maxDate) maxDate = d;
  }
  return { minDate, maxDate };
}
export class HealthProjectionRefreshService {
  constructor(private readonly ports: HealthProjectionRefreshServicePorts) {}
  async runRepairPass(userId: string): Promise<RepairPassResult> {
    const emptyResult = (errs: string[]): RepairPassResult => ({
      rollupKeysProcessed: 0, sleepNightsProcessed: 0, rollupKeysCleared: 0,
      sleepNightsCleared: 0, productImpactHydrations: 0, errors: errs,
    });
    if (!this.ports.isTablesReady()) {
      return emptyResult(['Tables not ready']);
    }
    if (!this.ports.isOnline()) {
      return emptyResult(['Offline']);
    }
    const errors: string[] = [];
    let rollupKeysCleared = 0;
    let sleepNightsCleared = 0;
    const affectedMetrics = new Set<string>();
    const rollupKeys = await this.ports.rollupDirtyKeyRepository.dequeueOldest(userId, MAX_DIRTY_KEYS_PER_PASS);
    const rollupKeysProcessed = rollupKeys.length;
    if (rollupKeys.length > 0) {
      const grouped = groupDirtyKeysByMetric(rollupKeys);
      const successfulRollupIds: number[] = [];
      for (const [metricCode, keys] of grouped) {
        affectedMetrics.add(metricCode);
        const dates = keys.map((k) => k.dayUtc);
        const range = computeBoundingDateRange(dates);
        if (!range) continue;
        const result = await this.ports.hydrationClient.hydrateRollups(
          userId, metricCode, range.minDate, range.maxDate,
        );
        if (result.success && !result.truncated && isTerminalSuccessState(result.serverSummaryState)) {
          successfulRollupIds.push(...keys.map((k) => k.id));
        } else if (!result.success) {
          errors.push(`Rollup hydration failed for ${metricCode}: ${result.error}`);
        } else if (result.truncated) {
          errors.push(`Rollup hydration truncated for ${metricCode}: MAX_HYDRATION_PAGES reached, ${result.itemsUpserted} items upserted but more remain`);
        } else if (!isTerminalSuccessState(result.serverSummaryState)) {
          errors.push(`Rollup hydration for ${metricCode} returned non-terminal server state '${result.serverSummaryState}': dirty keys preserved for retry`);
        }
      }
      if (successfulRollupIds.length > 0) {
        await this.ports.rollupDirtyKeyRepository.clearByIds(successfulRollupIds);
        rollupKeysCleared = successfulRollupIds.length;
      }
    }
    const sleepNights = await this.ports.sleepDirtyNightRepository.dequeueOldest(userId, MAX_DIRTY_KEYS_PER_PASS);
    const sleepNightsProcessed = sleepNights.length;
    if (sleepNights.length > 0) {
      const dates = sleepNights.map((n) => n.nightLocalDate);
      const range = computeBoundingDateRange(dates);
      if (range) {
        const result = await this.ports.hydrationClient.hydrateSleep(
          userId, range.minDate, range.maxDate,
        );
        if (result.success && !result.truncated && isTerminalSuccessState(result.serverSummaryState)) {
          const ids = sleepNights.map((n) => n.id);
          await this.ports.sleepDirtyNightRepository.clearByIds(ids);
          sleepNightsCleared = ids.length;
        } else if (!result.success) {
          errors.push(`Sleep hydration failed: ${result.error}`);
        } else if (result.truncated) {
          errors.push(`Sleep hydration truncated: ${result.itemsUpserted} items upserted but more remain`);
        } else if (!isTerminalSuccessState(result.serverSummaryState)) {
          errors.push(`Sleep hydration returned non-terminal server state '${result.serverSummaryState}': dirty keys preserved for retry`);
        }
      }
    }
    let productImpactHydrations = 0;
    if (affectedMetrics.size > 0 && this.ports.productImpactRepository) {
      for (const metricCode of affectedMetrics) {
        for (const periodDays of PRODUCT_IMPACT_PERIOD_DAYS) {
          try {
            const result = await this.ports.hydrationClient.hydrateProductImpact(userId, metricCode, periodDays);
            if (result.success) {
              productImpactHydrations += 1;
            } else {
              errors.push(`Product-impact hydration failed for ${metricCode}/${periodDays}d: ${result.error ?? 'Unknown error'}`);
            }
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            errors.push(`Product-impact hydration failed for ${metricCode}/${periodDays}d: ${message}`);
          }
        }
      }
    }
    if (rollupKeysProcessed > 0 || sleepNightsProcessed > 0 || productImpactHydrations > 0) {
      logger.info(`${LOG_PREFIX} Repair pass complete`, {
        rollupKeysProcessed, sleepNightsProcessed, rollupKeysCleared, sleepNightsCleared,
        productImpactHydrations, affectedMetrics: Array.from(affectedMetrics), errors,
      });
    }
    return {
      rollupKeysProcessed, sleepNightsProcessed, rollupKeysCleared, sleepNightsCleared,
      productImpactHydrations, errors,
    };
  }
  async hydrateRollupsIfNeeded(
    userId: string,
    metricCode: string,
    startDate: string,
    endDate: string,
  ): Promise<HydrationOutcome> {
    if (!this.ports.isTablesReady()) {
      return { success: false, truncated: false, serverState: 'UNKNOWN', error: 'Projection tables not ready', statusCounts: EMPTY_STATUS_COUNTS };
    }
    if (!this.ports.isOnline()) {
      return { success: false, truncated: false, serverState: 'UNKNOWN', error: 'Device is offline', statusCounts: EMPTY_STATUS_COUNTS };
    }
    try {
      const result = await this.ports.hydrationClient.hydrateRollups(
        userId, metricCode, startDate, endDate,
      );
      return {
        success: result.success,
        truncated: result.truncated,
        serverState: result.serverSummaryState,
        error: result.error ?? null,
        statusCounts: result.statusCounts,
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`${LOG_PREFIX} hydrateRollupsIfNeeded failed`, {
        metricCode, startDate, endDate, error: toLogError(error),
      });
      return { success: false, truncated: false, serverState: 'UNKNOWN', error: message, statusCounts: EMPTY_STATUS_COUNTS };
    }
  }
  async hydrateSleepIfNeeded(
    userId: string,
    startDate: string,
    endDate: string,
  ): Promise<HydrationOutcome> {
    if (!this.ports.isTablesReady()) {
      return { success: false, truncated: false, serverState: 'UNKNOWN', error: 'Projection tables not ready', statusCounts: EMPTY_STATUS_COUNTS };
    }
    if (!this.ports.isOnline()) {
      return { success: false, truncated: false, serverState: 'UNKNOWN', error: 'Device is offline', statusCounts: EMPTY_STATUS_COUNTS };
    }
    try {
      const result = await this.ports.hydrationClient.hydrateSleep(
        userId, startDate, endDate,
      );
      return {
        success: result.success,
        truncated: result.truncated,
        serverState: result.serverSummaryState,
        error: result.error ?? null,
        statusCounts: result.statusCounts,
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`${LOG_PREFIX} hydrateSleepIfNeeded failed`, {
        startDate, endDate, error: toLogError(error),
      });
      return { success: false, truncated: false, serverState: 'UNKNOWN', error: message, statusCounts: EMPTY_STATUS_COUNTS };
    }
  }
  async hydrateSessionImpactIfNeeded(
    userId: string,
    sessionId: string,
  ): Promise<HydrationOutcome> {
    if (!this.ports.isTablesReady()) {
      return { success: false, truncated: false, serverState: 'UNKNOWN', error: 'Projection tables not ready', statusCounts: EMPTY_STATUS_COUNTS };
    }
    if (!this.ports.isOnline()) {
      return { success: false, truncated: false, serverState: 'UNKNOWN', error: 'Device is offline', statusCounts: EMPTY_STATUS_COUNTS };
    }
    try {
      const result = await this.ports.hydrationClient.hydrateSessionImpact(
        userId, sessionId,
      );
      return {
        success: result.success,
        truncated: result.truncated,
        serverState: result.serverSummaryState,
        error: result.error ?? null,
        statusCounts: result.statusCounts,
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`${LOG_PREFIX} hydrateSessionImpactIfNeeded failed`, {
        sessionId, error: toLogError(error),
      });
      return { success: false, truncated: false, serverState: 'UNKNOWN', error: message, statusCounts: EMPTY_STATUS_COUNTS };
    }
  }
  async hydrateProductImpactIfNeeded(
    userId: string,
    metricCode: string,
    periodDays: number = 90,
  ): Promise<HydrationOutcome> {
    if (!this.ports.isTablesReady()) {
      return { success: false, truncated: false, serverState: 'UNKNOWN', error: 'Projection tables not ready', statusCounts: EMPTY_STATUS_COUNTS };
    }
    if (!this.ports.isOnline()) {
      return { success: false, truncated: false, serverState: 'UNKNOWN', error: 'Device is offline', statusCounts: EMPTY_STATUS_COUNTS };
    }
    try {
      const result = await this.ports.hydrationClient.hydrateProductImpact(
        userId, metricCode, periodDays,
      );
      return {
        success: result.success,
        truncated: result.truncated,
        serverState: result.serverSummaryState,
        error: result.error ?? null,
        statusCounts: result.statusCounts,
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`${LOG_PREFIX} hydrateProductImpactIfNeeded failed`, {
        metricCode, periodDays, error: toLogError(error),
      });
      return { success: false, truncated: false, serverState: 'UNKNOWN', error: message, statusCounts: EMPTY_STATUS_COUNTS };
    }
  }
  evaluateRollupStaleness(
    localData: ReadonlyArray<LocalHealthRollup>,
    _startDate: string,
    _endDate: string,
  ): StalenessEvaluation {
    if (!this.ports.isTablesReady()) {
      return { isStale: false, reason: 'tables_not_ready', oldestAgeMs: null };
    }
    if (localData.length === 0) {
      return { isStale: true, reason: 'no_data', oldestAgeMs: null };
    }
    const now = Date.now();
    let oldestFetchedAt = Infinity;
    for (const row of localData) {
      const fetchedAt = row.fetchedAt ?? 0;
      if (fetchedAt < oldestFetchedAt) {
        oldestFetchedAt = fetchedAt;
      }
    }
    const oldestAgeMs = oldestFetchedAt === Infinity ? null : now - oldestFetchedAt;
    const freshnessResult = evaluateServerFreshnessStatus(localData, oldestAgeMs);
    if (freshnessResult !== null) {
      return freshnessResult;
    }
    if (oldestAgeMs !== null && oldestAgeMs > STALE_THRESHOLD_MS) {
      return { isStale: true, reason: 'age_exceeded', oldestAgeMs };
    }
    return { isStale: false, reason: 'fresh', oldestAgeMs };
  }
  evaluateSleepStaleness(
    localData: ReadonlyArray<LocalSleepNightSummary>,
    _startDate: string,
    _endDate: string,
  ): StalenessEvaluation {
    if (!this.ports.isTablesReady()) {
      return { isStale: false, reason: 'tables_not_ready', oldestAgeMs: null };
    }
    if (localData.length === 0) {
      return { isStale: true, reason: 'no_data', oldestAgeMs: null };
    }
    const now = Date.now();
    let oldestFetchedAt = Infinity;
    for (const row of localData) {
      const fetchedAt = row.fetchedAt ?? 0;
      if (fetchedAt < oldestFetchedAt) {
        oldestFetchedAt = fetchedAt;
      }
    }
    const oldestAgeMs = oldestFetchedAt === Infinity ? null : now - oldestFetchedAt;
    const freshnessResult = evaluateServerFreshnessStatus(localData, oldestAgeMs);
    if (freshnessResult !== null) {
      return freshnessResult;
    }
    if (oldestAgeMs !== null && oldestAgeMs > STALE_THRESHOLD_MS) {
      return { isStale: true, reason: 'age_exceeded', oldestAgeMs };
    }
    return { isStale: false, reason: 'fresh', oldestAgeMs };
  }
  evaluateSessionImpactStaleness(
    localData: ReadonlyArray<LocalSessionImpact>,
    _sessionId: string,
  ): StalenessEvaluation {
    if (!this.ports.isTablesReady()) {
      return { isStale: false, reason: 'tables_not_ready', oldestAgeMs: null };
    }
    if (localData.length === 0) {
      return { isStale: true, reason: 'no_data', oldestAgeMs: null };
    }
    const now = Date.now();
    let oldestFetchedAt = Infinity;
    for (const row of localData) {
      const fetchedAt = row.fetchedAt ?? 0;
      if (fetchedAt < oldestFetchedAt) {
        oldestFetchedAt = fetchedAt;
      }
    }
    const oldestAgeMs = oldestFetchedAt === Infinity ? null : now - oldestFetchedAt;
    const freshnessResult = evaluateServerFreshnessStatus(localData, oldestAgeMs);
    if (freshnessResult !== null) {
      return freshnessResult;
    }
    if (oldestAgeMs !== null && oldestAgeMs > STALE_THRESHOLD_MS) {
      return { isStale: true, reason: 'age_exceeded', oldestAgeMs };
    }
    return { isStale: false, reason: 'fresh', oldestAgeMs };
  }
  evaluateProductImpactStaleness(
    localData: ReadonlyArray<LocalProductImpact>,
    _metricCode: string,
  ): StalenessEvaluation {
    if (!this.ports.isTablesReady()) {
      return { isStale: false, reason: 'tables_not_ready', oldestAgeMs: null };
    }
    if (localData.length === 0) {
      return { isStale: true, reason: 'no_data', oldestAgeMs: null };
    }
    const now = Date.now();
    let oldestFetchedAt = Infinity;
    for (const row of localData) {
      const fetchedAt = row.fetchedAt ?? 0;
      if (fetchedAt < oldestFetchedAt) {
        oldestFetchedAt = fetchedAt;
      }
    }
    const oldestAgeMs = oldestFetchedAt === Infinity ? null : now - oldestFetchedAt;
    const freshnessResult = evaluateServerFreshnessStatus(localData, oldestAgeMs);
    if (freshnessResult !== null) {
      return freshnessResult;
    }
    if (oldestAgeMs !== null && oldestAgeMs > STALE_THRESHOLD_MS) {
      return { isStale: true, reason: 'age_exceeded', oldestAgeMs };
    }
    return { isStale: false, reason: 'fresh', oldestAgeMs };
  }
  async hydrateInsightsIfNeeded(
    userId: string,
    domain: string,
    startDate: string,
    endDate: string,
  ): Promise<HydrationOutcome> {
    if (!this.ports.isTablesReady()) {
      return {
        success: false, truncated: false, serverState: 'UNKNOWN',
        error: 'Projection tables not ready',
        statusCounts: EMPTY_STATUS_COUNTS,
      };
    }
    if (!this.ports.isOnline()) {
      return {
        success: false, truncated: false, serverState: 'UNKNOWN',
        error: 'Device is offline',
        statusCounts: EMPTY_STATUS_COUNTS,
      };
    }
    try {
      const result = await this.ports.hydrationClient.hydrateInsights(
        userId, domain, startDate, endDate,
      );
      return {
        success: result.success,
        truncated: result.truncated,
        serverState: result.serverSummaryState,
        error: result.error ?? null,
        statusCounts: result.statusCounts,
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`${LOG_PREFIX} hydrateInsightsIfNeeded failed`, {
        domain, startDate, endDate, error: toLogError(error),
      });
      return {
        success: false, truncated: false, serverState: 'UNKNOWN',
        error: message,
        statusCounts: EMPTY_STATUS_COUNTS,
      };
    }
  }
  evaluateInsightStaleness(
    localData: ReadonlyArray<LocalHealthInsight>,
  ): StalenessEvaluation {
    if (!this.ports.isTablesReady()) {
      return { isStale: false, reason: 'tables_not_ready', oldestAgeMs: null };
    }
    if (localData.length === 0) {
      return { isStale: true, reason: 'no_data', oldestAgeMs: null };
    }
    const now = Date.now();
    let oldestFetchedAt = Infinity;
    for (const row of localData) {
      const fetchedAt = row.fetchedAt ?? 0;
      if (fetchedAt < oldestFetchedAt) {
        oldestFetchedAt = fetchedAt;
      }
    }
    const oldestAgeMs = oldestFetchedAt === Infinity ? null : now - oldestFetchedAt;
    const freshnessResult = evaluateServerFreshnessStatus(localData, oldestAgeMs);
    if (freshnessResult !== null) {
      return freshnessResult;
    }
    if (oldestAgeMs !== null && oldestAgeMs > STALE_THRESHOLD_MS) {
      return { isStale: true, reason: 'age_exceeded', oldestAgeMs };
    }
    return { isStale: false, reason: 'fresh', oldestAgeMs };
  }
}
