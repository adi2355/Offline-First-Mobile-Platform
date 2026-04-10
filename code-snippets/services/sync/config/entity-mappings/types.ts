export type SyncMode = 'SYNCED' | 'LOCAL_ONLY';
export interface ColumnMapping {
  backendField: string;
  sqliteColumn: string;
  transform?: (value: unknown) => string | number | null;
}
export interface BaseColumnsConfig {
  hasServerId: boolean;
  hasData: boolean;
  createdAtColumn: string;
  updatedAtColumn: string;
}
export interface EntityColumnConfig {
  baseColumns: BaseColumnsConfig;
  requiredColumns: ColumnMapping[];
  syncMode: SyncMode;
  clientIdBackendField: string | null;
}
export interface ClientIdFieldMapping {
  backendField: string;
  sqliteColumn: string;
}
export interface HardwareIdFieldMapping {
  backendField: string;
  sqliteColumn: string;
}
export interface SqlBuilderResult {
  sql: string;
  params: (string | number | null)[];
}
