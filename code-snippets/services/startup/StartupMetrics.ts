import { metrics } from '../metrics/Metrics';
export type StartupPhaseLabel = 'critical' | 'essential';
export interface MainThreadBlockStats {
  readonly totalBlockedMs: number;
  readonly maxBlockedMs: number;
  readonly longTaskCount: number;
  readonly sampleCount: number;
  readonly intervalMs: number;
  readonly longTaskThresholdMs: number;
  readonly observedMs: number;
}
interface MainThreadBlockMonitorOptions {
  readonly intervalMs?: number;
  readonly longTaskThresholdMs?: number;
  readonly now?: () => number;
  readonly schedule?: (fn: () => void, intervalMs: number) => ReturnType<typeof setInterval>;
  readonly cancel?: (handle: ReturnType<typeof setInterval>) => void;
}
export function createMainThreadBlockMonitor(options: MainThreadBlockMonitorOptions = {}) {
  const intervalMs = options.intervalMs ?? 50;
  const longTaskThresholdMs = options.longTaskThresholdMs ?? 50;
  const now = options.now ?? Date.now;
  const schedule = options.schedule ?? setInterval;
  const cancel = options.cancel ?? clearInterval;
  let timer: ReturnType<typeof setInterval> | null = null;
  let lastTick = 0;
  let startTime = 0;
  let totalBlockedMs = 0;
  let maxBlockedMs = 0;
  let longTaskCount = 0;
  let sampleCount = 0;
  const tick = () => {
    const current = now();
    if (lastTick > 0) {
      const delta = current - lastTick;
      const drift = delta - intervalMs;
      if (drift > longTaskThresholdMs) {
        totalBlockedMs += drift;
        maxBlockedMs = Math.max(maxBlockedMs, drift);
        longTaskCount += 1;
      }
    }
    sampleCount += 1;
    lastTick = current;
  };
  return {
    start() {
      if (timer) return;
      startTime = now();
      lastTick = startTime;
      timer = schedule(tick, intervalMs);
    },
    stop(): MainThreadBlockStats {
      if (timer) {
        cancel(timer);
        timer = null;
      }
      const observedMs = Math.max(0, now() - startTime);
      return {
        totalBlockedMs,
        maxBlockedMs,
        longTaskCount,
        sampleCount,
        intervalMs,
        longTaskThresholdMs,
        observedMs,
      };
    },
  };
}
export function trackStartupMainThreadBlock(params: {
  sessionId: string;
  phase: StartupPhaseLabel;
  stats: MainThreadBlockStats;
  appVersion: string;
  startupOrchestratorEnabled: boolean;
}): void {
  metrics.trackEvent('metricsStartup', 'startup_main_thread_block', {
    session_id: params.sessionId,
    phase: params.phase,
    blocked_ms_total: params.stats.totalBlockedMs,
    blocked_ms_max: params.stats.maxBlockedMs,
    long_task_count: params.stats.longTaskCount,
    sample_count: params.stats.sampleCount,
    interval_ms: params.stats.intervalMs,
    long_task_threshold_ms: params.stats.longTaskThresholdMs,
    observed_ms: params.stats.observedMs,
    app_version: params.appVersion,
    startup_orchestrator_enabled: params.startupOrchestratorEnabled,
  });
}
