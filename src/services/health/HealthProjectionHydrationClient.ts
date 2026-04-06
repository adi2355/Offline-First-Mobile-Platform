import { z } from 'zod';
import { logger, toLogError } from '../../utils/logger';
import type { LocalHealthRollupRepository, RollupDtoInput } from '../../repositories/health/LocalHealthRollupRepository';
import type { LocalSleepNightSummaryRepository, SleepNightDtoInput } from '../../repositories/health/LocalSleepNightSummaryRepository';
import type { LocalSessionImpactRepository, SessionImpactDtoInput } from '../../repositories/health/LocalSessionImpactRepository';
import type { LocalProductImpactRepository, ProductImpactDtoInput } from '../../repositories/health/LocalProductImpactRepository';
import type { LocalHealthInsightRepository, InsightDtoInput } from '../../repositories/health/LocalHealthInsightRepository';
import type { BackendAPIClient } from '../api/BackendAPIClient';
import { isTerminalSuccessState, periodDaysToApiParam, EMPTY_STATUS_COUNTS } from './projection-state-classification';
import type { StatusCounts } from './projection-state-classification';
const HYDRATION_PAGE_SIZE = 500;
const MAX_HYDRATION_PAGES = 20;
const LOG_PREFIX = '[HealthProjectionHydrationClient]';
const FreshnessMetaSchema = z.object({
  status: z.enum(['READY', 'COMPUTING', 'STALE', 'FAILED', 'NO_DATA']),
  computedAtIso: z.string().nullable(),
  sourceWatermark: z.string(),
  computeVersion: z.number(),
});
const PaginationMetaSchema = z.object({
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
  returnedCount: z.number(),
});
const SummarySchema = z.object({
  state: z.enum(['READY', 'COMPUTING', 'STALE', 'NO_DATA', 'PARTIAL', 'EMPTY', 'FAILED']),
  totalItems: z.number(),
  statusCounts: z.object({
    ready: z.number(),
    computing: z.number(),
    noData: z.number(),
    failed: z.number(),
    stale: z.number(),
  }),
});
const RollupItemSchema = z.object({
  id: z.string(),
  metricCode: z.string(),
  dayUtc: z.string(),
  valueKind: z.string(),
  sumVal: z.number().nullable(),
  countVal: z.number(),
  minVal: z.number().nullable(),
  maxVal: z.number().nullable(),
  avgVal: z.number().nullable(),
  timezoneOffsetMin: z.number().nullable(),
  freshness: FreshnessMetaSchema,
  dataQuality: z.enum(['FULL', 'PARTIAL_TRUNCATED']),
});
const RollupHydrationResponseSchema = z.object({
  items: z.array(RollupItemSchema),
  summary: SummarySchema,
  pagination: PaginationMetaSchema,
});
const SleepItemSchema = z.object({
  id: z.string(),
  nightLocalDate: z.string(),
  timezoneOffsetMin: z.number(),
  sleepStartTs: z.string().nullable(),
  sleepEndTs: z.string().nullable(),
  inBedStartTs: z.string().nullable(),
  inBedEndTs: z.string().nullable(),
  totalSleepMin: z.number().nullable(),
  inBedMin: z.number().nullable(),
  awakeMin: z.number().nullable(),
  remMin: z.number().nullable(),
  deepMin: z.number().nullable(),
  lightMin: z.number().nullable(),
  sleepEfficiency: z.number().nullable(),
  wakeEvents: z.number().nullable(),
  sleepLatencyMin: z.number().nullable(),
  hadSessionBefore: z.boolean(),
  sessionIdBefore: z.string().nullable(),
  hoursBeforeBed: z.number().nullable(),
  hasRemData: z.boolean(),
  hasDeepData: z.boolean(),
  hasLightData: z.boolean(),
  hasAwakeData: z.boolean(),
  canonicalSourceId: z.string().nullable(),
  sourceCount: z.number(),
  sourceCoverage: z.number().nullable(),
  dataQualityScore: z.number().nullable(),
  freshness: FreshnessMetaSchema,
  dataQuality: z.enum(['FULL', 'PARTIAL_TRUNCATED']),
});
const SleepHydrationResponseSchema = z.object({
  items: z.array(SleepItemSchema),
  summary: SummarySchema,
});
const SessionImpactItemSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  metricCode: z.string(),
  windowMinutes: z.number(),
  resolution: z.string(),
  avgBefore: z.number().nullable(),
  minBefore: z.number().nullable(),
  maxBefore: z.number().nullable(),
  countBefore: z.number(),
  avgDuring: z.number().nullable(),
  minDuring: z.number().nullable(),
  maxDuring: z.number().nullable(),
  countDuring: z.number(),
  avgAfter: z.number().nullable(),
  minAfter: z.number().nullable(),
  maxAfter: z.number().nullable(),
  countAfter: z.number(),
  deltaDuringAbs: z.number().nullable(),
  deltaDuringPct: z.number().nullable(),
  deltaAfterAbs: z.number().nullable(),
  deltaAfterPct: z.number().nullable(),
  beforeCoverage: z.number().nullable(),
  duringCoverage: z.number().nullable(),
  afterCoverage: z.number().nullable(),
  hasSignificantGaps: z.boolean(),
  isReliable: z.boolean(),
  freshness: FreshnessMetaSchema,
  dataQuality: z.enum(['FULL', 'PARTIAL_TRUNCATED']),
});
const SessionImpactHydrationResponseSchema = z.object({
  items: z.array(SessionImpactItemSchema),
  summary: SummarySchema,
});
const ProductImpactItemSchema = z.object({
  id: z.string(),
  productId: z.string(),
  productName: z.string(),
  productType: z.string(),
  variantGenetics: z.string().nullable(),
  metricCode: z.string(),
  windowMinutes: z.number(),
  resolution: z.string(),
  periodDays: z.number(),
  periodStart: z.string().nullable(),
  periodEnd: z.string().nullable(),
  sessionCount: z.number(),
  minSessionsRequired: z.number(),
  avgDeltaDuringAbs: z.number().nullable(),
  avgDeltaDuringPct: z.number().nullable(),
  avgDeltaAfterAbs: z.number().nullable(),
  avgDeltaAfterPct: z.number().nullable(),
  medianDeltaAfterPct: z.number().nullable(),
  baselineValue: z.number().nullable(),
  baselineMethod: z.string().nullable(),
  baselineN: z.number().nullable(),
  baselineWindow: z.string().nullable(),
  coverageScore: z.number().nullable(),
  isReliable: z.boolean(),
  qualityFlags: z.array(z.string()),
  exactness: z.string(),
  confidenceTier: z.string(),
  confidenceScore: z.number().nullable(),
  ciLow: z.number().nullable(),
  ciHigh: z.number().nullable(),
  freshness: FreshnessMetaSchema,
  dataQuality: z.enum(['FULL', 'PARTIAL_TRUNCATED']),
  evidenceSessionCount: z.number(),
  evidenceSessionIds: z.array(z.string()),
});
const ProductImpactHydrationResponseSchema = z.object({
  items: z.array(ProductImpactItemSchema),
  summary: SummarySchema,
});
const InsightEvidenceSchema = z.object({
  metricCode: z.string(),
  dataPointCount: z.number(),
  supportingMetrics: z.record(z.number()),
  sessionCount: z.number().nullable(),
  productName: z.string().nullable(),
  productId: z.string().nullable(),
});
const InsightItemSchema = z.object({
  insightId: z.string(),
  domain: z.string(),
  insightType: z.enum(['trend', 'session_correlation', 'product_effect', 'anomaly']),
  icon: z.string(),
  metric: z.string(),
  description: z.string(),
  displayType: z.enum(['primary', 'secondary', 'positive', 'negative']),
  confidenceTier: z.enum(['high', 'medium', 'low']),
  evidence: InsightEvidenceSchema,
  freshness: FreshnessMetaSchema,
  dataQuality: z.enum(['FULL', 'PARTIAL_TRUNCATED']),
  dateRange: z.object({ startDate: z.string(), endDate: z.string() }),
  generatedAt: z.string(),
});
const InsightHydrationResponseSchema = z.object({
  items: z.array(InsightItemSchema),
  summary: SummarySchema,
});
export type ProjectionServerState =
  | 'UNKNOWN'
  | 'READY'
  | 'COMPUTING'
  | 'STALE'
  | 'FAILED'
  | 'NO_DATA'
  | 'PARTIAL'
  | 'EMPTY';
export interface HydrationResult {
  readonly success: boolean;
  readonly truncated: boolean;
  readonly itemsUpserted: number;
  readonly pagesConsumed: number;
  readonly error?: string;
  readonly serverSummaryState: ProjectionServerState;
  readonly statusCounts: StatusCounts;
}
export interface HealthProjectionHydrationClientPorts {
  readonly apiClient: BackendAPIClient;
  readonly rollupRepository: LocalHealthRollupRepository;
  readonly sleepRepository: LocalSleepNightSummaryRepository;
  readonly sessionImpactRepository: LocalSessionImpactRepository;
  readonly productImpactRepository: LocalProductImpactRepository;
  readonly insightRepository: LocalHealthInsightRepository;
  readonly isTablesReady: () => boolean;
}
const KNOWN_SERVER_STATES = new Set<ProjectionServerState>([
  'READY', 'COMPUTING', 'STALE', 'FAILED', 'NO_DATA', 'PARTIAL', 'EMPTY',
]);
function normalizeServerState(raw: string): ProjectionServerState {
  const upper = raw.toUpperCase() as ProjectionServerState;
  return KNOWN_SERVER_STATES.has(upper) ? upper : 'UNKNOWN';
}
export class HealthProjectionHydrationClient {
  constructor(private readonly ports: HealthProjectionHydrationClientPorts) {}
  async hydrateRollups(
    userId: string,
    metricCode: string,
    startDate: string,
    endDate: string,
  ): Promise<HydrationResult> {
    if (!this.ports.isTablesReady()) {
      return { success: false, truncated: false, itemsUpserted: 0, pagesConsumed: 0, error: 'Projection tables not ready', serverSummaryState: 'UNKNOWN', statusCounts: EMPTY_STATUS_COUNTS };
    }
    let cursor: string | undefined;
    let totalUpserted = 0;
    let pagesConsumed = 0;
    let truncated = false;
    let lastServerState: ProjectionServerState = 'UNKNOWN';
    let lastStatusCounts: StatusCounts = EMPTY_STATUS_COUNTS;
    try {
      do {
        if (pagesConsumed >= MAX_HYDRATION_PAGES) {
          logger.warn(`${LOG_PREFIX} Rollup hydration reached MAX_HYDRATION_PAGES — hydration is partial`, {
            metricCode, startDate, endDate, pagesConsumed,
          });
          truncated = true;
          break;
        }
        const params: Record<string, unknown> = {
          metricCode,
          startDate,
          endDate,
          limit: HYDRATION_PAGE_SIZE,
        };
        if (cursor) {
          params.cursor = cursor;
        }
        const response = await this.ports.apiClient.get<{ data: unknown }>(
          '/health/rollups',
          { params },
        );
        const parsed = RollupHydrationResponseSchema.safeParse(
          (response.data as { data?: unknown })?.data ?? response.data
        );
        if (!parsed.success) {
          logger.error(`${LOG_PREFIX} Rollup response validation failed`, {
            error: toLogError(parsed.error.message),
            metricCode, startDate, endDate, page: pagesConsumed,
          });
          return {
            success: false,
            truncated: false,
            itemsUpserted: totalUpserted,
            pagesConsumed,
            error: `Response validation failed: ${parsed.error.message}`,
            serverSummaryState: lastServerState,
            statusCounts: lastStatusCounts,
          };
        }
        const { items, summary, pagination } = parsed.data;
        lastServerState = normalizeServerState(summary.state);
        lastStatusCounts = summary.statusCounts;
        if (items.length > 0) {
          const dtos: RollupDtoInput[] = items.map((item) => ({
            id: item.id,
            metricCode: item.metricCode,
            dayUtc: item.dayUtc,
            valueKind: item.valueKind,
            sumVal: item.sumVal,
            countVal: item.countVal,
            minVal: item.minVal,
            maxVal: item.maxVal,
            avgVal: item.avgVal,
            timezoneOffsetMin: item.timezoneOffsetMin,
            freshness: {
              status: item.freshness.status,
              computedAtIso: item.freshness.computedAtIso,
              sourceWatermark: item.freshness.sourceWatermark,
              computeVersion: item.freshness.computeVersion,
            },
            dataQuality: item.dataQuality,
          }));
          await this.ports.rollupRepository.upsertBatchFromDtos(userId, dtos);
          totalUpserted += items.length;
        }
        pagesConsumed++;
        cursor = pagination.hasMore && pagination.nextCursor ? pagination.nextCursor : undefined;
      } while (cursor);
      logger.info(`${LOG_PREFIX} Rollup hydration complete`, {
        metricCode, startDate, endDate, totalUpserted, pagesConsumed, truncated, serverState: lastServerState,
      });
      return { success: true, truncated, itemsUpserted: totalUpserted, pagesConsumed, serverSummaryState: lastServerState, statusCounts: lastStatusCounts };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`${LOG_PREFIX} Rollup hydration failed`, {
        metricCode, startDate, endDate, error: toLogError(error), totalUpserted, pagesConsumed,
      });
      return {
        success: false,
        truncated: false,
        itemsUpserted: totalUpserted,
        pagesConsumed,
        error: message,
        serverSummaryState: lastServerState,
        statusCounts: lastStatusCounts,
      };
    }
  }
  async hydrateSleep(
    userId: string,
    startDate: string,
    endDate: string,
  ): Promise<HydrationResult> {
    if (!this.ports.isTablesReady()) {
      return { success: false, truncated: false, itemsUpserted: 0, pagesConsumed: 0, error: 'Projection tables not ready', serverSummaryState: 'UNKNOWN', statusCounts: EMPTY_STATUS_COUNTS };
    }
    try {
      const response = await this.ports.apiClient.get<{ data: unknown }>(
        '/health/sleep',
        { params: { startDate, endDate } },
      );
      const parsed = SleepHydrationResponseSchema.safeParse(
        (response.data as { data?: unknown })?.data ?? response.data
      );
      if (!parsed.success) {
        logger.error(`${LOG_PREFIX} Sleep response validation failed`, {
          error: toLogError(parsed.error.message), startDate, endDate,
        });
        return {
          success: false,
          truncated: false,
          itemsUpserted: 0,
          pagesConsumed: 1,
          error: `Response validation failed: ${parsed.error.message}`,
          serverSummaryState: 'UNKNOWN',
          statusCounts: EMPTY_STATUS_COUNTS,
        };
      }
      const { items, summary } = parsed.data;
      const serverState = normalizeServerState(summary.state);
      if (items.length > 0) {
        const dtos: SleepNightDtoInput[] = items.map((item) => ({
          id: item.id,
          nightLocalDate: item.nightLocalDate,
          timezoneOffsetMin: item.timezoneOffsetMin,
          sleepStartTs: item.sleepStartTs,
          sleepEndTs: item.sleepEndTs,
          inBedStartTs: item.inBedStartTs,
          inBedEndTs: item.inBedEndTs,
          totalSleepMin: item.totalSleepMin,
          inBedMin: item.inBedMin,
          awakeMin: item.awakeMin,
          remMin: item.remMin,
          deepMin: item.deepMin,
          lightMin: item.lightMin,
          sleepEfficiency: item.sleepEfficiency,
          wakeEvents: item.wakeEvents,
          sleepLatencyMin: item.sleepLatencyMin,
          hadSessionBefore: item.hadSessionBefore,
          sessionIdBefore: item.sessionIdBefore,
          hoursBeforeBed: item.hoursBeforeBed,
          hasRemData: item.hasRemData,
          hasDeepData: item.hasDeepData,
          hasLightData: item.hasLightData,
          hasAwakeData: item.hasAwakeData,
          canonicalSourceId: item.canonicalSourceId,
          sourceCount: item.sourceCount,
          sourceCoverage: item.sourceCoverage,
          dataQualityScore: item.dataQualityScore,
          freshness: {
            status: item.freshness.status,
            computedAtIso: item.freshness.computedAtIso,
            sourceWatermark: item.freshness.sourceWatermark,
            computeVersion: item.freshness.computeVersion,
          },
          dataQuality: item.dataQuality,
        }));
        await this.ports.sleepRepository.upsertBatchFromDtos(userId, dtos);
      }
      logger.info(`${LOG_PREFIX} Sleep hydration complete`, {
        startDate, endDate, itemsUpserted: items.length, serverState,
      });
      return { success: true, truncated: false, itemsUpserted: items.length, pagesConsumed: 1, serverSummaryState: serverState, statusCounts: summary.statusCounts };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`${LOG_PREFIX} Sleep hydration failed`, {
        startDate, endDate, error: toLogError(error),
      });
      return { success: false, truncated: false, itemsUpserted: 0, pagesConsumed: 1, error: message, serverSummaryState: 'UNKNOWN', statusCounts: EMPTY_STATUS_COUNTS };
    }
  }
  async hydrateSessionImpact(
    userId: string,
    sessionId: string,
  ): Promise<HydrationResult> {
    if (!this.ports.isTablesReady()) {
      return { success: false, truncated: false, itemsUpserted: 0, pagesConsumed: 0, error: 'Projection tables not ready', serverSummaryState: 'UNKNOWN', statusCounts: EMPTY_STATUS_COUNTS };
    }
    try {
      const response = await this.ports.apiClient.get<{ data: unknown }>(
        '/health/session-impact',
        { params: { sessionId } },
      );
      const parsed = SessionImpactHydrationResponseSchema.safeParse(
        (response.data as { data?: unknown })?.data ?? response.data
      );
      if (!parsed.success) {
        logger.error(`${LOG_PREFIX} Session impact response validation failed`, {
          error: toLogError(parsed.error.message), sessionId,
        });
        return {
          success: false,
          truncated: false,
          itemsUpserted: 0,
          pagesConsumed: 1,
          error: `Response validation failed: ${parsed.error.message}`,
          serverSummaryState: 'UNKNOWN',
          statusCounts: EMPTY_STATUS_COUNTS,
        };
      }
      const { items, summary } = parsed.data;
      const serverState = normalizeServerState(summary.state);
      if (items.length > 0) {
        const dtos: SessionImpactDtoInput[] = items.map((item) => ({
          id: item.id,
          sessionId: item.sessionId,
          metricCode: item.metricCode,
          windowMinutes: item.windowMinutes,
          resolution: item.resolution,
          avgBefore: item.avgBefore,
          minBefore: item.minBefore,
          maxBefore: item.maxBefore,
          countBefore: item.countBefore,
          avgDuring: item.avgDuring,
          minDuring: item.minDuring,
          maxDuring: item.maxDuring,
          countDuring: item.countDuring,
          avgAfter: item.avgAfter,
          minAfter: item.minAfter,
          maxAfter: item.maxAfter,
          countAfter: item.countAfter,
          deltaDuringAbs: item.deltaDuringAbs,
          deltaDuringPct: item.deltaDuringPct,
          deltaAfterAbs: item.deltaAfterAbs,
          deltaAfterPct: item.deltaAfterPct,
          beforeCoverage: item.beforeCoverage,
          duringCoverage: item.duringCoverage,
          afterCoverage: item.afterCoverage,
          hasSignificantGaps: item.hasSignificantGaps,
          isReliable: item.isReliable,
          freshness: {
            status: item.freshness.status,
            computedAtIso: item.freshness.computedAtIso,
            sourceWatermark: item.freshness.sourceWatermark,
            computeVersion: item.freshness.computeVersion,
          },
          dataQuality: item.dataQuality,
        }));
        await this.ports.sessionImpactRepository.upsertBatchFromDtos(userId, dtos);
      }
      logger.info(`${LOG_PREFIX} Session impact hydration complete`, {
        sessionId, itemsUpserted: items.length, serverState,
      });
      return { success: true, truncated: false, itemsUpserted: items.length, pagesConsumed: 1, serverSummaryState: serverState, statusCounts: summary.statusCounts };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`${LOG_PREFIX} Session impact hydration failed`, {
        sessionId, error: toLogError(error),
      });
      return { success: false, truncated: false, itemsUpserted: 0, pagesConsumed: 1, error: message, serverSummaryState: 'UNKNOWN', statusCounts: EMPTY_STATUS_COUNTS };
    }
  }
  async hydrateProductImpact(
    userId: string,
    metricCode: string,
    periodDays: number = 90,
  ): Promise<HydrationResult> {
    if (!this.ports.isTablesReady()) {
      return { success: false, truncated: false, itemsUpserted: 0, pagesConsumed: 0, error: 'Projection tables not ready', serverSummaryState: 'UNKNOWN', statusCounts: EMPTY_STATUS_COUNTS };
    }
    const periodKey = periodDaysToApiParam(periodDays);
    try {
      const response = await this.ports.apiClient.get<{ data: unknown }>(
        '/health/impact/by-product',
        { params: { metricCode, period: periodKey } },
      );
      const parsed = ProductImpactHydrationResponseSchema.safeParse(
        (response.data as { data?: unknown })?.data ?? response.data
      );
      if (!parsed.success) {
        logger.error(`${LOG_PREFIX} Product impact response validation failed`, {
          error: toLogError(parsed.error.message), metricCode, periodDays,
        });
        return {
          success: false,
          truncated: false,
          itemsUpserted: 0,
          pagesConsumed: 1,
          error: `Response validation failed: ${parsed.error.message}`,
          serverSummaryState: 'UNKNOWN',
          statusCounts: EMPTY_STATUS_COUNTS,
        };
      }
      const { items, summary } = parsed.data;
      const serverState = normalizeServerState(summary.state);
      const dtos: ProductImpactDtoInput[] = items.map((item) => ({
        id: item.id,
        productId: item.productId,
        productName: item.productName,
        productType: item.productType,
        variantGenetics: item.variantGenetics,
        metricCode: item.metricCode,
        windowMinutes: item.windowMinutes,
        resolution: item.resolution,
        periodDays: item.periodDays,
        periodStart: item.periodStart,
        periodEnd: item.periodEnd,
        sessionCount: item.sessionCount,
        minSessionsRequired: item.minSessionsRequired,
        avgDeltaDuringAbs: item.avgDeltaDuringAbs,
        avgDeltaDuringPct: item.avgDeltaDuringPct,
        avgDeltaAfterAbs: item.avgDeltaAfterAbs,
        avgDeltaAfterPct: item.avgDeltaAfterPct,
        medianDeltaAfterPct: item.medianDeltaAfterPct,
        baselineValue: item.baselineValue,
        baselineMethod: item.baselineMethod,
        baselineN: item.baselineN,
        baselineWindow: item.baselineWindow,
        coverageScore: item.coverageScore,
        isReliable: item.isReliable,
        qualityFlags: item.qualityFlags,
        exactness: item.exactness,
        confidenceTier: item.confidenceTier,
        confidenceScore: item.confidenceScore,
        ciLow: item.ciLow,
        ciHigh: item.ciHigh,
        freshness: {
          status: item.freshness.status,
          computedAtIso: item.freshness.computedAtIso,
          sourceWatermark: item.freshness.sourceWatermark,
          computeVersion: item.freshness.computeVersion,
        },
        dataQuality: item.dataQuality,
        evidenceSessionCount: item.evidenceSessionCount,
        evidenceSessionIds: item.evidenceSessionIds,
      }));
      let orphansPruned = 0;
      if (isTerminalSuccessState(serverState)) {
        const retainedProductIds = new Set(items.map((item) => item.productId));
        const result = await this.ports.productImpactRepository.upsertAndPruneScope(userId, dtos, {
          metricCode, periodDays, retainedProductIds,
        });
        orphansPruned = result.pruned;
      } else if (dtos.length > 0) {
        await this.ports.productImpactRepository.upsertBatchFromDtos(userId, dtos);
      }
      logger.info(`${LOG_PREFIX} Product impact hydration complete`, {
        metricCode, periodDays, itemsUpserted: items.length, orphansPruned, serverState,
      });
      return { success: true, truncated: false, itemsUpserted: items.length, pagesConsumed: 1, serverSummaryState: serverState, statusCounts: summary.statusCounts };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`${LOG_PREFIX} Product impact hydration failed`, {
        metricCode, periodDays, error: toLogError(error),
      });
      return { success: false, truncated: false, itemsUpserted: 0, pagesConsumed: 1, error: message, serverSummaryState: 'UNKNOWN', statusCounts: EMPTY_STATUS_COUNTS };
    }
  }
  async hydrateInsights(
    userId: string,
    domain: string,
    startDate: string,
    endDate: string,
  ): Promise<HydrationResult> {
    if (!this.ports.isTablesReady()) {
      return {
        success: false, truncated: false, itemsUpserted: 0, pagesConsumed: 0,
        error: 'Projection tables not ready',
        serverSummaryState: 'UNKNOWN', statusCounts: EMPTY_STATUS_COUNTS,
      };
    }
    try {
      const response = await this.ports.apiClient.get<{ data: unknown }>(
        '/health/insights',
        { params: { domain, startDate, endDate } },
      );
      const parsed = InsightHydrationResponseSchema.safeParse(
        (response.data as { data?: unknown })?.data ?? response.data,
      );
      if (!parsed.success) {
        logger.error(`${LOG_PREFIX} Insight response validation failed`, {
          error: toLogError(parsed.error.message), domain, startDate, endDate,
        });
        return {
          success: false, truncated: false, itemsUpserted: 0, pagesConsumed: 1,
          error: `Response validation failed: ${parsed.error.message}`,
          serverSummaryState: 'UNKNOWN', statusCounts: EMPTY_STATUS_COUNTS,
        };
      }
      const { items, summary } = parsed.data;
      const serverState = normalizeServerState(summary.state);
      const dtos: InsightDtoInput[] = items.map((item) => ({
        insightId: item.insightId,
        domain: item.domain,
        insightType: item.insightType,
        icon: item.icon,
        metric: item.metric,
        description: item.description,
        displayType: item.displayType,
        confidenceTier: item.confidenceTier,
        evidence: item.evidence,
        freshness: item.freshness,
        dataQuality: item.dataQuality,
        dateRange: item.dateRange,
        generatedAt: item.generatedAt,
      }));
      let orphansPruned = 0;
      if (isTerminalSuccessState(serverState)) {
        const retainedIds = new Set(items.map((item) => item.insightId));
        const result = await this.ports.insightRepository.upsertAndPruneScope(userId, dtos, {
          domain, startDate, endDate, retainedIds,
        });
        orphansPruned = result.pruned;
      } else if (dtos.length > 0) {
        await this.ports.insightRepository.upsertBatchFromDtos(userId, dtos);
      }
      logger.info(`${LOG_PREFIX} Insight hydration complete`, {
        domain, startDate, endDate, itemsUpserted: items.length, orphansPruned, serverState,
      });
      return {
        success: true, truncated: false, itemsUpserted: items.length, pagesConsumed: 1,
        serverSummaryState: serverState, statusCounts: summary.statusCounts,
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`${LOG_PREFIX} Insight hydration failed`, {
        domain, startDate, endDate, error: toLogError(error),
      });
      return {
        success: false, truncated: false, itemsUpserted: 0, pagesConsumed: 1,
        error: message, serverSummaryState: 'UNKNOWN', statusCounts: EMPTY_STATUS_COUNTS,
      };
    }
  }
}
