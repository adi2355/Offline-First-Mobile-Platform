import type { EntityColumnConfig } from '../types';
import {
  toOptionalTimestamp,
  toDecimal3,
  toBooleanInt,
} from '../transforms';
export const INVENTORY_ITEMS_CONFIG: EntityColumnConfig = {
  baseColumns: {
    hasServerId: false,
    hasData: false,
    createdAtColumn: 'createdAt',
    updatedAtColumn: 'updatedAt',
  },
  requiredColumns: [
    { backendField: 'userId', sqliteColumn: 'userId' },
    { backendField: 'clientInventoryId', sqliteColumn: 'clientInventoryId' },
    { backendField: 'productId', sqliteColumn: 'productId' },
    { backendField: 'purchaseItemId', sqliteColumn: 'purchaseItemId' },
    { backendField: 'quantityRemaining', sqliteColumn: 'quantityRemaining', transform: toDecimal3 },
    { backendField: 'quantityInitial', sqliteColumn: 'quantityInitial', transform: toDecimal3 },
    { backendField: 'expirationDate', sqliteColumn: 'expirationDate', transform: toOptionalTimestamp },
    { backendField: 'batchNumber', sqliteColumn: 'batchNumber' },
    { backendField: 'isActive', sqliteColumn: 'isActive', transform: toBooleanInt },
    { backendField: 'notes', sqliteColumn: 'notes' },
    { backendField: 'version', sqliteColumn: 'version' },
  ],
  syncMode: 'SYNCED',
  clientIdBackendField: 'clientInventoryId',
};
export const INVENTORY_ITEMS_USER_COLUMN = 'userId';
