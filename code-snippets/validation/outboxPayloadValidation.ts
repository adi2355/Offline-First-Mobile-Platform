import { z } from 'zod';
import { type EntityType } from '@shared/contracts';
import {
  CreateConsumptionDtoSchema,
  UpdateConsumptionDtoSchema,
  CreatePurchaseDtoSchema,
  UpdatePurchaseDtoSchema,
  CreateProductDtoSchema,
  UpdateProductDtoSchema,
  CreateSessionDtoSchema,
  UpdateSessionDtoSchema,
  CreateDeviceDtoSchema,
  UpdateDeviceDtoSchema,
  CreateInventoryItemDtoSchema,
  UpdateInventoryItemDtoSchema,
  CreateJournalEntryDtoSchema,
  UpdateJournalEntryDtoSchema,
  CreateGoalDtoSchema,
  UpdateGoalDtoSchema,
  CreateAiUsageRecordDtoSchema,
  UpdateAiUsageRecordDtoSchema,
} from '../utils/ValidationSchemas';
import { logger } from '../utils/logger';
export type OutboxEventType = 'CREATE' | 'UPDATE' | 'DELETE';
export interface PayloadValidationResult {
  success: boolean;
  data?: Record<string, unknown>;
  errors?: z.ZodError;
  message?: string;
}
const CREATE_SCHEMA_REGISTRY: Record<EntityType, z.ZodType<unknown>> = {
  consumptions: CreateConsumptionDtoSchema,
  purchases: CreatePurchaseDtoSchema,
  products: CreateProductDtoSchema,
  sessions: CreateSessionDtoSchema,
  devices: CreateDeviceDtoSchema,
  inventory_items: CreateInventoryItemDtoSchema,
  journal_entries: CreateJournalEntryDtoSchema,
  goals: CreateGoalDtoSchema,
  ai_usage_records: CreateAiUsageRecordDtoSchema,
};
const UPDATE_SCHEMA_REGISTRY: Record<EntityType, z.ZodType<unknown>> = {
  consumptions: UpdateConsumptionDtoSchema,
  purchases: UpdatePurchaseDtoSchema,
  products: UpdateProductDtoSchema,
  sessions: UpdateSessionDtoSchema,
  devices: UpdateDeviceDtoSchema,
  inventory_items: UpdateInventoryItemDtoSchema,
  journal_entries: UpdateJournalEntryDtoSchema,
  goals: UpdateGoalDtoSchema,
  ai_usage_records: UpdateAiUsageRecordDtoSchema,
};
export function validateOutboxPayload(
  entityType: EntityType | string,
  eventType: OutboxEventType,
  payload: Record<string, unknown>
): Record<string, unknown> {
  if (eventType === 'DELETE') {
    logger.debug('[OutboxPayloadValidation] DELETE event - skipping validation', {
      entityType,
    });
    return payload;
  }
  const schemaRegistry = eventType === 'CREATE' ? CREATE_SCHEMA_REGISTRY : UPDATE_SCHEMA_REGISTRY;
  const schema = schemaRegistry[entityType as EntityType];
  if (!schema) {
    const message = `[OutboxPayloadValidation] No validation schema registered for entity type "${entityType}" (${eventType}). ` +
      `All canonical EntityTypes must have schemas. Add the missing schema to the registry.`;
    logger.error(message, { entityType, eventType });
    throw new Error(message);
  }
  const result = schema.safeParse(payload);
  if (!result.success) {
    const errorMessage = formatZodError(result.error, entityType, eventType);
    logger.error('[OutboxPayloadValidation] Payload validation failed', {
      entityType,
      eventType,
      errors: result.error.errors.map(e => ({
        path: e.path.join('.'),
        message: e.message,
        code: e.code,
      })),
      payload: sanitizePayloadForLogging(payload),
    });
    throw new Error(`[OutboxPayloadValidation] Invalid ${entityType} payload: ${errorMessage}`);
  }
  logger.debug('[OutboxPayloadValidation] Payload validated successfully', {
    entityType,
    eventType,
  });
  return result.data as Record<string, unknown>;
}
export function tryValidateOutboxPayload(
  entityType: EntityType | string,
  eventType: OutboxEventType,
  payload: Record<string, unknown>
): PayloadValidationResult {
  if (eventType === 'DELETE') {
    return { success: true, data: payload };
  }
  const schemaRegistry = eventType === 'CREATE' ? CREATE_SCHEMA_REGISTRY : UPDATE_SCHEMA_REGISTRY;
  const schema = schemaRegistry[entityType as EntityType];
  if (!schema) {
    return {
      success: false,
      message: `No validation schema registered for entity type "${entityType}" (${eventType}). ` +
        `All canonical EntityTypes must have schemas.`,
    };
  }
  const result = schema.safeParse(payload);
  if (result.success) {
    return { success: true, data: result.data as Record<string, unknown> };
  }
  return {
    success: false,
    errors: result.error,
    message: formatZodError(result.error, entityType, eventType),
  };
}
export function hasValidationSchema(
  entityType: EntityType | string,
  eventType: OutboxEventType
): boolean {
  if (eventType === 'DELETE') return true; 
  const schemaRegistry = eventType === 'CREATE' ? CREATE_SCHEMA_REGISTRY : UPDATE_SCHEMA_REGISTRY;
  return entityType in schemaRegistry;
}
function formatZodError(
  error: z.ZodError,
  entityType: string,
  eventType: string
): string {
  const issues = error.errors.map(e => {
    const path = e.path.length > 0 ? `${e.path.join('.')}: ` : '';
    return `${path}${e.message}`;
  });
  return `${eventType} ${entityType} validation failed: ${issues.join('; ')}`;
}
function sanitizePayloadForLogging(
  payload: Record<string, unknown>
): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  const sensitiveFields = ['password', 'token', 'secret', 'key', 'notes'];
  const maxValueLength = 100;
  for (const [key, value] of Object.entries(payload)) {
    if (sensitiveFields.some(f => key.toLowerCase().includes(f))) {
      sanitized[key] = '[REDACTED]';
    } else if (typeof value === 'string' && value.length > maxValueLength) {
      sanitized[key] = `${value.substring(0, maxValueLength)}...[truncated]`;
    } else if (value === null || value === undefined) {
      sanitized[key] = value;
    } else if (typeof value === 'object') {
      sanitized[key] = '[Object]';
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
}
