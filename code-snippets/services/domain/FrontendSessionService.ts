import { v4 as uuidv4 } from 'uuid';
import {
  LocalSessionRepository,
  CreateSessionInput,
  UpdateSessionInput,
  LocalSession,
  SessionDrizzleTransaction,
} from '../../repositories/LocalSessionRepository';
import {
  OutboxRepository,
  OutboxCommand,
} from '../../repositories/offline/OutboxRepository';
import { Session, SessionStatus } from '../../types';
import { dataChangeEmitter, dbEvents } from '../../utils/EventEmitter';
import { logger } from '../../utils/logger';
import {
  computeSessionEndTimestamp,
  computeSessionUpdateForHit,
  isHitWithinSessionWindow,
  resolveSessionEndTimestamp,
} from '../../utils/sessionWindow';
export interface FrontendSessionServiceConfig {
  staleSessionThresholdHours?: number;
  autoCleanupStaleSessions?: boolean;
}
export interface StartSessionResult {
  session: LocalSession;
  isNewSession: boolean;
}
export interface StartSessionOptions {
  timestamp?: string;
  initialHitDurationMs?: number;
  initialHitCount?: number;
  clientSessionId?: string;
}
export const SessionEvents = {
  SESSION_STARTED: 'SESSION_STARTED',
  SESSION_ENDED: 'SESSION_ENDED',
  SESSION_UPDATED: 'SESSION_UPDATED',
  STALE_SESSIONS_CLEANED: 'STALE_SESSIONS_CLEANED',
} as const;
const DEFAULT_CONFIG: Required<FrontendSessionServiceConfig> = {
  staleSessionThresholdHours: 1, 
  autoCleanupStaleSessions: true,
};
export class FrontendSessionService {
  private readonly config: Required<FrontendSessionServiceConfig>;
  private initialized: boolean = false;
  constructor(
    private readonly localRepo: LocalSessionRepository,
    private readonly outboxRepo: OutboxRepository,
    config?: FrontendSessionServiceConfig
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }
  async initialize(userId: string): Promise<void> {
    if (this.initialized) {
      logger.debug('[FrontendSessionService] Already initialized, skipping');
      return;
    }
    logger.info('[FrontendSessionService] Initializing session service', {
      userId,
      config: this.config,
    });
    try {
      if (this.config.autoCleanupStaleSessions) {
        await this.cleanupStaleSessions(userId);
      }
      this.initialized = true;
      logger.info('[FrontendSessionService] Initialization complete');
    } catch (error) {
      logger.error('[FrontendSessionService] Initialization failed', {
        error: error instanceof Error 
          ? { name: error.name, message: error.message, stack: error.stack }
          : { name: 'UnknownError', message: String(error) },
      });
    }
  }
  async startSession(
    userId: string,
    primaryProductId?: string,
    options?: StartSessionOptions
  ): Promise<StartSessionResult> {
    const sessionStartTime = options?.timestamp ?? new Date().toISOString();
    const clientSessionId = options?.clientSessionId;
    if (options?.initialHitDurationMs !== undefined && options.initialHitDurationMs < 0) {
      throw new Error('[FrontendSessionService] initialHitDurationMs must be >= 0');
    }
    if (options?.initialHitCount !== undefined && options.initialHitCount < 0) {
      throw new Error('[FrontendSessionService] initialHitCount must be >= 0');
    }
    if (clientSessionId) {
      const existingByClientId = await this.localRepo.getById(clientSessionId);
      if (existingByClientId) {
        logger.info('[FrontendSessionService] Session already exists for clientSessionId', {
          sessionId: existingByClientId.id,
          clientSessionId,
        });
        return { session: existingByClientId, isNewSession: false };
      }
    }
    const existingSession = await this.localRepo.getActiveSession(userId);
    if (existingSession && isHitWithinSessionWindow(existingSession, sessionStartTime)) {
      logger.info('[FrontendSessionService] Active session already exists', {
        sessionId: existingSession.id,
        userId,
      });
      return { session: existingSession, isNewSession: false };
    }
    const sessionId = uuidv4();
    const sessionEndTime = computeSessionEndTimestamp(sessionStartTime);
    const initialHitCount = options?.initialHitCount
      ?? (options?.initialHitDurationMs !== undefined ? 1 : 0);
    const totalDurationMs = options?.initialHitDurationMs ?? 0;
    const avgHitDurationMs = initialHitCount > 0
      ? Math.round(totalDurationMs / initialHitCount)
      : 0;
    const sessionInput: CreateSessionInput = {
      id: sessionId,
      userId,
      clientSessionId: clientSessionId ?? sessionId,
      primaryProductId: primaryProductId || null,
      sessionStartTimestamp: sessionStartTime,
      sessionEndTimestamp: sessionEndTime, 
      status: SessionStatus.ACTIVE,
      hitCount: initialHitCount,
      totalDurationMs,
      avgHitDurationMs,
    };
    try {
      const session = await this.localRepo.runTransaction(async (tx: SessionDrizzleTransaction) => {
        const createdSession = await this.localRepo.create(sessionInput, tx);
        const command: OutboxCommand = {
          userId,
          aggregateType: 'Session',
          aggregateId: sessionId,
          eventType: 'CREATE',
          payload: {
            clientSessionId: clientSessionId ?? sessionId,
            sessionStartTimestamp: sessionStartTime,
            sessionEndTimestamp: sessionEndTime, 
            primaryProductId: primaryProductId || null,
            hitCount: createdSession.hitCount,
            totalDurationMs: createdSession.totalDurationMs,
            avgHitDurationMs: createdSession.avgHitDurationMs,
            status: createdSession.status, 
            version: createdSession.syncVersion,
          },
        };
        await this.outboxRepo.enqueue(command, tx);
        return createdSession;
      });
      this.emitDataChanged(SessionEvents.SESSION_STARTED, sessionId);
      logger.info('[FrontendSessionService] Session started locally', {
        sessionId,
        userId,
        primaryProductId,
        startTime: sessionStartTime,
      });
      return { session, isNewSession: true };
    } catch (error) {
      logger.error('[FrontendSessionService] Failed to start session', {
        userId,
        error: error instanceof Error 
          ? { name: error.name, message: error.message, stack: error.stack }
          : { name: 'UnknownError', message: String(error) },
      });
      throw error;
    }
  }
  async endSession(sessionId: string, timestamp?: string): Promise<void> {
    const session = await this.localRepo.getById(sessionId);
    if (!session) {
      logger.warn('[FrontendSessionService] Session not found for ending', {
        sessionId,
      });
      return;
    }
    if (session.status === SessionStatus.COMPLETED) {
      logger.debug('[FrontendSessionService] Session already ended', {
        sessionId,
      });
      return;
    }
    const endTimeIso = timestamp || new Date().toISOString();
    const startTime = new Date(session.sessionStartTimestamp).getTime();
    const endTime = new Date(endTimeIso).getTime();
    const totalDurationMs = endTime - startTime;
    const nextSyncVersion = (session.syncVersion ?? 1) + 1;
    const updates: UpdateSessionInput = {
      sessionEndTimestamp: endTimeIso,
      status: SessionStatus.COMPLETED,
      totalDurationMs,
    };
    if (session.hitCount > 0) {
      updates.avgHitDurationMs = Math.round(totalDurationMs / session.hitCount);
    }
    try {
      await this.localRepo.runTransaction(async (tx: SessionDrizzleTransaction) => {
        await this.localRepo.update(sessionId, updates, tx);
        const command: OutboxCommand = {
          userId: session.userId,
          aggregateType: 'Session',
          aggregateId: sessionId,
          eventType: 'UPDATE',
          payload: {
            sessionStartTimestamp: session.sessionStartTimestamp, 
            sessionEndTimestamp: endTimeIso,
            status: SessionStatus.COMPLETED,
            totalDurationMs,
            avgHitDurationMs: updates.avgHitDurationMs,
            hitCount: session.hitCount, 
            version: nextSyncVersion,
          },
        };
        await this.outboxRepo.enqueue(command, tx);
      });
      this.emitDataChanged(SessionEvents.SESSION_ENDED, sessionId);
      logger.info('[FrontendSessionService] Session ended locally', {
        sessionId,
        totalDurationMs,
        hitCount: session.hitCount,
      });
    } catch (error) {
      logger.error('[FrontendSessionService] Failed to end session', {
        sessionId,
        error: error instanceof Error 
          ? { name: error.name, message: error.message, stack: error.stack }
          : { name: 'UnknownError', message: String(error) },
      });
      throw error;
    }
  }
  async pauseSession(sessionId: string): Promise<void> {
    const session = await this.localRepo.getById(sessionId);
    if (!session) {
      logger.warn('[FrontendSessionService] Session not found for pausing', {
        sessionId,
      });
      return;
    }
    if (session.status !== SessionStatus.ACTIVE) {
      logger.debug('[FrontendSessionService] Session not active, cannot pause', {
        sessionId,
        currentStatus: session.status,
      });
      return;
    }
    const now = new Date().toISOString();
    const nextSyncVersion = (session.syncVersion ?? 1) + 1;
    try {
      await this.localRepo.runTransaction(async (tx: SessionDrizzleTransaction) => {
        await this.localRepo.update(sessionId, {
          status: SessionStatus.PAUSED,
        }, tx);
        const command: OutboxCommand = {
          userId: session.userId,
          aggregateType: 'Session',
          aggregateId: sessionId,
          eventType: 'UPDATE',
          payload: {
            sessionStartTimestamp: session.sessionStartTimestamp, 
            status: SessionStatus.PAUSED,
            updatedAt: now,
            version: nextSyncVersion,
          },
        };
        await this.outboxRepo.enqueue(command, tx);
      });
      this.emitDataChanged(SessionEvents.SESSION_UPDATED, sessionId);
      logger.info('[FrontendSessionService] Session paused', { sessionId });
    } catch (error) {
      logger.error('[FrontendSessionService] Failed to pause session', {
        sessionId,
        error: error instanceof Error 
          ? { name: error.name, message: error.message, stack: error.stack }
          : { name: 'UnknownError', message: String(error) },
      });
      throw error;
    }
  }
  async resumeSession(sessionId: string): Promise<void> {
    const session = await this.localRepo.getById(sessionId);
    if (!session) {
      logger.warn('[FrontendSessionService] Session not found for resuming', {
        sessionId,
      });
      return;
    }
    if (session.status !== SessionStatus.PAUSED) {
      logger.debug('[FrontendSessionService] Session not paused, cannot resume', {
        sessionId,
        currentStatus: session.status,
      });
      return;
    }
    const now = new Date().toISOString();
    const nextSyncVersion = (session.syncVersion ?? 1) + 1;
    try {
      await this.localRepo.runTransaction(async (tx: SessionDrizzleTransaction) => {
        await this.localRepo.update(sessionId, {
          status: SessionStatus.ACTIVE,
        }, tx);
        const command: OutboxCommand = {
          userId: session.userId,
          aggregateType: 'Session',
          aggregateId: sessionId,
          eventType: 'UPDATE',
          payload: {
            sessionStartTimestamp: session.sessionStartTimestamp, 
            status: SessionStatus.ACTIVE,
            updatedAt: now,
            version: nextSyncVersion,
          },
        };
        await this.outboxRepo.enqueue(command, tx);
      });
      this.emitDataChanged(SessionEvents.SESSION_UPDATED, sessionId);
      logger.info('[FrontendSessionService] Session resumed', { sessionId });
    } catch (error) {
      logger.error('[FrontendSessionService] Failed to resume session', {
        sessionId,
        error: error instanceof Error 
          ? { name: error.name, message: error.message, stack: error.stack }
          : { name: 'UnknownError', message: String(error) },
      });
      throw error;
    }
  }
  async recordHit(
    sessionId: string,
    timestamp: string,
    durationMs: number,
    options?: { incrementBy?: number; primaryProductId?: string | null }
  ): Promise<void> {
    const incrementBy = options?.incrementBy ?? 1;
    try {
      await this.localRepo.runTransaction(async (tx: SessionDrizzleTransaction) => {
        const session = await this.localRepo.getById(sessionId);
        if (!session) {
          throw new Error(`[FrontendSessionService] Session not found for hit: ${sessionId}`);
        }
        const update = computeSessionUpdateForHit(
          {
            sessionStartTimestamp: session.sessionStartTimestamp,
            sessionEndTimestamp: session.sessionEndTimestamp,
            hitCount: session.hitCount,
            totalDurationMs: session.totalDurationMs,
          },
          { timestamp, durationMs },
          { incrementBy }
        );
        const updateFields: UpdateSessionInput = {
          sessionStartTimestamp: update.sessionStartTimestamp,
          sessionEndTimestamp: update.sessionEndTimestamp,
          hitCount: update.hitCount,
          totalDurationMs: update.totalDurationMs,
          avgHitDurationMs: update.avgHitDurationMs,
        };
        if (options?.primaryProductId && !session.primaryProductId) {
          updateFields.primaryProductId = options.primaryProductId;
        }
        await this.localRepo.update(sessionId, updateFields, tx);
        const nextSyncVersion = (session.syncVersion ?? 1) + 1;
        const payload: Record<string, unknown> = {
          sessionStartTimestamp: update.sessionStartTimestamp, 
          sessionEndTimestamp: update.sessionEndTimestamp,
          hitCount: update.hitCount,
          totalDurationMs: update.totalDurationMs,
          avgHitDurationMs: update.avgHitDurationMs,
          updatedAt: new Date().toISOString(),
          version: nextSyncVersion,
        };
        if (updateFields.primaryProductId !== undefined) {
          payload.primaryProductId = updateFields.primaryProductId;
        }
        const command: OutboxCommand = {
          userId: session.userId,
          aggregateType: 'Session',
          aggregateId: sessionId,
          eventType: 'UPDATE',
          payload,
        };
        await this.outboxRepo.enqueue(command, tx);
      });
      this.emitDataChanged(SessionEvents.SESSION_UPDATED, sessionId);
      logger.debug('[FrontendSessionService] Hit recorded and session extended', {
        sessionId,
        timestamp,
        incrementBy,
      });
    } catch (error) {
      logger.error('[FrontendSessionService] Failed to record hit', {
        sessionId,
        error: error instanceof Error 
          ? { name: error.name, message: error.message, stack: error.stack }
          : { name: 'UnknownError', message: String(error) },
      });
      throw error;
    }
  }
  async updateNotes(sessionId: string, notes: string): Promise<void> {
    const session = await this.localRepo.getById(sessionId);
    if (!session) {
      logger.warn('[FrontendSessionService] Session not found for notes update', { sessionId });
      return;
    }
    const nextSyncVersion = (session.syncVersion ?? 1) + 1;
    try {
      await this.localRepo.runTransaction(async (tx: SessionDrizzleTransaction) => {
        await this.localRepo.update(sessionId, { notes }, tx);
        const command: OutboxCommand = {
          userId: session.userId,
          aggregateType: 'Session',
          aggregateId: sessionId,
          eventType: 'UPDATE',
          payload: {
            sessionStartTimestamp: session.sessionStartTimestamp, 
            notes,
            updatedAt: new Date().toISOString(),
            version: nextSyncVersion,
          },
        };
        await this.outboxRepo.enqueue(command, tx);
      });
      this.emitDataChanged(SessionEvents.SESSION_UPDATED, sessionId);
      logger.debug('[FrontendSessionService] Notes updated', { sessionId });
    } catch (error) {
      logger.error('[FrontendSessionService] Failed to update notes', {
        sessionId,
        error: error instanceof Error 
          ? { name: error.name, message: error.message, stack: error.stack }
          : { name: 'UnknownError', message: String(error) },
      });
      throw error;
    }
  }
  async updatePrimaryProduct(
    sessionId: string,
    productId: string | null
  ): Promise<void> {
    const session = await this.localRepo.getById(sessionId);
    if (!session) {
      logger.warn('[FrontendSessionService] Session not found for primary product update', { sessionId });
      return;
    }
    const nextSyncVersion = (session.syncVersion ?? 1) + 1;
    try {
      await this.localRepo.runTransaction(async (tx: SessionDrizzleTransaction) => {
        await this.localRepo.update(sessionId, { primaryProductId: productId }, tx);
        const command: OutboxCommand = {
          userId: session.userId,
          aggregateType: 'Session',
          aggregateId: sessionId,
          eventType: 'UPDATE',
          payload: {
            sessionStartTimestamp: session.sessionStartTimestamp, 
            primaryProductId: productId,
            updatedAt: new Date().toISOString(),
            version: nextSyncVersion,
          },
        };
        await this.outboxRepo.enqueue(command, tx);
      });
      this.emitDataChanged(SessionEvents.SESSION_UPDATED, sessionId);
      logger.debug('[FrontendSessionService] Primary product updated', {
        sessionId,
        productId,
      });
    } catch (error) {
      logger.error('[FrontendSessionService] Failed to update primary product', {
        sessionId,
        error: error instanceof Error 
          ? { name: error.name, message: error.message, stack: error.stack }
          : { name: 'UnknownError', message: String(error) },
      });
      throw error;
    }
  }
  async getActiveSession(userId: string): Promise<LocalSession | null> {
    return this.localRepo.getActiveSession(userId);
  }
  async getSession(sessionId: string): Promise<LocalSession | null> {
    return this.localRepo.getById(sessionId);
  }
  async findSessionForTimestamp(
    userId: string,
    hitTimestamp: string
  ): Promise<LocalSession | null> {
    return this.localRepo.findSessionByTimestamp(userId, hitTimestamp);
  }
  async getRecentSessions(
    userId: string,
    limit: number = 10
  ): Promise<LocalSession[]> {
    return this.localRepo.getRecentSessions(userId, limit);
  }
  async getSessionsByDateRange(
    userId: string,
    startDate: string,
    endDate: string
  ): Promise<LocalSession[]> {
    return this.localRepo.getSessionsByDateRange(userId, startDate, endDate);
  }
  async cleanupStaleSessions(userId: string): Promise<void> {
    const thresholdMs =
      this.config.staleSessionThresholdHours * 60 * 60 * 1000;
    const thresholdDate = new Date(Date.now() - thresholdMs).toISOString();
    logger.info('[FrontendSessionService] Checking for stale sessions', {
      userId,
      threshold: thresholdDate,
    });
    try {
      const staleSessions = await this.localRepo.getStaleActiveSessions(
        userId,
        thresholdDate
      );
      if (staleSessions.length === 0) {
        logger.debug('[FrontendSessionService] No stale sessions found');
        return;
      }
      logger.info('[FrontendSessionService] Found stale sessions to clean up', {
        count: staleSessions.length,
        sessionIds: staleSessions.map((s) => s.id),
      });
      for (const session of staleSessions) {
        const now = new Date().toISOString();
        const endTime = resolveSessionEndTimestamp(
          session.sessionStartTimestamp,
          session.sessionEndTimestamp ?? null
        );
        const totalDurationMs = session.totalDurationMs ?? 0;
        const avgHitDurationMs = session.hitCount > 0
          ? Math.round(totalDurationMs / session.hitCount)
          : (session.avgHitDurationMs ?? 0);
        const nextSyncVersion = (session.syncVersion ?? 1) + 1;
        await this.localRepo.runTransaction(async (tx: SessionDrizzleTransaction) => {
          await this.localRepo.update(session.id, {
            sessionEndTimestamp: endTime,
            status: SessionStatus.COMPLETED,
            totalDurationMs,
            avgHitDurationMs,
          }, tx);
          const command: OutboxCommand = {
            userId: session.userId,
            aggregateType: 'Session',
            aggregateId: session.id,
            eventType: 'UPDATE',
            payload: {
              sessionStartTimestamp: session.sessionStartTimestamp,
              sessionEndTimestamp: endTime,
              status: SessionStatus.COMPLETED,
              totalDurationMs,
              avgHitDurationMs,
              hitCount: session.hitCount,
              updatedAt: now,
              autoEnded: true,
              version: nextSyncVersion,
            },
          };
          await this.outboxRepo.enqueue(command, tx);
        });
        logger.info('[FrontendSessionService] Stale session cleaned up', {
          sessionId: session.id,
          startTime: session.sessionStartTimestamp,
        });
      }
      this.emitDataChanged(
        SessionEvents.STALE_SESSIONS_CLEANED,
        staleSessions.map((s) => s.id).join(',')
      );
    } catch (error) {
      logger.error('[FrontendSessionService] Failed to clean up stale sessions', {
        userId,
        error: error instanceof Error 
          ? { name: error.name, message: error.message, stack: error.stack }
          : { name: 'UnknownError', message: String(error) },
      });
    }
  }
  private emitDataChanged(source: string, entityId: string): void {
    dataChangeEmitter.emit(dbEvents.DATA_CHANGED, {
      source,
      entityId,
      entityType: 'sessions',
      timestamp: new Date().toISOString(),
    });
  }
  reset(): void {
    this.initialized = false;
  }
}
