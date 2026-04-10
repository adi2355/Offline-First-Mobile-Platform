import type { SyncLeaseDecision, SyncLeaseKind, SyncLease } from '@shared/contracts';
import { BackendAPIClient } from '../api/BackendAPIClient';
import { logger } from '../../utils/logger';
export class SyncLeaseDeniedError extends Error {
  public readonly retryAfterMs?: number;
  public readonly reason?: string;
  constructor(message: string, retryAfterMs?: number, reason?: string) {
    super(message);
    this.name = 'SyncLeaseDeniedError';
    this.retryAfterMs = retryAfterMs;
    this.reason = reason;
  }
}
interface CachedLease {
  lease: SyncLease;
  usedRequests: number;
  expiresAtMs: number;
}
export class SyncLeaseManager {
  private readonly apiClient: BackendAPIClient;
  private readonly now: () => number;
  private readonly leases = new Map<SyncLeaseKind, CachedLease>();
  private readonly inFlight = new Map<SyncLeaseKind, Promise<CachedLease>>();
  private static readonly EXPIRY_SKEW_MS = 30_000;
  constructor(apiClient?: BackendAPIClient, now?: () => number) {
    this.apiClient = apiClient ?? BackendAPIClient.getInstance();
    this.now = now ?? (() => Date.now());
  }
  public invalidateLease(kind: SyncLeaseKind, reason?: string): void {
    if (this.leases.delete(kind)) {
      logger.info('[SyncLeaseManager] Lease invalidated', { kind, reason });
    }
  }
  public async getLeaseId(params: {
    kind: SyncLeaseKind;
    requestedBatchSize?: number;
    requestedMaxRequests?: number;
  }): Promise<string> {
    const cached = this.leases.get(params.kind);
    if (cached && this.isLeaseUsable(cached)) {
      cached.usedRequests += 1;
      return cached.lease.leaseId;
    }
    const lease = await this.requestLease(params);
    lease.usedRequests += 1;
    return lease.lease.leaseId;
  }
  private isLeaseUsable(cached: CachedLease): boolean {
    if (cached.usedRequests >= cached.lease.maxRequests) {
      return false;
    }
    return this.now() < cached.expiresAtMs - SyncLeaseManager.EXPIRY_SKEW_MS;
  }
  private async requestLease(params: {
    kind: SyncLeaseKind;
    requestedBatchSize?: number;
    requestedMaxRequests?: number;
  }): Promise<CachedLease> {
    const existing = this.inFlight.get(params.kind);
    if (existing) {
      return existing;
    }
    const requestPromise = this.doRequestLease(params)
      .finally(() => {
        this.inFlight.delete(params.kind);
      });
    this.inFlight.set(params.kind, requestPromise);
    return requestPromise;
  }
  private async doRequestLease(params: {
    kind: SyncLeaseKind;
    requestedBatchSize?: number;
    requestedMaxRequests?: number;
  }): Promise<CachedLease> {
    const response = await this.apiClient.post<SyncLeaseDecision>('/sync/lease', {
      kind: params.kind,
      ...(params.requestedBatchSize ? { requestedBatchSize: params.requestedBatchSize } : {}),
      ...(params.requestedMaxRequests ? { requestedMaxRequests: params.requestedMaxRequests } : {}),
    });
    const decision = response.data;
    if (decision.status !== 'GRANTED' || !decision.lease) {
      logger.warn('[SyncLeaseManager] Lease denied', {
        kind: params.kind,
        reason: decision.reason,
        retryAfterMs: decision.retryAfterMs,
      });
      throw new SyncLeaseDeniedError(
        'Sync lease denied by server',
        decision.retryAfterMs,
        decision.reason,
      );
    }
    const lease = decision.lease;
    const expiresAtMs = new Date(lease.expiresAt).getTime();
    const cached: CachedLease = {
      lease,
      usedRequests: 0,
      expiresAtMs,
    };
    this.leases.set(params.kind, cached);
    logger.info('[SyncLeaseManager] Lease granted', {
      kind: lease.kind,
      leaseId: lease.leaseId,
      expiresAt: lease.expiresAt,
      maxRequests: lease.maxRequests,
    });
    return cached;
  }
}
