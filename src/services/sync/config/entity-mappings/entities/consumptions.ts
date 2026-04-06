import type { EntityColumnConfig } from '../types';
import {
  toRequiredTimestamp,
  toDecimal2,
  toDecimal3,
  toBooleanInt,
} from '../transforms';
export const CONSUMPTIONS_CONFIG: EntityColumnConfig = {
  baseColumns: {
    hasServerId: true,
    hasData: true,
    createdAtColumn: 'created_at',
    updatedAtColumn: 'updated_at',
  },
  requiredColumns: [
    { backendField: 'userId', sqliteColumn: 'user_id' },
    { backendField: 'clientConsumptionId', sqliteColumn: 'client_consumption_id' },
    { backendField: 'timestamp', sqliteColumn: 'consumed_at', transform: toRequiredTimestamp },
    { backendField: 'durationMs', sqliteColumn: 'duration_ms' },
    { backendField: 'productId', sqliteColumn: 'strain_id' },
    { backendField: 'purchaseId', sqliteColumn: 'purchase_id' },
    { backendField: 'deviceId', sqliteColumn: 'device_id' },
    { backendField: 'sessionId', sqliteColumn: 'session_id' },
    { backendField: 'quantity', sqliteColumn: 'quantity', transform: toDecimal3 },
    { backendField: 'estimatedThcMg', sqliteColumn: 'estimated_thc_mg', transform: toDecimal2 },
    { backendField: 'isJournaled', sqliteColumn: 'is_journaled', transform: toBooleanInt },
    { backendField: 'notes', sqliteColumn: 'notes' },
    { backendField: 'clientPurchaseId', sqliteColumn: 'client_purchase_id' },
    { backendField: 'version', sqliteColumn: 'version' },
  ],
  syncMode: 'SYNCED',
  clientIdBackendField: 'clientConsumptionId',
};
export const CONSUMPTIONS_USER_COLUMN = 'user_id';
