import { normalizeDecimalString } from '../../../../db/schema-helpers';
export class TransformValidationError extends Error {
  constructor(
    public readonly fieldName: string,
    public readonly expectedType: string,
    public readonly actualValue: unknown,
    public readonly actualType: string = typeof actualValue
  ) {
    super(
      `Transform validation failed for '${fieldName}': ` +
      `expected ${expectedType}, got ${actualType} (${JSON.stringify(actualValue)})`
    );
    this.name = 'TransformValidationError';
  }
}
export function assertValidTimestamp(
  value: unknown,
  fieldName: string = 'timestamp'
): asserts value is string | Date | number {
  if (
    typeof value !== 'string' &&
    !(value instanceof Date) &&
    typeof value !== 'number'
  ) {
    throw new TransformValidationError(
      fieldName,
      'string | Date | number',
      value
    );
  }
}
export function assertValidOptionalTimestamp(
  value: unknown,
  fieldName: string = 'timestamp'
): asserts value is string | Date | number | null | undefined {
  if (
    value !== null &&
    value !== undefined &&
    value !== '' &&
    typeof value !== 'string' &&
    !(value instanceof Date) &&
    typeof value !== 'number'
  ) {
    throw new TransformValidationError(
      fieldName,
      'string | Date | number | null | undefined',
      value
    );
  }
}
export function assertValidDecimal(
  value: unknown,
  fieldName: string = 'decimal'
): asserts value is string | number | null | undefined {
  if (
    value !== null &&
    value !== undefined &&
    typeof value !== 'string' &&
    typeof value !== 'number'
  ) {
    throw new TransformValidationError(
      fieldName,
      'string | number | null | undefined',
      value
    );
  }
}
export function assertValidBoolean(
  value: unknown,
  _fieldName: string = 'boolean'
): asserts value is unknown {
}
export function assertValidJsonArray(
  value: unknown,
  fieldName: string = 'jsonArray'
): asserts value is unknown[] | null | undefined {
  if (value !== null && value !== undefined && !Array.isArray(value)) {
    throw new TransformValidationError(
      fieldName,
      'array | null | undefined',
      value
    );
  }
}
export function assertValidJsonObject(
  value: unknown,
  fieldName: string = 'jsonObject'
): asserts value is Record<string, unknown> | null | undefined {
  if (
    value !== null &&
    value !== undefined &&
    (typeof value !== 'object' || Array.isArray(value))
  ) {
    throw new TransformValidationError(
      fieldName,
      'object | null | undefined',
      value
    );
  }
}
export function normalizeTimestamp(value: string | Date | number): string {
  if (typeof value === 'string') return value;
  if (value instanceof Date) return value.toISOString();
  return new Date(value).toISOString();
}
export function normalizeOptionalTimestamp(
  value: string | Date | number | null | undefined
): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string') return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'number') return new Date(value).toISOString();
  return null;
}
export function normalizeDecimal(
  value: string | number | null | undefined,
  precision: number
): string | null {
  if (value === null || value === undefined) return null;
  return normalizeDecimalString(value, precision);
}
export function normalizeBoolean(value: unknown): number {
  return value ? 1 : 0;
}
export function normalizeInvertedBoolean(value: unknown): number {
  return value === true ? 0 : 1;
}
export function normalizeJsonArray(value: unknown[] | null | undefined): string {
  return JSON.stringify(value ?? []);
}
export function normalizeJsonObject(
  value: Record<string, unknown> | null | undefined
): string {
  return JSON.stringify(value ?? {});
}
export function strictRequiredTimestamp(
  value: unknown,
  fieldName: string = 'timestamp'
): string {
  assertValidTimestamp(value, fieldName);
  return normalizeTimestamp(value);
}
export function strictOptionalTimestamp(
  value: unknown,
  fieldName: string = 'timestamp'
): string | null {
  assertValidOptionalTimestamp(value, fieldName);
  return normalizeOptionalTimestamp(value);
}
export function strictDecimal(
  value: unknown,
  precision: number,
  fieldName: string = 'decimal'
): string | null {
  assertValidDecimal(value, fieldName);
  return normalizeDecimal(value, precision);
}
export function strictJsonArray(
  value: unknown,
  fieldName: string = 'jsonArray'
): string {
  assertValidJsonArray(value, fieldName);
  return normalizeJsonArray(value);
}
export function strictJsonObject(
  value: unknown,
  fieldName: string = 'jsonObject'
): string {
  assertValidJsonObject(value, fieldName);
  return normalizeJsonObject(value);
}
export function toRequiredTimestamp(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'number') return new Date(value).toISOString();
  return new Date().toISOString();
}
export function toOptionalTimestamp(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'number') return new Date(value).toISOString();
  return null;
}
function normalizeDecimalValue(value: unknown, precision: number): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'string' || typeof value === 'number') {
    return normalizeDecimalString(value, precision);
  }
  return null;
}
export function toDecimal2(value: unknown): string | null {
  return normalizeDecimalValue(value, 2);
}
export function toDecimal3(value: unknown): string | null {
  return normalizeDecimalValue(value, 3);
}
export function toDecimal4(value: unknown): string | null {
  return normalizeDecimalValue(value, 4);
}
export function toBooleanInt(value: unknown): number {
  return value ? 1 : 0;
}
export function toInvertedBooleanInt(value: unknown): number {
  return value === true ? 0 : 1;
}
export function toJsonArray(value: unknown): string {
  return JSON.stringify(value || []);
}
export function toJsonObject(value: unknown): string {
  return JSON.stringify(value || {});
}
export function createDecimalTransform(precision: number): (value: unknown) => string | null {
  return (value: unknown) => normalizeDecimalValue(value, precision);
}
export type TransformFn = (value: unknown) => string | number | null;
export const PERMISSIVE_TRANSFORM_REGISTRY = {
  toRequiredTimestamp,
  toOptionalTimestamp,
  toDecimal2,
  toDecimal3,
  toDecimal4,
  toBooleanInt,
  toInvertedBooleanInt,
  toJsonArray,
  toJsonObject,
} as const;
export const VALIDATION_REGISTRY = {
  assertValidTimestamp,
  assertValidOptionalTimestamp,
  assertValidDecimal,
  assertValidBoolean,
  assertValidJsonArray,
  assertValidJsonObject,
} as const;
export const NORMALIZE_REGISTRY = {
  normalizeTimestamp,
  normalizeOptionalTimestamp,
  normalizeDecimal,
  normalizeBoolean,
  normalizeInvertedBoolean,
  normalizeJsonArray,
  normalizeJsonObject,
} as const;
export const STRICT_TRANSFORM_REGISTRY = {
  strictRequiredTimestamp,
  strictOptionalTimestamp,
  strictDecimal,
  strictJsonArray,
  strictJsonObject,
} as const;
export const TRANSFORM_REGISTRY = PERMISSIVE_TRANSFORM_REGISTRY;
export function getTransformByName(
  name: keyof typeof PERMISSIVE_TRANSFORM_REGISTRY
): TransformFn | undefined {
  return PERMISSIVE_TRANSFORM_REGISTRY[name];
}
export function getStrictTransformByName(
  name: keyof typeof STRICT_TRANSFORM_REGISTRY
): ((value: unknown, fieldName?: string) => string | number | null) | undefined {
  return STRICT_TRANSFORM_REGISTRY[name] as ((value: unknown, fieldName?: string) => string | number | null) | undefined;
}
