import type { EntityColumnConfig } from '../types';
import {
  toOptionalTimestamp,
  toDecimal2,
  toDecimal3,
  toDecimal4,
  toBooleanInt,
} from '../transforms';
export const PURCHASES_CONFIG: EntityColumnConfig = {
  baseColumns: {
    hasServerId: false,
    hasData: false,
    createdAtColumn: 'createdAt',
    updatedAtColumn: 'updatedAt',
  },
  requiredColumns: [
    { backendField: 'userId', sqliteColumn: 'userId' },
    { backendField: 'clientPurchaseId', sqliteColumn: 'clientPurchaseId' },
    { backendField: 'productId', sqliteColumn: 'productId' },
    { backendField: 'purchaseDate', sqliteColumn: 'purchaseDate', transform: toOptionalTimestamp },
    { backendField: 'gramsBought', sqliteColumn: 'gramsBought', transform: toDecimal3 },
    { backendField: 'costSpent', sqliteColumn: 'costSpent', transform: toDecimal2 },
    { backendField: 'pricePerGram', sqliteColumn: 'pricePerGram', transform: toDecimal4 },
    { backendField: 'wasteFactor', sqliteColumn: 'wasteFactor', transform: toDecimal3 },
    { backendField: 'isActive', sqliteColumn: 'isActive', transform: toBooleanInt },
    { backendField: 'finishedDate', sqliteColumn: 'finishedDate', transform: toOptionalTimestamp },
    { backendField: 'version', sqliteColumn: 'version' },
  ],
  syncMode: 'SYNCED',
  clientIdBackendField: 'clientPurchaseId',
};
export const PURCHASES_USER_COLUMN = 'userId';
