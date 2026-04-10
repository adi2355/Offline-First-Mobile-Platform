import {
  FrontendSyncHandlerRegistry,
  type SyncLogger,
} from './handlers';
import { type IdMappingLookup } from './utils';
import {
  SyncHandlerFactory,
  createRepositoryFactory,
  getCurrentMigrationFlags,
  type GenericHandlerFeatureFlags,
} from './SyncHandlerFactory';
import type { DatabaseManager } from '../../DatabaseManager';
import type { LocalSessionRepository } from '../../repositories/LocalSessionRepository';
import type { LocalJournalRepository } from '../../repositories/LocalJournalRepository';
import type { LocalDeviceRepository } from '../../repositories/LocalDeviceRepository';
import type { LocalProductRepository } from '../../repositories/LocalProductRepository';
export interface SyncHandlerRegistryDependencies {
  databaseManager: DatabaseManager;
  localSessionRepository: LocalSessionRepository;
  localJournalRepository: LocalJournalRepository;
  localDeviceRepository: LocalDeviceRepository;
  localProductRepository: LocalProductRepository;
  logger?: SyncLogger;
  idMappingLookup?: IdMappingLookup;
  featureFlags?: Partial<GenericHandlerFeatureFlags>;
}
export function createSyncHandlerRegistry(
  deps: SyncHandlerRegistryDependencies
): FrontendSyncHandlerRegistry {
  const {
    databaseManager,
    logger,
    featureFlags,
    idMappingLookup,
  } = deps;
  const db = databaseManager.getMainDatabaseSync();
  const repositoryFactory = createRepositoryFactory(db);
  const factory = new SyncHandlerFactory({
    database: db,
    logger,
    featureFlags: {
      ...getCurrentMigrationFlags(),
      ...featureFlags, 
    },
    repositoryFactory,
    idMappingLookup,
  });
  const registry = factory.createPopulatedRegistry();
  logger?.info('[createSyncHandlerRegistry] Registry created with GenericSyncHandler', {
    handlerCount: registry.getRegisteredEntityTypes().length,
    handlers: registry.getRegisteredEntityTypes(),
    allGeneric: true,
  });
  return registry;
}
export function isUsingGenericSyncHandlers(): boolean {
  return true;
}
