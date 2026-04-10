import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import type { EntityType } from '@shared/contracts';
import { ENTITY_TYPES } from '@shared/contracts';
import {
  SyncBatchContext,
  createSyncBatchContext,
  type DeferredCursorUpdate,
} from './SyncBatchContext';
import {
  IntegrityGate,
  IntegrityViolationError,
  IntegrityCheckExecutionError,
  type IntegrityReport,
  type IntegrityCheckOptions,
  type TouchedIds,
} from './IntegrityGate';
jest.mock('../../utils/logger', () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
  toLogError: jest.fn((error: unknown) => ({
    name: error instanceof Error ? error.name : 'Error',
    message: error instanceof Error ? error.message : String(error),
  })),
}));
function createMockIntegrityGate() {
  const mockCheckIntegrity = jest.fn<(options: IntegrityCheckOptions) => Promise<IntegrityReport>>();
  mockCheckIntegrity.mockResolvedValue(createOkReport());
  const mockGate = {
    checkIntegrity: mockCheckIntegrity,
    setFailFastMode: jest.fn(),
    isFailFastMode: jest.fn().mockReturnValue(false),
    checkEntities: jest.fn(),
    checkTouchedEntities: jest.fn(),
    checkRequiredFksOnly: jest.fn(),
  };
  return {
    gate: mockGate as unknown as IntegrityGate,
    checkIntegrity: mockCheckIntegrity,
    setReport: (report: IntegrityReport) => mockCheckIntegrity.mockResolvedValue(report),
    setError: (error: Error) => mockCheckIntegrity.mockRejectedValue(error),
  };
}
function createOkReport(): IntegrityReport {
  return {
    status: 'ok',
    violations: [],
    violationCount: 0,
    timestamp: new Date().toISOString(),
    entitiesChecked: [],
    relationsPlanned: 0,
    relationsExecuted: 0,
    relationsSkipped: 0,
    relationsSucceeded: 0,
    relationsFailed: 0,
    relationResults: [],
    durationMs: 10,
    error: null,
  };
}
function createViolationsReport(violationCount: number): IntegrityReport {
  const violations = Array(violationCount).fill(null).map((_, i) => ({
    entityType: 'consumptions' as EntityType,
    entityId: `source-id-${i}`,
    foreignKeyField: 'sessionId',
    sqliteColumn: 'session_id',
    missingReferenceId: `orphan-id-${i}`,
    missingReferenceEntity: 'sessions' as EntityType,
    isOptionalFk: false,
  }));
  return {
    status: 'violations',
    violations,
    violationCount,
    timestamp: new Date().toISOString(),
    entitiesChecked: ['consumptions'] as EntityType[],
    relationsPlanned: 1,
    relationsExecuted: 1,
    relationsSkipped: 0,
    relationsSucceeded: 0,
    relationsFailed: 1,
    relationResults: [
      {
        relation: {
          sourceEntity: 'consumptions' as EntityType,
          sourceField: 'sessionId',
          targetEntity: 'sessions' as EntityType,
          optional: false,
          sqliteColumn: 'session_id',
        },
        status: 'failed' as const,
        violations,
        chunksExecuted: 1,
      },
    ],
    durationMs: 10,
    error: null,
  };
}
function createPartialReport(): IntegrityReport {
  return {
    status: 'partial',
    violations: [],
    violationCount: 0,
    timestamp: new Date().toISOString(),
    entitiesChecked: ['consumptions'] as EntityType[],
    relationsPlanned: 5,
    relationsExecuted: 2,
    relationsSkipped: 0,
    relationsSucceeded: 1,
    relationsFailed: 1,
    relationResults: [
      {
        relation: {
          sourceEntity: 'consumptions' as EntityType,
          sourceField: 'sessionId',
          targetEntity: 'sessions' as EntityType,
          optional: false,
          sqliteColumn: 'session_id',
        },
        status: 'success' as const,
        violations: [],
        chunksExecuted: 1,
      },
      {
        relation: {
          sourceEntity: 'consumptions' as EntityType,
          sourceField: 'productId',
          targetEntity: 'products' as EntityType,
          optional: false,
          sqliteColumn: 'product_id',
        },
        status: 'failed' as const,
        violations: [],
        chunksExecuted: 0,
        error: {
          name: 'Error',
          message: 'Query execution failed',
        },
      },
    ],
    durationMs: 10,
    error: 'Query execution failed for 1 relation',
  };
}
function createMockCursorRepo() {
  const cursors = new Map<EntityType, string | null>();
  return {
    getCursor: jest.fn((entityType: EntityType) => Promise.resolve(cursors.get(entityType) ?? null)),
    setCursor: jest.fn((entityType: EntityType, cursor: string | null) => {
      cursors.set(entityType, cursor);
      return Promise.resolve();
    }),
    clearCursor: jest.fn((entityType: EntityType) => {
      cursors.delete(entityType);
      return Promise.resolve();
    }),
    clearAllCursors: jest.fn(() => {
      cursors.clear();
      return Promise.resolve();
    }),
    _getCursorsMap: () => cursors, 
  };
}
describe('SyncBatchContext + IntegrityGate integration', () => {
  let ctx: SyncBatchContext;
  let mockGate: ReturnType<typeof createMockIntegrityGate>;
  beforeEach(() => {
    ctx = createSyncBatchContext();
    mockGate = createMockIntegrityGate();
  });
  describe('touchedIds flow from context to gate', () => {
    it('should pass touchedIds from context to IntegrityGate', async () => {
      ctx.touch('consumptions', 'cons-1');
      ctx.touch('consumptions', 'cons-2');
      ctx.touch('sessions', 'sess-1');
      const touchedIds = ctx.getTouchedIds();
      await mockGate.gate.checkIntegrity({
        touchedIds,
        syncBatchId: ctx.batchId,
      });
      expect(mockGate.checkIntegrity).toHaveBeenCalledTimes(1);
      const firstCall = mockGate.checkIntegrity.mock.calls[0];
      expect(firstCall).toBeDefined();
      const callArgs = firstCall![0];
      expect(callArgs.syncBatchId).toBe(ctx.batchId);
      expect(callArgs.touchedIds?.consumptions).toContain('cons-1');
      expect(callArgs.touchedIds?.consumptions).toContain('cons-2');
      expect(callArgs.touchedIds?.sessions).toContain('sess-1');
    });
    it('should include target-side IDs after ID replacements', async () => {
      ctx.recordIdReplacement('sessions', 'client-sess-1', 'server-sess-1');
      const sourceIds = ctx.getTouchedIds();
      const targetIds = ctx.getTouchedTargetIds();
      expect(sourceIds.sessions).toContain('server-sess-1');
      expect(targetIds.sessions).toContain('client-sess-1');
      expect(targetIds.sessions).toContain('server-sess-1');
      expect(ctx.hasIdReplacements()).toBe(true);
    });
    it('should track deletes correctly for integrity checking', async () => {
      ctx.recordDelete('products', 'deleted-prod-1');
      const sourceIds = ctx.getTouchedIds();
      const targetIds = ctx.getTouchedTargetIds();
      expect(sourceIds.products).toContain('deleted-prod-1');
      expect(targetIds.products).toContain('deleted-prod-1');
      expect(ctx.getEntityTypesWithDeletes()).toContain('products');
    });
  });
  describe('batchId correlation', () => {
    it('should pass batchId through for logging correlation', async () => {
      await mockGate.gate.checkIntegrity({
        touchedIds: ctx.getTouchedIds(),
        syncBatchId: ctx.batchId,
      });
      const firstCall = mockGate.checkIntegrity.mock.calls[0];
      expect(firstCall).toBeDefined();
      const callArgs = firstCall![0];
      expect(callArgs.syncBatchId).toBe(ctx.batchId);
    });
    it('should have unique batchId per sync run', () => {
      const ctx1 = createSyncBatchContext();
      const ctx2 = createSyncBatchContext();
      expect(ctx1.batchId).not.toBe(ctx2.batchId);
    });
  });
  describe('report handling', () => {
    it('should handle "ok" report (no violations)', async () => {
      mockGate.setReport(createOkReport());
      const report = await mockGate.gate.checkIntegrity({
        touchedIds: ctx.getTouchedIds(),
      });
      expect(report.status).toBe('ok');
      expect(report.violationCount).toBe(0);
    });
    it('should handle "violations" report', async () => {
      mockGate.setReport(createViolationsReport(5));
      const report = await mockGate.gate.checkIntegrity({
        touchedIds: ctx.getTouchedIds(),
      });
      expect(report.status).toBe('violations');
      expect(report.violationCount).toBe(5);
    });
    it('should handle "partial" report (execution errors)', async () => {
      mockGate.setReport(createPartialReport());
      const report = await mockGate.gate.checkIntegrity({
        touchedIds: ctx.getTouchedIds(),
      });
      expect(report.status).toBe('partial');
      expect(report.relationsFailed).toBeGreaterThan(0);
    });
  });
});
describe('Cursor deferral integration', () => {
  let ctx: SyncBatchContext;
  let mockCursorRepo: ReturnType<typeof createMockCursorRepo>;
  let mockGate: ReturnType<typeof createMockIntegrityGate>;
  beforeEach(() => {
    ctx = createSyncBatchContext();
    mockCursorRepo = createMockCursorRepo();
    mockGate = createMockIntegrityGate();
  });
  async function persistDeferredCursors(context: SyncBatchContext): Promise<void> {
    const updates = context.getDeferredCursorUpdates();
    for (const update of updates) {
      await mockCursorRepo.setCursor(update.entityType, update.cursor);
    }
  }
  describe('deferred cursor workflow', () => {
    it('should NOT persist cursors before integrity check', async () => {
      ctx.deferCursorUpdate('consumptions', 'cursor-cons', 100, false);
      ctx.deferCursorUpdate('sessions', 'cursor-sess', 50, false);
      expect(mockCursorRepo.setCursor).not.toHaveBeenCalled();
      expect(ctx.hasDeferredCursorUpdates()).toBe(true);
      expect(ctx.getDeferredCursorUpdates()).toHaveLength(2);
    });
    it('should persist cursors AFTER integrity check passes', async () => {
      ctx.deferCursorUpdate('consumptions', 'cursor-cons', 100, false);
      ctx.deferCursorUpdate('sessions', 'cursor-sess', 50, false);
      const report = await mockGate.gate.checkIntegrity({
        touchedIds: ctx.getTouchedIds(),
        syncBatchId: ctx.batchId,
      });
      expect(report.status).toBe('ok');
      await persistDeferredCursors(ctx);
      expect(mockCursorRepo.setCursor).toHaveBeenCalledTimes(2);
      expect(mockCursorRepo.setCursor).toHaveBeenCalledWith('consumptions', 'cursor-cons');
      expect(mockCursorRepo.setCursor).toHaveBeenCalledWith('sessions', 'cursor-sess');
    });
    it('should NOT persist cursors if integrity check finds violations (fail-fast)', async () => {
      ctx.deferCursorUpdate('consumptions', 'cursor-cons', 100, false);
      mockGate.setReport(createViolationsReport(3));
      const report = await mockGate.gate.checkIntegrity({
        touchedIds: ctx.getTouchedIds(),
      });
      expect(report.status).toBe('violations');
      expect(mockCursorRepo.setCursor).not.toHaveBeenCalled();
    });
    it('should NOT persist cursors if integrity check throws execution error', async () => {
      ctx.deferCursorUpdate('consumptions', 'cursor-cons', 100, false);
      const execError = new IntegrityCheckExecutionError(createPartialReport());
      mockGate.setError(execError);
      let caughtError: Error | null = null;
      try {
        await mockGate.gate.checkIntegrity({
          touchedIds: ctx.getTouchedIds(),
        });
      } catch (error) {
        caughtError = error as Error;
      }
      expect(caughtError).toBeInstanceOf(IntegrityCheckExecutionError);
      expect(mockCursorRepo.setCursor).not.toHaveBeenCalled();
    });
    it('should handle multiple cursor updates per entity type (keeps last)', async () => {
      ctx.deferCursorUpdate('consumptions', 'cursor-page-1', 100, true);
      ctx.deferCursorUpdate('consumptions', 'cursor-page-2', 100, true);
      ctx.deferCursorUpdate('consumptions', 'cursor-page-3', 100, false);
      const updates = ctx.getDeferredCursorUpdates();
      expect(updates).toHaveLength(1);
      const firstUpdate = updates[0];
      expect(firstUpdate).toBeDefined();
      expect(firstUpdate!.cursor).toBe('cursor-page-3');
      expect(firstUpdate!.hasMore).toBe(false);
      await persistDeferredCursors(ctx);
      expect(mockCursorRepo.setCursor).toHaveBeenCalledTimes(1);
      expect(mockCursorRepo.setCursor).toHaveBeenCalledWith('consumptions', 'cursor-page-3');
    });
  });
  describe('cursor persistence ordering', () => {
    it('should persist all deferred cursors in batch after integrity passes', async () => {
      ctx.deferCursorUpdate('consumptions', 'cursor-cons', 100, false);
      ctx.deferCursorUpdate('sessions', 'cursor-sess', 50, false);
      ctx.deferCursorUpdate('products', 'cursor-prod', 25, false);
      ctx.deferCursorUpdate('devices', 'cursor-dev', 10, false);
      const report = await mockGate.gate.checkIntegrity({
        touchedIds: ctx.getTouchedIds(),
      });
      expect(report.status).toBe('ok');
      await persistDeferredCursors(ctx);
      expect(mockCursorRepo.setCursor).toHaveBeenCalledTimes(4);
    });
  });
});
describe('Error propagation integration', () => {
  let ctx: SyncBatchContext;
  let mockGate: ReturnType<typeof createMockIntegrityGate>;
  beforeEach(() => {
    ctx = createSyncBatchContext();
    mockGate = createMockIntegrityGate();
  });
  describe('IntegrityViolationError handling', () => {
    it('should propagate violations in fail-fast mode', async () => {
      const violationsReport = createViolationsReport(3);
      const violationError = new IntegrityViolationError(violationsReport);
      mockGate.setError(violationError);
      let caughtError: Error | null = null;
      try {
        await mockGate.gate.checkIntegrity({
          touchedIds: ctx.getTouchedIds(),
        });
      } catch (error) {
        caughtError = error as Error;
      }
      expect(caughtError).toBeInstanceOf(IntegrityViolationError);
      const err = caughtError as IntegrityViolationError;
      expect(err.violations).toHaveLength(3);
      expect(err.report.status).toBe('violations');
    });
  });
  describe('IntegrityCheckExecutionError handling', () => {
    it('should propagate execution errors', async () => {
      const partialReport = createPartialReport();
      const execError = new IntegrityCheckExecutionError(partialReport);
      mockGate.setError(execError);
      let caughtError: Error | null = null;
      try {
        await mockGate.gate.checkIntegrity({
          touchedIds: ctx.getTouchedIds(),
        });
      } catch (error) {
        caughtError = error as Error;
      }
      expect(caughtError).toBeInstanceOf(IntegrityCheckExecutionError);
      const err = caughtError as IntegrityCheckExecutionError;
      expect(err.report.status).toBe('partial');
      expect(err.report.relationsFailed).toBeGreaterThan(0);
    });
  });
});
describe('Full sync flow simulation', () => {
  let ctx: SyncBatchContext;
  let mockGate: ReturnType<typeof createMockIntegrityGate>;
  let mockCursorRepo: ReturnType<typeof createMockCursorRepo>;
  beforeEach(() => {
    ctx = createSyncBatchContext();
    mockGate = createMockIntegrityGate();
    mockCursorRepo = createMockCursorRepo();
  });
  async function simulateSyncRun(options?: {
    integrityPasses?: boolean;
    throwExecutionError?: boolean;
    failFastMode?: boolean;
  }): Promise<{
    success: boolean;
    error?: Error;
    cursorsPersistedCount: number;
  }> {
    const {
      integrityPasses = true,
      throwExecutionError = false,
      failFastMode = false,
    } = options ?? {};
    ctx.touch('consumptions', 'pushed-cons-1');
    ctx.recordIdReplacement('sessions', 'client-sess-1', 'server-sess-1');
    ctx.touch('consumptions', 'pulled-cons-1');
    ctx.touch('consumptions', 'pulled-cons-2');
    ctx.touch('products', 'pulled-prod-1');
    ctx.deferCursorUpdate('consumptions', 'cursor-cons', 100, false);
    ctx.deferCursorUpdate('sessions', 'cursor-sess', 50, false);
    ctx.deferCursorUpdate('products', 'cursor-prod', 25, false);
    ctx.recordDelete('journal_entries', 'deleted-entry-1');
    if (throwExecutionError) {
      mockGate.setError(
        new IntegrityCheckExecutionError(createPartialReport())
      );
    } else if (!integrityPasses) {
      mockGate.setReport(createViolationsReport(5));
    } else {
      mockGate.setReport(createOkReport());
    }
    try {
      const report = await mockGate.gate.checkIntegrity({
        touchedIds: ctx.getTouchedIds(),
        syncBatchId: ctx.batchId,
      });
      if (failFastMode && report.status === 'violations') {
        throw new IntegrityViolationError(report);
      }
      if (report.status === 'ok' || (!failFastMode && report.status === 'violations')) {
        const updates = ctx.getDeferredCursorUpdates();
        for (const update of updates) {
          await mockCursorRepo.setCursor(update.entityType, update.cursor);
        }
      }
      return {
        success: report.status === 'ok' || (!failFastMode && report.status === 'violations'),
        cursorsPersistedCount: (mockCursorRepo.setCursor as jest.Mock).mock.calls.length,
      };
    } catch (error) {
      return {
        success: false,
        error: error as Error,
        cursorsPersistedCount: (mockCursorRepo.setCursor as jest.Mock).mock.calls.length,
      };
    }
  }
  it('should complete successfully when integrity passes', async () => {
    const result = await simulateSyncRun({ integrityPasses: true });
    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.cursorsPersistedCount).toBe(3); 
  });
  it('should continue in warn-only mode with violations (cursors persisted)', async () => {
    const result = await simulateSyncRun({
      integrityPasses: false,
      failFastMode: false,
    });
    expect(result.success).toBe(true);
    expect(result.cursorsPersistedCount).toBe(3);
  });
  it('should fail in fail-fast mode with violations (cursors NOT persisted)', async () => {
    const result = await simulateSyncRun({
      integrityPasses: false,
      failFastMode: true,
    });
    expect(result.success).toBe(false);
    expect(result.error).toBeInstanceOf(IntegrityViolationError);
    expect(result.cursorsPersistedCount).toBe(0);
  });
  it('should fail on execution error (cursors NOT persisted)', async () => {
    const result = await simulateSyncRun({
      throwExecutionError: true,
    });
    expect(result.success).toBe(false);
    expect(result.error).toBeInstanceOf(IntegrityCheckExecutionError);
    expect(result.cursorsPersistedCount).toBe(0);
  });
  it('should track all touched entities throughout sync phases', async () => {
    await simulateSyncRun({ integrityPasses: true });
    const firstCall = mockGate.checkIntegrity.mock.calls[0];
    expect(firstCall).toBeDefined();
    const callArgs = firstCall![0];
    const touchedIds = callArgs.touchedIds!;
    expect(touchedIds.consumptions).toContain('pushed-cons-1');
    expect(touchedIds.sessions).toContain('server-sess-1');
    expect(touchedIds.consumptions).toContain('pulled-cons-1');
    expect(touchedIds.consumptions).toContain('pulled-cons-2');
    expect(touchedIds.products).toContain('pulled-prod-1');
    expect(touchedIds.journal_entries).toContain('deleted-entry-1');
  });
  it('should pass batchId for correlation', async () => {
    await simulateSyncRun({ integrityPasses: true });
    const firstCall = mockGate.checkIntegrity.mock.calls[0];
    expect(firstCall).toBeDefined();
    const callArgs = firstCall![0];
    expect(callArgs.syncBatchId).toBe(ctx.batchId);
  });
});
describe('Context summary for logging', () => {
  it('should provide accurate summary after sync operations', () => {
    const ctx = createSyncBatchContext();
    ctx.touch('consumptions', 'cons-1');
    ctx.touch('consumptions', 'cons-2');
    ctx.touch('sessions', 'sess-1');
    ctx.recordIdReplacement('products', 'old-id', 'new-id');
    ctx.recordDelete('journal_entries', 'deleted-1');
    ctx.deferCursorUpdate('consumptions', 'cursor', 100, false);
    ctx.deferCursorUpdate('sessions', 'cursor', 50, false);
    const summary = ctx.getSummary();
    expect(summary.batchId).toBe(ctx.batchId);
    expect(summary.totalTouched).toBe(5); 
    expect(summary.hadIdReplacements).toBe(true);
    expect(summary.entitiesWithDeletes).toContain('journal_entries');
    expect(summary.deferredCursorCount).toBe(2);
    expect(summary.entitiesWithTouches.length).toBeGreaterThan(0);
  });
});
describe('Cursor advancement on partial failures', () => {
  it('should NOT defer cursor when failedApplies > 0 (partial failure scenario)', () => {
    const ctx = createSyncBatchContext();
    const successfulApplies: number = 4;
    const failedApplies: number = 1;
    const skippedApplies: number = 0;
    const canAdvanceCursor = 
      successfulApplies > 0 && 
      skippedApplies === 0 && 
      failedApplies === 0;
    expect(canAdvanceCursor).toBe(false);
    if (canAdvanceCursor) {
      ctx.deferCursorUpdate('consumptions', 'cursor-123', successfulApplies, false);
    }
    const updates = ctx.getDeferredCursorUpdates();
    expect(updates).toHaveLength(0);
  });
  it('should defer cursor when all applies succeed (no failures)', () => {
    const ctx = createSyncBatchContext();
    const successfulApplies: number = 5;
    const failedApplies: number = 0;
    const skippedApplies: number = 0;
    const canAdvanceCursor = 
      successfulApplies > 0 && 
      skippedApplies === 0 && 
      failedApplies === 0;
    expect(canAdvanceCursor).toBe(true);
    if (canAdvanceCursor) {
      ctx.deferCursorUpdate('consumptions', 'cursor-123', successfulApplies, false);
    }
    const updates = ctx.getDeferredCursorUpdates();
    expect(updates).toHaveLength(1);
    expect(updates[0]!.entityType).toBe('consumptions');
    expect(updates[0]!.cursor).toBe('cursor-123');
  });
  it('should NOT defer cursor when skippedApplies > 0', () => {
    const ctx = createSyncBatchContext();
    const successfulApplies: number = 3;
    const failedApplies: number = 0;
    const skippedApplies: number = 2;
    const canAdvanceCursor = 
      successfulApplies > 0 && 
      skippedApplies === 0 && 
      failedApplies === 0;
    expect(canAdvanceCursor).toBe(false);
    if (canAdvanceCursor) {
      ctx.deferCursorUpdate('consumptions', 'cursor-123', successfulApplies, false);
    }
    const updates = ctx.getDeferredCursorUpdates();
    expect(updates).toHaveLength(0);
  });
  it('should NOT defer cursor when no successful applies (all failed)', () => {
    const ctx = createSyncBatchContext();
    const successfulApplies: number = 0;
    const failedApplies: number = 5;
    const skippedApplies: number = 0;
    const canAdvanceCursor = 
      successfulApplies > 0 && 
      skippedApplies === 0 && 
      failedApplies === 0;
    expect(canAdvanceCursor).toBe(false);
    if (canAdvanceCursor) {
      ctx.deferCursorUpdate('consumptions', 'cursor-123', successfulApplies, false);
    }
    const updates = ctx.getDeferredCursorUpdates();
    expect(updates).toHaveLength(0);
  });
  it('should handle multiple entity types independently', () => {
    const ctx = createSyncBatchContext();
    const entity1Success: number = 10;
    const entity1Failed: number = 0;
    const entity1Skipped: number = 0;
    const canAdvanceEntity1 = entity1Success > 0 && entity1Skipped === 0 && entity1Failed === 0;
    expect(canAdvanceEntity1).toBe(true);
    if (canAdvanceEntity1) {
      ctx.deferCursorUpdate('consumptions', 'cons-cursor', entity1Success, false);
    }
    const entity2Success: number = 5;
    const entity2Failed: number = 2;
    const entity2Skipped: number = 0;
    const canAdvanceEntity2 = entity2Success > 0 && entity2Skipped === 0 && entity2Failed === 0;
    expect(canAdvanceEntity2).toBe(false);
    if (canAdvanceEntity2) {
      ctx.deferCursorUpdate('sessions', 'sess-cursor', entity2Success, false);
    }
    const entity3Success: number = 3;
    const entity3Failed: number = 0;
    const entity3Skipped: number = 0;
    const canAdvanceEntity3 = entity3Success > 0 && entity3Skipped === 0 && entity3Failed === 0;
    expect(canAdvanceEntity3).toBe(true);
    if (canAdvanceEntity3) {
      ctx.deferCursorUpdate('products', 'prod-cursor', entity3Success, false);
    }
    const updates = ctx.getDeferredCursorUpdates();
    expect(updates).toHaveLength(2);
    const entityTypes = updates.map(u => u.entityType);
    expect(entityTypes).toContain('consumptions');
    expect(entityTypes).toContain('products');
    expect(entityTypes).not.toContain('sessions');
  });
});
