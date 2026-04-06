export type ReconciliationAction = 'USE_SERVER' | 'KEEP_LOCAL';
export interface ReconciliationDecision {
  readonly action: ReconciliationAction;
  readonly reason: string;
}
export interface ReconciliableRow {
  readonly computeVersion: number;
  readonly sourceWatermark: string;
}
export interface ReconciliableWithCoverage extends ReconciliableRow {
  readonly coverage: number | null;
}
const COVERAGE_FLAP_THRESHOLD = 0.05;
const NUMERIC_WATERMARK_RE = /^\d+$/;
export function compareWatermarks(a: string, b: string): number {
  if (NUMERIC_WATERMARK_RE.test(a) && NUMERIC_WATERMARK_RE.test(b)) {
    const diff = BigInt(a) - BigInt(b);
    if (diff < 0n) return -1;
    if (diff > 0n) return 1;
    return 0;
  }
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
export function reconcile(
  local: ReconciliableRow,
  server: ReconciliableRow,
): ReconciliationDecision {
  if (server.computeVersion > local.computeVersion) {
    return {
      action: 'USE_SERVER',
      reason: `Server has newer algorithm (v${server.computeVersion} > v${local.computeVersion})`,
    };
  }
  if (local.computeVersion > server.computeVersion) {
    return {
      action: 'KEEP_LOCAL',
      reason: `Local has newer algorithm (v${local.computeVersion} > v${server.computeVersion})`,
    };
  }
  const wmCmp = compareWatermarks(server.sourceWatermark, local.sourceWatermark);
  if (wmCmp > 0) {
    return {
      action: 'USE_SERVER',
      reason: `Server includes more recent samples (wm: ${server.sourceWatermark} > ${local.sourceWatermark})`,
    };
  }
  if (wmCmp < 0) {
    return {
      action: 'KEEP_LOCAL',
      reason: `Local includes more recent samples (wm: ${local.sourceWatermark} > ${server.sourceWatermark})`,
    };
  }
  return {
    action: 'USE_SERVER',
    reason: 'Tie — server is canonical',
  };
}
export function reconcileWithCoverage(
  local: ReconciliableWithCoverage,
  server: ReconciliableWithCoverage,
): ReconciliationDecision {
  if (server.computeVersion > local.computeVersion) {
    return {
      action: 'USE_SERVER',
      reason: `Server has newer algorithm (v${server.computeVersion} > v${local.computeVersion})`,
    };
  }
  if (local.computeVersion > server.computeVersion) {
    return {
      action: 'KEEP_LOCAL',
      reason: `Local has newer algorithm (v${local.computeVersion} > v${server.computeVersion})`,
    };
  }
  const wmCmp = compareWatermarks(server.sourceWatermark, local.sourceWatermark);
  if (wmCmp > 0) {
    return {
      action: 'USE_SERVER',
      reason: `Server includes more recent samples (wm: ${server.sourceWatermark} > ${local.sourceWatermark})`,
    };
  }
  if (wmCmp < 0) {
    return {
      action: 'KEEP_LOCAL',
      reason: `Local includes more recent samples (wm: ${local.sourceWatermark} > ${server.sourceWatermark})`,
    };
  }
  const localCoverage = local.coverage ?? 0;
  const serverCoverage = server.coverage ?? 0;
  if (serverCoverage > localCoverage + COVERAGE_FLAP_THRESHOLD) {
    return {
      action: 'USE_SERVER',
      reason: `Server has better coverage (${serverCoverage} > ${localCoverage} + ${COVERAGE_FLAP_THRESHOLD})`,
    };
  }
  if (localCoverage > serverCoverage + COVERAGE_FLAP_THRESHOLD) {
    return {
      action: 'KEEP_LOCAL',
      reason: `Local has better coverage (${localCoverage} > ${serverCoverage} + ${COVERAGE_FLAP_THRESHOLD})`,
    };
  }
  return {
    action: 'USE_SERVER',
    reason: 'Tie — server is canonical',
  };
}
