import { eq, and, asc, inArray, count as drizzleCount } from 'drizzle-orm';
import type { DrizzleDB } from '../../db/client';
import { localRollupDirtyKeys } from '../../db/schema';
import { BaseRepository } from '../BaseRepository';
import { logger } from '../../utils/logger';
const CLEAR_CHUNK_SIZE = 500;
export interface DirtyRollupKey {
  readonly id: number;
  readonly userId: string;
  readonly metricCode: string;
  readonly dayUtc: string;
  readonly reason: string;
}
export class LocalRollupDirtyKeyRepository extends BaseRepository {
  constructor(drizzleDb: DrizzleDB) {
    super({ drizzleDb });
  }
  async enqueue(userId: string, metricCode: string, dayUtc: string, reason: string = 'new_samples'): Promise<void> {
    const drizzle = this.getDrizzle();
    await drizzle
      .insert(localRollupDirtyKeys)
      .values({
        userId,
        metricCode,
        dayUtc,
        reason,
        enqueuedAt: Date.now(),
      })
      .onConflictDoNothing({
        target: [
          localRollupDirtyKeys.userId,
          localRollupDirtyKeys.metricCode,
          localRollupDirtyKeys.dayUtc,
        ],
      });
  }
  async enqueueBatch(
    keys: ReadonlyArray<{ userId: string; metricCode: string; dayUtc: string; reason?: string }>
  ): Promise<number> {
    if (keys.length === 0) return 0;
    const drizzle = this.getDrizzle();
    const now = Date.now();
    let inserted = 0;
    const seen = new Set<string>();
    const unique: Array<{ userId: string; metricCode: string; dayUtc: string; reason?: string }> = [];
    for (const key of keys) {
      const composite = `${key.userId}:${key.metricCode}:${key.dayUtc}`;
      if (!seen.has(composite)) {
        seen.add(composite);
        unique.push(key);
      }
    }
    for (const key of unique) {
      const result = await drizzle
        .insert(localRollupDirtyKeys)
        .values({
          userId: key.userId,
          metricCode: key.metricCode,
          dayUtc: key.dayUtc,
          reason: key.reason ?? 'new_samples',
          enqueuedAt: now,
        })
        .onConflictDoNothing({
          target: [
            localRollupDirtyKeys.userId,
            localRollupDirtyKeys.metricCode,
            localRollupDirtyKeys.dayUtc,
          ],
        });
      if (result && typeof result === 'object' && 'changes' in result) {
        inserted += (result as { changes: number }).changes;
      }
    }
    logger.debug('[LocalRollupDirtyKeyRepository] Batch enqueued', {
      requested: keys.length,
      unique: unique.length,
      inserted,
    });
    return inserted;
  }
  async dequeueOldest(userId: string, limit: number): Promise<DirtyRollupKey[]> {
    const drizzle = this.getDrizzle();
    const rows = await drizzle
      .select({
        id: localRollupDirtyKeys.id,
        userId: localRollupDirtyKeys.userId,
        metricCode: localRollupDirtyKeys.metricCode,
        dayUtc: localRollupDirtyKeys.dayUtc,
        reason: localRollupDirtyKeys.reason,
      })
      .from(localRollupDirtyKeys)
      .where(eq(localRollupDirtyKeys.userId, userId))
      .orderBy(asc(localRollupDirtyKeys.enqueuedAt))
      .limit(limit);
    return rows;
  }
  async clearByIds(ids: readonly number[]): Promise<void> {
    if (ids.length === 0) return;
    const drizzle = this.getDrizzle();
    for (let i = 0; i < ids.length; i += CLEAR_CHUNK_SIZE) {
      const chunk = ids.slice(i, i + CLEAR_CHUNK_SIZE);
      await drizzle
        .delete(localRollupDirtyKeys)
        .where(inArray(localRollupDirtyKeys.id, chunk as number[]));
    }
  }
  async clearAllForUser(userId: string): Promise<void> {
    const drizzle = this.getDrizzle();
    await drizzle
      .delete(localRollupDirtyKeys)
      .where(eq(localRollupDirtyKeys.userId, userId));
    logger.debug('[LocalRollupDirtyKeyRepository] Cleared all dirty keys for user', { userId });
  }
  async count(userId: string): Promise<number> {
    const drizzle = this.getDrizzle();
    const result = await drizzle
      .select({ value: drizzleCount() })
      .from(localRollupDirtyKeys)
      .where(eq(localRollupDirtyKeys.userId, userId));
    return result[0]?.value ?? 0;
  }
}
