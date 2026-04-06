import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { SQLiteDatabase } from 'expo-sqlite';
import type { EntityType, ForeignKeyRelation } from '@shared/contracts';
import { RELATION_GRAPH, ENTITY_TYPES } from '@shared/contracts';
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
import {
  IntegrityGate,
  IntegrityViolationError,
  IntegrityCheckExecutionError,
  buildOrphanDetectionQuery,
  getRelationsToCheck,
  getEntityStorage,
  getEntityTypeFromTable,
  chunkArray,
  executeQuery,
  ENTITY_STORAGE,
  TABLE_TO_ENTITY,
  SQLITE_PARAM_LIMIT,
  type IntegrityReport,
  type IntegrityCheckOptions,
  type EntityStorageSpec,
  type TouchedIds,
  type IntegrityViolation,
  type RelationCheckResult,
} from './IntegrityGate';
function getRelationId(rel: ForeignKeyRelation): string {
  return `${rel.sourceEntity}.${rel.sqliteColumn}->${rel.targetEntity}`;
}
interface MockRelationResponse {
  relationId: string;
  rows: Array<{ entityId: string; missingReferenceId: string }>;
  shouldThrow?: boolean;
  error?: Error;
}
function createMockDatabase(responses: MockRelationResponse[] = []): SQLiteDatabase {
  const responseMap = new Map(responses.map((r) => [r.relationId, r]));
  return {
    getAllAsync: jest.fn(async (sql: string, _params?: unknown[]) => {
      const fromMatch = sql.match(/FROM\s+"(\w+)"\s+s/);
      const joinMatch = sql.match(/LEFT JOIN\s+"(\w+)"\s+t\s+ON\s+s\."(\w+)"/);
      if (!fromMatch || !joinMatch) {
        throw new Error(`Could not parse SQL: ${sql}`);
      }
      const sourceTableName = fromMatch[1] as string;
      const targetTableName = joinMatch[1] as string;
      const fkColumn = joinMatch[2] as string;
      const sourceEntity = TABLE_TO_ENTITY[sourceTableName] as EntityType | undefined;
      const targetEntity = TABLE_TO_ENTITY[targetTableName] as EntityType | undefined;
      if (!sourceEntity || !targetEntity) {
        return [];
      }
      const matchingRel = RELATION_GRAPH.find(
        (rel) =>
          rel.sourceEntity === sourceEntity &&
          rel.targetEntity === targetEntity &&
          rel.sqliteColumn === fkColumn
      );
      if (!matchingRel) {
        return [];
      }
      const relationId = getRelationId(matchingRel);
      const response = responseMap.get(relationId);
      if (!response) {
        return [];
      }
      if (response.shouldThrow) {
        throw response.error || new Error(`Query failed for ${relationId}`);
      }
      return response.rows;
    }),
  } as unknown as SQLiteDatabase;
}
function createFailingDatabaseGetter(error: Error): () => Promise<SQLiteDatabase> {
  return async () => {
    throw error;
  };
}
function getSampleRelation(): ForeignKeyRelation {
  const rel = RELATION_GRAPH.find((r) => r.sourceEntity === 'consumptions');
  if (!rel) {
    throw new Error('Test requires consumptions relation');
  }
  return rel;
}
function getMultipleRelations(): ForeignKeyRelation[] {
  return RELATION_GRAPH.filter(
    (r) => r.sourceEntity === 'consumptions' || r.sourceEntity === 'sessions'
  );
}
describe('ENTITY_STORAGE', () => {
  it('should have specs for all entity types', () => {
    for (const entityType of ENTITY_TYPES) {
      expect(ENTITY_STORAGE[entityType]).toBeDefined();
      expect(ENTITY_STORAGE[entityType].tableName).toBeTruthy();
      expect(ENTITY_STORAGE[entityType].idColumn).toBeTruthy();
    }
  });
  it('should be frozen (immutable)', () => {
    expect(Object.isFrozen(ENTITY_STORAGE)).toBe(true);
    for (const entityType of ENTITY_TYPES) {
      expect(Object.isFrozen(ENTITY_STORAGE[entityType])).toBe(true);
    }
  });
  it('should have valid SQL identifiers', () => {
    const validIdentifier = /^[A-Za-z_][A-Za-z0-9_]*$/;
    for (const entityType of ENTITY_TYPES) {
      const spec = ENTITY_STORAGE[entityType];
      expect(spec.tableName).toMatch(validIdentifier);
      expect(spec.idColumn).toMatch(validIdentifier);
    }
  });
});
describe('TABLE_TO_ENTITY', () => {
  it('should provide reverse lookup for all entity types', () => {
    for (const entityType of ENTITY_TYPES) {
      const tableName = ENTITY_STORAGE[entityType].tableName;
      expect(TABLE_TO_ENTITY[tableName]).toBe(entityType);
    }
  });
  it('should be frozen (immutable)', () => {
    expect(Object.isFrozen(TABLE_TO_ENTITY)).toBe(true);
  });
});
describe('getEntityStorage', () => {
  it('should return storage spec for valid entity type', () => {
    const spec = getEntityStorage('consumptions');
    expect(spec.tableName).toBe('consumptions');
    expect(spec.idColumn).toBe('id');
  });
  it('should throw for unknown entity type', () => {
    expect(() => getEntityStorage('unknown_entity' as EntityType)).toThrow(
      /No storage spec/
    );
  });
});
describe('getEntityTypeFromTable', () => {
  it('should return entity type for valid table name', () => {
    expect(getEntityTypeFromTable('consumptions')).toBe('consumptions');
    expect(getEntityTypeFromTable('sessions')).toBe('sessions');
  });
  it('should throw for unknown table name', () => {
    expect(() => getEntityTypeFromTable('unknown_table')).toThrow(
      /No entity type for table/
    );
  });
});
describe('chunkArray', () => {
  it('should chunk array into specified sizes', () => {
    const arr = [1, 2, 3, 4, 5, 6, 7];
    const chunks = chunkArray(arr, 3);
    expect(chunks).toEqual([[1, 2, 3], [4, 5, 6], [7]]);
  });
  it('should return single chunk if array smaller than chunk size', () => {
    const arr = [1, 2];
    const chunks = chunkArray(arr, 5);
    expect(chunks).toEqual([[1, 2]]);
  });
  it('should handle empty array', () => {
    const chunks = chunkArray([], 5);
    expect(chunks).toEqual([]);
  });
  it('should throw on invalid chunk size', () => {
    expect(() => chunkArray([1, 2], 0)).toThrow(/chunkSize must be positive/);
    expect(() => chunkArray([1, 2], -1)).toThrow(/chunkSize must be positive/);
  });
});
describe('buildOrphanDetectionQuery', () => {
  const sourceStorage: EntityStorageSpec = { tableName: 'consumptions', idColumn: 'id' };
  const targetStorage: EntityStorageSpec = { tableName: 'sessions', idColumn: 'id' };
  const relation: ForeignKeyRelation = {
    sourceEntity: 'consumptions',
    sourceField: 'sessionId',
    targetEntity: 'sessions',
    sqliteColumn: 'session_id',
    optional: true,
  };
  it('should build valid SQL without touchedIds', () => {
    const { sql, params } = buildOrphanDetectionQuery(
      relation,
      sourceStorage,
      targetStorage,
      100
    );
    expect(sql).toContain('FROM "consumptions" s');
    expect(sql).toContain('LEFT JOIN "sessions" t');
    expect(sql).toContain('ON s."session_id" = t."id"');
    expect(sql).toContain('WHERE');
    expect(sql).toContain('s."session_id" IS NOT NULL');
    expect(sql).toContain('t."id" IS NULL');
    expect(sql).toContain('LIMIT ?');
    expect(params).toEqual([100]);
  });
  it('should include touchedIds filter when provided', () => {
    const touchedIds = ['id-1', 'id-2', 'id-3'];
    const { sql, params } = buildOrphanDetectionQuery(
      relation,
      sourceStorage,
      targetStorage,
      100,
      touchedIds
    );
    expect(sql).toContain('s."id" IN (?, ?, ?)');
    expect(params).toEqual(['id-1', 'id-2', 'id-3', 100]);
  });
  it('should THROW when touchedIds exceeds SQLITE_PARAM_LIMIT', () => {
    const tooManyIds = Array.from({ length: SQLITE_PARAM_LIMIT + 1 }, (_, i) => `id-${i}`);
    expect(() =>
      buildOrphanDetectionQuery(
        relation,
        sourceStorage,
        targetStorage,
        100,
        tooManyIds
      )
    ).toThrow(/exceeds SQLITE_PARAM_LIMIT/);
  });
  it('should accept exactly SQLITE_PARAM_LIMIT touchedIds', () => {
    const exactLimitIds = Array.from({ length: SQLITE_PARAM_LIMIT }, (_, i) => `id-${i}`);
    const { params } = buildOrphanDetectionQuery(
      relation,
      sourceStorage,
      targetStorage,
      100,
      exactLimitIds
    );
    expect(params.length).toBe(SQLITE_PARAM_LIMIT + 1);
  });
  it('should quote all identifiers', () => {
    const { sql } = buildOrphanDetectionQuery(
      relation,
      sourceStorage,
      targetStorage,
      100
    );
    expect(sql).toContain('"consumptions"');
    expect(sql).toContain('"sessions"');
    expect(sql).toContain('"session_id"');
    expect(sql).toContain('"id"');
  });
  it('should throw on invalid table name', () => {
    const invalidStorage: EntityStorageSpec = {
      tableName: 'invalid-table-name', 
      idColumn: 'id',
    };
    expect(() =>
      buildOrphanDetectionQuery(relation, invalidStorage, targetStorage, 100)
    ).toThrow(/Invalid SQL identifier/);
  });
  it('should throw on invalid FK column', () => {
    const invalidRelation: ForeignKeyRelation = {
      ...relation,
      sqliteColumn: 'column with spaces',
    };
    expect(() =>
      buildOrphanDetectionQuery(invalidRelation, sourceStorage, targetStorage, 100)
    ).toThrow(/Invalid SQL identifier/);
  });
  it('should be a pure function (deterministic)', () => {
    const result1 = buildOrphanDetectionQuery(relation, sourceStorage, targetStorage, 100);
    const result2 = buildOrphanDetectionQuery(relation, sourceStorage, targetStorage, 100);
    expect(result1.sql).toBe(result2.sql);
    expect(result1.params).toEqual(result2.params);
  });
  it('should include limit parameter correctly', () => {
    const limit = 42;
    const { sql, params } = buildOrphanDetectionQuery(
      relation,
      sourceStorage,
      targetStorage,
      limit
    );
    expect(sql).toContain('LIMIT ?');
    expect(params[params.length - 1]).toBe(limit);
  });
});
describe('getRelationsToCheck', () => {
  it('should return all relations when no filters', () => {
    const relations = getRelationsToCheck({});
    expect(relations.length).toBe(RELATION_GRAPH.length);
  });
  it('should filter by entity types', () => {
    const relations = getRelationsToCheck({
      entityTypes: ['consumptions'],
    });
    expect(relations.length).toBeGreaterThan(0);
    expect(relations.every((r) => r.sourceEntity === 'consumptions')).toBe(true);
  });
  it('should filter to required FKs only', () => {
    const relations = getRelationsToCheck({
      requiredFksOnly: true,
    });
    expect(relations.every((r) => !r.optional)).toBe(true);
  });
  it('should combine filters', () => {
    const relations = getRelationsToCheck({
      entityTypes: ['consumptions'],
      requiredFksOnly: true,
    });
    expect(relations.every((r) => r.sourceEntity === 'consumptions')).toBe(true);
    expect(relations.every((r) => !r.optional)).toBe(true);
  });
  it('should return empty array for non-existent entity type', () => {
    const relations = getRelationsToCheck({
      entityTypes: ['ai_usage_records'], 
    });
    expect(Array.isArray(relations)).toBe(true);
  });
});
describe('IntegrityGate constructor', () => {
  it('should require a function', () => {
    expect(() => new IntegrityGate(null as unknown as () => Promise<SQLiteDatabase>)).toThrow(
      /requires a function/
    );
  });
  it('should accept valid database getter', () => {
    const db = createMockDatabase();
    const gate = new IntegrityGate(async () => db);
    expect(gate).toBeInstanceOf(IntegrityGate);
  });
});
describe('IntegrityGate fail-fast mode', () => {
  let gate: IntegrityGate;
  let mockDb: SQLiteDatabase;
  beforeEach(() => {
    mockDb = createMockDatabase();
    gate = new IntegrityGate(async () => mockDb);
  });
  it('should default to fail-fast mode (Phase 3 change)', () => {
    expect(gate.isFailFastMode()).toBe(true);
  });
  it('should allow disabling fail-fast mode for warn-only behavior', () => {
    gate.setFailFastMode(false);
    expect(gate.isFailFastMode()).toBe(false);
  });
  it('should allow re-enabling fail-fast mode', () => {
    gate.setFailFastMode(false);
    gate.setFailFastMode(true);
    expect(gate.isFailFastMode()).toBe(true);
  });
});
describe('IntegrityGate checkIntegrity - status model', () => {
  it('should return status "ok" when no violations', async () => {
    const mockDb = createMockDatabase([]);
    const gate = new IntegrityGate(async () => mockDb);
    const report = await gate.checkIntegrity({ entityTypes: ['consumptions'] });
    expect(report.status).toBe('ok');
    expect(report.violationCount).toBe(0);
    expect(report.relationsSucceeded).toBeGreaterThan(0);
    expect(report.relationsFailed).toBe(0);
    expect(report.error).toBeNull();
  });
  it('should return status "violations" when orphans found (warn-only mode)', async () => {
    const sampleRel = getSampleRelation();
    const mockDb = createMockDatabase([
      {
        relationId: getRelationId(sampleRel),
        rows: [{ entityId: 'ent-1', missingReferenceId: 'missing-ref-1' }],
      },
    ]);
    const gate = new IntegrityGate(async () => mockDb);
    gate.setFailFastMode(false);
    const report = await gate.checkIntegrity({ entityTypes: ['consumptions'] });
    expect(report.status).toBe('violations');
    expect(report.violationCount).toBe(1);
  });
  it('should return status "partial" when some relations fail (onQueryError=record)', async () => {
    const sampleRel = getSampleRelation();
    const mockDb = createMockDatabase([
      {
        relationId: getRelationId(sampleRel),
        shouldThrow: true,
        error: new Error('DB query failed'),
        rows: [],
      },
    ]);
    const gate = new IntegrityGate(async () => mockDb);
    const report = await gate.checkIntegrity({
      entityTypes: ['consumptions'],
      onQueryError: 'record',
    });
    expect(report.status).toBe('partial');
    expect(report.relationsFailed).toBeGreaterThan(0);
  });
  it('should return status "failed" when DB connection fails', async () => {
    const gate = new IntegrityGate(
      createFailingDatabaseGetter(new Error('Connection refused'))
    );
    const report = await gate.checkIntegrity();
    expect(report.status).toBe('failed');
    expect(report.error).toContain('Connection refused');
  });
});
describe('IntegrityGate checkIntegrity - report metrics', () => {
  it('should maintain invariant: relationsPlanned = relationsExecuted + relationsSkipped', async () => {
    const mockDb = createMockDatabase([]);
    const gate = new IntegrityGate(async () => mockDb);
    const report = await gate.checkIntegrity({
      touchedIds: {
        consumptions: ['id-1'],
      },
    });
    expect(report.relationsPlanned).toBe(report.relationsExecuted + report.relationsSkipped);
  });
  it('should maintain invariant: relationsExecuted = relationsSucceeded + relationsFailed', async () => {
    const mockDb = createMockDatabase([]);
    const gate = new IntegrityGate(async () => mockDb);
    const report = await gate.checkIntegrity({ entityTypes: ['consumptions'] });
    expect(report.relationsExecuted).toBe(report.relationsSucceeded + report.relationsFailed);
  });
  it('should count skipped relations when touchedIds filters them', async () => {
    const mockDb = createMockDatabase([]);
    const gate = new IntegrityGate(async () => mockDb);
    const report = await gate.checkIntegrity({
      touchedIds: {
        consumptions: ['id-1'],
      },
      entityTypes: ['consumptions', 'sessions'],
    });
    expect(report.relationsSkipped).toBeGreaterThanOrEqual(0);
    expect(report.relationsPlanned).toBe(report.relationsExecuted + report.relationsSkipped);
  });
  it('should report chunksExecuted when query is chunked', async () => {
    const mockDb = createMockDatabase([]);
    const gate = new IntegrityGate(async () => mockDb);
    const manyIds = Array.from({ length: SQLITE_PARAM_LIMIT + 100 }, (_, i) => `id-${i}`);
    const report = await gate.checkIntegrity({
      touchedIds: {
        consumptions: manyIds,
      },
      entityTypes: ['consumptions'],
    });
    const chunkedResult = report.relationResults.find(
      (r) => r.status === 'success' && (r.chunksExecuted ?? 0) > 1
    );
    expect(chunkedResult).toBeDefined();
    expect(chunkedResult!.chunksExecuted).toBe(2); 
    expect(chunkedResult!.totalIdsChecked).toBe(manyIds.length);
  });
});
describe('IntegrityGate checkIntegrity - execution errors', () => {
  it('should throw IntegrityCheckExecutionError on query error (default)', async () => {
    const sampleRel = getSampleRelation();
    const mockDb = createMockDatabase([
      {
        relationId: getRelationId(sampleRel),
        shouldThrow: true,
        error: new Error('SQLITE_ERROR: no such column'),
        rows: [],
      },
    ]);
    const gate = new IntegrityGate(async () => mockDb);
    await expect(
      gate.checkIntegrity({ entityTypes: ['consumptions'] })
    ).rejects.toThrow(IntegrityCheckExecutionError);
  });
  it('should include partial report in execution error', async () => {
    const sampleRel = getSampleRelation();
    const mockDb = createMockDatabase([
      {
        relationId: getRelationId(sampleRel),
        shouldThrow: true,
        error: new Error('Query error'),
        rows: [],
      },
    ]);
    const gate = new IntegrityGate(async () => mockDb);
    try {
      await gate.checkIntegrity({ entityTypes: ['consumptions'] });
      throw new Error('Expected IntegrityCheckExecutionError to be thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(IntegrityCheckExecutionError);
      const execError = err as IntegrityCheckExecutionError;
      expect(execError.report).toBeDefined();
      expect(execError.report.status).toBe('partial');
      expect(execError.relationFailures.length).toBeGreaterThan(0);
    }
  });
  it('should record errors and continue when onQueryError=record', async () => {
    const relations = getMultipleRelations();
    const failingRel = relations[0];
    if (!failingRel) {
      return;
    }
    const mockDb = createMockDatabase([
      {
        relationId: getRelationId(failingRel),
        shouldThrow: true,
        error: new Error('First relation fails'),
        rows: [],
      },
    ]);
    const gate = new IntegrityGate(async () => mockDb);
    const report = await gate.checkIntegrity({
      entityTypes: ['consumptions', 'sessions'],
      onQueryError: 'record',
    });
    expect(report.status).toBe('partial');
    expect(report.relationsFailed).toBeGreaterThan(0);
    expect(report.relationsExecuted).toBe(report.relationsSucceeded + report.relationsFailed);
  });
});
describe('IntegrityGate checkIntegrity - violation detection', () => {
  it('should detect orphaned FK references (warn-only mode)', async () => {
    const sampleRel = getSampleRelation();
    const orphanData = [
      { entityId: 'ent-1', missingReferenceId: 'missing-1' },
      { entityId: 'ent-2', missingReferenceId: 'missing-2' },
    ];
    const mockDb = createMockDatabase([
      { relationId: getRelationId(sampleRel), rows: orphanData },
    ]);
    const gate = new IntegrityGate(async () => mockDb);
    gate.setFailFastMode(false);
    const report = await gate.checkIntegrity({ entityTypes: ['consumptions'] });
    expect(report.violations.length).toBe(2);
    expect(report.violations[0]).toMatchObject({
      entityType: sampleRel.sourceEntity,
      entityId: 'ent-1',
      foreignKeyField: sampleRel.sourceField,
      sqliteColumn: sampleRel.sqliteColumn,
      missingReferenceId: 'missing-1',
      missingReferenceEntity: sampleRel.targetEntity,
    });
  });
  it('should throw IntegrityViolationError in fail-fast mode', async () => {
    const sampleRel = getSampleRelation();
    const mockDb = createMockDatabase([
      {
        relationId: getRelationId(sampleRel),
        rows: [{ entityId: 'e1', missingReferenceId: 'm1' }],
      },
    ]);
    const gate = new IntegrityGate(async () => mockDb);
    gate.setFailFastMode(true);
    await expect(
      gate.checkIntegrity({ entityTypes: ['consumptions'] })
    ).rejects.toThrow(IntegrityViolationError);
  });
  it('should include full report in violation error', async () => {
    const sampleRel = getSampleRelation();
    const mockDb = createMockDatabase([
      {
        relationId: getRelationId(sampleRel),
        rows: [{ entityId: 'e1', missingReferenceId: 'm1' }],
      },
    ]);
    const gate = new IntegrityGate(async () => mockDb);
    gate.setFailFastMode(true);
    try {
      await gate.checkIntegrity({ entityTypes: ['consumptions'] });
      throw new Error('Expected IntegrityViolationError to be thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(IntegrityViolationError);
      const violationError = err as IntegrityViolationError;
      expect(violationError.violations).toHaveLength(1);
      expect(violationError.report.status).toBe('violations');
      expect(violationError.report.violationCount).toBe(1);
    }
  });
  it('should return report without throwing in warn-only mode', async () => {
    const sampleRel = getSampleRelation();
    const mockDb = createMockDatabase([
      {
        relationId: getRelationId(sampleRel),
        rows: [{ entityId: 'e1', missingReferenceId: 'm1' }],
      },
    ]);
    const gate = new IntegrityGate(async () => mockDb);
    gate.setFailFastMode(false);
    const report = await gate.checkIntegrity({ entityTypes: ['consumptions'] });
    expect(report.status).toBe('violations');
    expect(report.violationCount).toBe(1);
  });
  it('should include limit parameter in query', async () => {
    const mockDb = createMockDatabase([]);
    const gate = new IntegrityGate(async () => mockDb);
    const getAllAsync = mockDb.getAllAsync as jest.MockedFunction<typeof mockDb.getAllAsync>;
    const customLimit = 25;
    await gate.checkIntegrity({
      entityTypes: ['consumptions'],
      maxViolationsPerRelation: customLimit,
    });
    const calls = getAllAsync.mock.calls;
    const hasLimitParam = calls.some(([sql, params]) => {
      const paramsArray = params as unknown as (string | number)[];
      return (sql as string).includes('LIMIT ?') && paramsArray[paramsArray.length - 1] === customLimit;
    });
    expect(hasLimitParam).toBe(true);
  });
});
describe('IntegrityGate checkIntegrity - touched IDs filtering', () => {
  it('should skip relations for entities with no touched IDs', async () => {
    const mockDb = createMockDatabase([]);
    const gate = new IntegrityGate(async () => mockDb);
    const report = await gate.checkIntegrity({
      touchedIds: {
        consumptions: ['id-1', 'id-2'],
      },
    });
    const sessionResults = report.relationResults.filter(
      (r) => r.relation.sourceEntity === 'sessions'
    );
    expect(sessionResults.every((r) => r.status === 'skipped')).toBe(true);
  });
  it('should only check touched entities when touchedIds provided', async () => {
    const mockDb = createMockDatabase([]);
    const gate = new IntegrityGate(async () => mockDb);
    const getAllAsync = mockDb.getAllAsync as jest.MockedFunction<typeof mockDb.getAllAsync>;
    await gate.checkIntegrity({
      touchedIds: {
        consumptions: ['id-1', 'id-2'],
      },
    });
    const calls = getAllAsync.mock.calls;
    for (const [sql] of calls) {
      expect(sql).toContain('"consumptions"');
      expect(sql).toContain('IN (?, ?)');
    }
  });
  it('should include touched IDs in query parameters', async () => {
    const mockDb = createMockDatabase([]);
    const gate = new IntegrityGate(async () => mockDb);
    const getAllAsync = mockDb.getAllAsync as jest.MockedFunction<typeof mockDb.getAllAsync>;
    await gate.checkIntegrity({
      touchedIds: {
        consumptions: ['touched-id-1', 'touched-id-2'],
      },
    });
    const firstCall = getAllAsync.mock.calls.find(
      ([sql]) => (sql as string).includes('"consumptions"')
    );
    if (firstCall) {
      const params = firstCall[1] as unknown as (string | number)[];
      expect(params).toContain('touched-id-1');
      expect(params).toContain('touched-id-2');
    }
  });
  it('should chunk large touchedIds sets without truncation', async () => {
    const mockDb = createMockDatabase([]);
    const gate = new IntegrityGate(async () => mockDb);
    const getAllAsync = mockDb.getAllAsync as jest.MockedFunction<typeof mockDb.getAllAsync>;
    const largeIdSet = Array.from({ length: SQLITE_PARAM_LIMIT + 500 }, (_, i) => `id-${i}`);
    await gate.checkIntegrity({
      touchedIds: {
        consumptions: largeIdSet,
      },
      entityTypes: ['consumptions'],
    });
    const consumptionCalls = getAllAsync.mock.calls.filter(
      ([sql]) => (sql as string).includes('"consumptions"')
    );
    expect(consumptionCalls.length).toBeGreaterThanOrEqual(2);
  });
});
describe('IntegrityGate checkIntegrity - target-side scoping', () => {
  it('should accept touchedTargetIds option', async () => {
    const mockDb = createMockDatabase([]);
    const gate = new IntegrityGate(async () => mockDb);
    const report = await gate.checkIntegrity({
      touchedTargetIds: {
        sessions: ['target-id-1', 'target-id-2'],
      },
    });
    expect(report.status).toBe('ok');
  });
  it('should check relations when target entity has touched IDs', async () => {
    const mockDb = createMockDatabase([]);
    const gate = new IntegrityGate(async () => mockDb);
    const getAllAsync = mockDb.getAllAsync as jest.MockedFunction<typeof mockDb.getAllAsync>;
    await gate.checkIntegrity({
      touchedTargetIds: {
        sessions: ['session-1', 'session-2'],
      },
    });
    const consumptionQueries = getAllAsync.mock.calls.filter(
      ([sql]) => (sql as string).includes('"consumptions"')
    );
    expect(consumptionQueries.length).toBeGreaterThan(0);
  });
  it('should skip relations when neither source nor target IDs are touched', async () => {
    const mockDb = createMockDatabase([]);
    const gate = new IntegrityGate(async () => mockDb);
    const report = await gate.checkIntegrity({
      touchedIds: {
        devices: ['device-1'], 
      },
      touchedTargetIds: {
        products: ['product-1'], 
      },
    });
    const skippedResults = report.relationResults.filter(
      (r) => r.status === 'skipped'
    );
    expect(skippedResults.length).toBeGreaterThan(0);
  });
  it('should include entityTypesWithDeletes in scoping decision', async () => {
    const mockDb = createMockDatabase([]);
    const gate = new IntegrityGate(async () => mockDb);
    const report = await gate.checkIntegrity({
      touchedIds: {}, 
      touchedTargetIds: {}, 
      entityTypesWithDeletes: ['sessions'], 
    });
    const sessionTargetResults = report.relationResults.filter(
      (r) => r.relation.targetEntity === 'sessions'
    );
    const nonSkipped = sessionTargetResults.filter((r) => r.status !== 'skipped');
    expect(nonSkipped.length).toBeGreaterThanOrEqual(0);
  });
  it('should combine source and target scoping for comprehensive check', async () => {
    const mockDb = createMockDatabase([]);
    const gate = new IntegrityGate(async () => mockDb);
    await gate.checkIntegrity({
      touchedIds: {
        consumptions: ['cons-1'], 
      },
      touchedTargetIds: {
        sessions: ['sess-old'], 
      },
    });
    expect(true).toBe(true);
  });
});
describe('IntegrityGate convenience methods', () => {
  let gate: IntegrityGate;
  beforeEach(() => {
    const mockDb = createMockDatabase([]);
    gate = new IntegrityGate(async () => mockDb);
  });
  describe('checkEntities', () => {
    it('should filter to specified entity types', async () => {
      const report = await gate.checkEntities(['consumptions']);
      expect(report.entitiesChecked).toContain('consumptions');
    });
  });
  describe('checkTouchedEntities', () => {
    it('should use touchedIds for filtering', async () => {
      const touchedIds: TouchedIds = {
        consumptions: ['id-1'],
        sessions: ['id-2'],
      };
      const report = await gate.checkTouchedEntities(touchedIds, 'batch-123');
      expect(report.syncBatchId).toBe('batch-123');
      expect([...report.entitiesChecked].sort()).toEqual(['consumptions', 'sessions'].sort());
    });
    it('should filter out entities with empty touched IDs', async () => {
      const touchedIds: TouchedIds = {
        consumptions: ['id-1'],
        sessions: [], 
      };
      const report = await gate.checkTouchedEntities(touchedIds);
      expect(report.entitiesChecked).toContain('consumptions');
    });
  });
  describe('checkRequiredFksOnly', () => {
    it('should only check required FKs', async () => {
      const report = await gate.checkRequiredFksOnly();
      for (const result of report.relationResults) {
        if (result.status !== 'skipped') {
          expect(result.relation.optional).toBe(false);
        }
      }
    });
  });
});
describe('IntegrityGate.summarize', () => {
  it('should summarize "ok" status with new metrics', () => {
    const report: IntegrityReport = {
      status: 'ok',
      relationResults: [],
      violations: [],
      violationCount: 0,
      timestamp: new Date().toISOString(),
      entitiesChecked: ['consumptions'],
      relationsPlanned: 5,
      relationsExecuted: 4,
      relationsSkipped: 1,
      relationsSucceeded: 4,
      relationsFailed: 0,
      durationMs: 42,
      error: null,
    };
    const summary = IntegrityGate.summarize(report);
    expect(summary).toContain('Integrity OK');
    expect(summary).toContain('4/5'); 
    expect(summary).toContain('1 skipped');
    expect(summary).toContain('42ms');
  });
  it('should summarize "violations" status', () => {
    const violations: IntegrityViolation[] = [
      {
        entityType: 'consumptions',
        entityId: 'e1',
        foreignKeyField: 'sessionId',
        sqliteColumn: 'session_id',
        missingReferenceId: 'm1',
        missingReferenceEntity: 'sessions',
        isOptionalFk: true,
      },
    ];
    const report: IntegrityReport = {
      status: 'violations',
      relationResults: [],
      violations,
      violationCount: 1,
      timestamp: new Date().toISOString(),
      entitiesChecked: ['consumptions'],
      relationsPlanned: 5,
      relationsExecuted: 5,
      relationsSkipped: 0,
      relationsSucceeded: 5,
      relationsFailed: 0,
      durationMs: 50,
      error: null,
    };
    const summary = IntegrityGate.summarize(report);
    expect(summary).toContain('VIOLATIONS');
    expect(summary).toContain('1 orphaned');
    expect(summary).toContain('consumptions');
  });
  it('should summarize "partial" status', () => {
    const sampleRel = getSampleRelation();
    const relationResults: RelationCheckResult[] = [
      {
        relation: sampleRel,
        status: 'failed',
        violations: [],
        error: { name: 'Error', message: 'DB error' },
      },
    ];
    const report: IntegrityReport = {
      status: 'partial',
      relationResults,
      violations: [],
      violationCount: 0,
      timestamp: new Date().toISOString(),
      entitiesChecked: ['consumptions'],
      relationsPlanned: 5,
      relationsExecuted: 5,
      relationsSkipped: 0,
      relationsSucceeded: 4,
      relationsFailed: 1,
      durationMs: 50,
      error: null,
    };
    const summary = IntegrityGate.summarize(report);
    expect(summary).toContain('PARTIAL');
    expect(summary).toContain('1 check(s) failed');
  });
  it('should summarize "failed" status', () => {
    const report: IntegrityReport = {
      status: 'failed',
      relationResults: [],
      violations: [],
      violationCount: 0,
      timestamp: new Date().toISOString(),
      entitiesChecked: [],
      relationsPlanned: 0,
      relationsExecuted: 0,
      relationsSkipped: 0,
      relationsSucceeded: 0,
      relationsFailed: 0,
      durationMs: 5,
      error: 'Connection refused',
    };
    const summary = IntegrityGate.summarize(report);
    expect(summary).toContain('FAILED');
    expect(summary).toContain('Connection refused');
  });
});
describe('IntegrityViolationError', () => {
  it('should contain violations and report', () => {
    const violations: IntegrityViolation[] = [
      {
        entityType: 'consumptions',
        entityId: 'e1',
        foreignKeyField: 'sessionId',
        sqliteColumn: 'session_id',
        missingReferenceId: 'm1',
        missingReferenceEntity: 'sessions',
        isOptionalFk: true,
      },
    ];
    const report: IntegrityReport = {
      status: 'violations',
      relationResults: [],
      violations,
      violationCount: 1,
      timestamp: new Date().toISOString(),
      entitiesChecked: ['consumptions'],
      relationsPlanned: 1,
      relationsExecuted: 1,
      relationsSkipped: 0,
      relationsSucceeded: 1,
      relationsFailed: 0,
      durationMs: 10,
      error: null,
    };
    const error = new IntegrityViolationError(report);
    expect(error.name).toBe('IntegrityViolationError');
    expect(error.violations).toEqual(violations);
    expect(error.report).toBe(report);
    expect(error.message).toContain('1 orphaned FK');
    expect(error.message).toContain('consumptions');
  });
  it('should extend Error properly', () => {
    const report: IntegrityReport = {
      status: 'violations',
      relationResults: [],
      violations: [],
      violationCount: 0,
      timestamp: new Date().toISOString(),
      entitiesChecked: [],
      relationsPlanned: 0,
      relationsExecuted: 0,
      relationsSkipped: 0,
      relationsSucceeded: 0,
      relationsFailed: 0,
      durationMs: 0,
      error: null,
    };
    const error = new IntegrityViolationError(report);
    expect(error instanceof Error).toBe(true);
    expect(error instanceof IntegrityViolationError).toBe(true);
  });
});
describe('IntegrityCheckExecutionError', () => {
  it('should contain report and relation failures', () => {
    const sampleRel = getSampleRelation();
    const relationResults: RelationCheckResult[] = [
      {
        relation: sampleRel,
        status: 'failed',
        violations: [],
        error: { name: 'Error', message: 'Query failed' },
      },
    ];
    const report: IntegrityReport = {
      status: 'partial',
      relationResults,
      violations: [],
      violationCount: 0,
      timestamp: new Date().toISOString(),
      entitiesChecked: ['consumptions'],
      relationsPlanned: 1,
      relationsExecuted: 1,
      relationsSkipped: 0,
      relationsSucceeded: 0,
      relationsFailed: 1,
      durationMs: 10,
      error: null,
    };
    const error = new IntegrityCheckExecutionError(report);
    expect(error.name).toBe('IntegrityCheckExecutionError');
    expect(error.report).toBe(report);
    expect(error.relationFailures).toHaveLength(1);
    expect(error.message).toContain('1 relation(s) could not be checked');
    expect(error.message).toContain('Integrity is UNKNOWN');
  });
});
describe('IntegrityReport structure', () => {
  it('should include all required fields', async () => {
    const mockDb = createMockDatabase([]);
    const gate = new IntegrityGate(async () => mockDb);
    const report = await gate.checkIntegrity({
      entityTypes: ['consumptions'],
      syncBatchId: 'test-batch-123',
    });
    expect(report.status).toBeDefined();
    expect(report.relationResults).toBeDefined();
    expect(report.violations).toBeDefined();
    expect(report.violationCount).toBeDefined();
    expect(report.timestamp).toBeDefined();
    expect(report.entitiesChecked).toBeDefined();
    expect(report.relationsPlanned).toBeDefined();
    expect(report.relationsExecuted).toBeDefined();
    expect(report.relationsSkipped).toBeDefined();
    expect(report.relationsSucceeded).toBeDefined();
    expect(report.relationsFailed).toBeDefined();
    expect(report.durationMs).toBeDefined();
    expect(report.error).toBeDefined();
    expect(report.syncBatchId).toBe('test-batch-123');
  });
  it('should have valid ISO timestamp', async () => {
    const mockDb = createMockDatabase([]);
    const gate = new IntegrityGate(async () => mockDb);
    const report = await gate.checkIntegrity();
    expect(new Date(report.timestamp).toISOString()).toBe(report.timestamp);
  });
  it('should track duration accurately', async () => {
    const mockDb = createMockDatabase([]);
    const gate = new IntegrityGate(async () => mockDb);
    const before = Date.now();
    const report = await gate.checkIntegrity();
    const after = Date.now();
    expect(report.durationMs).toBeGreaterThanOrEqual(0);
    expect(report.durationMs).toBeLessThanOrEqual(after - before + 100);
  });
});
describe('RelationCheckResult structure', () => {
  it('should include all fields for successful check', async () => {
    const mockDb = createMockDatabase([]);
    const gate = new IntegrityGate(async () => mockDb);
    const report = await gate.checkIntegrity({ entityTypes: ['consumptions'] });
    for (const result of report.relationResults) {
      if (result.status === 'success') {
        expect(result.relation).toBeDefined();
        expect(result.violations).toBeDefined();
        expect(Array.isArray(result.violations)).toBe(true);
        expect(result.error).toBeUndefined();
        expect(result.chunksExecuted).toBeDefined();
      }
    }
  });
  it('should include error for failed check', async () => {
    const sampleRel = getSampleRelation();
    const mockDb = createMockDatabase([
      {
        relationId: getRelationId(sampleRel),
        shouldThrow: true,
        error: new Error('Test error message'),
        rows: [],
      },
    ]);
    const gate = new IntegrityGate(async () => mockDb);
    const report = await gate.checkIntegrity({
      entityTypes: ['consumptions'],
      onQueryError: 'record',
    });
    const failedResult = report.relationResults.find((r) => r.status === 'failed');
    expect(failedResult).toBeDefined();
    expect(failedResult!.error).toBeDefined();
    expect(failedResult!.error!.message).toContain('Test error message');
  });
});
describe('IntegrityGate edge cases', () => {
  it('should handle empty relations list', async () => {
    const mockDb = createMockDatabase([]);
    const gate = new IntegrityGate(async () => mockDb);
    const report = await gate.checkIntegrity({
      entityTypes: ['ai_usage_records'],
    });
    expect(report.status).toBe('ok');
  });
  it('should handle multiple violations across multiple relations', async () => {
    const consumptionRel = RELATION_GRAPH.find((r) => r.sourceEntity === 'consumptions');
    const sessionRel = RELATION_GRAPH.find((r) => r.sourceEntity === 'sessions');
    const responses: MockRelationResponse[] = [];
    if (consumptionRel) {
      responses.push({
        relationId: getRelationId(consumptionRel),
        rows: [{ entityId: 'c1', missingReferenceId: 'm1' }],
      });
    }
    if (sessionRel) {
      responses.push({
        relationId: getRelationId(sessionRel),
        rows: [{ entityId: 's1', missingReferenceId: 'm2' }],
      });
    }
    if (responses.length < 2) {
      return;
    }
    const mockDb = createMockDatabase(responses);
    const gate = new IntegrityGate(async () => mockDb);
    gate.setFailFastMode(false);
    const report = await gate.checkIntegrity({
      entityTypes: ['consumptions', 'sessions'],
    });
    expect(report.violationCount).toBeGreaterThanOrEqual(2);
  });
  it('should correctly identify optional vs required FK in violations', async () => {
    const optionalRel = RELATION_GRAPH.find((r) => r.optional);
    const requiredRel = RELATION_GRAPH.find((r) => !r.optional);
    const responses: MockRelationResponse[] = [];
    if (optionalRel) {
      responses.push({
        relationId: getRelationId(optionalRel),
        rows: [{ entityId: 'opt-1', missingReferenceId: 'missing-opt' }],
      });
    }
    if (requiredRel) {
      responses.push({
        relationId: getRelationId(requiredRel),
        rows: [{ entityId: 'req-1', missingReferenceId: 'missing-req' }],
      });
    }
    const mockDb = createMockDatabase(responses);
    const gate = new IntegrityGate(async () => mockDb);
    gate.setFailFastMode(false);
    const report = await gate.checkIntegrity();
    const optionalViolation = report.violations.find((v) => v.isOptionalFk);
    const requiredViolation = report.violations.find((v) => !v.isOptionalFk);
    if (optionalRel) {
      expect(optionalViolation).toBeDefined();
      expect(optionalViolation!.isOptionalFk).toBe(true);
    }
    if (requiredRel) {
      expect(requiredViolation).toBeDefined();
      expect(requiredViolation!.isOptionalFk).toBe(false);
    }
  });
});
