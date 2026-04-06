import { Socket as SocketIOSocket } from 'socket.io-client';
export type RealtimeEventType =
  | 'consumption.created'
  | 'consumption.updated'
  | 'consumption.deleted'
  | 'session.created'
  | 'session.updated'
  | 'session.completed'
  | 'journal.created'
  | 'journal.updated'
  | 'journal.deleted'
  | 'user.updated'
  | 'user.preferences.updated'
  | 'goal.created'
  | 'goal.updated'
  | 'goal.deleted'
  | 'goal.progress.updated'
  | 'achievement.unlocked'
  | 'inventory.updated'
  | 'purchase.created'
  | 'sync.conflict.detected'
  | 'sync.completed';
export type EntityType =
  | 'Consumption'
  | 'Session'
  | 'JournalEntry'
  | 'User'
  | 'Goal'
  | 'Achievement'
  | 'Inventory'
  | 'Purchase'
  | 'Product'
  | 'Device';
export interface RealtimeEnvelopeV1 {
  v: 1;
  type: RealtimeEventType;
  entity: EntityType;
  entityId: string; 
  userId: string; 
  occurredAt: string; 
  correlationId?: string;
  data?: Record<string, unknown>; 
}
export interface ConnectedEventPayload {
  socketId: string;
  userId: string;
  deviceId: string;
  serverTime: string;
}
export interface ErrorEventPayload {
  type: string;
  message: string;
  details?: Record<string, unknown>;
}
export interface SessionStartedEventPayload {
  sessionId: string; 
  startedBy: string; 
  timestamp: string; 
}
export interface SessionJoinedEventPayload {
  sessionId: string; 
  participants: string[]; 
  state: SessionStateData | null;
}
export interface SessionStateData {
  id: string; 
  userId: string; 
  sessionStartTimestamp: string; 
  sessionEndTimestamp?: string; 
  hitCount: number;
  totalDurationMs: number;
  avgHitDurationMs: number;
  sessionTypeHeuristic?: string;
  createdAt: string; 
  updatedAt: string; 
}
export interface ParticipantJoinedEventPayload {
  userId: string; 
  role: 'host' | 'participant';
  timestamp: string; 
}
export interface ParticipantLeftEventPayload {
  userId: string; 
  timestamp: string; 
}
export interface ParticipantStatusEventPayload {
  userId: string; 
  status: 'online' | 'away' | 'busy' | 'offline';
}
export interface SessionUpdatedEventPayload {
  sessionId: string; 
  updates: {
    hitCount?: number;
    totalDurationMs?: number;
    sessionTypeHeuristic?: string;
  };
  updatedBy: string; 
  timestamp: string; 
}
export interface SessionEndedEventPayload {
  endedBy: string; 
  reason?: string;
  timestamp: string; 
}
export interface ConsumptionUpdateEventPayload {
  id: string; 
  userId: string; 
  sessionId: string; 
  hitDurationMs: number;
  intensity?: number;
  deviceData?: Record<string, unknown>;
  timestamp: string; 
}
export interface ConsumptionSyncedEventPayload {
  id: string; 
  userId: string; 
  sessionId: string; 
  timestamp: string; 
  [key: string]: unknown; 
}
export interface ConsumptionRateEventPayload {
  userId: string; 
  rate: number; 
  timestamp: string; 
}
export interface MessageNewEventPayload {
  id: string; 
  sessionId: string; 
  userId: string; 
  text: string;
  metadata?: Record<string, unknown>;
  createdAt: string; 
  user?: {
    id: string;
    name?: string;
  };
}
export interface UserTypingEventPayload {
  userId: string; 
  isTyping: boolean;
}
export interface ReactionNewEventPayload {
  userId: string; 
  targetId: string; 
  type: 'like' | 'love' | 'fire' | 'celebrate';
  timestamp: string; 
}
export interface SyncRequiredEventPayload {
  requestedBy: string; 
  timestamp: string; 
  entities?: string[]; 
}
export interface SyncInitiatedEventPayload {
  success: boolean;
}
export interface SyncDataEventPayload {
  fromDevice: string; 
  changes: Array<{
    entityType: string;
    entityId: string;
    operation: 'CREATE' | 'UPDATE' | 'DELETE';
    data?: Record<string, unknown>;
    timestamp: number; 
  }>;
  timestamp: string; 
}
export interface SyncPushedEventPayload {
  success: boolean;
}
export interface DeviceDisconnectedEventPayload {
  deviceId: string;
  timestamp: string; 
}
export interface DataChangedEventPayload {
  source: string; 
  entityType?: EntityType;
  entityId?: string; 
  userId?: string; 
  correlationId?: string;
  timestamp?: string; 
  data?: Record<string, unknown>;
}
declare module 'socket.io-client' {
  interface Socket {
    on(event: 'connected', listener: (data: ConnectedEventPayload) => void): this;
    on(event: 'connect', listener: () => void): this;
    on(event: 'disconnect', listener: (reason: string) => void): this;
    on(event: 'connect_error', listener: (error: Error) => void): this;
    on(event: 'reconnect_attempt', listener: (attemptNumber: number) => void): this;
    on(event: 'reconnect', listener: (attemptNumber: number) => void): this;
    on(event: 'reconnect_failed', listener: () => void): this;
    on(event: 'error', listener: (error: Error) => void): this;
    on(event: 'ping', listener: () => void): this;
    on(event: 'pong', listener: () => void): this;
    on(event: 'error', listener: (data: ErrorEventPayload) => void): this;
    on(event: 'consumption.created', listener: (data: RealtimeEnvelopeV1) => void): this;
    on(event: 'consumption.updated', listener: (data: RealtimeEnvelopeV1) => void): this;
    on(event: 'consumption.deleted', listener: (data: RealtimeEnvelopeV1) => void): this;
    on(event: 'session.created', listener: (data: RealtimeEnvelopeV1) => void): this;
    on(event: 'session.updated', listener: (data: RealtimeEnvelopeV1) => void): this;
    on(event: 'session.completed', listener: (data: RealtimeEnvelopeV1) => void): this;
    on(event: 'journal.created', listener: (data: RealtimeEnvelopeV1) => void): this;
    on(event: 'journal.updated', listener: (data: RealtimeEnvelopeV1) => void): this;
    on(event: 'journal.deleted', listener: (data: RealtimeEnvelopeV1) => void): this;
    on(event: 'user.updated', listener: (data: RealtimeEnvelopeV1) => void): this;
    on(event: 'user.preferences.updated', listener: (data: RealtimeEnvelopeV1) => void): this;
    on(event: 'goal.created', listener: (data: RealtimeEnvelopeV1) => void): this;
    on(event: 'goal.updated', listener: (data: RealtimeEnvelopeV1) => void): this;
    on(event: 'goal.deleted', listener: (data: RealtimeEnvelopeV1) => void): this;
    on(event: 'goal.progress.updated', listener: (data: RealtimeEnvelopeV1) => void): this;
    on(event: 'achievement.unlocked', listener: (data: RealtimeEnvelopeV1) => void): this;
    on(event: 'inventory.updated', listener: (data: RealtimeEnvelopeV1) => void): this;
    on(event: 'purchase.created', listener: (data: RealtimeEnvelopeV1) => void): this;
    on(event: 'sync.conflict.detected', listener: (data: RealtimeEnvelopeV1) => void): this;
    on(event: 'sync.completed', listener: (data: RealtimeEnvelopeV1) => void): this;
    on(event: 'session:started', listener: (data: SessionStartedEventPayload) => void): this;
    on(event: 'session:joined', listener: (data: SessionJoinedEventPayload) => void): this;
    on(event: 'session:updated', listener: (data: SessionUpdatedEventPayload) => void): this;
    on(event: 'session:ended', listener: (data: SessionEndedEventPayload) => void): this;
    on(event: 'participant:joined', listener: (data: ParticipantJoinedEventPayload) => void): this;
    on(event: 'participant:left', listener: (data: ParticipantLeftEventPayload) => void): this;
    on(event: 'participant:status', listener: (data: ParticipantStatusEventPayload) => void): this;
    on(event: 'consumption:update', listener: (data: ConsumptionUpdateEventPayload) => void): this;
    on(event: 'consumption:synced', listener: (data: ConsumptionSyncedEventPayload) => void): this;
    on(event: 'consumption:rate', listener: (data: ConsumptionRateEventPayload) => void): this;
    on(event: 'message:new', listener: (data: MessageNewEventPayload) => void): this;
    on(event: 'user:typing', listener: (data: UserTypingEventPayload) => void): this;
    on(event: 'reaction:new', listener: (data: ReactionNewEventPayload) => void): this;
    on(event: 'sync:required', listener: (data: SyncRequiredEventPayload) => void): this;
    on(event: 'sync:initiated', listener: (data: SyncInitiatedEventPayload) => void): this;
    on(event: 'sync:data', listener: (data: SyncDataEventPayload) => void): this;
    on(event: 'sync:pushed', listener: (data: SyncPushedEventPayload) => void): this;
    on(event: 'device:disconnected', listener: (data: DeviceDisconnectedEventPayload) => void): this;
    on(event: string, listener: (...args: unknown[]) => void): this;
  }
}
export {};
