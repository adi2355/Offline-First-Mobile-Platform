import { eq, and, asc, desc, sql, inArray } from 'drizzle-orm';
import type { DrizzleDB } from '../../db/client';
import {
  localProductImpactRollup,
  type DbLocalProductImpactRollup,
  type DbLocalProductImpactRollupInsert,
} from '../../db/schema';
import { BaseRepository } from '../BaseRepository';
import { logger } from '../../utils/logger';
import { reconcileWithCoverage } from '../../services/health/projection-reconciliation';
const CHUNK_SIZE = 50;
export interface LocalProductImpact {
  readonly id: string;
  readonly userId: string;
  readonly productId: string;
  readonly productName: string;
  readonly productType: string;
  readonly variantGenetics: string | null;
  readonly metricCode: string;
  readonly windowMinutes: number;
  readonly resolution: string;
  readonly periodDays: number;
  readonly periodStart: string | null;
  readonly periodEnd: string | null;
  readonly sessionCount: number;
  readonly minSessionsRequired: number;
  readonly avgDeltaDuringAbs: number | null;
  readonly avgDeltaDuringPct: number | null;
  readonly avgDeltaAfterAbs: number | null;
  readonly avgDeltaAfterPct: number | null;
  readonly medianDeltaAfterPct: number | null;
  readonly baselineValue: number | null;
  readonly baselineMethod: string | null;
  readonly baselineN: number | null;
  readonly baselineWindow: string | null;
  readonly coverageScore: number | null;
  readonly isReliable: boolean;
  readonly qualityFlags: string | null;
  readonly exactness: string;
  readonly confidenceTier: string;
  readonly confidenceScore: number | null;
  readonly ciLow: number | null;
  readonly ciHigh: number | null;
  readonly freshnessStatus: string;
  readonly computedAtIso: string | null;
  readonly sourceWatermark: string;
  readonly computeVersion: number;
  readonly dataQuality: string;
  readonly evidenceSessionCount: number;
  readonly evidenceSessionIds: string | null;
  readonly fetchedAt: number | null;
}
export interface ProductImpactDtoInput {
  readonly id: string;
  readonly productId: string;
  readonly productName: string;
  readonly productType: string;
  readonly variantGenetics: string | null;
  readonly metricCode: string;
  readonly windowMinutes: number;
  readonly resolution: string;
  readonly periodDays: number;
  readonly periodStart: string | null;
  readonly periodEnd: string | null;
  readonly sessionCount: number;
  readonly minSessionsRequired: number;
  readonly avgDeltaDuringAbs: number | null;
  readonly avgDeltaDuringPct: number | null;
  readonly avgDeltaAfterAbs: number | null;
  readonly avgDeltaAfterPct: number | null;
  readonly medianDeltaAfterPct: number | null;
  readonly baselineValue: number | null;
  readonly baselineMethod: string | null;
  readonly baselineN: number | null;
  readonly baselineWindow: string | null;
  readonly coverageScore: number | null;
  readonly isReliable: boolean;
  readonly qualityFlags: string[];
  readonly exactness: string;
  readonly confidenceTier: string;
  readonly confidenceScore: number | null;
  readonly ciLow: number | null;
  readonly ciHigh: number | null;
  readonly freshness: {
    readonly status: string;
    readonly computedAtIso: string | null;
    readonly sourceWatermark: string;
    readonly computeVersion: number;
  };
  readonly dataQuality: string;
  readonly evidenceSessionCount: number;
  readonly evidenceSessionIds: string[];
}
function toLocalProductImpact(row: DbLocalProductImpactRollup): LocalProductImpact {
  return {
    id: row.id,
    userId: row.userId,
    productId: row.productId,
    productName: row.productName,
    productType: row.productType,
    variantGenetics: row.variantGenetics,
    metricCode: row.metricCode,
    windowMinutes: row.windowMinutes,
    resolution: row.resolution,
    periodDays: row.periodDays,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    sessionCount: row.sessionCount,
    minSessionsRequired: row.minSessionsRequired,
    avgDeltaDuringAbs: row.avgDeltaDuringAbs,
    avgDeltaDuringPct: row.avgDeltaDuringPct,
    avgDeltaAfterAbs: row.avgDeltaAfterAbs,
    avgDeltaAfterPct: row.avgDeltaAfterPct,
    medianDeltaAfterPct: row.medianDeltaAfterPct,
    baselineValue: row.baselineValue,
    baselineMethod: row.baselineMethod,
    baselineN: row.baselineN,
    baselineWindow: row.baselineWindow,
    coverageScore: row.coverageScore,
    isReliable: row.isReliable,
    qualityFlags: row.qualityFlags,
    exactness: row.exactness,
    confidenceTier: row.confidenceTier,
    confidenceScore: row.confidenceScore,
    ciLow: row.ciLow,
    ciHigh: row.ciHigh,
    freshnessStatus: row.freshnessStatus,
    computedAtIso: row.computedAtIso,
    sourceWatermark: row.sourceWatermark,
    computeVersion: row.computeVersion,
    dataQuality: row.dataQuality,
    evidenceSessionCount: row.evidenceSessionCount,
    evidenceSessionIds: row.evidenceSessionIds,
    fetchedAt: row.fetchedAt,
  };
}
export class LocalProductImpactRepository extends BaseRepository {
  constructor(drizzleDb: DrizzleDB) {
    super({ drizzleDb });
  }
  async upsertBatchFromDtos(
    userId: string,
    dtos: readonly ProductImpactDtoInput[]
  ): Promise<number> {
    return this._upsertBatchWith(this.getDrizzle(), userId, dtos);
  }
  async queryByMetricAndPeriod(
    userId: string,
    metricCode: string,
    periodDays: number = 90
  ): Promise<LocalProductImpact[]> {
    const drizzle = this.getDrizzle();
    const rows = await drizzle
      .select()
      .from(localProductImpactRollup)
      .where(
        and(
          eq(localProductImpactRollup.userId, userId),
          eq(localProductImpactRollup.metricCode, metricCode),
          eq(localProductImpactRollup.periodDays, periodDays),
        )
      )
      .orderBy(
        sql`${localProductImpactRollup.avgDeltaAfterPct} IS NULL`,
        desc(sql`ABS(${localProductImpactRollup.avgDeltaAfterPct})`),
      );
    return rows.map(toLocalProductImpact);
  }
  async queryByProduct(
    userId: string,
    productId: string,
    metricCode?: string,
    periodDays?: number
  ): Promise<LocalProductImpact[]> {
    const drizzle = this.getDrizzle();
    const conditions = [
      eq(localProductImpactRollup.userId, userId),
      eq(localProductImpactRollup.productId, productId),
    ];
    if (metricCode != null) {
      conditions.push(eq(localProductImpactRollup.metricCode, metricCode));
    }
    if (periodDays != null) {
      conditions.push(eq(localProductImpactRollup.periodDays, periodDays));
    }
    const rows = await drizzle
      .select()
      .from(localProductImpactRollup)
      .where(and(...conditions))
      .orderBy(asc(localProductImpactRollup.metricCode));
    return rows.map(toLocalProductImpact);
  }
  async getByNaturalKey(
    userId: string,
    productId: string,
    metricCode: string,
    windowMinutes: number,
    resolution: string,
    periodDays: number
  ): Promise<LocalProductImpact | null> {
    const drizzle = this.getDrizzle();
    const rows = await drizzle
      .select()
      .from(localProductImpactRollup)
      .where(
        and(
          eq(localProductImpactRollup.userId, userId),
          eq(localProductImpactRollup.productId, productId),
          eq(localProductImpactRollup.metricCode, metricCode),
          eq(localProductImpactRollup.windowMinutes, windowMinutes),
          eq(localProductImpactRollup.resolution, resolution),
          eq(localProductImpactRollup.periodDays, periodDays),
        )
      )
      .limit(1);
    const first = rows[0];
    return first != null ? toLocalProductImpact(first) : null;
  }
  async pruneOrphansForScope(
    userId: string,
    metricCode: string,
    periodDays: number,
    retainedProductIds: ReadonlySet<string>,
  ): Promise<number> {
    return this._pruneOrphansForScopeWith(this.getDrizzle(), userId, metricCode, periodDays, retainedProductIds);
  }
  async upsertAndPruneScope(
    userId: string,
    dtos: readonly ProductImpactDtoInput[],
    scope: {
      readonly metricCode: string;
      readonly periodDays: number;
      readonly retainedProductIds: ReadonlySet<string>;
    },
  ): Promise<{ upserted: number; pruned: number }> {
    const drizzle = this.getDrizzle();
    await drizzle.run(sql`BEGIN TRANSACTION`);
    try {
      const upserted = await this._upsertBatchWith(drizzle, userId, dtos);
      const pruned = await this._pruneOrphansForScopeWith(
        drizzle, userId, scope.metricCode, scope.periodDays, scope.retainedProductIds,
      );
      await drizzle.run(sql`COMMIT`);
      return { upserted, pruned };
    } catch (error) {
      try {
        await drizzle.run(sql`ROLLBACK`);
      } catch (rollbackError) {
        logger.error('[LocalProductImpactRepository] Rollback failed during upsertAndPruneScope', {
          error: rollbackError instanceof Error
            ? { name: rollbackError.name, message: rollbackError.message }
            : { name: 'Error', message: String(rollbackError) },
        });
      }
      throw error;
    }
  }
  async deleteByUser(userId: string): Promise<void> {
    const drizzle = this.getDrizzle();
    await drizzle
      .delete(localProductImpactRollup)
      .where(eq(localProductImpactRollup.userId, userId));
    logger.debug('[LocalProductImpactRepository] Deleted all product impacts for user', { userId });
  }
  private async _upsertBatchWith(
    db: DrizzleDB,
    userId: string,
    dtos: readonly ProductImpactDtoInput[],
  ): Promise<number> {
    if (dtos.length === 0) return 0;
    const now = Date.now();
    let upsertedCount = 0;
    let skippedByReconciliation = 0;
    const naturalKeyMap = new Map<string, DbLocalProductImpactRollup>();
    for (let i = 0; i < dtos.length; i += CHUNK_SIZE) {
      const chunk = dtos.slice(i, i + CHUNK_SIZE);
      for (const dto of chunk) {
        const existing = await db
          .select()
          .from(localProductImpactRollup)
          .where(
            and(
              eq(localProductImpactRollup.userId, userId),
              eq(localProductImpactRollup.productId, dto.productId),
              eq(localProductImpactRollup.metricCode, dto.metricCode),
              eq(localProductImpactRollup.windowMinutes, dto.windowMinutes),
              eq(localProductImpactRollup.resolution, dto.resolution),
              eq(localProductImpactRollup.periodDays, dto.periodDays),
            )
          )
          .limit(1);
        const first = existing[0];
        if (first != null) {
          const key = `${userId}|${dto.productId}|${dto.metricCode}|${dto.windowMinutes}|${dto.resolution}|${dto.periodDays}`;
          naturalKeyMap.set(key, first);
        }
      }
    }
    for (let i = 0; i < dtos.length; i += CHUNK_SIZE) {
      const chunk = dtos.slice(i, i + CHUNK_SIZE);
      for (const dto of chunk) {
        const naturalKey = `${userId}|${dto.productId}|${dto.metricCode}|${dto.windowMinutes}|${dto.resolution}|${dto.periodDays}`;
        const existingLocal = naturalKeyMap.get(naturalKey);
        if (existingLocal) {
          const decision = reconcileWithCoverage(
            {
              computeVersion: existingLocal.computeVersion,
              sourceWatermark: existingLocal.sourceWatermark,
              coverage: existingLocal.coverageScore,
            },
            {
              computeVersion: dto.freshness.computeVersion,
              sourceWatermark: dto.freshness.sourceWatermark,
              coverage: dto.coverageScore,
            },
          );
          if (decision.action === 'KEEP_LOCAL') {
            skippedByReconciliation++;
            continue;
          }
        }
        const row: DbLocalProductImpactRollupInsert = {
          id: dto.id,
          userId,
          productId: dto.productId,
          productName: dto.productName,
          productType: dto.productType,
          variantGenetics: dto.variantGenetics,
          metricCode: dto.metricCode,
          windowMinutes: dto.windowMinutes,
          resolution: dto.resolution,
          periodDays: dto.periodDays,
          periodStart: dto.periodStart,
          periodEnd: dto.periodEnd,
          sessionCount: dto.sessionCount,
          minSessionsRequired: dto.minSessionsRequired,
          avgDeltaDuringAbs: dto.avgDeltaDuringAbs,
          avgDeltaDuringPct: dto.avgDeltaDuringPct,
          avgDeltaAfterAbs: dto.avgDeltaAfterAbs,
          avgDeltaAfterPct: dto.avgDeltaAfterPct,
          medianDeltaAfterPct: dto.medianDeltaAfterPct,
          baselineValue: dto.baselineValue,
          baselineMethod: dto.baselineMethod,
          baselineN: dto.baselineN,
          baselineWindow: dto.baselineWindow,
          coverageScore: dto.coverageScore,
          isReliable: dto.isReliable,
          qualityFlags: JSON.stringify(dto.qualityFlags),
          exactness: dto.exactness,
          confidenceTier: dto.confidenceTier,
          confidenceScore: dto.confidenceScore,
          ciLow: dto.ciLow,
          ciHigh: dto.ciHigh,
          freshnessStatus: dto.freshness.status,
          computedAtIso: dto.freshness.computedAtIso,
          sourceWatermark: dto.freshness.sourceWatermark,
          computeVersion: dto.freshness.computeVersion,
          dataQuality: dto.dataQuality,
          evidenceSessionCount: dto.evidenceSessionCount,
          evidenceSessionIds: JSON.stringify(dto.evidenceSessionIds),
          fetchedAt: now,
          updatedAt: now,
        };
        await db
          .insert(localProductImpactRollup)
          .values(row)
          .onConflictDoUpdate({
            target: [
              localProductImpactRollup.userId,
              localProductImpactRollup.productId,
              localProductImpactRollup.metricCode,
              localProductImpactRollup.windowMinutes,
              localProductImpactRollup.resolution,
              localProductImpactRollup.periodDays,
            ],
            set: {
              id: row.id,
              productName: row.productName,
              productType: row.productType,
              variantGenetics: row.variantGenetics,
              periodStart: row.periodStart,
              periodEnd: row.periodEnd,
              sessionCount: row.sessionCount,
              minSessionsRequired: row.minSessionsRequired,
              avgDeltaDuringAbs: row.avgDeltaDuringAbs,
              avgDeltaDuringPct: row.avgDeltaDuringPct,
              avgDeltaAfterAbs: row.avgDeltaAfterAbs,
              avgDeltaAfterPct: row.avgDeltaAfterPct,
              medianDeltaAfterPct: row.medianDeltaAfterPct,
              baselineValue: row.baselineValue,
              baselineMethod: row.baselineMethod,
              baselineN: row.baselineN,
              baselineWindow: row.baselineWindow,
              coverageScore: row.coverageScore,
              isReliable: row.isReliable,
              qualityFlags: row.qualityFlags,
              exactness: row.exactness,
              confidenceTier: row.confidenceTier,
              confidenceScore: row.confidenceScore,
              ciLow: row.ciLow,
              ciHigh: row.ciHigh,
              freshnessStatus: row.freshnessStatus,
              computedAtIso: row.computedAtIso,
              sourceWatermark: row.sourceWatermark,
              computeVersion: row.computeVersion,
              dataQuality: row.dataQuality,
              evidenceSessionCount: row.evidenceSessionCount,
              evidenceSessionIds: row.evidenceSessionIds,
              fetchedAt: now,
              updatedAt: now,
            },
          });
        upsertedCount++;
      }
    }
    if (skippedByReconciliation > 0) {
      logger.debug('[LocalProductImpactRepository] Reconciliation skipped stale server DTOs', {
        userId,
        skippedByReconciliation,
        upsertedCount,
      });
    }
    logger.debug('[LocalProductImpactRepository] Upserted product impacts', {
      userId,
      count: upsertedCount,
    });
    return upsertedCount;
  }
  private async _pruneOrphansForScopeWith(
    db: DrizzleDB,
    userId: string,
    metricCode: string,
    periodDays: number,
    retainedProductIds: ReadonlySet<string>,
  ): Promise<number> {
    const scopeCondition = and(
      eq(localProductImpactRollup.userId, userId),
      eq(localProductImpactRollup.metricCode, metricCode),
      eq(localProductImpactRollup.periodDays, periodDays),
    );
    const localRows = await db
      .select({ productId: localProductImpactRollup.productId })
      .from(localProductImpactRollup)
      .where(scopeCondition);
    const orphanProductIds: string[] = [];
    const seen = new Set<string>();
    for (const row of localRows) {
      if (!seen.has(row.productId) && !retainedProductIds.has(row.productId)) {
        orphanProductIds.push(row.productId);
        seen.add(row.productId);
      }
    }
    if (orphanProductIds.length === 0) return 0;
    const PRUNE_CHUNK_SIZE = 50;
    for (let i = 0; i < orphanProductIds.length; i += PRUNE_CHUNK_SIZE) {
      const chunk = orphanProductIds.slice(i, i + PRUNE_CHUNK_SIZE);
      await db
        .delete(localProductImpactRollup)
        .where(
          and(
            scopeCondition,
            inArray(localProductImpactRollup.productId, chunk),
          )
        );
    }
    logger.debug('[LocalProductImpactRepository] Pruned orphaned product impacts', {
      userId, metricCode, periodDays,
      orphanProducts: orphanProductIds.length,
    });
    return orphanProductIds.length;
  }
}
