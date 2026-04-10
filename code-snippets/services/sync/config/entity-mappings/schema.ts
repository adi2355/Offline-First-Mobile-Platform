import { z } from 'zod';
import { type EntityType, ENTITY_TYPES, getForeignKeyFields } from '@shared/contracts';
export const BaseColumnsSchema = z.object({
  hasServerId: z.boolean(),
  hasData: z.boolean(),
  createdAtColumn: z.string().min(1, 'createdAtColumn cannot be empty'),
  updatedAtColumn: z.string().min(1, 'updatedAtColumn cannot be empty'),
});
export const ColumnMappingSchema = z.object({
  backendField: z.string().min(1, 'backendField cannot be empty'),
  sqliteColumn: z.string().min(1, 'sqliteColumn cannot be empty'),
  transform: z.function().args(z.unknown()).returns(z.union([z.string(), z.number(), z.null()])).optional(),
});
export const EntityColumnConfigSchema = z.object({
  baseColumns: BaseColumnsSchema,
  requiredColumns: z.array(ColumnMappingSchema).min(1, 'requiredColumns must have at least one column'),
  syncMode: z.enum(['SYNCED', 'LOCAL_ONLY']),
  clientIdBackendField: z.string().min(1).nullable(),
});
export const EntityColumnMappingsSchema = z.object({
  consumptions: EntityColumnConfigSchema,
  sessions: EntityColumnConfigSchema,
  purchases: EntityColumnConfigSchema,
  inventory_items: EntityColumnConfigSchema,
  journal_entries: EntityColumnConfigSchema,
  goals: EntityColumnConfigSchema,
  devices: EntityColumnConfigSchema,
  products: EntityColumnConfigSchema,
  ai_usage_records: EntityColumnConfigSchema,
});
export const ClientIdFieldSchema = z.object({
  backendField: z.string().min(1),
  sqliteColumn: z.string().min(1),
});
const EntityTypeKeySchema = z.enum([
  'consumptions',
  'sessions',
  'purchases',
  'inventory_items',
  'journal_entries',
  'goals',
  'devices',
  'products',
  'ai_usage_records',
] as const);
export const EntityClientIdFieldsSchema = z.record(
  EntityTypeKeySchema,
  ClientIdFieldSchema.optional()
);
export const HardwareIdFieldSchema = z.object({
  backendField: z.string().min(1),
  sqliteColumn: z.string().min(1),
});
export const EntityHardwareIdFieldsSchema = z.record(
  EntityTypeKeySchema,
  z.array(HardwareIdFieldSchema).optional()
);
export const SyncModeSchema = z.enum(['SYNCED', 'LOCAL_ONLY']);
export type ValidatedBaseColumns = z.infer<typeof BaseColumnsSchema>;
export type ValidatedColumnMapping = z.infer<typeof ColumnMappingSchema>;
export type ValidatedEntityColumnConfig = z.infer<typeof EntityColumnConfigSchema>;
export type ValidatedEntityColumnMappings = z.infer<typeof EntityColumnMappingsSchema>;
export interface ValidationResult {
  success: boolean;
  errors: string[];
}
export function validateEntityColumnMappings(
  mappings: Record<string, unknown>
): ValidationResult {
  const result = EntityColumnMappingsSchema.safeParse(mappings);
  if (result.success) {
    return { success: true, errors: [] };
  }
  const errors = result.error.issues.map((issue) => {
    const path = issue.path.join('.');
    return `[${path}] ${issue.message}`;
  });
  return { success: false, errors };
}
export function validateClientIdFields(
  fields: Record<string, unknown>
): ValidationResult {
  const result = EntityClientIdFieldsSchema.safeParse(fields);
  if (result.success) {
    return { success: true, errors: [] };
  }
  const errors = result.error.issues.map((issue) => {
    const path = issue.path.join('.');
    return `[ENTITY_CLIENT_ID_FIELDS.${path}] ${issue.message}`;
  });
  return { success: false, errors };
}
export function validateHardwareIdFields(
  fields: Record<string, unknown>
): ValidationResult {
  const result = EntityHardwareIdFieldsSchema.safeParse(fields);
  if (result.success) {
    return { success: true, errors: [] };
  }
  const errors = result.error.issues.map((issue) => {
    const path = issue.path.join('.');
    return `[ENTITY_HARDWARE_ID_FIELDS.${path}] ${issue.message}`;
  });
  return { success: false, errors };
}
export function validateAllEntityMappings(
  columnMappings: Record<string, unknown>,
  clientIdFields: Record<string, unknown>,
  hardwareIdFields: Record<string, unknown>
): ValidationResult {
  const allErrors: string[] = [];
  const columnResult = validateEntityColumnMappings(columnMappings);
  if (!columnResult.success) {
    allErrors.push(...columnResult.errors);
  }
  const clientIdResult = validateClientIdFields(clientIdFields);
  if (!clientIdResult.success) {
    allErrors.push(...clientIdResult.errors);
  }
  const hardwareIdResult = validateHardwareIdFields(hardwareIdFields);
  if (!hardwareIdResult.success) {
    allErrors.push(...hardwareIdResult.errors);
  }
  return {
    success: allErrors.length === 0,
    errors: allErrors,
  };
}
export function assertEntityMappingsValid(
  columnMappings: Record<string, unknown>,
  clientIdFields: Record<string, unknown>,
  hardwareIdFields: Record<string, unknown>
): void {
  const result = validateAllEntityMappings(
    columnMappings,
    clientIdFields,
    hardwareIdFields
  );
  if (!result.success) {
    throw new Error(
      `ENTITY_COLUMN_MAPPINGS validation failed. Fix these configuration errors:\n` +
      result.errors.map((e) => `  - ${e}`).join('\n')
    );
  }
}
export function validateBusinessRules(
  mappings: Record<string, { baseColumns: unknown; requiredColumns: Array<{ backendField: string; sqliteColumn: string; transform?: unknown }> }>
): ValidationResult {
  const errors: string[] = [];
  for (const [entityType, config] of Object.entries(mappings)) {
    const sqliteColumns = new Set<string>();
    const backendFields = new Set<string>();
    for (const col of config.requiredColumns) {
      if (sqliteColumns.has(col.sqliteColumn)) {
        errors.push(`[${entityType}] Duplicate sqliteColumn: '${col.sqliteColumn}'`);
      }
      sqliteColumns.add(col.sqliteColumn);
      if (backendFields.has(col.backendField)) {
        errors.push(`[${entityType}] Duplicate backendField: '${col.backendField}'`);
      }
      backendFields.add(col.backendField);
    }
  }
  return {
    success: errors.length === 0,
    errors,
  };
}
export function validateClientIdBackendFields(
  mappings: Record<string, { requiredColumns: Array<{ backendField: string }>; clientIdBackendField: string | null }>
): ValidationResult {
  const errors: string[] = [];
  for (const [entityType, config] of Object.entries(mappings)) {
    if (config.clientIdBackendField === null) {
      continue;
    }
    const backendFields = new Set(config.requiredColumns.map((col) => col.backendField));
    if (!backendFields.has(config.clientIdBackendField)) {
      errors.push(
        `[CLIENT_ID_MISMATCH] Entity '${entityType}' has clientIdBackendField '${config.clientIdBackendField}' ` +
        `but no corresponding backendField in requiredColumns. ` +
        `This violates the single-source-of-truth design and would cause runtime failures.`
      );
    }
  }
  return {
    success: errors.length === 0,
    errors,
  };
}
export function validateSyncModeConsistency(
  mappings: Record<string, { syncMode: string; clientIdBackendField: string | null }>
): ValidationResult {
  const errors: string[] = [];
  for (const [entityType, config] of Object.entries(mappings)) {
    if (config.syncMode === 'LOCAL_ONLY' && config.clientIdBackendField !== null) {
      errors.push(
        `[SYNC_MODE_INCONSISTENT] Entity '${entityType}' has syncMode 'LOCAL_ONLY' but also has ` +
        `clientIdBackendField '${config.clientIdBackendField}'. LOCAL_ONLY entities should not ` +
        `have client IDs since they are never synced.`
      );
    }
  }
  return {
    success: errors.length === 0,
    errors,
  };
}
export function validateEntityTypeCoverage(
  mappings: Record<string, unknown>
): ValidationResult {
  const errors: string[] = [];
  const configuredEntityTypes = new Set(Object.keys(mappings));
  const canonicalEntityTypes = new Set(ENTITY_TYPES);
  for (const requiredType of canonicalEntityTypes) {
    if (!configuredEntityTypes.has(requiredType)) {
      errors.push(`[MISSING] EntityType '${requiredType}' is not configured in ENTITY_COLUMN_MAPPINGS`);
    }
  }
  for (const configuredType of configuredEntityTypes) {
    if (!canonicalEntityTypes.has(configuredType as EntityType)) {
      errors.push(`[EXTRA] '${configuredType}' in ENTITY_COLUMN_MAPPINGS is not a valid EntityType`);
    }
  }
  return {
    success: errors.length === 0,
    errors,
  };
}
export function validateForeignKeyAlignment(
  mappings: Record<string, { requiredColumns: Array<{ backendField: string; sqliteColumn: string }> }>
): ValidationResult {
  const errors: string[] = [];
  for (const entityType of ENTITY_TYPES) {
    const fkFields = getForeignKeyFields(entityType);
    const config = mappings[entityType];
    if (!config) {
      continue;
    }
    const mappedBackendFields = new Set(config.requiredColumns.map(c => c.backendField));
    for (const fkField of fkFields) {
      if (!mappedBackendFields.has(fkField)) {
        errors.push(
          `[FK_MISSING] Entity '${entityType}' has FK field '${fkField}' in relation-graph ` +
          `but no corresponding mapping in ENTITY_COLUMN_MAPPINGS.requiredColumns`
        );
      }
    }
  }
  return {
    success: errors.length === 0,
    errors,
  };
}
export function validateSchemaAlignment(
  mappings: Record<string, { requiredColumns: Array<{ backendField: string; sqliteColumn: string }> }>
): ValidationResult {
  const allErrors: string[] = [];
  const coverageResult = validateEntityTypeCoverage(mappings);
  if (!coverageResult.success) {
    allErrors.push(...coverageResult.errors);
  }
  const fkResult = validateForeignKeyAlignment(mappings);
  if (!fkResult.success) {
    allErrors.push(...fkResult.errors);
  }
  return {
    success: allErrors.length === 0,
    errors: allErrors,
  };
}
export const UserColumnSchema = z.union([z.string().min(1), z.null()]);
export const EntityUserColumnSchema = z.object({
  consumptions: UserColumnSchema,
  sessions: UserColumnSchema,
  purchases: UserColumnSchema,
  inventory_items: UserColumnSchema,
  journal_entries: UserColumnSchema,
  goals: UserColumnSchema,
  devices: UserColumnSchema,
  products: UserColumnSchema,
  ai_usage_records: UserColumnSchema,
});
export function validateUserColumnFields(
  userColumns: Record<string, unknown>
): ValidationResult {
  const result = EntityUserColumnSchema.safeParse(userColumns);
  if (result.success) {
    return { success: true, errors: [] };
  }
  const errors = result.error.issues.map((issue) => {
    const path = issue.path.join('.');
    return `[ENTITY_USER_COLUMN.${path}] ${issue.message}`;
  });
  return { success: false, errors };
}
export function validateUserColumnCoverage(
  userColumns: Record<string, unknown>
): ValidationResult {
  const errors: string[] = [];
  const configuredTypes = new Set(Object.keys(userColumns));
  const canonicalTypes = new Set(ENTITY_TYPES);
  for (const requiredType of canonicalTypes) {
    if (!configuredTypes.has(requiredType)) {
      errors.push(`[USER_COLUMN_MISSING] EntityType '${requiredType}' is not configured in ENTITY_USER_COLUMN`);
    }
  }
  for (const configuredType of configuredTypes) {
    if (!canonicalTypes.has(configuredType as EntityType)) {
      errors.push(`[USER_COLUMN_EXTRA] '${configuredType}' in ENTITY_USER_COLUMN is not a valid EntityType`);
    }
  }
  return {
    success: errors.length === 0,
    errors,
  };
}
export function validateUserColumnAlignment(
  userColumns: Record<string, string | null>,
  columnMappings: Record<string, { requiredColumns: Array<{ backendField: string; sqliteColumn: string }> }>
): ValidationResult {
  const errors: string[] = [];
  for (const [entityType, userColumn] of Object.entries(userColumns)) {
    if (userColumn === null) {
      continue;
    }
    const config = columnMappings[entityType];
    if (!config) {
      continue;
    }
    const columnExists = config.requiredColumns.some(
      (col) => col.sqliteColumn === userColumn
    );
    if (!columnExists) {
      errors.push(
        `[USER_COLUMN_MISMATCH] Entity '${entityType}' has userColumn '${userColumn}' ` +
        `but no corresponding sqliteColumn in ENTITY_COLUMN_MAPPINGS.requiredColumns`
      );
    }
  }
  return {
    success: errors.length === 0,
    errors,
  };
}
export function validateAllUserColumnChecks(
  userColumns: Record<string, unknown>,
  columnMappings: Record<string, { requiredColumns: Array<{ backendField: string; sqliteColumn: string }> }>
): ValidationResult {
  const allErrors: string[] = [];
  const schemaResult = validateUserColumnFields(userColumns);
  if (!schemaResult.success) {
    allErrors.push(...schemaResult.errors);
  }
  const coverageResult = validateUserColumnCoverage(userColumns);
  if (!coverageResult.success) {
    allErrors.push(...coverageResult.errors);
  }
  if (schemaResult.success) {
    const alignmentResult = validateUserColumnAlignment(
      userColumns as Record<string, string | null>,
      columnMappings
    );
    if (!alignmentResult.success) {
      allErrors.push(...alignmentResult.errors);
    }
  }
  return {
    success: allErrors.length === 0,
    errors: allErrors,
  };
}
