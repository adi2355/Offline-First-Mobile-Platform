import { eq, and, sql } from 'drizzle-orm';
import type { DrizzleDB } from '../../db/client';
import { localHealthInsights } from '../../db/schema';
import { BaseRepository } from '../BaseRepository';
import { logger, toLogError } from '../../utils/logger';
import type { InsightDisplayType, InsightConfidenceTier } from '@shared/contracts';
const LOG_PREFIX = '[LocalHealthInsightRepo]';
const CHUNK_SIZE = 50;
export interface LocalHealthInsight {
  readonly insightId: string;
  readonly userId: string;
  readonly domain: string;
  readonly insightType: string;
  readonly icon: string;
  readonly metric: string;
  readonly description: string;
  readonly displayType: InsightDisplayType;
  readonly confidenceTier: InsightConfidenceTier;
  readonly evidence: string; 
  readonly freshnessStatus: string;
  readonly computedAtIso: string | null;
  readonly sourceWatermark: string;
  readonly computeVersion: number;
  readonly dataQuality: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly generatedAt: string;
  readonly fetchedAt: number | null;
}
export interface InsightDtoInput {
  readonly insightId: string;
  readonly domain: string;
  readonly insightType: string;
  readonly icon: string;
  readonly metric: string;
  readonly description: string;
  readonly displayType: InsightDisplayType;
  readonly confidenceTier: InsightConfidenceTier;
  readonly evidence: Record<string, unknown>;
  readonly freshness: {
    readonly status: string;
    readonly computedAtIso: string | null;
    readonly sourceWatermark: string;
    readonly computeVersion: number;
  };
  readonly dataQuality: string;
  readonly dateRange: { readonly startDate: string; readonly endDate: string };
  readonly generatedAt: string;
}
export class LocalHealthInsightRepository extends BaseRepository {
  constructor(drizzleDb: DrizzleDB) {
    super({ drizzleDb });
  }
  async upsertBatchFromDtos(userId: string, dtos: readonly InsightDtoInput[]): Promise<number> {
    return this._upsertBatch(userId, dtos);
  }
  async queryByDomainAndDateRange(
    userId: string,
    domain: string,
    startDate: string,
    endDate: string,
  ): Promise<LocalHealthInsight[]> {
    const rows = await this.getDrizzle().select()
      .from(localHealthInsights)
      .where(
        and(
          eq(localHealthInsights.userId, userId),
          eq(localHealthInsights.domain, domain),
          eq(localHealthInsights.startDate, startDate),
          eq(localHealthInsights.endDate, endDate),
        ),
      );
    return rows as LocalHealthInsight[];
  }
  async deleteByUser(userId: string): Promise<number> {
    const result = await this.getDrizzle().delete(localHealthInsights)
      .where(eq(localHealthInsights.userId, userId));
    return result.changes ?? 0;
  }
  async pruneOrphansForScope(
    userId: string,
    domain: string,
    startDate: string,
    endDate: string,
    retainedIds: ReadonlySet<string>,
  ): Promise<number> {
    return this._pruneOrphans(userId, domain, startDate, endDate, retainedIds);
  }
  async upsertAndPruneScope(
    userId: string,
    dtos: readonly InsightDtoInput[],
    scope: {
      readonly domain: string;
      readonly startDate: string;
      readonly endDate: string;
      readonly retainedIds: ReadonlySet<string>;
    },
  ): Promise<{ upserted: number; pruned: number }> {
    const drizzle = this.getDrizzle();
    await drizzle.run(sql`BEGIN TRANSACTION`);
    try {
      const upserted = await this._upsertBatch(userId, dtos);
      const pruned = await this._pruneOrphans(
        userId, scope.domain, scope.startDate, scope.endDate, scope.retainedIds,
      );
      await drizzle.run(sql`COMMIT`);
      return { upserted, pruned };
    } catch (error) {
      try {
        await drizzle.run(sql`ROLLBACK`);
      } catch (rollbackError) {
        logger.error(`${LOG_PREFIX} Rollback failed during upsertAndPruneScope`, {
          error: toLogError(rollbackError),
        });
      }
      throw error;
    }
  }
  private async _upsertBatch(
    userId: string,
    dtos: readonly InsightDtoInput[],
  ): Promise<number> {
    if (dtos.length === 0) return 0;
    const drizzle = this.getDrizzle();
    const now = Date.now();
    let total = 0;
    for (let i = 0; i < dtos.length; i += CHUNK_SIZE) {
      const chunk = dtos.slice(i, i + CHUNK_SIZE);
      for (const dto of chunk) {
        try {
          await drizzle.insert(localHealthInsights)
            .values({
              insightId: dto.insightId,
              userId,
              domain: dto.domain,
              insightType: dto.insightType,
              icon: dto.icon,
              metric: dto.metric,
              description: dto.description,
              displayType: dto.displayType,
              confidenceTier: dto.confidenceTier,
              evidence: JSON.stringify(dto.evidence),
              freshnessStatus: dto.freshness.status,
              computedAtIso: dto.freshness.computedAtIso,
              sourceWatermark: dto.freshness.sourceWatermark,
              computeVersion: dto.freshness.computeVersion,
              dataQuality: dto.dataQuality,
              startDate: dto.dateRange.startDate,
              endDate: dto.dateRange.endDate,
              generatedAt: dto.generatedAt,
              fetchedAt: now,
              updatedAt: now,
            })
            .onConflictDoUpdate({
              target: [localHealthInsights.userId, localHealthInsights.insightId],
              set: {
                domain: sql`excluded.domain`,
                insightType: sql`excluded.insight_type`,
                icon: sql`excluded.icon`,
                metric: sql`excluded.metric`,
                description: sql`excluded.description`,
                displayType: sql`excluded.display_type`,
                confidenceTier: sql`excluded.confidence_tier`,
                evidence: sql`excluded.evidence`,
                freshnessStatus: sql`excluded.freshness_status`,
                computedAtIso: sql`excluded.computed_at_iso`,
                sourceWatermark: sql`excluded.source_watermark`,
                computeVersion: sql`excluded.compute_version`,
                dataQuality: sql`excluded.data_quality`,
                startDate: sql`excluded.start_date`,
                endDate: sql`excluded.end_date`,
                generatedAt: sql`excluded.generated_at`,
                fetchedAt: sql`excluded.fetched_at`,
                updatedAt: sql`excluded.updated_at`,
              },
            });
          total++;
        } catch (error) {
          logger.error(`${LOG_PREFIX} upsert failed for insightId=${dto.insightId}`, {
            error: toLogError(error),
          });
          throw error; 
        }
      }
    }
    logger.debug(`${LOG_PREFIX} Upserted ${total} insights for userId=${userId}`);
    return total;
  }
  private async _pruneOrphans(
    userId: string,
    domain: string,
    startDate: string,
    endDate: string,
    retainedIds: ReadonlySet<string>,
  ): Promise<number> {
    const drizzle = this.getDrizzle();
    const existing = await drizzle.select({ insightId: localHealthInsights.insightId })
      .from(localHealthInsights)
      .where(
        and(
          eq(localHealthInsights.userId, userId),
          eq(localHealthInsights.domain, domain),
          eq(localHealthInsights.startDate, startDate),
          eq(localHealthInsights.endDate, endDate),
        ),
      );
    const toDelete = existing.filter((r: { insightId: string }) => !retainedIds.has(r.insightId));
    if (toDelete.length === 0) return 0;
    for (const row of toDelete) {
      await drizzle.delete(localHealthInsights)
        .where(
          and(
            eq(localHealthInsights.userId, userId),
            eq(localHealthInsights.insightId, row.insightId),
          ),
        );
    }
    logger.debug(`${LOG_PREFIX} Pruned ${toDelete.length} orphaned insights for domain=${domain}`);
    return toDelete.length;
  }
}
