import { DatabaseManager } from '../DatabaseManager';
import { logger } from '../utils/logger';
import { hashQueryKey } from '../utils/cache-helpers';
export interface CacheEntry<T = unknown> {
  queryKey: string;
  data: T;
  dataUpdatedAt: string;
  staleTime: number;
  cacheTime: number;
  isStale: boolean;
  isInvalidated: boolean;
  accessCount: number;
  lastAccessedAt: string;
  createdAt: string;
  updatedAt: string;
}
export interface CacheOptions {
  staleTime?: number;  
  cacheTime?: number;  
}
export interface CacheStats {
  totalEntries: number;
  staleEntries: number;
  invalidatedEntries: number;
  oldestEntry: string | null;
  newestEntry: string | null;
  totalSize: number; 
}
export class CacheManager {
  private static instance: CacheManager | null = null;
  private databaseManager: DatabaseManager;
  private isInitialized: boolean = false;
  private cleanupInterval: NodeJS.Timeout | null = null;
  private constructor(databaseManager: DatabaseManager) {
    this.databaseManager = databaseManager;
  }
  public static getInstance(databaseManager?: DatabaseManager): CacheManager {
    if (!CacheManager.instance) {
      if (!databaseManager) {
        throw new Error('CacheManager: DatabaseManager must be provided on first getInstance() call');
      }
      CacheManager.instance = new CacheManager(databaseManager);
    }
    return CacheManager.instance;
  }
  public async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }
    try {
      await this.databaseManager.ensureInitialized();
      this.startAutoCleanup(60 * 60 * 1000); 
      this.isInitialized = true;
      logger.info('[CacheManager] Initialized successfully');
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error('[CacheManager] Initialization failed', { error: { name: err.name, message: err.message, stack: err.stack } });
      throw error;
    }
  }
  public async get<T = unknown>(queryKey: string | unknown[]): Promise<T | null> {
    try {
      await this.databaseManager.ensureInitialized();
      const db = await this.databaseManager.getDatabase('DeviceEvents');
      const serializedKey = this.serializeQueryKey(queryKey);
      const queryHash = hashQueryKey(serializedKey);
      interface CacheRow {
        query_key: string;
        query_hash: string;
        data: string;
        data_updated_at: string;
        stale_time: number;
        cache_time: number;
        is_stale: number;
        is_invalidated: number;
        access_count: number;
        last_accessed_at: string;
        created_at: string;
        updated_at: string;
      }
      const result = await db.getFirstAsync<CacheRow>(
        `SELECT * FROM query_cache WHERE query_hash = ? AND is_invalidated = 0`,
        [queryHash]
      );
      if (!result) {
        return null;
      }
      const now = Date.now();
      const createdAt = new Date(result.created_at).getTime();
      const cacheExpiry = createdAt + result.cache_time;
      if (now > cacheExpiry) {
        await this.delete(serializedKey);
        return null;
      }
      const dataUpdatedAt = new Date(result.data_updated_at).getTime();
      const staleExpiry = dataUpdatedAt + result.stale_time;
      const isStale = now > staleExpiry;
      await db.runAsync(
        `UPDATE query_cache
         SET access_count = access_count + 1,
             last_accessed_at = datetime('now'),
             is_stale = ?
         WHERE query_hash = ?`,
        [isStale ? 1 : 0, queryHash]
      );
      return JSON.parse(result.data) as T;
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error('[CacheManager] Get failed', { queryKey, error: { name: err.name, message: err.message, stack: err.stack } });
      return null;
    }
  }
  public async set<T = unknown>(
    queryKey: string | unknown[],
    data: T,
    options: CacheOptions = {}
  ): Promise<void> {
    try {
      await this.databaseManager.ensureInitialized();
      const db = await this.databaseManager.getDatabase('DeviceEvents');
      const serializedKey = this.serializeQueryKey(queryKey);
      const queryHash = hashQueryKey(serializedKey);
      const serializedData = JSON.stringify(data);
      const staleTime = options.staleTime ?? 5 * 60 * 1000; 
      const cacheTime = options.cacheTime ?? 60 * 60 * 1000; 
      await db.runAsync(
        `INSERT OR REPLACE INTO query_cache
         (query_key, query_hash, data, data_updated_at, stale_time, cache_time,
          is_stale, is_invalidated, access_count, last_accessed_at, created_at, updated_at)
         VALUES (?, ?, ?, datetime('now'), ?, ?, 0, 0, 0, datetime('now'), datetime('now'), datetime('now'))`,
        [serializedKey, queryHash, serializedData, staleTime, cacheTime]
      );
      logger.debug('[CacheManager] Set cache', { queryKey: serializedKey, dataSize: serializedData.length });
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error('[CacheManager] Set failed', { queryKey, error: { name: err.name, message: err.message, stack: err.stack } });
      throw error;
    }
  }
  public async invalidate(queryKey: string | unknown[]): Promise<void> {
    try {
      await this.databaseManager.ensureInitialized();
      const db = await this.databaseManager.getDatabase('DeviceEvents');
      const serializedKey = this.serializeQueryKey(queryKey);
      const queryHash = hashQueryKey(serializedKey);
      await db.runAsync(
        `UPDATE query_cache SET is_invalidated = 1, updated_at = datetime('now') WHERE query_hash = ?`,
        [queryHash]
      );
      logger.debug('[CacheManager] Invalidated cache', { queryKey: serializedKey });
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error('[CacheManager] Invalidate failed', { queryKey, error: { name: err.name, message: err.message, stack: err.stack } });
      throw error;
    }
  }
  public async invalidateByPrefix(keyPrefix: string): Promise<void> {
    try {
      await this.databaseManager.ensureInitialized();
      const db = await this.databaseManager.getDatabase('DeviceEvents');
      await db.runAsync(
        `UPDATE query_cache SET is_invalidated = 1, updated_at = datetime('now')
         WHERE query_key LIKE ?`,
        [`${keyPrefix}%`]
      );
      logger.debug('[CacheManager] Invalidated cache by prefix', { keyPrefix });
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error('[CacheManager] Invalidate by prefix failed', { keyPrefix, error: { name: err.name, message: err.message, stack: err.stack } });
      throw error;
    }
  }
  public async delete(queryKey: string | unknown[]): Promise<void> {
    try {
      await this.databaseManager.ensureInitialized();
      const db = await this.databaseManager.getDatabase('DeviceEvents');
      const serializedKey = this.serializeQueryKey(queryKey);
      const queryHash = hashQueryKey(serializedKey);
      await db.runAsync(
        `DELETE FROM query_cache WHERE query_hash = ?`,
        [queryHash]
      );
      logger.debug('[CacheManager] Deleted cache', { queryKey: serializedKey });
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error('[CacheManager] Delete failed', { queryKey, error: { name: err.name, message: err.message, stack: err.stack } });
      throw error;
    }
  }
  public async clearAll(): Promise<void> {
    try {
      await this.databaseManager.ensureInitialized();
      const db = await this.databaseManager.getDatabase('DeviceEvents');
      await db.runAsync(`DELETE FROM query_cache`);
      logger.info('[CacheManager] Cleared all cache');
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error('[CacheManager] Clear all failed', { error: { name: err.name, message: err.message, stack: err.stack } });
      throw error;
    }
  }
  public async cleanup(): Promise<number> {
    try {
      await this.databaseManager.ensureInitialized();
      const db = await this.databaseManager.getDatabase('DeviceEvents');
      const result = await db.runAsync(
        `DELETE FROM query_cache
         WHERE datetime(created_at, '+' || cache_time / 1000 || ' seconds') < datetime('now')
         OR is_invalidated = 1`
      );
      const deletedCount = result.changes ?? 0;
      if (deletedCount > 0) {
        logger.info('[CacheManager] Cleanup completed', { deletedCount });
      }
      return deletedCount;
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error('[CacheManager] Cleanup failed', { error: { name: err.name, message: err.message, stack: err.stack } });
      return 0;
    }
  }
  public async getStats(): Promise<CacheStats> {
    try {
      await this.databaseManager.ensureInitialized();
      const db = await this.databaseManager.getDatabase('DeviceEvents');
      interface StatsRow {
        total_entries: number;
        stale_entries: number;
        invalidated_entries: number;
        oldest_entry: string | null;
        newest_entry: string | null;
        total_size: number;
      }
      const stats = await db.getFirstAsync<StatsRow>(
        `SELECT
          COUNT(*) as total_entries,
          SUM(CASE WHEN is_stale = 1 THEN 1 ELSE 0 END) as stale_entries,
          SUM(CASE WHEN is_invalidated = 1 THEN 1 ELSE 0 END) as invalidated_entries,
          MIN(created_at) as oldest_entry,
          MAX(created_at) as newest_entry,
          SUM(LENGTH(data)) as total_size
         FROM query_cache`
      );
      return {
        totalEntries: stats?.total_entries ?? 0,
        staleEntries: stats?.stale_entries ?? 0,
        invalidatedEntries: stats?.invalidated_entries ?? 0,
        oldestEntry: stats?.oldest_entry ?? null,
        newestEntry: stats?.newest_entry ?? null,
        totalSize: stats?.total_size ?? 0,
      };
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error('[CacheManager] Get stats failed', { error: { name: err.name, message: err.message, stack: err.stack } });
      return {
        totalEntries: 0,
        staleEntries: 0,
        invalidatedEntries: 0,
        oldestEntry: null,
        newestEntry: null,
        totalSize: 0,
      };
    }
  }
  private startAutoCleanup(intervalMs: number): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    this.cleanupInterval = setInterval(() => {
      this.cleanup().catch((error: unknown) => {
        const err = error instanceof Error ? error : new Error(String(error));
        logger.error('[CacheManager] Auto-cleanup failed', { error: { name: err.name, message: err.message, stack: err.stack } });
      });
    }, intervalMs);
  }
  public stopAutoCleanup(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }
  private serializeQueryKey(queryKey: string | unknown[]): string {
    if (typeof queryKey === 'string') {
      return queryKey;
    }
    return JSON.stringify(queryKey);
  }
}
export const getCacheManager = (databaseManager?: DatabaseManager) =>
  CacheManager.getInstance(databaseManager);
