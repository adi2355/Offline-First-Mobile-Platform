import { type EntityType, ENTITY_TYPES } from '@shared/contracts';
import type { EntityColumnConfig, ClientIdFieldMapping, HardwareIdFieldMapping, SyncMode } from '../types';
import { deepFreeze } from '../utils';
import { CONSUMPTIONS_CONFIG, CONSUMPTIONS_USER_COLUMN } from './consumptions';
import { SESSIONS_CONFIG, SESSIONS_USER_COLUMN } from './sessions';
import { PURCHASES_CONFIG, PURCHASES_USER_COLUMN } from './purchases';
import { INVENTORY_ITEMS_CONFIG, INVENTORY_ITEMS_USER_COLUMN } from './inventory-items';
import { JOURNAL_ENTRIES_CONFIG, JOURNAL_ENTRIES_USER_COLUMN } from './journal-entries';
import { GOALS_CONFIG, GOALS_USER_COLUMN } from './goals';
import { DEVICES_CONFIG, DEVICES_USER_COLUMN, DEVICES_HARDWARE_ID_FIELDS } from './devices';
import { PRODUCTS_CONFIG, PRODUCTS_USER_COLUMN } from './products';
import { AI_USAGE_RECORDS_CONFIG, AI_USAGE_RECORDS_USER_COLUMN } from './ai-usage-records';
const _ENTITY_COLUMN_MAPPINGS = {
  consumptions: CONSUMPTIONS_CONFIG,
  sessions: SESSIONS_CONFIG,
  purchases: PURCHASES_CONFIG,
  inventory_items: INVENTORY_ITEMS_CONFIG,
  journal_entries: JOURNAL_ENTRIES_CONFIG,
  goals: GOALS_CONFIG,
  devices: DEVICES_CONFIG,
  products: PRODUCTS_CONFIG,
  ai_usage_records: AI_USAGE_RECORDS_CONFIG,
} satisfies Record<EntityType, EntityColumnConfig>;
export const ENTITY_COLUMN_MAPPINGS: Readonly<Record<string, EntityColumnConfig>> =
  deepFreeze(_ENTITY_COLUMN_MAPPINGS);
function deriveClientIdMapping(config: EntityColumnConfig): ClientIdFieldMapping | null {
  if (config.clientIdBackendField === null) {
    return null;
  }
  const columnMapping = config.requiredColumns.find(
    (col) => col.backendField === config.clientIdBackendField
  );
  if (!columnMapping) {
    throw new Error(
      `Configuration error: clientIdBackendField '${config.clientIdBackendField}' ` +
      `not found in requiredColumns. This is a single-source-of-truth violation.`
    );
  }
  return {
    backendField: config.clientIdBackendField,
    sqliteColumn: columnMapping.sqliteColumn,
  };
}
function buildEntityClientIdFields(): Partial<Record<EntityType, ClientIdFieldMapping>> {
  const result: Partial<Record<EntityType, ClientIdFieldMapping>> = {};
  for (const entityType of ENTITY_TYPES) {
    const config = _ENTITY_COLUMN_MAPPINGS[entityType];
    const clientIdMapping = deriveClientIdMapping(config);
    if (clientIdMapping !== null) {
      result[entityType] = clientIdMapping;
    }
  }
  return result;
}
export const ENTITY_CLIENT_ID_FIELDS: Readonly<Partial<Record<EntityType, ClientIdFieldMapping>>> =
  deepFreeze(buildEntityClientIdFields());
const _ENTITY_HARDWARE_ID_FIELDS: Partial<Record<EntityType, HardwareIdFieldMapping[]>> = {
  devices: DEVICES_HARDWARE_ID_FIELDS,
};
export const ENTITY_HARDWARE_ID_FIELDS: Readonly<typeof _ENTITY_HARDWARE_ID_FIELDS> =
  deepFreeze(_ENTITY_HARDWARE_ID_FIELDS);
const _ENTITY_USER_COLUMN: Record<EntityType, string | null> = {
  consumptions: CONSUMPTIONS_USER_COLUMN,
  sessions: SESSIONS_USER_COLUMN,
  purchases: PURCHASES_USER_COLUMN,
  inventory_items: INVENTORY_ITEMS_USER_COLUMN,
  journal_entries: JOURNAL_ENTRIES_USER_COLUMN,
  goals: GOALS_USER_COLUMN,
  devices: DEVICES_USER_COLUMN,
  products: PRODUCTS_USER_COLUMN,
  ai_usage_records: AI_USAGE_RECORDS_USER_COLUMN,
} satisfies Record<EntityType, string | null>;
export const ENTITY_USER_COLUMN: Readonly<Record<string, string | null>> =
  deepFreeze(_ENTITY_USER_COLUMN);
function buildEntitySyncMode(): Record<EntityType, SyncMode> {
  const result: Record<string, SyncMode> = {};
  for (const entityType of ENTITY_TYPES) {
    const config = _ENTITY_COLUMN_MAPPINGS[entityType];
    result[entityType] = config.syncMode;
  }
  return result as Record<EntityType, SyncMode>;
}
export const ENTITY_SYNC_MODE: Readonly<Record<EntityType, SyncMode>> =
  deepFreeze(buildEntitySyncMode());
export function getSyncableEntityTypes(): readonly EntityType[] {
  return ENTITY_TYPES.filter((entityType) => ENTITY_SYNC_MODE[entityType] === 'SYNCED');
}
export function isSyncableEntity(entityType: EntityType): boolean {
  const syncMode = ENTITY_SYNC_MODE[entityType];
  if (syncMode === undefined) {
    throw new Error(`Unknown entity type: '${entityType}'. Not found in ENTITY_SYNC_MODE.`);
  }
  return syncMode === 'SYNCED';
}
export function assertSyncableEntity(entityType: EntityType): void {
  if (!isSyncableEntity(entityType)) {
    throw new Error(
      `Cannot sync entity type '${entityType}': syncMode is 'LOCAL_ONLY'. ` +
      `LOCAL_ONLY entities are never pushed to or pulled from the backend.`
    );
  }
}
export {
  CONSUMPTIONS_CONFIG,
  SESSIONS_CONFIG,
  PURCHASES_CONFIG,
  INVENTORY_ITEMS_CONFIG,
  JOURNAL_ENTRIES_CONFIG,
  GOALS_CONFIG,
  DEVICES_CONFIG,
  PRODUCTS_CONFIG,
  AI_USAGE_RECORDS_CONFIG,
};
