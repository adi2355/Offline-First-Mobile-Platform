import type { EntityType } from '@shared/contracts';
import {
  ENTITY_CLIENT_ID_FIELDS,
  ENTITY_USER_COLUMN,
} from './entities';
export function extractClientIdFromPayload(
  entityType: EntityType,
  changeData?: Record<string, unknown>
): string | null {
  if (!changeData) {
    return null;
  }
  const mapping = ENTITY_CLIENT_ID_FIELDS[entityType];
  if (!mapping) {
    return null;
  }
  const rawValue = changeData[mapping.backendField];
  if (typeof rawValue !== 'string') {
    return null;
  }
  const trimmed = rawValue.trim();
  return trimmed.length > 0 ? trimmed : null;
}
export function getEntityUserColumn(entityType: string): string | null {
  return ENTITY_USER_COLUMN[entityType] ?? null;
}
