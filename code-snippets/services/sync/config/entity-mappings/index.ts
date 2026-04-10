export type {
  EntityColumnConfig,
  ColumnMapping,
  BaseColumnsConfig,
  ClientIdFieldMapping,
  HardwareIdFieldMapping,
  SqlBuilderResult,
  SyncMode,
} from './types';
export { deepFreeze } from './utils';
export {
  ENTITY_COLUMN_MAPPINGS,
  ENTITY_CLIENT_ID_FIELDS,
  ENTITY_HARDWARE_ID_FIELDS,
  ENTITY_USER_COLUMN,
  ENTITY_SYNC_MODE,
  getSyncableEntityTypes,
  isSyncableEntity,
  assertSyncableEntity,
  CONSUMPTIONS_CONFIG,
  SESSIONS_CONFIG,
  PURCHASES_CONFIG,
  INVENTORY_ITEMS_CONFIG,
  JOURNAL_ENTRIES_CONFIG,
  GOALS_CONFIG,
  DEVICES_CONFIG,
  PRODUCTS_CONFIG,
  AI_USAGE_RECORDS_CONFIG,
} from './entities';
export * from './transforms';
export {
  buildEntityInsert,
  buildEntityUpdate,
} from './sql-builders';
export {
  extractClientIdFromPayload,
  getEntityUserColumn,
} from './id-mappings';
export {
  getEntityColumnConfig,
  getConfiguredEntityTypes,
} from './config-accessors';
export {
  validateEntityColumnMappings,
  validateClientIdFields,
  validateHardwareIdFields,
  validateAllEntityMappings,
  assertEntityMappingsValid,
  validateBusinessRules,
  validateClientIdBackendFields,
  validateSyncModeConsistency,
  validateEntityTypeCoverage,
  validateForeignKeyAlignment,
  validateSchemaAlignment,
  validateUserColumnFields,
  validateUserColumnCoverage,
  validateUserColumnAlignment,
  validateAllUserColumnChecks,
  type ValidationResult,
} from './schema';
