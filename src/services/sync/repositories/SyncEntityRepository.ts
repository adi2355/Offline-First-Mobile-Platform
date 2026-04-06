import { type EntityType } from '@shared/contracts';
export type SyncStatus = 'synced' | 'pending_create' | 'pending_update' | 'pending_delete' | 'error';
export interface SyncEntityRepository<T> {
  readonly entityType: EntityType;
  findById(id: string): Promise<T | null>;
  create(data: T, options?: CreateOptions): Promise<T>;
  update(id: string, data: Partial<T>): Promise<T>;
  delete(id: string): Promise<T | null>;
  markSynced(id: string): Promise<void>;
  markSyncError?(id: string, error: string | Error): Promise<void>;
}
export interface CreateOptions {
  syncStatus?: SyncStatus;
  allowDuplicate?: boolean;
}
export interface ExtendedSyncEntityRepository<T> extends SyncEntityRepository<T> {
  findPending(userId: string): Promise<T[]>;
  updateRaw(id: string, data: Partial<T>): Promise<void>;
  exists(id: string): Promise<boolean>;
}
export type SyncRepositoryFactory<T> = () => SyncEntityRepository<T>;
export function isSyncEntityRepository<T>(obj: unknown): obj is SyncEntityRepository<T> {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    'entityType' in obj &&
    typeof (obj as SyncEntityRepository<T>).entityType === 'string' &&
    'findById' in obj &&
    typeof (obj as SyncEntityRepository<T>).findById === 'function' &&
    'create' in obj &&
    typeof (obj as SyncEntityRepository<T>).create === 'function' &&
    'update' in obj &&
    typeof (obj as SyncEntityRepository<T>).update === 'function' &&
    'delete' in obj &&
    typeof (obj as SyncEntityRepository<T>).delete === 'function' &&
    'markSynced' in obj &&
    typeof (obj as SyncEntityRepository<T>).markSynced === 'function'
  );
}
