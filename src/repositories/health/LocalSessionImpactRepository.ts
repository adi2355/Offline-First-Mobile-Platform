import { eq, and, asc, inArray, or } from 'drizzle-orm';
import type { DrizzleDB } from '../../db/client';
import {
  localSessionImpactSummary,
  type DbLocalSessionImpactSummary,
  type DbLocalSessionImpactSummaryInsert,
} from '../../db/schema';
import { BaseRepository } from '../BaseRepository';
import { logger } from '../../utils/logger';
import { reconcileWithCoverage } from '../../services/health/projection-reconciliation';
const CHUNK_SIZE = 50;
function computeAverageCoverage(
  beforeCoverage: number | null,
  duringCoverage: number | null,
  afterCoverage: number | null,
): number | null {
  const values = [beforeCoverage, duringCoverage, afterCoverage].filter(
    (v): v is number => v != null,
  );
  if (values.length === 0) return null;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}
export interface LocalSessionImpact {
  readonly id: string;
  readonly sessionId: string;
  readonly userId: string;
  readonly metricCode: string;
  readonly windowMinutes: number;
  readonly resolution: string;
  readonly avgBefore: number | null;
  readonly minBefore: number | null;
  readonly maxBefore: number | null;
  readonly countBefore: number;
  readonly avgDuring: number | null;
  readonly minDuring: number | null;
  readonly maxDuring: number | null;
  readonly countDuring: number;
  readonly avgAfter: number | null;
  readonly minAfter: number | null;
  readonly maxAfter: number | null;
  readonly countAfter: number;
  readonly deltaDuringAbs: number | null;
  readonly deltaDuringPct: number | null;
  readonly deltaAfterAbs: number | null;
  readonly deltaAfterPct: number | null;
  readonly beforeCoverage: number | null;
  readonly duringCoverage: number | null;
  readonly afterCoverage: number | null;
  readonly hasSignificantGaps: boolean;
  readonly isReliable: boolean;
  readonly freshnessStatus: string;
  readonly computedAtIso: string | null;
  readonly sourceWatermark: string;
  readonly computeVersion: number;
  readonly dataQuality: string;
  readonly fetchedAt: number | null;
}
export interface SessionImpactDtoInput {
  readonly id: string;
  readonly sessionId: string;
  readonly metricCode: string;
  readonly windowMinutes: number;
  readonly resolution: string;
  readonly avgBefore: number | null;
  readonly minBefore: number | null;
  readonly maxBefore: number | null;
  readonly countBefore: number;
  readonly avgDuring: number | null;
  readonly minDuring: number | null;
  readonly maxDuring: number | null;
  readonly countDuring: number;
  readonly avgAfter: number | null;
  readonly minAfter: number | null;
  readonly maxAfter: number | null;
  readonly countAfter: number;
  readonly deltaDuringAbs: number | null;
  readonly deltaDuringPct: number | null;
  readonly deltaAfterAbs: number | null;
  readonly deltaAfterPct: number | null;
  readonly beforeCoverage: number | null;
  readonly duringCoverage: number | null;
  readonly afterCoverage: number | null;
  readonly hasSignificantGaps: boolean;
  readonly isReliable: boolean;
  readonly freshness: {
    readonly status: string;
    readonly computedAtIso: string | null;
    readonly sourceWatermark: string;
    readonly computeVersion: number;
  };
  readonly dataQuality: string;
}
function toLocalSessionImpact(row: DbLocalSessionImpactSummary): LocalSessionImpact {
  return {
    id: row.id,
    sessionId: row.sessionId,
    userId: row.userId,
    metricCode: row.metricCode,
    windowMinutes: row.windowMinutes,
    resolution: row.resolution,
    avgBefore: row.avgBefore,
    minBefore: row.minBefore,
    maxBefore: row.maxBefore,
    countBefore: row.countBefore,
    avgDuring: row.avgDuring,
    minDuring: row.minDuring,
    maxDuring: row.maxDuring,
    countDuring: row.countDuring,
    avgAfter: row.avgAfter,
    minAfter: row.minAfter,
    maxAfter: row.maxAfter,
    countAfter: row.countAfter,
    deltaDuringAbs: row.deltaDuringAbs,
    deltaDuringPct: row.deltaDuringPct,
    deltaAfterAbs: row.deltaAfterAbs,
    deltaAfterPct: row.deltaAfterPct,
    beforeCoverage: row.beforeCoverage,
    duringCoverage: row.duringCoverage,
    afterCoverage: row.afterCoverage,
    hasSignificantGaps: row.hasSignificantGaps,
    isReliable: row.isReliable,
    freshnessStatus: row.freshnessStatus,
    computedAtIso: row.computedAtIso,
    sourceWatermark: row.sourceWatermark,
    computeVersion: row.computeVersion,
    dataQuality: row.dataQuality,
    fetchedAt: row.fetchedAt,
  };
}
export class LocalSessionImpactRepository extends BaseRepository {
  constructor(drizzleDb: DrizzleDB) {
    super({ drizzleDb });
  }
  async upsertBatchFromDtos(
    userId: string,
    dtos: readonly SessionImpactDtoInput[]
  ): Promise<number> {
    if (dtos.length === 0) return 0;
    const drizzle = this.getDrizzle();
    const now = Date.now();
    let upsertedCount = 0;
    let skippedByReconciliation = 0;
    const naturalKeyMap = new Map<string, DbLocalSessionImpactSummary>();
    for (let i = 0; i < dtos.length; i += CHUNK_SIZE) {
      const chunk = dtos.slice(i, i + CHUNK_SIZE);
      const conditions = chunk.map(dto =>
        and(
          eq(localSessionImpactSummary.sessionId, dto.sessionId),
          eq(localSessionImpactSummary.metricCode, dto.metricCode),
          eq(localSessionImpactSummary.windowMinutes, dto.windowMinutes),
          eq(localSessionImpactSummary.resolution, dto.resolution),
        )
      );
      if (conditions.length > 0) {
        const existingRows = await drizzle
          .select()
          .from(localSessionImpactSummary)
          .where(or(...conditions));
        for (const row of existingRows) {
          const key = `${row.sessionId}|${row.metricCode}|${row.windowMinutes}|${row.resolution}`;
          naturalKeyMap.set(key, row);
        }
      }
    }
    for (let i = 0; i < dtos.length; i += CHUNK_SIZE) {
      const chunk = dtos.slice(i, i + CHUNK_SIZE);
      for (const dto of chunk) {
        const naturalKey = `${dto.sessionId}|${dto.metricCode}|${dto.windowMinutes}|${dto.resolution}`;
        const existingLocal = naturalKeyMap.get(naturalKey);
        if (existingLocal) {
          const localCoverage = computeAverageCoverage(
            existingLocal.beforeCoverage,
            existingLocal.duringCoverage,
            existingLocal.afterCoverage,
          );
          const serverCoverage = computeAverageCoverage(
            dto.beforeCoverage,
            dto.duringCoverage,
            dto.afterCoverage,
          );
          const decision = reconcileWithCoverage(
            {
              computeVersion: existingLocal.computeVersion,
              sourceWatermark: existingLocal.sourceWatermark,
              coverage: localCoverage,
            },
            {
              computeVersion: dto.freshness.computeVersion,
              sourceWatermark: dto.freshness.sourceWatermark,
              coverage: serverCoverage,
            },
          );
          if (decision.action === 'KEEP_LOCAL') {
            skippedByReconciliation++;
            continue;
          }
        }
        const row: DbLocalSessionImpactSummaryInsert = {
          id: dto.id,
          sessionId: dto.sessionId,
          userId,
          metricCode: dto.metricCode,
          windowMinutes: dto.windowMinutes,
          resolution: dto.resolution,
          avgBefore: dto.avgBefore,
          minBefore: dto.minBefore,
          maxBefore: dto.maxBefore,
          countBefore: dto.countBefore,
          avgDuring: dto.avgDuring,
          minDuring: dto.minDuring,
          maxDuring: dto.maxDuring,
          countDuring: dto.countDuring,
          avgAfter: dto.avgAfter,
          minAfter: dto.minAfter,
          maxAfter: dto.maxAfter,
          countAfter: dto.countAfter,
          deltaDuringAbs: dto.deltaDuringAbs,
          deltaDuringPct: dto.deltaDuringPct,
          deltaAfterAbs: dto.deltaAfterAbs,
          deltaAfterPct: dto.deltaAfterPct,
          beforeCoverage: dto.beforeCoverage,
          duringCoverage: dto.duringCoverage,
          afterCoverage: dto.afterCoverage,
          hasSignificantGaps: dto.hasSignificantGaps,
          isReliable: dto.isReliable,
          freshnessStatus: dto.freshness.status,
          computedAtIso: dto.freshness.computedAtIso,
          sourceWatermark: dto.freshness.sourceWatermark,
          computeVersion: dto.freshness.computeVersion,
          dataQuality: dto.dataQuality,
          fetchedAt: now,
          updatedAt: now,
        };
        await drizzle
          .insert(localSessionImpactSummary)
          .values(row)
          .onConflictDoUpdate({
            target: [
              localSessionImpactSummary.sessionId,
              localSessionImpactSummary.metricCode,
              localSessionImpactSummary.windowMinutes,
              localSessionImpactSummary.resolution,
            ],
            set: {
              id: row.id,
              avgBefore: row.avgBefore,
              minBefore: row.minBefore,
              maxBefore: row.maxBefore,
              countBefore: row.countBefore,
              avgDuring: row.avgDuring,
              minDuring: row.minDuring,
              maxDuring: row.maxDuring,
              countDuring: row.countDuring,
              avgAfter: row.avgAfter,
              minAfter: row.minAfter,
              maxAfter: row.maxAfter,
              countAfter: row.countAfter,
              deltaDuringAbs: row.deltaDuringAbs,
              deltaDuringPct: row.deltaDuringPct,
              deltaAfterAbs: row.deltaAfterAbs,
              deltaAfterPct: row.deltaAfterPct,
              beforeCoverage: row.beforeCoverage,
              duringCoverage: row.duringCoverage,
              afterCoverage: row.afterCoverage,
              hasSignificantGaps: row.hasSignificantGaps,
              isReliable: row.isReliable,
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
      logger.debug('[LocalSessionImpactRepository] Reconciliation skipped stale server DTOs', {
        userId,
        skippedByReconciliation,
        upsertedCount,
      });
    }
    logger.debug('[LocalSessionImpactRepository] Upserted session impacts', {
      userId,
      count: upsertedCount,
    });
    return upsertedCount;
  }
  async queryBySession(
    userId: string,
    sessionId: string
  ): Promise<LocalSessionImpact[]> {
    const drizzle = this.getDrizzle();
    const rows = await drizzle
      .select()
      .from(localSessionImpactSummary)
      .where(
        and(
          eq(localSessionImpactSummary.userId, userId),
          eq(localSessionImpactSummary.sessionId, sessionId),
        )
      )
      .orderBy(asc(localSessionImpactSummary.metricCode));
    return rows.map(toLocalSessionImpact);
  }
  async queryBySessions(
    userId: string,
    sessionIds: readonly string[]
  ): Promise<LocalSessionImpact[]> {
    if (sessionIds.length === 0) return [];
    const drizzle = this.getDrizzle();
    const results: LocalSessionImpact[] = [];
    const SESSION_CHUNK = 100;
    for (let i = 0; i < sessionIds.length; i += SESSION_CHUNK) {
      const chunk = sessionIds.slice(i, i + SESSION_CHUNK);
      const rows = await drizzle
        .select()
        .from(localSessionImpactSummary)
        .where(
          and(
            eq(localSessionImpactSummary.userId, userId),
            inArray(localSessionImpactSummary.sessionId, chunk as string[]),
          )
        )
        .orderBy(
          asc(localSessionImpactSummary.sessionId),
          asc(localSessionImpactSummary.metricCode),
        );
      results.push(...rows.map(toLocalSessionImpact));
    }
    return results;
  }
  async getByNaturalKey(
    sessionId: string,
    metricCode: string,
    windowMinutes: number,
    resolution: string
  ): Promise<LocalSessionImpact | null> {
    const drizzle = this.getDrizzle();
    const rows = await drizzle
      .select()
      .from(localSessionImpactSummary)
      .where(
        and(
          eq(localSessionImpactSummary.sessionId, sessionId),
          eq(localSessionImpactSummary.metricCode, metricCode),
          eq(localSessionImpactSummary.windowMinutes, windowMinutes),
          eq(localSessionImpactSummary.resolution, resolution),
        )
      )
      .limit(1);
    const first = rows[0];
    return first != null ? toLocalSessionImpact(first) : null;
  }
  async deleteByUser(userId: string): Promise<void> {
    const drizzle = this.getDrizzle();
    await drizzle
      .delete(localSessionImpactSummary)
      .where(eq(localSessionImpactSummary.userId, userId));
    logger.debug('[LocalSessionImpactRepository] Deleted all impacts for user', { userId });
  }
  async deleteBySession(sessionId: string): Promise<void> {
    const drizzle = this.getDrizzle();
    await drizzle
      .delete(localSessionImpactSummary)
      .where(eq(localSessionImpactSummary.sessionId, sessionId));
    logger.debug('[LocalSessionImpactRepository] Deleted impacts for session', { sessionId });
  }
}
