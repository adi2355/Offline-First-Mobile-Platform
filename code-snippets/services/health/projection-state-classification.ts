import type { ProjectionServerState } from './HealthProjectionHydrationClient';
const TERMINAL_SUCCESS_STATES: ReadonlySet<ProjectionServerState> = new Set([
  'READY', 'NO_DATA', 'EMPTY', 'PARTIAL',
]);
const NON_TERMINAL_STATES: ReadonlySet<ProjectionServerState> = new Set([
  'COMPUTING', 'STALE',
]);
export interface StatusCounts {
  readonly ready: number;
  readonly computing: number;
  readonly noData: number;
  readonly failed: number;
  readonly stale: number;
}
export const EMPTY_STATUS_COUNTS: Readonly<StatusCounts> = Object.freeze({
  ready: 0, computing: 0, noData: 0, failed: 0, stale: 0,
});
export function hasNonTerminalItems(counts: StatusCounts): boolean {
  return counts.stale > 0 || counts.computing > 0;
}
export function isTerminalSuccessState(state: ProjectionServerState): boolean {
  return TERMINAL_SUCCESS_STATES.has(state);
}
export function isNonTerminalServerState(state: ProjectionServerState): boolean {
  return NON_TERMINAL_STATES.has(state);
}
export function shouldRetryHydration(
  success: boolean,
  serverState: ProjectionServerState,
  statusCounts?: StatusCounts,
): boolean {
  if (isNonTerminalServerState(serverState)) return true;
  if (serverState === 'PARTIAL' && statusCounts != null && hasNonTerminalItems(statusCounts)) return true;
  if (!success) return true;
  return false;
}
export type ValidPeriodDays = 7 | 30 | 90;
export const VALID_PERIOD_DAYS: ReadonlySet<number> = new Set([7, 30, 90]);
const PERIOD_DAYS_TO_API_PARAM: Readonly<Record<ValidPeriodDays, string>> = {
  7: '7d',
  30: '30d',
  90: '90d',
};
export function periodDaysToApiParam(periodDays: number): string {
  if (!VALID_PERIOD_DAYS.has(periodDays)) {
    throw new Error(
      `Invalid periodDays: ${periodDays}. Must be one of: ${Array.from(VALID_PERIOD_DAYS).join(', ')}`,
    );
  }
  return PERIOD_DAYS_TO_API_PARAM[periodDays as ValidPeriodDays];
}
export const MAX_HYDRATION_RETRIES = 3;
export const HYDRATION_RETRY_BASE_MS = 2000;
export const HYDRATION_RETRY_JITTER_MS = 500;
