import { SQLiteDatabase } from "expo-sqlite";
import type { DrizzleDB } from "../db/client";
import { DatabaseResponse } from "../types";
export interface BaseRepositoryOptions {
  sqliteDb?: SQLiteDatabase;
  drizzleDb?: DrizzleDB;
}
export class BaseRepository {
  protected db: SQLiteDatabase | null;
  protected drizzle: DrizzleDB | null;
  constructor(dbOrOptions: SQLiteDatabase | BaseRepositoryOptions) {
    if (dbOrOptions && typeof dbOrOptions === 'object' && 'execAsync' in dbOrOptions) {
      this.db = dbOrOptions as SQLiteDatabase;
      this.drizzle = null;
    } else if (dbOrOptions && typeof dbOrOptions === 'object') {
      const options = dbOrOptions as BaseRepositoryOptions;
      this.db = options.sqliteDb || null;
      this.drizzle = options.drizzleDb || null;
    } else {
      throw new Error('[BaseRepository] Constructor requires SQLiteDatabase or BaseRepositoryOptions');
    }
  }
  protected getDrizzle(): DrizzleDB {
    if (!this.drizzle) {
      throw new Error(
        '[BaseRepository] Drizzle instance not available. ' +
        'Ensure DrizzleDB was passed to constructor via options.drizzleDb'
      );
    }
    return this.drizzle;
  }
  public getDrizzleDb(): DrizzleDB {
    return this.getDrizzle();
  }
  protected getSqliteDb(): SQLiteDatabase {
    if (!this.db) {
      throw new Error(
        '[BaseRepository] SQLite instance not available. ' +
        'Ensure SQLiteDatabase was passed to constructor via options.sqliteDb'
      );
    }
    return this.db;
  }
  protected get sqlite(): SQLiteDatabase {
    return this.getSqliteDb();
  }
  protected async executeTransaction<T>(operations: () => Promise<T>): Promise<T> {
    const db = this.getSqliteDb(); 
    try {
      console.log('[Transaction] Beginning transaction...');
      await db.execAsync('BEGIN TRANSACTION');
      console.log('[Transaction] Transaction started, executing operations...');
      const result = await operations();
      console.log('[Transaction] Operations completed successfully, committing transaction...');
      await db.execAsync('COMMIT');
      console.log('[Transaction] Transaction committed.');
      return result;
    } catch (error: unknown) {
      console.error('[Transaction] Error during transaction, rolling back:', error);
      if (error instanceof Error) {
        console.error('[Transaction] Error details:', {
          message: error.message,
          name: error.name,
          stack: error.stack
        });
      } else {
        console.error('[Transaction] Non-Error object thrown:', error);
      }
      try {
        console.log('[Transaction] Attempting to roll back transaction...');
        await db.execAsync('ROLLBACK');
        console.log('[Transaction] Transaction rolled back successfully.');
      } catch (rollbackError: unknown) {
        console.error('[Transaction] Error rolling back transaction:', rollbackError);
        if (rollbackError instanceof Error) {
          console.error('[Transaction] Rollback error details:', {
            message: rollbackError.message,
            name: rollbackError.name,
            stack: rollbackError.stack
          });
        }
      }
      throw error;
    }
  }
  protected async executeDrizzleTransaction<T>(
    operations: (tx: Parameters<DrizzleDB['transaction']>[0] extends (tx: infer TX) => unknown ? TX : never) => Promise<T>
  ): Promise<T> {
    const drizzle = this.getDrizzle(); 
    try {
      console.log('[DrizzleTransaction] Beginning transaction...');
      const result = await drizzle.transaction(async (tx) => {
        console.log('[DrizzleTransaction] Transaction started, executing operations...');
        return await operations(tx);
      });
      console.log('[DrizzleTransaction] Transaction committed successfully.');
      return result;
    } catch (error: unknown) {
      console.error('[DrizzleTransaction] Transaction failed (auto-rolled back):', error);
      if (error instanceof Error) {
        console.error('[DrizzleTransaction] Error details:', {
          message: error.message,
          name: error.name,
          stack: error.stack
        });
      }
      throw error;
    }
  }
  protected handleError<T>(error: unknown, operation: string): DatabaseResponse<T> {
    console.error(`[Repository] Error in ${operation}:`, error);
    const userFriendlyMessage = `Failed to ${operation}. Please try again.`;
    return {
      success: false,
      error: userFriendlyMessage
    };
  }
  protected validateInput<T>(
    data: unknown, 
    schema: { safeParse: (data: unknown) => { success: boolean; data?: T; error?: unknown } },
    operation: string
  ): { success: true; data: T } | { success: false; error: string } {
    const result = schema.safeParse(data);
    if (!result.success) {
      console.error(`[Repository] Validation failed for ${operation}:`, result.error);
      return {
        success: false,
        error: `Invalid data provided for ${operation}.`
      };
    }
    return {
      success: true,
      data: result.data!
    };
  }
} 