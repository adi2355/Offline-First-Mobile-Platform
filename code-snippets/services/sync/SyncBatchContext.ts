import { EntityType, ENTITY_TYPES } from '@shared/contracts';
import type { TouchedIds } from './IntegrityGate';
export const MAX_TOUCHED_IDS_PER_ENTITY = 5000;
export interface DeferredCursorUpdate {
  readonly entityType: EntityType;
  readonly cursor: string | null;
  readonly recordsSynced: number;
  readonly hasMore: boolean;
}
export class SyncBatchContext {
  public readonly batchId: string;
  public readonly startedAt: Date;
  private readonly touchedSourceIds: Map<EntityType, Set<string>>;
  private readonly touchedTargetIds: Map<EntityType, Set<string>>;
  private readonly deferredCursorUpdates: Map<EntityType, DeferredCursorUpdate>;
  private hadIdReplacements = false;
  private readonly entityTypesWithDeletes: Set<EntityType>;
  private readonly sourceOverflowEntities: Set<EntityType>;
  private readonly targetOverflowEntities: Set<EntityType>;
  constructor() {
    this.batchId = this.generateBatchId();
    this.startedAt = new Date();
    this.touchedSourceIds = new Map();
    this.touchedTargetIds = new Map();
    this.deferredCursorUpdates = new Map();
    this.entityTypesWithDeletes = new Set();
    this.sourceOverflowEntities = new Set();
    this.targetOverflowEntities = new Set();
    for (const entityType of ENTITY_TYPES) {
      this.touchedSourceIds.set(entityType, new Set());
      this.touchedTargetIds.set(entityType, new Set());
    }
  }
  private generateBatchId(): string {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 8);
    return `sync-${timestamp}-${random}`;
  }
  touch(entityType: EntityType, id: string): void {
    const ids = this.touchedSourceIds.get(entityType);
    if (!ids) return;
    if (ids.size >= MAX_TOUCHED_IDS_PER_ENTITY) {
      this.sourceOverflowEntities.add(entityType);
      return;
    }
    ids.add(id);
  }
  touchMultiple(entityType: EntityType, ids: readonly string[]): void {
    const idSet = this.touchedSourceIds.get(entityType);
    if (!idSet) return;
    for (const id of ids) {
      if (idSet.size >= MAX_TOUCHED_IDS_PER_ENTITY) {
        this.sourceOverflowEntities.add(entityType);
        break;
      }
      idSet.add(id);
    }
  }
  touchTarget(entityType: EntityType, id: string): void {
    const ids = this.touchedTargetIds.get(entityType);
    if (!ids) return;
    if (ids.size >= MAX_TOUCHED_IDS_PER_ENTITY) {
      this.targetOverflowEntities.add(entityType);
      return;
    }
    ids.add(id);
  }
  recordIdReplacement(entityType: EntityType, oldId: string, newId: string): void {
    this.hadIdReplacements = true;
    this.touchTarget(entityType, oldId);
    this.touchTarget(entityType, newId);
    this.touch(entityType, newId);
  }
  recordDelete(entityType: EntityType, id: string): void {
    this.entityTypesWithDeletes.add(entityType);
    this.touchTarget(entityType, id);
    this.touch(entityType, id);
  }
  getTouchedIds(): TouchedIds {
    const result: Partial<Record<EntityType, readonly string[]>> = {};
    for (const [entityType, ids] of this.touchedSourceIds) {
      if (ids.size > 0) {
        result[entityType] = [...ids].sort();
      }
    }
    return result;
  }
  getTouchedTargetIds(): TouchedIds {
    const result: Partial<Record<EntityType, readonly string[]>> = {};
    for (const [entityType, ids] of this.touchedTargetIds) {
      if (ids.size > 0) {
        result[entityType] = [...ids].sort();
      }
    }
    return result;
  }
  hasTouchedEntities(): boolean {
    for (const ids of this.touchedSourceIds.values()) {
      if (ids.size > 0) return true;
    }
    return false;
  }
  hasIdReplacements(): boolean {
    return this.hadIdReplacements;
  }
  getEntityTypesWithDeletes(): readonly EntityType[] {
    return [...this.entityTypesWithDeletes];
  }
  hasSourceOverflow(): boolean {
    return this.sourceOverflowEntities.size > 0;
  }
  hasTargetOverflow(): boolean {
    return this.targetOverflowEntities.size > 0;
  }
  hasOverflow(): boolean {
    return this.hasSourceOverflow() || this.hasTargetOverflow();
  }
  getSourceOverflowEntities(): readonly EntityType[] {
    return [...this.sourceOverflowEntities];
  }
  getTargetOverflowEntities(): readonly EntityType[] {
    return [...this.targetOverflowEntities];
  }
  getTotalTouchedCount(): number {
    let count = 0;
    for (const ids of this.touchedSourceIds.values()) {
      count += ids.size;
    }
    return count;
  }
  deferCursorUpdate(
    entityType: EntityType,
    cursor: string | null,
    recordsSynced: number,
    hasMore: boolean
  ): void {
    this.deferredCursorUpdates.set(entityType, {
      entityType,
      cursor,
      recordsSynced,
      hasMore,
    });
  }
  getDeferredCursorUpdates(): readonly DeferredCursorUpdate[] {
    return [...this.deferredCursorUpdates.values()];
  }
  hasDeferredCursorUpdates(): boolean {
    return this.deferredCursorUpdates.size > 0;
  }
  getSummary(): {
    batchId: string;
    startedAt: string;
    totalTouched: number;
    entitiesWithTouches: string[];
    hadIdReplacements: boolean;
    entitiesWithDeletes: string[];
    deferredCursorCount: number;
    hasOverflow: boolean;
    sourceOverflowEntities: string[];
    targetOverflowEntities: string[];
  } {
    const entitiesWithTouches: string[] = [];
    for (const [entityType, ids] of this.touchedSourceIds) {
      if (ids.size > 0) {
        const suffix = this.sourceOverflowEntities.has(entityType) ? '+' : '';
        entitiesWithTouches.push(`${entityType}(${ids.size}${suffix})`);
      }
    }
    return {
      batchId: this.batchId,
      startedAt: this.startedAt.toISOString(),
      totalTouched: this.getTotalTouchedCount(),
      entitiesWithTouches,
      hadIdReplacements: this.hadIdReplacements,
      entitiesWithDeletes: [...this.entityTypesWithDeletes],
      deferredCursorCount: this.deferredCursorUpdates.size,
      hasOverflow: this.hasOverflow(),
      sourceOverflowEntities: [...this.sourceOverflowEntities],
      targetOverflowEntities: [...this.targetOverflowEntities],
    };
  }
  getDurationMs(): number {
    return Date.now() - this.startedAt.getTime();
  }
}
export function createSyncBatchContext(): SyncBatchContext {
  return new SyncBatchContext();
}
