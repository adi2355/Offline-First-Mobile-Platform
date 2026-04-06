import { metrics } from '../metrics/Metrics';
import { logger } from '../../utils/logger';
export type SyncTaskPriority = 'critical' | 'high' | 'normal' | 'low';
export type SyncTaskKind = 'data_sync' | 'health_ingest' | 'health_upload' | 'catalog_sync' | 'lease_request';
export type SyncResource = 'network' | 'sqlite';
export interface SyncSchedulerConfig {
  readonly maxConcurrentNetwork: number;
  readonly maxConcurrentSqlite: number;
  readonly defaultSliceBudgetMs: number;
  readonly maxQueueSize: number;
  readonly now?: () => number;
  readonly yieldFn?: () => Promise<void>;
}
export interface SyncTaskSpec {
  readonly id: string;
  readonly name: string;
  readonly kind: SyncTaskKind;
  readonly priority: SyncTaskPriority;
  readonly deadlineMs?: number;
  readonly timeoutMs?: number;
  readonly resources?: Partial<Record<SyncResource, number>>;
  readonly sliceBudgetMs?: number;
  readonly tags?: Record<string, string | number | boolean>;
}
export interface YieldStats {
  readonly budgetMs: number;
  readonly maxSliceMs: number;
  readonly yieldCount: number;
  readonly totalSlices: number;
}
export interface CooperativeYieldController {
  yieldIfNeeded(reason?: string): Promise<void>;
  getStats(): YieldStats;
  finalize(): void;
}
export interface SyncTaskContext {
  readonly taskId: string;
  readonly taskName: string;
  readonly startedAt: number;
  readonly deadlineAt?: number;
  readonly yieldController: CooperativeYieldController;
  readonly resources: Partial<Record<SyncResource, number>>;
}
const PRIORITY_WEIGHT: Record<SyncTaskPriority, number> = {
  critical: 3,
  high: 2,
  normal: 1,
  low: 0,
};
const defaultYieldFn = (): Promise<void> => {
  if (typeof requestAnimationFrame === 'function') {
    return new Promise((resolve) => requestAnimationFrame(() => resolve()));
  }
  return new Promise((resolve) => setTimeout(resolve, 0));
};
class TimeSliceBudget implements CooperativeYieldController {
  private readonly budgetMs: number;
  private readonly now: () => number;
  private readonly yieldFn: () => Promise<void>;
  private sliceStart: number;
  private maxSliceMs = 0;
  private yieldCount = 0;
  private totalSlices = 1;
  constructor(budgetMs: number, now: () => number, yieldFn: () => Promise<void>) {
    this.budgetMs = Math.max(1, Math.floor(budgetMs));
    this.now = now;
    this.yieldFn = yieldFn;
    this.sliceStart = this.now();
  }
  public async yieldIfNeeded(_reason?: string): Promise<void> {
    const elapsed = this.now() - this.sliceStart;
    if (elapsed < this.budgetMs) {
      return;
    }
    this.maxSliceMs = Math.max(this.maxSliceMs, elapsed);
    this.yieldCount += 1;
    this.totalSlices += 1;
    await this.yieldFn();
    this.sliceStart = this.now();
  }
  public finalize(): void {
    const elapsed = this.now() - this.sliceStart;
    this.maxSliceMs = Math.max(this.maxSliceMs, elapsed);
  }
  public getStats(): YieldStats {
    return {
      budgetMs: this.budgetMs,
      maxSliceMs: this.maxSliceMs,
      yieldCount: this.yieldCount,
      totalSlices: this.totalSlices,
    };
  }
}
export class SyncSchedulerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SyncSchedulerError';
  }
}
export class SyncSchedulerDeadlineExceededError extends SyncSchedulerError {
  constructor(message: string) {
    super(message);
    this.name = 'SyncSchedulerDeadlineExceededError';
  }
}
export class SyncSchedulerQueueFullError extends SyncSchedulerError {
  constructor(message: string) {
    super(message);
    this.name = 'SyncSchedulerQueueFullError';
  }
}
interface ScheduledTask<T> {
  spec: SyncTaskSpec;
  createdAt: number;
  deadlineAt?: number;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  fn: (ctx: SyncTaskContext) => Promise<T>;
}
export class SyncScheduler {
  private readonly config: SyncSchedulerConfig;
  private readonly now: () => number;
  private readonly yieldFn: () => Promise<void>;
  private readonly queue: Array<ScheduledTask<unknown>> = [];
  private isDraining = false;
  private activeNetwork = 0;
  private activeSqlite = 0;
  private maxQueueDepth = 0;
  constructor(config: Partial<SyncSchedulerConfig> = {}) {
    this.config = {
      maxConcurrentNetwork: config.maxConcurrentNetwork ?? 2,
      maxConcurrentSqlite: config.maxConcurrentSqlite ?? 1,
      defaultSliceBudgetMs: config.defaultSliceBudgetMs ?? 8,
      maxQueueSize: config.maxQueueSize ?? 100,
      now: config.now,
      yieldFn: config.yieldFn,
    };
    this.now = this.config.now ?? (() => Date.now());
    this.yieldFn = this.config.yieldFn ?? defaultYieldFn;
  }
  public runTask<T>(spec: SyncTaskSpec, fn: (ctx: SyncTaskContext) => Promise<T>): Promise<T> {
    if (this.queue.length >= this.config.maxQueueSize) {
      const error = new SyncSchedulerQueueFullError(
        `SyncScheduler queue full (${this.queue.length}/${this.config.maxQueueSize}) for task ${spec.name}`
      );
      logger.warn('[SyncScheduler] Queue full - rejecting task', {
        taskId: spec.id,
        taskName: spec.name,
        queueDepth: this.queue.length,
      });
      return Promise.reject(error);
    }
    return new Promise<T>((resolve, reject) => {
      const createdAt = this.now();
      const deadlineAt = spec.deadlineMs ? createdAt + spec.deadlineMs : undefined;
      this.queue.push({
        spec,
        createdAt,
        deadlineAt,
        resolve: resolve as (value: unknown) => void,
        reject,
        fn: fn as (ctx: SyncTaskContext) => Promise<unknown>,
      });
      this.maxQueueDepth = Math.max(this.maxQueueDepth, this.queue.length);
      this.drainQueue();
    });
  }
  public getStats(): {
    queueDepth: number;
    activeNetwork: number;
    activeSqlite: number;
    maxQueueDepth: number;
  } {
    return {
      queueDepth: this.queue.length,
      activeNetwork: this.activeNetwork,
      activeSqlite: this.activeSqlite,
      maxQueueDepth: this.maxQueueDepth,
    };
  }
  private drainQueue(): void {
    if (this.isDraining) {
      return;
    }
    this.isDraining = true;
    Promise.resolve().then(() => {
      try {
        this.processQueue();
      } finally {
        this.isDraining = false;
      }
    }).catch((error) => {
      this.isDraining = false;
      logger.error('[SyncScheduler] Drain queue failed', {
        error: error instanceof Error ? { name: error.name, message: error.message } : { name: 'Error', message: String(error) },
      });
    });
  }
  private processQueue(): void {
    if (this.queue.length === 0) {
      return;
    }
    const now = this.now();
    const sorted = [...this.queue].sort((a, b) => {
      const priorityDiff = PRIORITY_WEIGHT[b.spec.priority] - PRIORITY_WEIGHT[a.spec.priority];
      if (priorityDiff !== 0) return priorityDiff;
      const deadlineA = a.deadlineAt ?? Number.POSITIVE_INFINITY;
      const deadlineB = b.deadlineAt ?? Number.POSITIVE_INFINITY;
      if (deadlineA !== deadlineB) return deadlineA - deadlineB;
      return a.createdAt - b.createdAt;
    });
    for (const task of sorted) {
      if (!this.canRun(task.spec)) {
        continue;
      }
      if (task.deadlineAt && now > task.deadlineAt) {
        this.rejectTask(task, new SyncSchedulerDeadlineExceededError(
          `SyncScheduler deadline exceeded for task ${task.spec.name}`
        ));
        continue;
      }
      this.queue.splice(this.queue.indexOf(task), 1);
      this.startTask(task as ScheduledTask<unknown>);
    }
  }
  private canRun(spec: SyncTaskSpec): boolean {
    const resources = spec.resources ?? {};
    const needsNetwork = resources.network ?? 0;
    const needsSqlite = resources.sqlite ?? 0;
    if (this.activeNetwork + needsNetwork > this.config.maxConcurrentNetwork) {
      return false;
    }
    if (this.activeSqlite + needsSqlite > this.config.maxConcurrentSqlite) {
      return false;
    }
    return true;
  }
  private startTask<T>(task: ScheduledTask<T>): void {
    const resources = task.spec.resources ?? {};
    const needsNetwork = resources.network ?? 0;
    const needsSqlite = resources.sqlite ?? 0;
    const startTime = this.now();
    this.activeNetwork += needsNetwork;
    this.activeSqlite += needsSqlite;
    const yieldController = new TimeSliceBudget(
      task.spec.sliceBudgetMs ?? this.config.defaultSliceBudgetMs,
      this.now,
      this.yieldFn
    );
    const ctx: SyncTaskContext = {
      taskId: task.spec.id,
      taskName: task.spec.name,
      startedAt: startTime,
      deadlineAt: task.deadlineAt,
      yieldController,
      resources,
    };
    task.fn(ctx)
      .then((result) => {
        yieldController.finalize();
        const durationMs = this.now() - startTime;
        const waitMs = startTime - task.createdAt;
        const stats = yieldController.getStats();
        metrics.trackEvent('metricsSync', 'sync_scheduler_task', {
          task_id: task.spec.id,
          task_name: task.spec.name,
          task_kind: task.spec.kind,
          priority: task.spec.priority,
          duration_ms: durationMs,
          wait_ms: waitMs,
          max_slice_ms: stats.maxSliceMs,
          budget_ms: stats.budgetMs,
          yield_count: stats.yieldCount,
          total_slices: stats.totalSlices,
          success: true,
          ...(task.spec.tags ?? {}),
        });
        task.resolve(result);
      })
      .catch((error: unknown) => {
        yieldController.finalize();
        const durationMs = this.now() - startTime;
        const waitMs = startTime - task.createdAt;
        const stats = yieldController.getStats();
        const err = error instanceof Error ? error : new Error(String(error));
        metrics.trackEvent('metricsSync', 'sync_scheduler_task', {
          task_id: task.spec.id,
          task_name: task.spec.name,
          task_kind: task.spec.kind,
          priority: task.spec.priority,
          duration_ms: durationMs,
          wait_ms: waitMs,
          max_slice_ms: stats.maxSliceMs,
          budget_ms: stats.budgetMs,
          yield_count: stats.yieldCount,
          total_slices: stats.totalSlices,
          success: false,
          error: err.name,
          ...(task.spec.tags ?? {}),
        });
        task.reject(err);
      })
      .finally(() => {
        this.activeNetwork = Math.max(0, this.activeNetwork - needsNetwork);
        this.activeSqlite = Math.max(0, this.activeSqlite - needsSqlite);
        this.drainQueue();
      });
  }
  private rejectTask(task: ScheduledTask<unknown>, error: Error): void {
    const idx = this.queue.indexOf(task);
    if (idx >= 0) {
      this.queue.splice(idx, 1);
    }
    task.reject(error);
  }
}
