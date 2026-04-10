import { EntityType } from '../../../repositories/offline';
import { FrontendSyncEntityHandler, isFrontendSyncEntityHandler } from './FrontendSyncEntityHandler';
import { logger } from '../../../utils/logger';
export class FrontendSyncHandlerRegistry {
  private readonly handlers: Map<EntityType, FrontendSyncEntityHandler<unknown>>;
  constructor() {
    this.handlers = new Map<EntityType, FrontendSyncEntityHandler<unknown>>();
  }
  register<T>(handler: FrontendSyncEntityHandler<T>): void {
    if (!isFrontendSyncEntityHandler(handler)) {
      throw new Error(
        `Invalid handler: Must implement FrontendSyncEntityHandler interface (entity type: ${String(handler)})`,
      );
    }
    const {entityType} = handler;
    if (this.handlers.has(entityType)) {
      throw new Error(
        `Handler already registered for entity type: ${entityType}. ` +
        'Each entity type can only have one handler.',
      );
    }
    this.handlers.set(entityType, handler as FrontendSyncEntityHandler<unknown>);
    logger.debug(`[FrontendSyncHandlerRegistry] Registered handler for ${entityType}`, {
      entityType,
      handlerClass: handler.constructor.name,
    });
  }
  get<T>(entityType: EntityType): FrontendSyncEntityHandler<T> | undefined {
    return this.handlers.get(entityType) as FrontendSyncEntityHandler<T> | undefined;
  }
  has(entityType: EntityType): boolean {
    return this.handlers.has(entityType);
  }
  getRegisteredEntityTypes(): EntityType[] {
    return Array.from(this.handlers.keys());
  }
  size(): number {
    return this.handlers.size;
  }
  clear(): void {
    this.handlers.clear();
    logger.debug('[FrontendSyncHandlerRegistry] All handlers cleared');
  }
}
