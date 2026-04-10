import { SQLiteDatabase } from 'expo-sqlite';
import {
  type EntityType,
  type ForeignKeyRelation,
  RELATION_GRAPH,
  ENTITY_TYPES,
} from '@shared/contracts';
import { logger, toLogError } from '../../utils/logger';
export interface EntityStorageSpec {
  readonly tableName: string;
  readonly idColumn: string;
}
const _ENTITY_STORAGE: Record<EntityType, EntityStorageSpec> = {
  consumptions: { tableName: 'consumptions', idColumn: 'id' },
  sessions: { tableName: 'sessions', idColumn: 'id' },
  purchases: { tableName: 'purchases', idColumn: 'id' },
  products: { tableName: 'products', idColumn: 'id' },
  devices: { tableName: 'devices', idColumn: 'id' },
  journal_entries: { tableName: 'journal_entries', idColumn: 'id' },
  inventory_items: { tableName: 'inventory_items', idColumn: 'id' },
  goals: { tableName: 'goals', idColumn: 'id' },
  ai_usage_records: { tableName: 'ai_usage_records', idColumn: 'id' },
};
export const ENTITY_STORAGE: Readonly<Record<EntityType, EntityStorageSpec>> =
  Object.freeze(
    Object.fromEntries(
      Object.entries(_ENTITY_STORAGE).map(([k, v]) => [k, Object.freeze(v)])
    ) as Record<EntityType, EntityStorageSpec>
  );
const _TABLE_TO_ENTITY: Record<string, EntityType> = {};
for (const entityType of ENTITY_TYPES) {
  _TABLE_TO_ENTITY[ENTITY_STORAGE[entityType].tableName] = entityType;
}
export const TABLE_TO_ENTITY: Readonly<Record<string, EntityType>> =
  Object.freeze(_TABLE_TO_ENTITY);
export function getEntityStorage(entityType: EntityType): EntityStorageSpec {
  const spec = ENTITY_STORAGE[entityType];
  if (!spec) {
    throw new Error(
      `[IntegrityGate] No storage spec for entity type: ${entityType}`
    );
  }
  return spec;
}
export function getEntityTypeFromTable(tableName: string): EntityType {
  const entityType = TABLE_TO_ENTITY[tableName];
  if (!entityType) {
    throw new Error(
      `[IntegrityGate] No entity type for table: ${tableName}`
    );
  }
  return entityType;
}
export type RelationCheckStatus = 'success' | 'failed' | 'skipped';
export interface RelationCheckResult {
  readonly relation: ForeignKeyRelation;
  readonly status: RelationCheckStatus;
  readonly violations: readonly IntegrityViolation[];
  readonly error?: {
    readonly name: string;
    readonly message: string;
  };
  readonly chunksExecuted?: number;
  readonly totalIdsChecked?: number;
}
export interface IntegrityViolation {
  readonly entityType: EntityType;
  readonly entityId: string;
  readonly foreignKeyField: string;
  readonly sqliteColumn: string;
  readonly missingReferenceId: string;
  readonly missingReferenceEntity: EntityType;
  readonly isOptionalFk: boolean;
}
export type IntegrityCheckStatus = 'ok' | 'violations' | 'partial' | 'failed';
export interface IntegrityReport {
  readonly status: IntegrityCheckStatus;
  readonly relationResults: readonly RelationCheckResult[];
  readonly violations: readonly IntegrityViolation[];
  readonly violationCount: number;
  readonly timestamp: string;
  readonly entitiesChecked: readonly EntityType[];
  readonly relationsPlanned: number;
  readonly relationsExecuted: number;
  readonly relationsSkipped: number;
  readonly relationsSucceeded: number;
  readonly relationsFailed: number;
  readonly durationMs: number;
  readonly error: string | null;
  readonly syncBatchId?: string;
}
export type TouchedIds = Partial<Record<EntityType, readonly string[]>>;
export interface IntegrityCheckOptions {
  readonly entityTypes?: readonly EntityType[];
  readonly touchedIds?: TouchedIds;
  readonly touchedTargetIds?: TouchedIds;
  readonly entityTypesWithDeletes?: readonly EntityType[];
  readonly maxViolationsPerRelation?: number;
  readonly requiredFksOnly?: boolean;
  readonly onQueryError?: 'throw' | 'record';
  readonly syncBatchId?: string;
}
export class IntegrityViolationError extends Error {
  public readonly violations: readonly IntegrityViolation[];
  public readonly report: IntegrityReport;
  constructor(report: IntegrityReport) {
    const affectedEntities = [
      ...new Set(report.violations.map((v) => v.entityType)),
    ];
    super(
      `Integrity check failed: ${report.violationCount} orphaned FK reference(s) detected. ` +
        `Affected entities: ${affectedEntities.join(', ')}. ` +
        `This indicates data corruption that could cause downstream errors.`
    );
    this.name = 'IntegrityViolationError';
    this.violations = report.violations;
    this.report = report;
    Object.setPrototypeOf(this, IntegrityViolationError.prototype);
  }
}
export class IntegrityCheckExecutionError extends Error {
  public readonly report: IntegrityReport;
  public readonly relationFailures: readonly RelationCheckResult[];
  constructor(report: IntegrityReport) {
    const failures = report.relationResults.filter((r) => r.status === 'failed');
    const failedRelations = failures
      .map((f) => `${f.relation.sourceEntity}.${f.relation.sourceField}`)
      .slice(0, 5);
    super(
      `Integrity check execution failed: ${report.relationsFailed} relation(s) could not be checked. ` +
        `Failed: ${failedRelations.join(', ')}${failures.length > 5 ? '...' : ''}. ` +
        `Integrity is UNKNOWN - this is not a clean pass.`
    );
    this.name = 'IntegrityCheckExecutionError';
    this.report = report;
    this.relationFailures = failures;
    Object.setPrototypeOf(this, IntegrityCheckExecutionError.prototype);
  }
}
const VALID_SQL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
function validateSqlIdentifier(identifier: string, context: string): void {
  if (!identifier || !VALID_SQL_IDENTIFIER.test(identifier)) {
    throw new Error(
      `[IntegrityGate] Invalid SQL identifier for ${context}: "${identifier}"`
    );
  }
}
export const SQLITE_PARAM_LIMIT = 900;
export function buildOrphanDetectionQuery(
  relation: ForeignKeyRelation,
  sourceStorage: EntityStorageSpec,
  targetStorage: EntityStorageSpec,
  limit: number,
  touchedIds?: readonly string[]
): { sql: string; params: readonly (string | number)[] } {
  validateSqlIdentifier(sourceStorage.tableName, 'source table');
  validateSqlIdentifier(sourceStorage.idColumn, 'source id column');
  validateSqlIdentifier(targetStorage.tableName, 'target table');
  validateSqlIdentifier(targetStorage.idColumn, 'target id column');
  validateSqlIdentifier(relation.sqliteColumn, 'FK column');
  if (touchedIds && touchedIds.length > SQLITE_PARAM_LIMIT) {
    throw new Error(
      `[IntegrityGate] touchedIds.length (${touchedIds.length}) exceeds SQLITE_PARAM_LIMIT (${SQLITE_PARAM_LIMIT}). ` +
        `Caller must chunk touchedIds before calling buildOrphanDetectionQuery.`
    );
  }
  const sourceTable = `"${sourceStorage.tableName}"`;
  const targetTable = `"${targetStorage.tableName}"`;
  const fkColumn = `"${relation.sqliteColumn}"`;
  const sourceIdCol = `"${sourceStorage.idColumn}"`;
  const targetIdCol = `"${targetStorage.idColumn}"`;
  let whereClause = `s.${fkColumn} IS NOT NULL AND s.${fkColumn} != '' AND t.${targetIdCol} IS NULL`;
  const params: (string | number)[] = [];
  if (touchedIds && touchedIds.length > 0) {
    const placeholders = touchedIds.map(() => '?').join(', ');
    whereClause = `s.${sourceIdCol} IN (${placeholders}) AND ${whereClause}`;
    params.push(...touchedIds);
  }
  params.push(limit);
  const sql = `
    SELECT s.${sourceIdCol} AS entityId, s.${fkColumn} AS missingReferenceId
    FROM ${sourceTable} s
    LEFT JOIN ${targetTable} t ON s.${fkColumn} = t.${targetIdCol}
    WHERE ${whereClause}
    LIMIT ?
  `.trim();
  return { sql, params };
}
export function buildTargetSideOrphanQuery(
  relation: ForeignKeyRelation,
  sourceStorage: EntityStorageSpec,
  targetStorage: EntityStorageSpec,
  limit: number,
  touchedTargetIds: readonly string[]
): { sql: string; params: readonly (string | number)[] } {
  validateSqlIdentifier(sourceStorage.tableName, 'source table');
  validateSqlIdentifier(sourceStorage.idColumn, 'source id column');
  validateSqlIdentifier(targetStorage.tableName, 'target table');
  validateSqlIdentifier(targetStorage.idColumn, 'target id column');
  validateSqlIdentifier(relation.sqliteColumn, 'FK column');
  if (touchedTargetIds.length > SQLITE_PARAM_LIMIT) {
    throw new Error(
      `[IntegrityGate] touchedTargetIds.length (${touchedTargetIds.length}) exceeds SQLITE_PARAM_LIMIT (${SQLITE_PARAM_LIMIT}). ` +
        `Caller must chunk touchedTargetIds before calling buildTargetSideOrphanQuery.`
    );
  }
  if (touchedTargetIds.length === 0) {
    throw new Error('[IntegrityGate] touchedTargetIds must not be empty for target-side query');
  }
  const sourceTable = `"${sourceStorage.tableName}"`;
  const targetTable = `"${targetStorage.tableName}"`;
  const fkColumn = `"${relation.sqliteColumn}"`;
  const sourceIdCol = `"${sourceStorage.idColumn}"`;
  const targetIdCol = `"${targetStorage.idColumn}"`;
  const placeholders = touchedTargetIds.map(() => '?').join(', ');
  const params: (string | number)[] = [...touchedTargetIds, limit];
  const sql = `
    SELECT s.${sourceIdCol} AS entityId, s.${fkColumn} AS missingReferenceId
    FROM ${sourceTable} s
    LEFT JOIN ${targetTable} t ON s.${fkColumn} = t.${targetIdCol}
    WHERE s.${fkColumn} IN (${placeholders})
      AND s.${fkColumn} IS NOT NULL
      AND s.${fkColumn} != ''
      AND t.${targetIdCol} IS NULL
    LIMIT ?
  `.trim();
  return { sql, params };
}
export function getRelationsToCheck(
  options: IntegrityCheckOptions
): readonly ForeignKeyRelation[] {
  let relations = [...RELATION_GRAPH];
  if (options.entityTypes && options.entityTypes.length > 0) {
    const entitySet = new Set(options.entityTypes);
    relations = relations.filter((rel) => entitySet.has(rel.sourceEntity));
  }
  if (options.requiredFksOnly) {
    relations = relations.filter((rel) => !rel.optional);
  }
  return relations;
}
export function chunkArray<T>(arr: readonly T[], chunkSize: number): T[][] {
  if (chunkSize <= 0) {
    throw new Error(`[IntegrityGate] chunkSize must be positive, got ${chunkSize}`);
  }
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += chunkSize) {
    chunks.push(arr.slice(i, i + chunkSize) as T[]);
  }
  return chunks;
}
function computeStatus(
  relationResults: readonly RelationCheckResult[],
  topLevelError: string | null
): IntegrityCheckStatus {
  if (topLevelError) {
    return 'failed';
  }
  const hasFailures = relationResults.some((r) => r.status === 'failed');
  const hasViolations = relationResults.some((r) => r.violations.length > 0);
  if (hasFailures) {
    return 'partial';
  }
  if (hasViolations) {
    return 'violations';
  }
  return 'ok';
}
interface OrphanRow {
  entityId: string;
  missingReferenceId: string;
}
export async function executeQuery<T>(
  db: SQLiteDatabase,
  sql: string,
  params: readonly (string | number)[]
): Promise<T[]> {
  return db.getAllAsync<T>(sql, [...params]);
}
export class IntegrityGate {
  private static readonly DEFAULT_MAX_VIOLATIONS = 100;
  private failFastMode = true;
  constructor(private readonly getDatabase: () => Promise<SQLiteDatabase>) {
    if (typeof getDatabase !== 'function') {
      throw new Error(
        '[IntegrityGate] Constructor requires a function that returns Promise<SQLiteDatabase>'
      );
    }
  }
  setFailFastMode(enabled: boolean): void {
    this.failFastMode = enabled;
    logger.info('[IntegrityGate] Fail-fast mode updated', {
      failFastMode: enabled,
    });
  }
  isFailFastMode(): boolean {
    return this.failFastMode;
  }
  async checkIntegrity(
    options: IntegrityCheckOptions = {}
  ): Promise<IntegrityReport> {
    const startTime = Date.now();
    const timestamp = new Date().toISOString();
    const maxViolationsPerRelation =
      options.maxViolationsPerRelation ?? IntegrityGate.DEFAULT_MAX_VIOLATIONS;
    const onQueryError = options.onQueryError ?? 'throw';
    const relationsToCheck = getRelationsToCheck(options);
    const entitiesChecked = new Set<EntityType>();
    const relationResults: RelationCheckResult[] = [];
    const allViolations: IntegrityViolation[] = [];
    let topLevelError: string | null = null;
    const hasSourceScope = !!options.touchedIds &&
      Object.values(options.touchedIds).some((ids) => (ids?.length ?? 0) > 0);
    const hasTargetScope = !!options.touchedTargetIds &&
      Object.values(options.touchedTargetIds).some((ids) => (ids?.length ?? 0) > 0);
    const entityTypesWithDeletes = new Set(options.entityTypesWithDeletes ?? []);
    logger.debug('[IntegrityGate] Starting integrity check', {
      relationsPlanned: relationsToCheck.length,
      failFastMode: this.failFastMode,
      onQueryError,
      hasSourceScope,
      hasTargetScope,
      entityTypesWithDeletes: options.entityTypesWithDeletes?.length ?? 0,
      syncBatchId: options.syncBatchId,
    });
    try {
      const db = await this.getDatabase();
      for (const relation of relationsToCheck) {
        entitiesChecked.add(relation.sourceEntity);
        const sourceStorage = getEntityStorage(relation.sourceEntity);
        const targetStorage = getEntityStorage(relation.targetEntity);
        const touchedSourceIds = options.touchedIds?.[relation.sourceEntity];
        const touchedTargetIds = options.touchedTargetIds?.[relation.targetEntity];
        const hasSourceIdsToCheck = touchedSourceIds && touchedSourceIds.length > 0;
        const hasTargetIdsToCheck = touchedTargetIds && touchedTargetIds.length > 0;
        const targetHadDeletes = entityTypesWithDeletes.has(relation.targetEntity);
        if (hasSourceScope || hasTargetScope) {
          if (!hasSourceIdsToCheck && !hasTargetIdsToCheck && !targetHadDeletes) {
            relationResults.push({
              relation,
              status: 'skipped',
              violations: [],
            });
            continue;
          }
        }
        try {
          const result = await this.executeRelationCheck(
            db,
            relation,
            sourceStorage,
            targetStorage,
            maxViolationsPerRelation,
            touchedSourceIds,
            touchedTargetIds
          );
          const violations: IntegrityViolation[] = result.orphans.map((orphan) => ({
            entityType: relation.sourceEntity,
            entityId: orphan.entityId,
            foreignKeyField: relation.sourceField,
            sqliteColumn: relation.sqliteColumn,
            missingReferenceId: orphan.missingReferenceId,
            missingReferenceEntity: relation.targetEntity,
            isOptionalFk: relation.optional,
          }));
          allViolations.push(...violations);
          relationResults.push({
            relation,
            status: 'success',
            violations,
            chunksExecuted: result.chunksExecuted,
            totalIdsChecked: result.totalIdsChecked,
          });
          if (violations.length > 0) {
            logger.debug('[IntegrityGate] Orphans found', {
              sourceEntity: relation.sourceEntity,
              targetEntity: relation.targetEntity,
              field: relation.sourceField,
              count: violations.length,
              isOptional: relation.optional,
              syncBatchId: options.syncBatchId,
            });
          }
        } catch (queryError) {
          const errorInfo = {
            name: queryError instanceof Error ? queryError.name : 'Error',
            message: queryError instanceof Error ? queryError.message : String(queryError),
          };
          relationResults.push({
            relation,
            status: 'failed',
            violations: [],
            error: errorInfo,
          });
          logger.error('[IntegrityGate] Query execution failed', {
            sourceEntity: relation.sourceEntity,
            targetEntity: relation.targetEntity,
            field: relation.sourceField,
            error: toLogError(queryError),
            syncBatchId: options.syncBatchId,
          });
          if (onQueryError === 'throw') {
            const partialReport = this.buildReport(
              relationResults,
              allViolations,
              entitiesChecked,
              relationsToCheck.length,
              startTime,
              timestamp,
              null,
              options.syncBatchId
            );
            throw new IntegrityCheckExecutionError(partialReport);
          }
        }
      }
    } catch (error) {
      if (error instanceof IntegrityViolationError || error instanceof IntegrityCheckExecutionError) {
        throw error;
      }
      topLevelError = error instanceof Error ? error.message : String(error);
      logger.error('[IntegrityGate] Check failed', {
        error: toLogError(error),
        syncBatchId: options.syncBatchId,
      });
    }
    const report = this.buildReport(
      relationResults,
      allViolations,
      entitiesChecked,
      relationsToCheck.length,
      startTime,
      timestamp,
      topLevelError,
      options.syncBatchId
    );
    this.handleReportResult(report, options.syncBatchId);
    return report;
  }
  private async executeRelationCheck(
    db: SQLiteDatabase,
    relation: ForeignKeyRelation,
    sourceStorage: EntityStorageSpec,
    targetStorage: EntityStorageSpec,
    maxViolations: number,
    touchedSourceIds?: readonly string[],
    touchedTargetIds?: readonly string[]
  ): Promise<{
    orphans: OrphanRow[];
    chunksExecuted: number;
    totalIdsChecked: number;
  }> {
    const allOrphans: OrphanRow[] = [];
    const seenOrphans = new Set<string>(); 
    let chunksExecuted = 0;
    let totalSourceIdsChecked = 0;
    let totalTargetIdsChecked = 0;
    const addOrphan = (orphan: OrphanRow): void => {
      const key = `${orphan.entityId}:${orphan.missingReferenceId}`;
      if (!seenOrphans.has(key)) {
        seenOrphans.add(key);
        allOrphans.push(orphan);
      }
    };
    if (touchedSourceIds && touchedSourceIds.length > 0) {
      const sourceResult = await this.executeSourceSideCheck(
        db,
        relation,
        sourceStorage,
        targetStorage,
        maxViolations - allOrphans.length,
        touchedSourceIds
      );
      sourceResult.orphans.forEach(addOrphan);
      chunksExecuted += sourceResult.chunksExecuted;
      totalSourceIdsChecked = sourceResult.idsChecked;
    }
    if (touchedTargetIds && touchedTargetIds.length > 0 && allOrphans.length < maxViolations) {
      const targetResult = await this.executeTargetSideCheck(
        db,
        relation,
        sourceStorage,
        targetStorage,
        maxViolations - allOrphans.length,
        touchedTargetIds
      );
      targetResult.orphans.forEach(addOrphan);
      chunksExecuted += targetResult.chunksExecuted;
      totalTargetIdsChecked = targetResult.idsChecked;
    }
    if (!touchedSourceIds && !touchedTargetIds) {
      const { sql, params } = buildOrphanDetectionQuery(
        relation,
        sourceStorage,
        targetStorage,
        maxViolations
      );
      const rows = await executeQuery<OrphanRow>(db, sql, params);
      rows.forEach(addOrphan);
      chunksExecuted = 1;
    }
    return {
      orphans: allOrphans,
      chunksExecuted,
      totalIdsChecked: totalSourceIdsChecked + totalTargetIdsChecked,
    };
  }
  private async executeSourceSideCheck(
    db: SQLiteDatabase,
    relation: ForeignKeyRelation,
    sourceStorage: EntityStorageSpec,
    targetStorage: EntityStorageSpec,
    maxViolations: number,
    touchedSourceIds: readonly string[]
  ): Promise<{ orphans: OrphanRow[]; chunksExecuted: number; idsChecked: number }> {
    const orphans: OrphanRow[] = [];
    let chunksExecuted = 0;
    let idsChecked = 0;
    if (touchedSourceIds.length <= SQLITE_PARAM_LIMIT) {
      const { sql, params } = buildOrphanDetectionQuery(
        relation,
        sourceStorage,
        targetStorage,
        maxViolations,
        touchedSourceIds
      );
      const rows = await executeQuery<OrphanRow>(db, sql, params);
      orphans.push(...rows);
      chunksExecuted = 1;
      idsChecked = touchedSourceIds.length;
    } else {
      const chunks = chunkArray(touchedSourceIds, SQLITE_PARAM_LIMIT);
      for (const chunk of chunks) {
        if (orphans.length >= maxViolations) break;
        const remainingLimit = maxViolations - orphans.length;
        const { sql, params } = buildOrphanDetectionQuery(
          relation,
          sourceStorage,
          targetStorage,
          remainingLimit,
          chunk
        );
        const rows = await executeQuery<OrphanRow>(db, sql, params);
        orphans.push(...rows);
        chunksExecuted++;
        idsChecked += chunk.length; 
      }
    }
    return { orphans, chunksExecuted, idsChecked };
  }
  private async executeTargetSideCheck(
    db: SQLiteDatabase,
    relation: ForeignKeyRelation,
    sourceStorage: EntityStorageSpec,
    targetStorage: EntityStorageSpec,
    maxViolations: number,
    touchedTargetIds: readonly string[]
  ): Promise<{ orphans: OrphanRow[]; chunksExecuted: number; idsChecked: number }> {
    const orphans: OrphanRow[] = [];
    let chunksExecuted = 0;
    let idsChecked = 0;
    if (touchedTargetIds.length <= SQLITE_PARAM_LIMIT) {
      const { sql, params } = buildTargetSideOrphanQuery(
        relation,
        sourceStorage,
        targetStorage,
        maxViolations,
        touchedTargetIds
      );
      const rows = await executeQuery<OrphanRow>(db, sql, params);
      orphans.push(...rows);
      chunksExecuted = 1;
      idsChecked = touchedTargetIds.length;
    } else {
      const chunks = chunkArray(touchedTargetIds, SQLITE_PARAM_LIMIT);
      for (const chunk of chunks) {
        if (orphans.length >= maxViolations) break;
        const remainingLimit = maxViolations - orphans.length;
        const { sql, params } = buildTargetSideOrphanQuery(
          relation,
          sourceStorage,
          targetStorage,
          remainingLimit,
          chunk
        );
        const rows = await executeQuery<OrphanRow>(db, sql, params);
        orphans.push(...rows);
        chunksExecuted++;
        idsChecked += chunk.length; 
      }
    }
    return { orphans, chunksExecuted, idsChecked };
  }
  private buildReport(
    relationResults: readonly RelationCheckResult[],
    violations: readonly IntegrityViolation[],
    entitiesChecked: ReadonlySet<EntityType>,
    relationsPlanned: number,
    startTime: number,
    timestamp: string,
    topLevelError: string | null,
    syncBatchId?: string
  ): IntegrityReport {
    const durationMs = Date.now() - startTime;
    const relationsSucceeded = relationResults.filter((r) => r.status === 'success').length;
    const relationsFailed = relationResults.filter((r) => r.status === 'failed').length;
    const relationsSkipped = relationResults.filter((r) => r.status === 'skipped').length;
    const relationsExecuted = relationsSucceeded + relationsFailed;
    return {
      status: computeStatus(relationResults, topLevelError),
      relationResults,
      violations,
      violationCount: violations.length,
      timestamp,
      entitiesChecked: [...entitiesChecked],
      relationsPlanned,
      relationsExecuted,
      relationsSkipped,
      relationsSucceeded,
      relationsFailed,
      durationMs,
      error: topLevelError,
      syncBatchId,
    };
  }
  private handleReportResult(report: IntegrityReport, syncBatchId?: string): void {
    const logContext = {
      status: report.status,
      violationCount: report.violationCount,
      relationsPlanned: report.relationsPlanned,
      relationsExecuted: report.relationsExecuted,
      relationsSkipped: report.relationsSkipped,
      relationsSucceeded: report.relationsSucceeded,
      relationsFailed: report.relationsFailed,
      durationMs: report.durationMs,
      syncBatchId,
    };
    switch (report.status) {
      case 'ok':
        logger.debug('[IntegrityGate] Check passed', logContext);
        break;
      case 'violations': {
        const requiredViolations = report.violations.filter((v) => !v.isOptionalFk);
        const optionalViolations = report.violations.filter((v) => v.isOptionalFk);
        if (optionalViolations.length > 0) {
          logger.warn('[IntegrityGate] Optional FK orphans detected (non-blocking)', {
            count: optionalViolations.length,
            violations: optionalViolations.slice(0, 5),
            affectedEntities: [...new Set(optionalViolations.map((v) => v.entityType))],
            syncBatchId,
          });
        }
        if (requiredViolations.length > 0 && this.failFastMode) {
          logger.error('[IntegrityGate] Required FK violations detected (fail-fast)', {
            ...logContext,
            requiredViolationCount: requiredViolations.length,
            optionalViolationCount: optionalViolations.length,
            violations: requiredViolations.slice(0, 10),
          });
          const requiredReport: IntegrityReport = {
            ...report,
            violations: requiredViolations,
            violationCount: requiredViolations.length,
          };
          throw new IntegrityViolationError(requiredReport);
        } else if (requiredViolations.length > 0) {
          logger.warn('[IntegrityGate] Required FK orphans detected', {
            ...logContext,
            requiredViolationCount: requiredViolations.length,
            violations: requiredViolations.slice(0, 10),
            affectedEntities: [...new Set(requiredViolations.map((v) => v.entityType))],
          });
        }
        break;
      }
      case 'partial':
        logger.warn('[IntegrityGate] Partial check - some relations failed', logContext);
        break;
      case 'failed':
        logger.error('[IntegrityGate] Check failed completely', {
          ...logContext,
          error: report.error
            ? { name: 'IntegrityCheckError', message: report.error }
            : undefined,
        });
        break;
    }
  }
  async checkEntities(
    entityTypes: readonly EntityType[],
    options: Omit<IntegrityCheckOptions, 'entityTypes'> = {}
  ): Promise<IntegrityReport> {
    return this.checkIntegrity({ ...options, entityTypes });
  }
  async checkTouchedEntities(
    touchedIds: TouchedIds,
    syncBatchId?: string
  ): Promise<IntegrityReport> {
    return this.checkIntegrity({
      touchedIds,
      syncBatchId,
      entityTypes: Object.keys(touchedIds).filter(
        (k) => (touchedIds[k as EntityType]?.length ?? 0) > 0
      ) as EntityType[],
    });
  }
  async checkRequiredFksOnly(
    options: Omit<IntegrityCheckOptions, 'requiredFksOnly'> = {}
  ): Promise<IntegrityReport> {
    return this.checkIntegrity({ ...options, requiredFksOnly: true });
  }
  static summarize(report: IntegrityReport): string {
    switch (report.status) {
      case 'ok':
        return `Integrity OK: ${report.relationsExecuted}/${report.relationsPlanned} relations checked ` +
          `(${report.relationsSkipped} skipped) in ${report.durationMs}ms`;
      case 'violations': {
        const entities = [...new Set(report.violations.map((v) => v.entityType))];
        return `Integrity VIOLATIONS: ${report.violationCount} orphaned reference(s) in ${entities.join(', ')}`;
      }
      case 'partial': {
        const failedRelations = report.relationResults
          .filter((r) => r.status === 'failed')
          .map((r) => `${r.relation.sourceEntity}.${r.relation.sourceField}`)
          .slice(0, 3);
        return `Integrity PARTIAL: ${report.relationsFailed} check(s) failed (${failedRelations.join(', ')}${report.relationsFailed > 3 ? '...' : ''}), ` +
          `${report.violationCount} violation(s) found`;
      }
      case 'failed':
        return `Integrity FAILED: ${report.error || 'Unknown error'}`;
    }
  }
}
function validateModuleInvariants(): void {
  const errors: string[] = [];
  for (const entityType of ENTITY_TYPES) {
    const spec = ENTITY_STORAGE[entityType];
    if (!spec) {
      errors.push(`Missing storage spec for entity type: ${entityType}`);
      continue;
    }
    try {
      validateSqlIdentifier(spec.tableName, `${entityType}.tableName`);
    } catch {
      errors.push(`Invalid tableName for ${entityType}: "${spec.tableName}"`);
    }
    try {
      validateSqlIdentifier(spec.idColumn, `${entityType}.idColumn`);
    } catch {
      errors.push(`Invalid idColumn for ${entityType}: "${spec.idColumn}"`);
    }
  }
  for (const rel of RELATION_GRAPH) {
    if (!ENTITY_STORAGE[rel.sourceEntity]) {
      errors.push(
        `Relation references unknown source entity: ${rel.sourceEntity} ` +
          `(in ${rel.sourceEntity}.${rel.sourceField} -> ${rel.targetEntity})`
      );
    }
    if (!ENTITY_STORAGE[rel.targetEntity]) {
      errors.push(
        `Relation references unknown target entity: ${rel.targetEntity} ` +
          `(in ${rel.sourceEntity}.${rel.sourceField} -> ${rel.targetEntity})`
      );
    }
    try {
      validateSqlIdentifier(rel.sqliteColumn, `${rel.sourceEntity}.${rel.sourceField}.sqliteColumn`);
    } catch {
      errors.push(
        `Invalid sqliteColumn "${rel.sqliteColumn}" in relation ` +
          `${rel.sourceEntity}.${rel.sourceField} -> ${rel.targetEntity}`
      );
    }
  }
  if (errors.length > 0) {
    throw new Error(
      `[IntegrityGate] MODULE INVARIANT VIOLATIONS (${errors.length}):\n` +
        errors.map((e, i) => `  ${i + 1}. ${e}`).join('\n') +
        `\n\nThis indicates a contract mismatch between ENTITY_TYPES, RELATION_GRAPH, and ENTITY_STORAGE. ` +
        `Ensure shared contracts and app code are in sync.`
    );
  }
}
validateModuleInvariants();
