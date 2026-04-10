import type { EntityColumnConfig, SqlBuilderResult } from './types';
import { ENTITY_COLUMN_MAPPINGS } from './entities';
export function buildEntityInsert(
  entityType: string,
  serverId: string,
  changeData: Record<string, unknown> | undefined,
  nowIso: string
): SqlBuilderResult {
  const config = ENTITY_COLUMN_MAPPINGS[entityType];
  if (!config) {
    const baseColumns = ['id', 'server_id', 'data', 'created_at', 'updated_at'];
    const baseParams: (string | number | null)[] = [
      serverId,
      serverId,
      JSON.stringify(changeData),
      nowIso,
      nowIso,
    ];
    const placeholders = baseColumns.map(() => '?').join(', ');
    return {
      sql: `INSERT OR REPLACE INTO ${entityType} (${baseColumns.join(', ')}) VALUES (${placeholders})`,
      params: baseParams,
    };
  }
  const columns: string[] = ['id'];
  const params: (string | number | null)[] = [serverId];
  if (config.baseColumns.hasServerId) {
    columns.push('server_id');
    params.push(serverId);
  }
  if (config.baseColumns.hasData) {
    columns.push('data');
    params.push(JSON.stringify(changeData));
  }
  columns.push(config.baseColumns.createdAtColumn);
  params.push(nowIso);
  columns.push(config.baseColumns.updatedAtColumn);
  params.push(nowIso);
  if (changeData) {
    for (const col of config.requiredColumns) {
      const rawValue = changeData[col.backendField];
      if (rawValue !== undefined) {
        const transformedValue = col.transform
          ? col.transform(rawValue)
          : (rawValue as string | number | null);
        columns.push(col.sqliteColumn);
        params.push(transformedValue);
      }
    }
  }
  const placeholders = columns.map(() => '?').join(', ');
  return {
    sql: `INSERT OR REPLACE INTO ${entityType} (${columns.join(', ')}) VALUES (${placeholders})`,
    params,
  };
}
export function buildEntityUpdate(
  entityType: string,
  serverId: string,
  changeData: Record<string, unknown> | undefined,
  nowIso: string
): SqlBuilderResult {
  const config = ENTITY_COLUMN_MAPPINGS[entityType];
  if (!config) {
    const params: (string | number | null)[] = [JSON.stringify(changeData), nowIso, serverId];
    return {
      sql: `UPDATE ${entityType} SET data = ?, updated_at = ? WHERE server_id = ?`,
      params,
    };
  }
  const setClauses: string[] = [];
  const params: (string | number | null)[] = [];
  if (config.baseColumns.hasData) {
    setClauses.push('data = ?');
    params.push(JSON.stringify(changeData));
  }
  setClauses.push(`${config.baseColumns.updatedAtColumn} = ?`);
  params.push(nowIso);
  if (changeData) {
    for (const col of config.requiredColumns) {
      const rawValue = changeData[col.backendField];
      if (rawValue !== undefined) {
        const transformedValue = col.transform
          ? col.transform(rawValue)
          : (rawValue as string | number | null);
        setClauses.push(`${col.sqliteColumn} = ?`);
        params.push(transformedValue);
      }
    }
  }
  const idColumn = config.baseColumns.hasServerId ? 'server_id' : 'id';
  params.push(serverId);
  return {
    sql: `UPDATE ${entityType} SET ${setClauses.join(', ')} WHERE ${idColumn} = ?`,
    params,
  };
}
