import { eq, and, gte, lte, desc, or } from 'drizzle-orm';
import type { DrizzleDB } from '../../db/client';
import {
  localSleepNightSummary,
  type DbLocalSleepNightSummary,
  type DbLocalSleepNightSummaryInsert,
} from '../../db/schema';
import { BaseRepository } from '../BaseRepository';
import { logger } from '../../utils/logger';
import { canonicalizeCalendarDate } from './date-canonicalization';
import { reconcileWithCoverage } from '../../services/health/projection-reconciliation';
const CHUNK_SIZE = 50;
export interface LocalSleepNightSummary {
  readonly id: string;
  readonly userId: string;
  readonly nightLocalDate: string;
  readonly timezoneOffsetMin: number;
  readonly sleepStartTs: string | null;
  readonly sleepEndTs: string | null;
  readonly inBedStartTs: string | null;
  readonly inBedEndTs: string | null;
  readonly totalSleepMin: number | null;
  readonly inBedMin: number | null;
  readonly awakeMin: number | null;
  readonly remMin: number | null;
  readonly deepMin: number | null;
  readonly lightMin: number | null;
  readonly sleepEfficiency: number | null;
  readonly wakeEvents: number | null;
  readonly sleepLatencyMin: number | null;
  readonly hadSessionBefore: boolean;
  readonly sessionIdBefore: string | null;
  readonly hoursBeforeBed: number | null;
  readonly hasRemData: boolean;
  readonly hasDeepData: boolean;
  readonly hasLightData: boolean;
  readonly hasAwakeData: boolean;
  readonly canonicalSourceId: string | null;
  readonly sourceCount: number;
  readonly sourceCoverage: number | null;
  readonly dataQualityScore: number | null;
  readonly freshnessStatus: string;
  readonly computedAtIso: string | null;
  readonly sourceWatermark: string;
  readonly computeVersion: number;
  readonly dataQuality: string;
  readonly fetchedAt: number | null;
}
export interface SleepNightDtoInput {
  readonly id: string;
  readonly nightLocalDate: string;
  readonly timezoneOffsetMin: number;
  readonly sleepStartTs: string | null;
  readonly sleepEndTs: string | null;
  readonly inBedStartTs: string | null;
  readonly inBedEndTs: string | null;
  readonly totalSleepMin: number | null;
  readonly inBedMin: number | null;
  readonly awakeMin: number | null;
  readonly remMin: number | null;
  readonly deepMin: number | null;
  readonly lightMin: number | null;
  readonly sleepEfficiency: number | null;
  readonly wakeEvents: number | null;
  readonly sleepLatencyMin: number | null;
  readonly hadSessionBefore: boolean;
  readonly sessionIdBefore: string | null;
  readonly hoursBeforeBed: number | null;
  readonly hasRemData: boolean;
  readonly hasDeepData: boolean;
  readonly hasLightData: boolean;
  readonly hasAwakeData: boolean;
  readonly canonicalSourceId: string | null;
  readonly sourceCount: number;
  readonly sourceCoverage: number | null;
  readonly dataQualityScore: number | null;
  readonly freshness: {
    readonly status: string;
    readonly computedAtIso: string | null;
    readonly sourceWatermark: string;
    readonly computeVersion: number;
  };
  readonly dataQuality: string;
}
function toLocalSleepNightSummary(row: DbLocalSleepNightSummary): LocalSleepNightSummary {
  return {
    id: row.id,
    userId: row.userId,
    nightLocalDate: row.nightLocalDate,
    timezoneOffsetMin: row.timezoneOffsetMin,
    sleepStartTs: row.sleepStartTs,
    sleepEndTs: row.sleepEndTs,
    inBedStartTs: row.inBedStartTs,
    inBedEndTs: row.inBedEndTs,
    totalSleepMin: row.totalSleepMin,
    inBedMin: row.inBedMin,
    awakeMin: row.awakeMin,
    remMin: row.remMin,
    deepMin: row.deepMin,
    lightMin: row.lightMin,
    sleepEfficiency: row.sleepEfficiency,
    wakeEvents: row.wakeEvents,
    sleepLatencyMin: row.sleepLatencyMin,
    hadSessionBefore: row.hadSessionBefore,
    sessionIdBefore: row.sessionIdBefore,
    hoursBeforeBed: row.hoursBeforeBed,
    hasRemData: row.hasRemData,
    hasDeepData: row.hasDeepData,
    hasLightData: row.hasLightData,
    hasAwakeData: row.hasAwakeData,
    canonicalSourceId: row.canonicalSourceId,
    sourceCount: row.sourceCount,
    sourceCoverage: row.sourceCoverage,
    dataQualityScore: row.dataQualityScore,
    freshnessStatus: row.freshnessStatus,
    computedAtIso: row.computedAtIso,
    sourceWatermark: row.sourceWatermark,
    computeVersion: row.computeVersion,
    dataQuality: row.dataQuality,
    fetchedAt: row.fetchedAt,
  };
}
export class LocalSleepNightSummaryRepository extends BaseRepository {
  constructor(drizzleDb: DrizzleDB) {
    super({ drizzleDb });
  }
  async upsertBatchFromDtos(
    userId: string,
    dtos: readonly SleepNightDtoInput[]
  ): Promise<number> {
    if (dtos.length === 0) return 0;
    const drizzle = this.getDrizzle();
    const now = Date.now();
    let upsertedCount = 0;
    let skippedByReconciliation = 0;
    const naturalKeyMap = new Map<string, DbLocalSleepNightSummary>();
    for (let i = 0; i < dtos.length; i += CHUNK_SIZE) {
      const chunk = dtos.slice(i, i + CHUNK_SIZE);
      const conditions = chunk.map(dto => {
        const canonicalNight = canonicalizeCalendarDate(dto.nightLocalDate);
        return and(
          eq(localSleepNightSummary.userId, userId),
          eq(localSleepNightSummary.nightLocalDate, canonicalNight),
        );
      });
      if (conditions.length > 0) {
        const existingRows = await drizzle
          .select()
          .from(localSleepNightSummary)
          .where(or(...conditions));
        for (const row of existingRows) {
          const key = `${row.userId}|${row.nightLocalDate}`;
          naturalKeyMap.set(key, row);
        }
      }
    }
    for (let i = 0; i < dtos.length; i += CHUNK_SIZE) {
      const chunk = dtos.slice(i, i + CHUNK_SIZE);
      for (const dto of chunk) {
        const canonicalNightDate = canonicalizeCalendarDate(dto.nightLocalDate);
        const naturalKey = `${userId}|${canonicalNightDate}`;
        const existingLocal = naturalKeyMap.get(naturalKey);
        if (existingLocal) {
          const decision = reconcileWithCoverage(
            {
              computeVersion: existingLocal.computeVersion,
              sourceWatermark: existingLocal.sourceWatermark,
              coverage: existingLocal.sourceCoverage,
            },
            {
              computeVersion: dto.freshness.computeVersion,
              sourceWatermark: dto.freshness.sourceWatermark,
              coverage: dto.sourceCoverage,
            },
          );
          if (decision.action === 'KEEP_LOCAL') {
            skippedByReconciliation++;
            continue;
          }
        }
        const row: DbLocalSleepNightSummaryInsert = {
          id: dto.id,
          userId,
          nightLocalDate: canonicalNightDate,
          timezoneOffsetMin: dto.timezoneOffsetMin,
          sleepStartTs: dto.sleepStartTs,
          sleepEndTs: dto.sleepEndTs,
          inBedStartTs: dto.inBedStartTs,
          inBedEndTs: dto.inBedEndTs,
          totalSleepMin: dto.totalSleepMin,
          inBedMin: dto.inBedMin,
          awakeMin: dto.awakeMin,
          remMin: dto.remMin,
          deepMin: dto.deepMin,
          lightMin: dto.lightMin,
          sleepEfficiency: dto.sleepEfficiency,
          wakeEvents: dto.wakeEvents,
          sleepLatencyMin: dto.sleepLatencyMin,
          hadSessionBefore: dto.hadSessionBefore,
          sessionIdBefore: dto.sessionIdBefore,
          hoursBeforeBed: dto.hoursBeforeBed,
          hasRemData: dto.hasRemData,
          hasDeepData: dto.hasDeepData,
          hasLightData: dto.hasLightData,
          hasAwakeData: dto.hasAwakeData,
          canonicalSourceId: dto.canonicalSourceId,
          sourceCount: dto.sourceCount,
          sourceCoverage: dto.sourceCoverage,
          dataQualityScore: dto.dataQualityScore,
          freshnessStatus: dto.freshness.status,
          computedAtIso: dto.freshness.computedAtIso,
          sourceWatermark: dto.freshness.sourceWatermark,
          computeVersion: dto.freshness.computeVersion,
          dataQuality: dto.dataQuality,
          fetchedAt: now,
          updatedAt: now,
        };
        await drizzle
          .insert(localSleepNightSummary)
          .values(row)
          .onConflictDoUpdate({
            target: [
              localSleepNightSummary.userId,
              localSleepNightSummary.nightLocalDate,
            ],
            set: {
              id: row.id,
              timezoneOffsetMin: row.timezoneOffsetMin,
              sleepStartTs: row.sleepStartTs,
              sleepEndTs: row.sleepEndTs,
              inBedStartTs: row.inBedStartTs,
              inBedEndTs: row.inBedEndTs,
              totalSleepMin: row.totalSleepMin,
              inBedMin: row.inBedMin,
              awakeMin: row.awakeMin,
              remMin: row.remMin,
              deepMin: row.deepMin,
              lightMin: row.lightMin,
              sleepEfficiency: row.sleepEfficiency,
              wakeEvents: row.wakeEvents,
              sleepLatencyMin: row.sleepLatencyMin,
              hadSessionBefore: row.hadSessionBefore,
              sessionIdBefore: row.sessionIdBefore,
              hoursBeforeBed: row.hoursBeforeBed,
              hasRemData: row.hasRemData,
              hasDeepData: row.hasDeepData,
              hasLightData: row.hasLightData,
              hasAwakeData: row.hasAwakeData,
              canonicalSourceId: row.canonicalSourceId,
              sourceCount: row.sourceCount,
              sourceCoverage: row.sourceCoverage,
              dataQualityScore: row.dataQualityScore,
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
      logger.debug('[LocalSleepNightSummaryRepository] Reconciliation skipped stale server DTOs', {
        userId,
        skippedByReconciliation,
        upsertedCount,
      });
    }
    logger.debug('[LocalSleepNightSummaryRepository] Upserted sleep summaries', {
      userId,
      count: upsertedCount,
    });
    return upsertedCount;
  }
  async queryByDateRange(
    userId: string,
    startDate: string,
    endDate: string
  ): Promise<LocalSleepNightSummary[]> {
    const drizzle = this.getDrizzle();
    const rows = await drizzle
      .select()
      .from(localSleepNightSummary)
      .where(
        and(
          eq(localSleepNightSummary.userId, userId),
          gte(localSleepNightSummary.nightLocalDate, startDate),
          lte(localSleepNightSummary.nightLocalDate, endDate),
        )
      )
      .orderBy(desc(localSleepNightSummary.nightLocalDate));
    return rows.map(toLocalSleepNightSummary);
  }
  async getByNight(
    userId: string,
    nightLocalDate: string
  ): Promise<LocalSleepNightSummary | null> {
    const drizzle = this.getDrizzle();
    const rows = await drizzle
      .select()
      .from(localSleepNightSummary)
      .where(
        and(
          eq(localSleepNightSummary.userId, userId),
          eq(localSleepNightSummary.nightLocalDate, nightLocalDate),
        )
      )
      .limit(1);
    const first = rows[0];
    return first != null ? toLocalSleepNightSummary(first) : null;
  }
  async deleteByUser(userId: string): Promise<void> {
    const drizzle = this.getDrizzle();
    await drizzle
      .delete(localSleepNightSummary)
      .where(eq(localSleepNightSummary.userId, userId));
    logger.debug('[LocalSleepNightSummaryRepository] Deleted all sleep summaries for user', {
      userId,
    });
  }
}
