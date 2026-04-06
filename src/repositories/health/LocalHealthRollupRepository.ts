import { eq, and, gte, lte, asc, or } from 'drizzle-orm';
import type { DrizzleDB } from '../../db/client';
import {
  localHealthRollupDay,
  type DbLocalHealthRollupDay,
  type DbLocalHealthRollupDayInsert,
} from '../../db/schema';
import { BaseRepository } from '../BaseRepository';
import { logger } from '../../utils/logger';
import { canonicalizeCalendarDate } from './date-canonicalization';
import { reconcile } from '../../services/health/projection-reconciliation';
const CHUNK_SIZE = 50;
export interface LocalHealthRollup {
  readonly id: string;
  readonly userId: string;
  readonly metricCode: string;
  readonly dayUtc: string;
  readonly valueKind: string;
  readonly sumVal: number | null;
  readonly countVal: number;
  readonly minVal: number | null;
  readonly maxVal: number | null;
  readonly avgVal: number | null;
  readonly timezoneOffsetMin: number | null;
  readonly freshnessStatus: string;
  readonly computedAtIso: string | null;
  readonly sourceWatermark: string;
  readonly computeVersion: number;
  readonly dataQuality: string;
  readonly fetchedAt: number | null;
}
export interface RollupDtoInput {
  readonly id: string;
  readonly metricCode: string;
  readonly dayUtc: string;
  readonly valueKind: string;
  readonly sumVal: number | null;
  readonly countVal: number;
  readonly minVal: number | null;
  readonly maxVal: number | null;
  readonly avgVal: number | null;
  readonly timezoneOffsetMin: number | null;
  readonly freshness: {
    readonly status: string;
    readonly computedAtIso: string | null;
    readonly sourceWatermark: string;
    readonly computeVersion: number;
  };
  readonly dataQuality: string;
}
function toLocalHealthRollup(row: DbLocalHealthRollupDay): LocalHealthRollup {
  return {
    id: row.id,
    userId: row.userId,
    metricCode: row.metricCode,
    dayUtc: row.dayUtc,
    valueKind: row.valueKind,
    sumVal: row.sumVal,
    countVal: row.countVal,
    minVal: row.minVal,
    maxVal: row.maxVal,
    avgVal: row.avgVal,
    timezoneOffsetMin: row.timezoneOffsetMin,
    freshnessStatus: row.freshnessStatus,
    computedAtIso: row.computedAtIso,
    sourceWatermark: row.sourceWatermark,
    computeVersion: row.computeVersion,
    dataQuality: row.dataQuality,
    fetchedAt: row.fetchedAt,
  };
}
export class LocalHealthRollupRepository extends BaseRepository {
  constructor(drizzleDb: DrizzleDB) {
    super({ drizzleDb });
  }
  async upsertBatchFromDtos(
    userId: string,
    dtos: readonly RollupDtoInput[]
  ): Promise<number> {
    if (dtos.length === 0) return 0;
    const drizzle = this.getDrizzle();
    const now = Date.now();
    let upsertedCount = 0;
    let skippedByReconciliation = 0;
    const naturalKeyMap = new Map<string, DbLocalHealthRollupDay>();
    for (let i = 0; i < dtos.length; i += CHUNK_SIZE) {
      const chunk = dtos.slice(i, i + CHUNK_SIZE);
      const conditions = chunk.map(dto => {
        const canonicalDay = canonicalizeCalendarDate(dto.dayUtc);
        return and(
          eq(localHealthRollupDay.userId, userId),
          eq(localHealthRollupDay.metricCode, dto.metricCode),
          eq(localHealthRollupDay.dayUtc, canonicalDay),
        );
      });
      if (conditions.length > 0) {
        const existingRows = await drizzle
          .select()
          .from(localHealthRollupDay)
          .where(or(...conditions));
        for (const row of existingRows) {
          const key = `${row.userId}|${row.metricCode}|${row.dayUtc}`;
          naturalKeyMap.set(key, row);
        }
      }
    }
    for (let i = 0; i < dtos.length; i += CHUNK_SIZE) {
      const chunk = dtos.slice(i, i + CHUNK_SIZE);
      for (const dto of chunk) {
        const canonicalDayUtc = canonicalizeCalendarDate(dto.dayUtc);
        const naturalKey = `${userId}|${dto.metricCode}|${canonicalDayUtc}`;
        const existingLocal = naturalKeyMap.get(naturalKey);
        if (existingLocal) {
          const decision = reconcile(
            {
              computeVersion: existingLocal.computeVersion,
              sourceWatermark: existingLocal.sourceWatermark,
            },
            {
              computeVersion: dto.freshness.computeVersion,
              sourceWatermark: dto.freshness.sourceWatermark,
            },
          );
          if (decision.action === 'KEEP_LOCAL') {
            skippedByReconciliation++;
            continue; 
          }
        }
        const row: DbLocalHealthRollupDayInsert = {
          id: dto.id,
          userId,
          metricCode: dto.metricCode,
          dayUtc: canonicalDayUtc,
          valueKind: dto.valueKind,
          sumVal: dto.sumVal,
          countVal: dto.countVal,
          minVal: dto.minVal,
          maxVal: dto.maxVal,
          avgVal: dto.avgVal,
          timezoneOffsetMin: dto.timezoneOffsetMin,
          freshnessStatus: dto.freshness.status,
          computedAtIso: dto.freshness.computedAtIso,
          sourceWatermark: dto.freshness.sourceWatermark,
          computeVersion: dto.freshness.computeVersion,
          dataQuality: dto.dataQuality,
          fetchedAt: now,
          updatedAt: now,
        };
        await drizzle
          .insert(localHealthRollupDay)
          .values(row)
          .onConflictDoUpdate({
            target: [
              localHealthRollupDay.userId,
              localHealthRollupDay.metricCode,
              localHealthRollupDay.dayUtc,
            ],
            set: {
              id: row.id,
              valueKind: row.valueKind,
              sumVal: row.sumVal,
              countVal: row.countVal,
              minVal: row.minVal,
              maxVal: row.maxVal,
              avgVal: row.avgVal,
              timezoneOffsetMin: row.timezoneOffsetMin,
              freshnessStatus: row.freshnessStatus,
              computedAtIso: row.computedAtIso,
              sourceWatermark: row.sourceWatermark,
              computeVersion: row.computeVersion,
              dataQuality: row.dataQuality,
              fetchedAt: now,
              updatedAt: now,
            },
          });
        upsertedCount++;
      }
    }
    if (skippedByReconciliation > 0) {
      logger.debug('[LocalHealthRollupRepository] Reconciliation skipped stale server DTOs', {
        userId,
        skippedByReconciliation,
        upsertedCount,
      });
    }
    logger.debug('[LocalHealthRollupRepository] Upserted rollups', {
      userId,
      count: upsertedCount,
    });
    return upsertedCount;
  }
  async queryByMetricAndDateRange(
    userId: string,
    metricCode: string,
    startDate: string,
    endDate: string
  ): Promise<LocalHealthRollup[]> {
    const drizzle = this.getDrizzle();
    const rows = await drizzle
      .select()
      .from(localHealthRollupDay)
      .where(
        and(
          eq(localHealthRollupDay.userId, userId),
          eq(localHealthRollupDay.metricCode, metricCode),
          gte(localHealthRollupDay.dayUtc, startDate),
          lte(localHealthRollupDay.dayUtc, endDate),
        )
      )
      .orderBy(asc(localHealthRollupDay.dayUtc));
    return rows.map(toLocalHealthRollup);
  }
  async queryByDateRange(
    userId: string,
    startDate: string,
    endDate: string
  ): Promise<LocalHealthRollup[]> {
    const drizzle = this.getDrizzle();
    const rows = await drizzle
      .select()
      .from(localHealthRollupDay)
      .where(
        and(
          eq(localHealthRollupDay.userId, userId),
          gte(localHealthRollupDay.dayUtc, startDate),
          lte(localHealthRollupDay.dayUtc, endDate),
        )
      )
      .orderBy(
        asc(localHealthRollupDay.dayUtc),
        asc(localHealthRollupDay.metricCode),
      );
    return rows.map(toLocalHealthRollup);
  }
  async getByNaturalKey(
    userId: string,
    metricCode: string,
    dayUtc: string
  ): Promise<LocalHealthRollup | null> {
    const drizzle = this.getDrizzle();
    const rows = await drizzle
      .select()
      .from(localHealthRollupDay)
      .where(
        and(
          eq(localHealthRollupDay.userId, userId),
          eq(localHealthRollupDay.metricCode, metricCode),
          eq(localHealthRollupDay.dayUtc, dayUtc),
        )
      )
      .limit(1);
    const first = rows[0];
    return first != null ? toLocalHealthRollup(first) : null;
  }
  async deleteByUser(userId: string): Promise<void> {
    const drizzle = this.getDrizzle();
    await drizzle
      .delete(localHealthRollupDay)
      .where(eq(localHealthRollupDay.userId, userId));
    logger.debug('[LocalHealthRollupRepository] Deleted all rollups for user', { userId });
  }
}
