import type { EntityColumnConfig } from '../types';
import { toOptionalTimestamp } from '../transforms';
export const GOALS_CONFIG: EntityColumnConfig = {
  baseColumns: {
    hasServerId: false,
    hasData: false,
    createdAtColumn: 'created_at',
    updatedAtColumn: 'updated_at',
  },
  requiredColumns: [
    { backendField: 'userId', sqliteColumn: 'user_id' },
    { backendField: 'type', sqliteColumn: 'goal_type' },
    { backendField: 'name', sqliteColumn: 'title' },
    { backendField: 'description', sqliteColumn: 'description' },
    { backendField: 'metricType', sqliteColumn: 'metric_type' },
    { backendField: 'targetValue', sqliteColumn: 'target_value' },
    { backendField: 'targetUnit', sqliteColumn: 'target_unit' },
    { backendField: 'currentValue', sqliteColumn: 'current_value' },
    { backendField: 'startDate', sqliteColumn: 'start_date', transform: toOptionalTimestamp },
    { backendField: 'endDate', sqliteColumn: 'end_date', transform: toOptionalTimestamp },
    { backendField: 'status', sqliteColumn: 'status' },
    { backendField: 'progressPercentage', sqliteColumn: 'progress_percentage' },
    { backendField: 'version', sqliteColumn: 'version' },
  ],
  syncMode: 'SYNCED',
  clientIdBackendField: null,
};
export const GOALS_USER_COLUMN = 'user_id';
