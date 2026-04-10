import { type SQLiteDatabase } from 'expo-sqlite';
import { buildIdCascadeStatements, type CascadeStatement, type EntityType } from '@shared/contracts';
export class CascadeExecutionError extends Error {
  public readonly entityType: EntityType;
  public readonly clientId: string;
  public readonly serverId: string;
  public readonly failedStatement?: CascadeStatement;
  public readonly phase: 'cascade' | 'primary_update' | 'transaction_control';
  public readonly cause?: Error;
  constructor(
    entityType: EntityType,
    clientId: string,
    serverId: string,
    phase: 'cascade' | 'primary_update' | 'transaction_control',
    message: string,
    options?: {
      failedStatement?: CascadeStatement;
      cause?: Error;
    }
  ) {
    const statementInfo = options?.failedStatement
      ? ` (${options.failedStatement.table}.${options.failedStatement.column})`
      : '';
    super(
      `[CascadeExecutor] ${entityType} ID replacement failed during ${phase}${statementInfo}: ${message}`
    );
    this.name = 'CascadeExecutionError';
    this.entityType = entityType;
    this.clientId = clientId;
    this.serverId = serverId;
    this.phase = phase;
    this.failedStatement = options?.failedStatement;
    this.cause = options?.cause;
    Object.setPrototypeOf(this, CascadeExecutionError.prototype);
  }
}
export interface CascadeExecutionResult {
  entityType: EntityType;
  clientId: string;
  serverId: string;
  cascadeCount: number;
  cascadedTables: readonly string[];
  committed: boolean;
}
export interface CascadeExecutionOptions {
  logger?: {
    debug: (message: string, context?: Record<string, unknown>) => void;
    info: (message: string, context?: Record<string, unknown>) => void;
    error: (message: string, context?: Record<string, unknown>) => void;
  };
  primaryUpdateSql?: string;
  primaryUpdateParams?: (string | number | null)[];
  tableName?: string;
  skipPrimaryUpdate?: boolean;
}
export async function executeCascade(
  db: SQLiteDatabase,
  entityType: EntityType,
  clientId: string,
  serverId: string,
  options: CascadeExecutionOptions = {}
): Promise<CascadeExecutionResult> {
  const { logger, skipPrimaryUpdate = false, tableName } = options;
  if (!clientId || !serverId) {
    throw new CascadeExecutionError(
      entityType,
      clientId,
      serverId,
      'transaction_control',
      'clientId and serverId are required'
    );
  }
  if (clientId === serverId) {
    logger?.debug('[CascadeExecutor] clientId and serverId are identical, skipping', {
      entityType,
      clientId,
      serverId,
    });
    return {
      entityType,
      clientId,
      serverId,
      cascadeCount: 0,
      cascadedTables: [],
      committed: false,
    };
  }
  const cascadeStatements = buildIdCascadeStatements(entityType, clientId, serverId);
  const cascadedTables: string[] = [];
  logger?.info('[CascadeExecutor] Starting transactional cascade', {
    entityType,
    clientId,
    serverId,
    cascadeCount: cascadeStatements.length,
  });
  try {
    await db.execAsync('BEGIN TRANSACTION');
  } catch (error) {
    throw new CascadeExecutionError(
      entityType,
      clientId,
      serverId,
      'transaction_control',
      'Failed to begin transaction',
      { cause: error instanceof Error ? error : new Error(String(error)) }
    );
  }
  try {
    for (const stmt of cascadeStatements) {
      try {
        await db.runAsync(stmt.sql, stmt.params as (string | number | null)[]);
        cascadedTables.push(stmt.table);
        logger?.debug('[CascadeExecutor] Cascade statement succeeded', {
          table: stmt.table,
          column: stmt.column,
        });
      } catch (error) {
        throw new CascadeExecutionError(
          entityType,
          clientId,
          serverId,
          'cascade',
          error instanceof Error ? error.message : String(error),
          { failedStatement: stmt, cause: error instanceof Error ? error : undefined }
        );
      }
    }
    if (!skipPrimaryUpdate) {
      const primarySql = options.primaryUpdateSql ?? generatePrimaryUpdateSql(tableName ?? entityType);
      const primaryParams = options.primaryUpdateParams ?? [serverId, clientId];
      try {
        await db.runAsync(primarySql, primaryParams);
        logger?.debug('[CascadeExecutor] Primary entity ID updated', {
          entityType,
          tableName: tableName ?? entityType,
        });
      } catch (error) {
        throw new CascadeExecutionError(
          entityType,
          clientId,
          serverId,
          'primary_update',
          error instanceof Error ? error.message : String(error),
          { cause: error instanceof Error ? error : undefined }
        );
      }
    }
    try {
      await db.execAsync('COMMIT');
    } catch (error) {
      throw new CascadeExecutionError(
        entityType,
        clientId,
        serverId,
        'transaction_control',
        'Failed to commit transaction',
        { cause: error instanceof Error ? error : new Error(String(error)) }
      );
    }
    logger?.info('[CascadeExecutor] Transactional cascade completed successfully', {
      entityType,
      clientId,
      serverId,
      cascadeCount: cascadeStatements.length,
      cascadedTables,
    });
    return {
      entityType,
      clientId,
      serverId,
      cascadeCount: cascadeStatements.length,
      cascadedTables: Object.freeze(cascadedTables),
      committed: true,
    };
  } catch (error) {
    try {
      await db.execAsync('ROLLBACK');
      logger?.error('[CascadeExecutor] Transaction rolled back due to error', {
        entityType,
        clientId,
        serverId,
        error: error instanceof Error
          ? { name: error.name, message: error.message }
          : { name: 'Unknown', message: String(error) },
      });
    } catch (rollbackError) {
      logger?.error('[CascadeExecutor] Rollback failed', {
        entityType,
        rollbackError: rollbackError instanceof Error
          ? { name: rollbackError.name, message: rollbackError.message }
          : { name: 'Unknown', message: String(rollbackError) },
      });
    }
    if (error instanceof CascadeExecutionError) {
      throw error;
    }
    throw new CascadeExecutionError(
      entityType,
      clientId,
      serverId,
      'cascade',
      error instanceof Error ? error.message : String(error),
      { cause: error instanceof Error ? error : undefined }
    );
  }
}
function generatePrimaryUpdateSql(tableName: string): string {
  return `UPDATE "${tableName}" SET id = ? WHERE id = ?`;
}
export function createCascadeExecutor(
  db: SQLiteDatabase,
  defaultOptions: Omit<CascadeExecutionOptions, 'tableName' | 'skipPrimaryUpdate'> = {}
) {
  return async (
    entityType: EntityType,
    clientId: string,
    serverId: string,
    options: CascadeExecutionOptions = {}
  ): Promise<CascadeExecutionResult> => {
    return executeCascade(db, entityType, clientId, serverId, {
      ...defaultOptions,
      ...options,
    });
  };
}
export function validateCascade(
  entityType: EntityType,
  clientId: string,
  serverId: string
): {
  cascadeStatements: CascadeStatement[];
  primaryUpdateSql: string;
  primaryUpdateParams: (string | number | null)[];
} {
  const cascadeStatements = buildIdCascadeStatements(entityType, clientId, serverId);
  const primaryUpdateSql = generatePrimaryUpdateSql(entityType);
  const primaryUpdateParams = [serverId, clientId];
  return {
    cascadeStatements,
    primaryUpdateSql,
    primaryUpdateParams,
  };
}
