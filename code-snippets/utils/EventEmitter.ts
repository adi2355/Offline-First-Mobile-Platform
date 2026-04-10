export class EventEmitter<T = unknown> {
  private listeners: Record<string, Array<(data?: T) => void>> = {};
  private suppressedEvents: Set<string> = new Set();
  suppress(event: string): void {
    this.suppressedEvents.add(event);
  }
  resume(event: string): void {
    this.suppressedEvents.delete(event);
  }
  isSuppressed(event: string): boolean {
    return this.suppressedEvents.has(event);
  }
  on(event: string, callback: (data?: T) => void): void {
    if (!this.listeners[event]) {
      this.listeners[event] = [];
    }
    this.listeners[event].push(callback);
  }
  off(event: string, callback: (data?: T) => void): void {
    if (!this.listeners[event]) return;
    this.listeners[event] = this.listeners[event].filter(cb => cb !== callback);
  }
  emit(event: string, data?: T): void {
    if (this.isSuppressed(event)) {
      return;
    }
    if (!this.listeners[event]) return;
    this.listeners[event].forEach(callback => {
      try {
        callback(data);
      } catch (error) {
        console.error(`[EventEmitter] Error in event listener for ${event}:`, error);
      }
    });
  }
}
export interface DataChangeEvent {
  source?: string;
  payload?: unknown;
  consumptionId?: string;
  sessionId?: string;
  mode?: 'online' | 'offline';
  outboxId?: string; 
  count?: number;
  userId?: string | null;
  data?: Record<string, unknown> | unknown;
  reason?: string;
  entityType?: string;
  entityId?: string;
  correlationId?: string;
  timestamp?: string;
  deviceId?: string;
  isConnected?: boolean;
}
export const dataChangeEmitter = new EventEmitter<DataChangeEvent>();
export const dbEvents = {
  DATA_CHANGED: 'dataChanged',
  AUTH_TERMINAL_FAILURE: 'authTerminalFailure'
};
export interface AchievementTriggerEvent {
  actionType: string;
  actionData: Record<string, unknown>; 
}
export const achievementEmitter = new EventEmitter<AchievementTriggerEvent>();
export const achievementEvents = {
  TRIGGER_CHECK: 'achievementTriggerCheck'
};
export const deviceEvents = {
  DEVICE_LIST_UPDATED: 'deviceListUpdated',
  DEVICE_CONNECTION_STATE_CHANGED: 'deviceConnectionStateChanged',
  DEVICE_BATTERY_UPDATED: 'deviceBatteryUpdated'
}; 