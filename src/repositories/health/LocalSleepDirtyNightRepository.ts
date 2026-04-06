import { eq, and, asc, inArray, count as drizzleCount } from 'drizzle-orm';
import type { DrizzleDB } from '../../db/client';
import { localSleepDirtyNights } from '../../db/schema';
import { BaseRepository } from '../BaseRepository';
import { logger } from '../../utils/logger';
const CLEAR_CHUNK_SIZE = 500;
export interface DirtySleepNight {
  readonly id: number;
  readonly userId: string;
  readonly nightLocalDate: string;
  readonly reason: string;
}
export class LocalSleepDirtyNightRepository extends BaseRepository {
  constructor(drizzleDb: DrizzleDB) {
    super({ drizzleDb });
  }
  async enqueue(userId: string, nightLocalDate: string, reason: string = 'new_samples'): Promise<void> {
    const drizzle = this.getDrizzle();
    await drizzle
      .insert(localSleepDirtyNights)
      .values({
        userId,
        nightLocalDate,
        reason,
        enqueuedAt: Date.now(),
      })
      .onConflictDoNothing({
        target: [
          localSleepDirtyNights.userId,
          localSleepDirtyNights.nightLocalDate,
        ],
      });
  }
  async enqueueBatch(
    keys: ReadonlyArray<{ userId: string; nightLocalDate: string; reason?: string }>
  ): Promise<number> {
    if (keys.length === 0) return 0;
    const drizzle = this.getDrizzle();
    const now = Date.now();
    let inserted = 0;
    const seen = new Set<string>();
    const unique: Array<{ userId: string; nightLocalDate: string; reason?: string }> = [];
    for (const key of keys) {
      const composite = `${key.userId}:${key.nightLocalDate}`;
      if (!seen.has(composite)) {
        seen.add(composite);
        unique.push(key);
      }
    }
    for (const key of unique) {
      const result = await drizzle
        .insert(localSleepDirtyNights)
        .values({
          userId: key.userId,
          nightLocalDate: key.nightLocalDate,
          reason: key.reason ?? 'new_samples',
          enqueuedAt: now,
        })
        .onConflictDoNothing({
          target: [
            localSleepDirtyNights.userId,
            localSleepDirtyNights.nightLocalDate,
          ],
        });
      if (result && typeof result === 'object' && 'changes' in result) {
        inserted += (result as { changes: number }).changes;
      }
    }
    logger.debug('[LocalSleepDirtyNightRepository] Batch enqueued', {
      requested: keys.length,
      unique: unique.length,
      inserted,
    });
    return inserted;
  }
  async dequeueOldest(userId: string, limit: number): Promise<DirtySleepNight[]> {
    const drizzle = this.getDrizzle();
    const rows = await drizzle
      .select({
        id: localSleepDirtyNights.id,
        userId: localSleepDirtyNights.userId,
        nightLocalDate: localSleepDirtyNights.nightLocalDate,
        reason: localSleepDirtyNights.reason,
      })
      .from(localSleepDirtyNights)
      .where(eq(localSleepDirtyNights.userId, userId))
      .orderBy(asc(localSleepDirtyNights.enqueuedAt))
      .limit(limit);
    return rows;
  }
  async clearByIds(ids: readonly number[]): Promise<void> {
    if (ids.length === 0) return;
    const drizzle = this.getDrizzle();
    for (let i = 0; i < ids.length; i += CLEAR_CHUNK_SIZE) {
      const chunk = ids.slice(i, i + CLEAR_CHUNK_SIZE);
      await drizzle
        .delete(localSleepDirtyNights)
        .where(inArray(localSleepDirtyNights.id, chunk as number[]));
    }
  }
  async clearAllForUser(userId: string): Promise<void> {
    const drizzle = this.getDrizzle();
    await drizzle
      .delete(localSleepDirtyNights)
      .where(eq(localSleepDirtyNights.userId, userId));
    logger.debug('[LocalSleepDirtyNightRepository] Cleared all dirty nights for user', {
      userId,
    });
  }
  async count(userId: string): Promise<number> {
    const drizzle = this.getDrizzle();
    const result = await drizzle
      .select({ value: drizzleCount() })
      .from(localSleepDirtyNights)
      .where(eq(localSleepDirtyNights.userId, userId));
    return result[0]?.value ?? 0;
  }
}
