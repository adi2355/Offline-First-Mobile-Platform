import type { EntityColumnConfig } from '../types';
export const AI_USAGE_RECORDS_CONFIG: EntityColumnConfig = {
  baseColumns: {
    hasServerId: false,
    hasData: false,
    createdAtColumn: 'created_at',
    updatedAtColumn: 'created_at', 
  },
  requiredColumns: [
    { backendField: 'userId', sqliteColumn: 'user_id' },
    { backendField: 'requestType', sqliteColumn: 'request_type' },
    { backendField: 'prompt', sqliteColumn: 'prompt' },
    { backendField: 'response', sqliteColumn: 'response' },
    { backendField: 'tokensUsed', sqliteColumn: 'tokens_used' },
    { backendField: 'costUsd', sqliteColumn: 'cost_usd' },
    { backendField: 'modelUsed', sqliteColumn: 'model_used' },
    { backendField: 'sessionId', sqliteColumn: 'session_id' },
    { backendField: 'correlationId', sqliteColumn: 'correlation_id' },
    { backendField: 'processingTimeMs', sqliteColumn: 'processing_time_ms' },
  ],
  syncMode: 'LOCAL_ONLY',
  clientIdBackendField: null,
};
export const AI_USAGE_RECORDS_USER_COLUMN = 'user_id';
