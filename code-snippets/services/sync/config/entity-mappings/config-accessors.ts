import type { EntityColumnConfig } from './types';
import { ENTITY_COLUMN_MAPPINGS } from './entities';
export function getEntityColumnConfig(entityType: string): EntityColumnConfig | undefined {
  return ENTITY_COLUMN_MAPPINGS[entityType];
}
export function getConfiguredEntityTypes(): string[] {
  return Object.keys(ENTITY_COLUMN_MAPPINGS);
}
