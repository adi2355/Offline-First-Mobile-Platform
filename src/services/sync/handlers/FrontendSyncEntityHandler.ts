import { EntityType } from '../../../repositories/offline';
import { type ConflictResolutionOutcome } from '@shared/contracts';
export interface FrontendSyncEntityHandler<T> {
  readonly entityType: EntityType;
  merge(localData: T, serverData: T): T;
  handleIdReplacement?(clientId: string, serverId: string): Promise<void>;
  handleConflict?(userId: string, entityId: string, localData: Partial<T>, serverData?: T): Promise<T | null>;
  handleConflictV2?(
    userId: string,
    entityId: string,
    localData: Partial<T>,
    serverData?: T
  ): Promise<ConflictResolutionOutcome<T>>;
}
export function isFrontendSyncEntityHandler(
  handler: unknown,
): handler is FrontendSyncEntityHandler<unknown> {
  return (
    typeof handler === 'object' &&
    handler !== null &&
    'entityType' in handler &&
    typeof (handler as FrontendSyncEntityHandler<unknown>).entityType === 'string' &&
    'merge' in handler &&
    typeof (handler as FrontendSyncEntityHandler<unknown>).merge === 'function'
  );
}
