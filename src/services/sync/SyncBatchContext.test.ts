import { describe, it, expect, beforeEach } from '@jest/globals';
import type { EntityType } from '@shared/contracts';
import { ENTITY_TYPES } from '@shared/contracts';
import {
  SyncBatchContext,
  createSyncBatchContext,
  type DeferredCursorUpdate,
} from './SyncBatchContext';
describe('SyncBatchContext construction', () => {
  it('should generate unique batchId on each construction', () => {
    const ctx1 = new SyncBatchContext();
    const ctx2 = new SyncBatchContext();
    expect(ctx1.batchId).toBeDefined();
    expect(ctx2.batchId).toBeDefined();
    expect(ctx1.batchId).not.toBe(ctx2.batchId);
  });
  it('should have batchId matching expected format', () => {
    const ctx = new SyncBatchContext();
    expect(ctx.batchId).toMatch(/^sync-[a-z0-9]+-[a-z0-9]+$/);
  });
  it('should set startedAt to current time', () => {
    const before = new Date();
    const ctx = new SyncBatchContext();
    const after = new Date();
    expect(ctx.startedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(ctx.startedAt.getTime()).toBeLessThanOrEqual(after.getTime());
  });
  it('should initialize with no touched entities', () => {
    const ctx = new SyncBatchContext();
    expect(ctx.hasTouchedEntities()).toBe(false);
    expect(ctx.getTotalTouchedCount()).toBe(0);
  });
  it('should initialize with no deferred cursor updates', () => {
    const ctx = new SyncBatchContext();
    expect(ctx.hasDeferredCursorUpdates()).toBe(false);
    expect(ctx.getDeferredCursorUpdates()).toHaveLength(0);
  });
  it('should initialize with no ID replacements', () => {
    const ctx = new SyncBatchContext();
    expect(ctx.hasIdReplacements()).toBe(false);
  });
  it('should initialize with no deletes', () => {
    const ctx = new SyncBatchContext();
    expect(ctx.getEntityTypesWithDeletes()).toHaveLength(0);
  });
});
describe('createSyncBatchContext factory', () => {
  it('should return a valid SyncBatchContext instance', () => {
    const ctx = createSyncBatchContext();
    expect(ctx).toBeInstanceOf(SyncBatchContext);
    expect(ctx.batchId).toBeDefined();
  });
  it('should create unique instances each time', () => {
    const ctx1 = createSyncBatchContext();
    const ctx2 = createSyncBatchContext();
    expect(ctx1).not.toBe(ctx2);
    expect(ctx1.batchId).not.toBe(ctx2.batchId);
  });
});
describe('SyncBatchContext source-side tracking', () => {
  let ctx: SyncBatchContext;
  beforeEach(() => {
    ctx = new SyncBatchContext();
  });
  describe('touch()', () => {
    it('should mark a single entity as touched', () => {
      ctx.touch('consumptions', 'id-1');
      const touched = ctx.getTouchedIds();
      expect(touched.consumptions).toContain('id-1');
      expect(ctx.getTotalTouchedCount()).toBe(1);
    });
    it('should deduplicate same ID touched multiple times', () => {
      ctx.touch('sessions', 'id-1');
      ctx.touch('sessions', 'id-1');
      ctx.touch('sessions', 'id-1');
      const touched = ctx.getTouchedIds();
      expect(touched.sessions).toHaveLength(1);
      expect(ctx.getTotalTouchedCount()).toBe(1);
    });
    it('should track different entity types separately', () => {
      ctx.touch('consumptions', 'cons-1');
      ctx.touch('sessions', 'sess-1');
      ctx.touch('products', 'prod-1');
      const touched = ctx.getTouchedIds();
      expect(touched.consumptions).toContain('cons-1');
      expect(touched.sessions).toContain('sess-1');
      expect(touched.products).toContain('prod-1');
      expect(ctx.getTotalTouchedCount()).toBe(3);
    });
    it('should track multiple IDs for same entity type', () => {
      ctx.touch('consumptions', 'id-1');
      ctx.touch('consumptions', 'id-2');
      ctx.touch('consumptions', 'id-3');
      const touched = ctx.getTouchedIds();
      expect(touched.consumptions).toHaveLength(3);
      expect(touched.consumptions).toContain('id-1');
      expect(touched.consumptions).toContain('id-2');
      expect(touched.consumptions).toContain('id-3');
    });
  });
  describe('touchMultiple()', () => {
    it('should mark multiple entities as touched at once', () => {
      ctx.touchMultiple('sessions', ['id-1', 'id-2', 'id-3']);
      const touched = ctx.getTouchedIds();
      expect(touched.sessions).toHaveLength(3);
      expect(ctx.getTotalTouchedCount()).toBe(3);
    });
    it('should handle empty array', () => {
      ctx.touchMultiple('products', []);
      expect(ctx.hasTouchedEntities()).toBe(false);
    });
    it('should deduplicate within the same call', () => {
      ctx.touchMultiple('consumptions', ['id-1', 'id-1', 'id-2']);
      const touched = ctx.getTouchedIds();
      expect(touched.consumptions).toHaveLength(2);
    });
    it('should deduplicate across touch and touchMultiple calls', () => {
      ctx.touch('sessions', 'id-1');
      ctx.touchMultiple('sessions', ['id-1', 'id-2']);
      const touched = ctx.getTouchedIds();
      expect(touched.sessions).toHaveLength(2);
    });
  });
  describe('getTouchedIds()', () => {
    it('should return only entity types with touched IDs', () => {
      ctx.touch('consumptions', 'id-1');
      ctx.touch('sessions', 'id-2');
      const touched = ctx.getTouchedIds();
      expect(touched.consumptions).toBeDefined();
      expect(touched.sessions).toBeDefined();
      expect(touched.products).toBeUndefined();
      expect(touched.devices).toBeUndefined();
    });
    it('should return empty object when nothing touched', () => {
      const touched = ctx.getTouchedIds();
      expect(Object.keys(touched)).toHaveLength(0);
    });
    it('should return arrays, not Sets', () => {
      ctx.touch('consumptions', 'id-1');
      const touched = ctx.getTouchedIds();
      expect(Array.isArray(touched.consumptions)).toBe(true);
    });
  });
  describe('hasTouchedEntities()', () => {
    it('should return false when nothing touched', () => {
      expect(ctx.hasTouchedEntities()).toBe(false);
    });
    it('should return true when at least one entity touched', () => {
      ctx.touch('devices', 'device-1');
      expect(ctx.hasTouchedEntities()).toBe(true);
    });
  });
  describe('getTotalTouchedCount()', () => {
    it('should count all unique touched IDs across all entity types', () => {
      ctx.touch('consumptions', 'id-1');
      ctx.touch('consumptions', 'id-2');
      ctx.touch('sessions', 'id-3');
      ctx.touch('products', 'id-4');
      expect(ctx.getTotalTouchedCount()).toBe(4);
    });
    it('should not double-count duplicate IDs', () => {
      ctx.touch('sessions', 'id-1');
      ctx.touch('sessions', 'id-1');
      expect(ctx.getTotalTouchedCount()).toBe(1);
    });
  });
});
describe('SyncBatchContext target-side tracking', () => {
  let ctx: SyncBatchContext;
  beforeEach(() => {
    ctx = new SyncBatchContext();
  });
  describe('touchTarget()', () => {
    it('should track target entity IDs separately from source IDs', () => {
      ctx.touchTarget('products', 'prod-1');
      const targetIds = ctx.getTouchedTargetIds();
      const sourceIds = ctx.getTouchedIds();
      expect(targetIds.products).toContain('prod-1');
      expect(sourceIds.products).toBeUndefined(); 
    });
    it('should deduplicate target IDs', () => {
      ctx.touchTarget('sessions', 'sess-1');
      ctx.touchTarget('sessions', 'sess-1');
      const targetIds = ctx.getTouchedTargetIds();
      expect(targetIds.sessions).toHaveLength(1);
    });
  });
  describe('recordIdReplacement()', () => {
    it('should track both old and new IDs as target touches', () => {
      ctx.recordIdReplacement('products', 'client-id', 'server-id');
      const targetIds = ctx.getTouchedTargetIds();
      expect(targetIds.products).toContain('client-id');
      expect(targetIds.products).toContain('server-id');
    });
    it('should also track new ID as source touch', () => {
      ctx.recordIdReplacement('consumptions', 'old-id', 'new-id');
      const sourceIds = ctx.getTouchedIds();
      expect(sourceIds.consumptions).toContain('new-id');
      expect(sourceIds.consumptions).not.toContain('old-id');
    });
    it('should set hadIdReplacements flag', () => {
      expect(ctx.hasIdReplacements()).toBe(false);
      ctx.recordIdReplacement('sessions', 'old', 'new');
      expect(ctx.hasIdReplacements()).toBe(true);
    });
  });
  describe('recordDelete()', () => {
    it('should track deleted entity ID in both source and target', () => {
      ctx.recordDelete('products', 'deleted-id');
      const sourceIds = ctx.getTouchedIds();
      const targetIds = ctx.getTouchedTargetIds();
      expect(sourceIds.products).toContain('deleted-id');
      expect(targetIds.products).toContain('deleted-id');
    });
    it('should track entity type with deletes', () => {
      ctx.recordDelete('sessions', 'sess-1');
      ctx.recordDelete('consumptions', 'cons-1');
      const withDeletes = ctx.getEntityTypesWithDeletes();
      expect(withDeletes).toContain('sessions');
      expect(withDeletes).toContain('consumptions');
      expect(withDeletes).not.toContain('products');
    });
    it('should not duplicate entity type in deletes list', () => {
      ctx.recordDelete('sessions', 'sess-1');
      ctx.recordDelete('sessions', 'sess-2');
      const withDeletes = ctx.getEntityTypesWithDeletes();
      expect(withDeletes.filter((e) => e === 'sessions')).toHaveLength(1);
    });
  });
  describe('getTouchedTargetIds()', () => {
    it('should return only entity types with touched target IDs', () => {
      ctx.touchTarget('products', 'prod-1');
      const targetIds = ctx.getTouchedTargetIds();
      expect(targetIds.products).toBeDefined();
      expect(targetIds.sessions).toBeUndefined();
    });
  });
});
describe('SyncBatchContext deferred cursor updates', () => {
  let ctx: SyncBatchContext;
  beforeEach(() => {
    ctx = new SyncBatchContext();
  });
  describe('deferCursorUpdate()', () => {
    it('should store cursor update for later persistence', () => {
      ctx.deferCursorUpdate('consumptions', 'cursor-abc', 50, false);
      expect(ctx.hasDeferredCursorUpdates()).toBe(true);
      const updates = ctx.getDeferredCursorUpdates();
      expect(updates).toHaveLength(1);
      expect(updates[0]).toEqual({
        entityType: 'consumptions',
        cursor: 'cursor-abc',
        recordsSynced: 50,
        hasMore: false,
      });
    });
    it('should handle null cursor', () => {
      ctx.deferCursorUpdate('sessions', null, 0, false);
      const updates = ctx.getDeferredCursorUpdates();
      expect(updates).toHaveLength(1);
      expect(updates[0]!.cursor).toBeNull();
    });
    it('should keep most recent cursor per entity type', () => {
      ctx.deferCursorUpdate('consumptions', 'cursor-1', 10, true);
      ctx.deferCursorUpdate('consumptions', 'cursor-2', 20, true);
      ctx.deferCursorUpdate('consumptions', 'cursor-3', 30, false);
      const updates = ctx.getDeferredCursorUpdates();
      expect(updates).toHaveLength(1);
      expect(updates[0]!.cursor).toBe('cursor-3');
      expect(updates[0]!.recordsSynced).toBe(30);
      expect(updates[0]!.hasMore).toBe(false);
    });
    it('should track multiple entity types independently', () => {
      ctx.deferCursorUpdate('consumptions', 'cursor-cons', 10, false);
      ctx.deferCursorUpdate('sessions', 'cursor-sess', 20, false);
      ctx.deferCursorUpdate('products', 'cursor-prod', 30, false);
      const updates = ctx.getDeferredCursorUpdates();
      expect(updates).toHaveLength(3);
      const entityTypes = updates.map((u) => u.entityType);
      expect(entityTypes).toContain('consumptions');
      expect(entityTypes).toContain('sessions');
      expect(entityTypes).toContain('products');
    });
  });
  describe('getDeferredCursorUpdates()', () => {
    it('should return empty array when no updates', () => {
      const updates = ctx.getDeferredCursorUpdates();
      expect(updates).toEqual([]);
    });
    it('should return readonly array', () => {
      ctx.deferCursorUpdate('consumptions', 'cursor', 10, false);
      const updates = ctx.getDeferredCursorUpdates();
      expect(Array.isArray(updates)).toBe(true);
    });
  });
  describe('hasDeferredCursorUpdates()', () => {
    it('should return false when no updates', () => {
      expect(ctx.hasDeferredCursorUpdates()).toBe(false);
    });
    it('should return true when updates exist', () => {
      ctx.deferCursorUpdate('sessions', 'cursor', 5, false);
      expect(ctx.hasDeferredCursorUpdates()).toBe(true);
    });
  });
});
describe('SyncBatchContext immutability', () => {
  it('should have readonly batchId (compile-time enforcement)', () => {
    const ctx = new SyncBatchContext();
    expect(ctx.batchId).toBeDefined();
    expect(ctx.batchId).toMatch(/^sync-[a-z0-9]+-[a-z0-9]+$/);
  });
  it('should have readonly startedAt (compile-time enforcement)', () => {
    const ctx = new SyncBatchContext();
    const originalTime = ctx.startedAt.getTime();
    expect(ctx.startedAt).toBeInstanceOf(Date);
    expect(originalTime).toBeGreaterThan(0);
  });
  it('should only allow IDs to be added, not removed', () => {
    const ctx = new SyncBatchContext();
    ctx.touch('consumptions', 'id-1');
    ctx.touch('consumptions', 'id-2');
    expect(ctx.getTouchedIds().consumptions).toHaveLength(2);
    expect(typeof (ctx as any).removeTouch).not.toBe('function');
    expect(typeof (ctx as any).clearTouched).not.toBe('function');
  });
});
describe('SyncBatchContext logging support', () => {
  it('should provide comprehensive summary', () => {
    const ctx = new SyncBatchContext();
    ctx.touch('consumptions', 'cons-1');
    ctx.touch('consumptions', 'cons-2');
    ctx.touch('sessions', 'sess-1');
    ctx.recordDelete('products', 'prod-1');
    ctx.recordIdReplacement('devices', 'old', 'new');
    ctx.deferCursorUpdate('consumptions', 'cursor', 10, false);
    const summary = ctx.getSummary();
    expect(summary.batchId).toBe(ctx.batchId);
    expect(summary.startedAt).toBe(ctx.startedAt.toISOString());
    expect(summary.totalTouched).toBe(5); 
    expect(summary.hadIdReplacements).toBe(true);
    expect(summary.entitiesWithDeletes).toContain('products');
    expect(summary.deferredCursorCount).toBe(1);
  });
  it('should format entitiesWithTouches correctly', () => {
    const ctx = new SyncBatchContext();
    ctx.touch('consumptions', 'id-1');
    ctx.touch('consumptions', 'id-2');
    ctx.touch('sessions', 'id-3');
    const summary = ctx.getSummary();
    expect(summary.entitiesWithTouches).toContain('consumptions(2)');
    expect(summary.entitiesWithTouches).toContain('sessions(1)');
  });
  it('should calculate duration correctly', () => {
    const ctx = new SyncBatchContext();
    const startTime = ctx.startedAt.getTime();
    const duration = ctx.getDurationMs();
    expect(duration).toBeGreaterThanOrEqual(0);
    expect(duration).toBeLessThan(1000); 
  });
});
describe('SyncBatchContext integration behavior', () => {
  it('should support typical sync flow: touch during push/pull, defer cursors, get summary', () => {
    const ctx = createSyncBatchContext();
    ctx.touch('consumptions', 'pushed-cons-1');
    ctx.recordIdReplacement('sessions', 'client-sess-1', 'server-sess-1');
    ctx.touch('consumptions', 'pulled-cons-1');
    ctx.touch('products', 'pulled-prod-1');
    ctx.recordDelete('journal_entries', 'deleted-entry-1');
    ctx.deferCursorUpdate('consumptions', 'cursor-cons', 100, false);
    ctx.deferCursorUpdate('sessions', 'cursor-sess', 50, false);
    const sourceIds = ctx.getTouchedIds();
    const targetIds = ctx.getTouchedTargetIds();
    expect(sourceIds.consumptions).toContain('pushed-cons-1');
    expect(sourceIds.consumptions).toContain('pulled-cons-1');
    expect(sourceIds.sessions).toContain('server-sess-1');
    expect(sourceIds.products).toContain('pulled-prod-1');
    expect(sourceIds.journal_entries).toContain('deleted-entry-1');
    expect(targetIds.sessions).toContain('client-sess-1');
    expect(targetIds.sessions).toContain('server-sess-1');
    expect(targetIds.journal_entries).toContain('deleted-entry-1');
    expect(ctx.getDeferredCursorUpdates()).toHaveLength(2);
    expect(ctx.hasIdReplacements()).toBe(true);
    expect(ctx.getEntityTypesWithDeletes()).toContain('journal_entries');
    const summary = ctx.getSummary();
    expect(summary.batchId).toBe(ctx.batchId);
    expect(summary.totalTouched).toBeGreaterThan(0);
    expect(summary.deferredCursorCount).toBe(2);
  });
  it('should provide correct touchedIds format for IntegrityGate', () => {
    const ctx = new SyncBatchContext();
    ctx.touch('consumptions', 'id-1');
    ctx.touch('consumptions', 'id-2');
    ctx.touch('sessions', 'id-3');
    const touchedIds = ctx.getTouchedIds();
    expect(typeof touchedIds).toBe('object');
    expect(Array.isArray(touchedIds.consumptions)).toBe(true);
    expect(Array.isArray(touchedIds.sessions)).toBe(true);
    expect(Object.keys(touchedIds).length).toBe(2);
  });
  it('should handle all valid entity types', () => {
    const ctx = new SyncBatchContext();
    for (const entityType of ENTITY_TYPES) {
      ctx.touch(entityType, `${entityType}-id`);
    }
    const touched = ctx.getTouchedIds();
    expect(Object.keys(touched).length).toBe(ENTITY_TYPES.length);
  });
});
describe('SyncBatchContext overflow protection', () => {
  it('should track source overflow entities', () => {
    const ctx = new SyncBatchContext();
    for (let i = 0; i < 5001; i++) {
      ctx.touch('consumptions', `id-${i}`);
    }
    expect(ctx.hasSourceOverflow()).toBe(true);
    expect(ctx.hasTargetOverflow()).toBe(false);
    expect(ctx.hasOverflow()).toBe(true);
    expect(ctx.getSourceOverflowEntities()).toContain('consumptions');
  });
  it('should track target overflow entities', () => {
    const ctx = new SyncBatchContext();
    for (let i = 0; i < 5001; i++) {
      ctx.touchTarget('sessions', `id-${i}`);
    }
    expect(ctx.hasSourceOverflow()).toBe(false);
    expect(ctx.hasTargetOverflow()).toBe(true);
    expect(ctx.hasOverflow()).toBe(true);
    expect(ctx.getTargetOverflowEntities()).toContain('sessions');
  });
  it('should not overflow before limit', () => {
    const ctx = new SyncBatchContext();
    for (let i = 0; i < 4999; i++) {
      ctx.touch('products', `id-${i}`);
    }
    expect(ctx.hasOverflow()).toBe(false);
    expect(ctx.getTotalTouchedCount()).toBe(4999);
  });
  it('should include overflow in summary', () => {
    const ctx = new SyncBatchContext();
    for (let i = 0; i < 5001; i++) {
      ctx.touch('consumptions', `id-${i}`);
    }
    const summary = ctx.getSummary();
    expect(summary.hasOverflow).toBe(true);
    expect(summary.sourceOverflowEntities).toContain('consumptions');
  });
  it('should show overflow indicator in entitiesWithTouches', () => {
    const ctx = new SyncBatchContext();
    for (let i = 0; i < 5001; i++) {
      ctx.touch('sessions', `id-${i}`);
    }
    const summary = ctx.getSummary();
    const sessionsEntry = summary.entitiesWithTouches.find((e) => e.startsWith('sessions'));
    expect(sessionsEntry).toContain('+');
  });
});
describe('SyncBatchContext sorted output', () => {
  it('should return sorted touchedIds arrays', () => {
    const ctx = new SyncBatchContext();
    ctx.touch('consumptions', 'z-id');
    ctx.touch('consumptions', 'a-id');
    ctx.touch('consumptions', 'm-id');
    const touched = ctx.getTouchedIds();
    const ids = touched.consumptions!;
    expect(ids[0]).toBe('a-id');
    expect(ids[1]).toBe('m-id');
    expect(ids[2]).toBe('z-id');
  });
  it('should return sorted touchedTargetIds arrays', () => {
    const ctx = new SyncBatchContext();
    ctx.touchTarget('sessions', 'z-target');
    ctx.touchTarget('sessions', 'a-target');
    const targetIds = ctx.getTouchedTargetIds();
    const ids = targetIds.sessions!;
    expect(ids[0]).toBe('a-target');
    expect(ids[1]).toBe('z-target');
  });
});
describe('SyncBatchContext edge cases', () => {
  it('should handle empty string IDs', () => {
    const ctx = new SyncBatchContext();
    ctx.touch('consumptions', '');
    const touched = ctx.getTouchedIds();
    expect(touched.consumptions).toContain('');
  });
  it('should handle very long IDs', () => {
    const ctx = new SyncBatchContext();
    const longId = 'a'.repeat(1000);
    ctx.touch('sessions', longId);
    const touched = ctx.getTouchedIds();
    expect(touched.sessions).toContain(longId);
  });
  it('should handle special characters in IDs', () => {
    const ctx = new SyncBatchContext();
    const specialId = 'id-with-special-chars!@#$%^&*()_+';
    ctx.touch('products', specialId);
    const touched = ctx.getTouchedIds();
    expect(touched.products).toContain(specialId);
  });
  it('should handle large number of touched IDs with overflow protection', () => {
    const ctx = new SyncBatchContext();
    for (let i = 0; i < 10000; i++) {
      ctx.touch('consumptions', `id-${i}`);
    }
    expect(ctx.getTotalTouchedCount()).toBe(5000);
    expect(ctx.getTouchedIds().consumptions).toHaveLength(5000);
    expect(ctx.hasSourceOverflow()).toBe(true);
    expect(ctx.getSourceOverflowEntities()).toContain('consumptions');
  });
});
