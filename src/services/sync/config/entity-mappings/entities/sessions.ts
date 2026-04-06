import type { EntityColumnConfig } from '../types';
import {
  toRequiredTimestamp,
  toOptionalTimestamp,
} from '../transforms';
export const SESSIONS_CONFIG: EntityColumnConfig = {
  baseColumns: {
    hasServerId: false,
    hasData: false,
    createdAtColumn: 'createdAt',
    updatedAtColumn: 'updatedAt',
  },
  requiredColumns: [
    { backendField: 'userId', sqliteColumn: 'userId' },
    { backendField: 'clientSessionId', sqliteColumn: 'clientSessionId' },
    { backendField: 'sessionStartTimestamp', sqliteColumn: 'sessionStartTimestamp', transform: toRequiredTimestamp },
    { backendField: 'sessionEndTimestamp', sqliteColumn: 'sessionEndTimestamp', transform: toOptionalTimestamp },
    { backendField: 'hitCount', sqliteColumn: 'hitCount' },
    { backendField: 'totalDurationMs', sqliteColumn: 'totalDurationMs' },
    { backendField: 'avgHitDurationMs', sqliteColumn: 'avgHitDurationMs' },
    { backendField: 'status', sqliteColumn: 'status' },
    { backendField: 'primaryProductId', sqliteColumn: 'primaryProductId' },
    { backendField: 'deviceId', sqliteColumn: 'deviceId' },
    { backendField: 'purchaseId', sqliteColumn: 'purchaseId' },
    { backendField: 'version', sqliteColumn: 'version' },
    { backendField: 'clientId', sqliteColumn: 'client_id' },
  ],
  syncMode: 'SYNCED',
  clientIdBackendField: 'clientSessionId',
};
export const SESSIONS_USER_COLUMN = 'userId';
