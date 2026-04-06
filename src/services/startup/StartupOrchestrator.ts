export enum StartupPhase {
  CRITICAL = 'critical',
  ESSENTIAL = 'essential',
  BACKGROUND = 'background',
  DEFERRED = 'deferred',
}
export type StartupAppState = 'active' | 'background' | 'inactive' | 'extension' | 'unknown';
export interface StartupTask {
  readonly name: string;
  readonly phase: StartupPhase;
  readonly execute: () => Promise<void>;
  readonly timeoutMs?: number;
  readonly canFail?: boolean;
  readonly dependsOn?: string[];
  readonly heavy?: boolean;
}
export interface StartupTaskResult {
  readonly name: string;
  readonly phase: StartupPhase;
  readonly success: boolean;
  readonly durationMs: number;
  readonly timedOut: boolean;
  readonly error?: string;
}
export interface StartupReport {
  readonly startedAt: number;
  readonly completedAt: number;
  readonly results: StartupTaskResult[];
}
interface StartupOrchestratorOptions {
  readonly onTaskStart?: (task: StartupTask) => void;
  readonly onTaskComplete?: (result: StartupTaskResult) => void;
  readonly initialAppState?: StartupAppState;
}
const PHASE_ORDER: StartupPhase[] = [
  StartupPhase.CRITICAL,
  StartupPhase.ESSENTIAL,
  StartupPhase.BACKGROUND,
  StartupPhase.DEFERRED,
];
const isBackgroundPhase = (phase: StartupPhase): boolean =>
  phase === StartupPhase.BACKGROUND || phase === StartupPhase.DEFERRED;
export class StartupOrchestrator {
  private readonly tasks = new Map<string, StartupTask>();
  private readonly results = new Map<string, StartupTaskResult>();
  private readonly options: StartupOrchestratorOptions;
  private firstPaintComplete = false;
  private appState: StartupAppState = 'active';
  private gateWaiters: Array<() => void> = [];
  constructor(options: StartupOrchestratorOptions = {}) {
    this.options = options;
    if (options.initialAppState) {
      this.appState = options.initialAppState;
    }
  }
  public addTask(task: StartupTask): void {
    if (this.tasks.has(task.name)) {
      throw new Error(`StartupOrchestrator: Duplicate task name "${task.name}"`);
    }
    if (task.heavy && !isBackgroundPhase(task.phase)) {
      throw new Error(
        `StartupOrchestrator: Heavy task "${task.name}" must be scheduled in BACKGROUND or DEFERRED`
      );
    }
    this.tasks.set(task.name, task);
  }
  public markFirstPaintComplete(): void {
    this.firstPaintComplete = true;
    this.resolveGateIfReady();
  }
  public setAppState(state: StartupAppState): void {
    this.appState = state;
    this.resolveGateIfReady();
  }
  public async runPhases(phases: StartupPhase[]): Promise<StartupReport> {
    const startedAt = Date.now();
    const orderedPhases = this.normalizePhaseOrder(phases);
    const results: StartupTaskResult[] = [];
    for (const phase of orderedPhases) {
      const phaseTasks = this.getPhaseTasks(phase);
      if (phaseTasks.length === 0) {
        continue;
      }
      if (isBackgroundPhase(phase)) {
        await this.waitForBackgroundGate();
      }
      const orderedTasks = this.resolveTaskOrder(phaseTasks);
      for (const task of orderedTasks) {
        if (this.results.has(task.name)) {
          continue;
        }
        const deps = task.dependsOn ?? [];
        for (const dep of deps) {
          const depResult = this.results.get(dep);
          if (!depResult || !depResult.success) {
            throw new Error(
              `StartupOrchestrator: Task "${task.name}" depends on "${dep}" which has not completed successfully`
            );
          }
        }
        const result = await this.runTask(task);
        results.push(result);
        this.results.set(task.name, result);
        if (!result.success && !task.canFail) {
          throw new Error(
            `StartupOrchestrator: Task "${task.name}" failed in phase "${task.phase}"` +
              (result.error ? ` - ${result.error}` : '')
          );
        }
      }
    }
    return {
      startedAt,
      completedAt: Date.now(),
      results,
    };
  }
  private normalizePhaseOrder(phases: StartupPhase[]): StartupPhase[] {
    const unique = Array.from(new Set(phases));
    return PHASE_ORDER.filter((phase) => unique.includes(phase));
  }
  private getPhaseTasks(phase: StartupPhase): StartupTask[] {
    return Array.from(this.tasks.values()).filter((task) => task.phase === phase);
  }
  private resolveTaskOrder(tasks: StartupTask[]): StartupTask[] {
    if (tasks.length <= 1) return tasks;
    const tasksByName = new Map(tasks.map((task) => [task.name, task]));
    const inDegree = new Map<string, number>();
    const adjacency = new Map<string, string[]>();
    for (const task of tasks) {
      inDegree.set(task.name, 0);
      adjacency.set(task.name, []);
    }
    for (const task of tasks) {
      const deps = task.dependsOn ?? [];
      for (const dep of deps) {
        const depTask = this.tasks.get(dep);
        if (!depTask) {
          throw new Error(`StartupOrchestrator: Task "${task.name}" depends on unknown "${dep}"`);
        }
        const depPhaseIndex = PHASE_ORDER.indexOf(depTask.phase);
        const taskPhaseIndex = PHASE_ORDER.indexOf(task.phase);
        if (depPhaseIndex > taskPhaseIndex) {
          throw new Error(
            `StartupOrchestrator: Task "${task.name}" depends on "${dep}" in later phase "${depTask.phase}"`
          );
        }
        if (depTask.phase !== task.phase) {
          continue;
        }
        adjacency.get(dep)!.push(task.name);
        inDegree.set(task.name, (inDegree.get(task.name) ?? 0) + 1);
      }
    }
    const queue: string[] = [];
    for (const [name, degree] of inDegree.entries()) {
      if (degree === 0) queue.push(name);
    }
    const ordered: StartupTask[] = [];
    while (queue.length > 0) {
      const name = queue.shift()!;
      ordered.push(tasksByName.get(name)!);
      for (const neighbor of adjacency.get(name) ?? []) {
        inDegree.set(neighbor, (inDegree.get(neighbor) ?? 0) - 1);
        if (inDegree.get(neighbor) === 0) {
          queue.push(neighbor);
        }
      }
    }
    if (ordered.length !== tasks.length) {
      throw new Error('StartupOrchestrator: Dependency cycle detected in startup tasks');
    }
    return ordered;
  }
  private async runTask(task: StartupTask): Promise<StartupTaskResult> {
    this.options.onTaskStart?.(task);
    const startTime = Date.now();
    let timedOut = false;
    try {
      if (task.timeoutMs && task.timeoutMs > 0) {
        const taskPromise = task.execute();
        let timeoutId: ReturnType<typeof setTimeout> | null = null;
        const timeoutPromise = new Promise<void>((_, reject) => {
          timeoutId = setTimeout(() => {
            timedOut = true;
            reject(new Error(`Task "${task.name}" timed out after ${task.timeoutMs}ms`));
          }, task.timeoutMs);
        });
        await Promise.race([taskPromise, timeoutPromise]).finally(() => {
          if (timeoutId) {
            clearTimeout(timeoutId);
          }
        });
      } else {
        await task.execute();
      }
      const result: StartupTaskResult = {
        name: task.name,
        phase: task.phase,
        success: true,
        durationMs: Date.now() - startTime,
        timedOut,
      };
      this.options.onTaskComplete?.(result);
      return result;
    } catch (error) {
      const result: StartupTaskResult = {
        name: task.name,
        phase: task.phase,
        success: false,
        durationMs: Date.now() - startTime,
        timedOut,
        error: error instanceof Error ? error.message : String(error),
      };
      this.options.onTaskComplete?.(result);
      return result;
    }
  }
  private async waitForBackgroundGate(): Promise<void> {
    if (this.firstPaintComplete && this.appState === 'active') {
      return;
    }
    await new Promise<void>((resolve) => {
      this.gateWaiters.push(resolve);
    });
  }
  private resolveGateIfReady(): void {
    if (!this.firstPaintComplete || this.appState !== 'active') {
      return;
    }
    const waiters = [...this.gateWaiters];
    this.gateWaiters = [];
    waiters.forEach((resolve) => resolve());
  }
}
