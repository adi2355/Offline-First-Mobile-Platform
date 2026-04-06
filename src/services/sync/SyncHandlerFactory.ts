import { type SQLiteDatabase } from 'expo-sqlite';
import {
  ENTITY_TYPES,
  type EntityType,
  type MergeContext,
  type MergeResult,
  requiresCustomMerge,
} from '@shared/contracts';
import {
  FrontendSyncHandlerRegistry,
  FrontendSyncEntityHandler,
  GenericSyncHandler,
  type GenericSyncHandlerDependencies,
  type SyncLogger,
} from './handlers';
import { type SyncEntityRepository } from './repositories/SyncEntityRepository';
import {
  mergeSession,
  mergeConsumption,
  mergeProduct,
  mergeDevice,
  mergeJournalEntry,
  type SessionMergeData,
  type ConsumptionMergeData,
  type ProductMergeData,
  type DeviceMergeData,
  type JournalEntryMergeData,
  type IdMappingLookup,
} from './utils';
type CustomMergeEntityMap = {
  sessions: SessionMergeData;
  consumptions: ConsumptionMergeData;
  products: ProductMergeData;
  devices: DeviceMergeData;
  journal_entries: JournalEntryMergeData;
};
type CustomMergeEntityType = keyof CustomMergeEntityMap;
function isCustomMergeEntityType(entityType: EntityType): entityType is CustomMergeEntityType {
  return entityType in CUSTOM_MERGE_FUNCTIONS;
}
const CUSTOM_MERGE_FUNCTIONS: {
  [K in CustomMergeEntityType]: (
    local: CustomMergeEntityMap[K],
    server: CustomMergeEntityMap[K],
    context: MergeContext
  ) => MergeResult<CustomMergeEntityMap[K]>;
} = {
  sessions: mergeSession,
  consumptions: mergeConsumption,
  products: mergeProduct,
  devices: mergeDevice,
  journal_entries: mergeJournalEntry,
};
export interface GenericHandlerFeatureFlags {
  goals: boolean;
  journal_entries: boolean;
  products: boolean;
  devices: boolean;
  consumptions: boolean;
  sessions: boolean;
  purchases: boolean;
  inventory_items: boolean;
  ai_usage_records: boolean;
}
export const DEFAULT_FEATURE_FLAGS: Readonly<GenericHandlerFeatureFlags> = Object.freeze({
  goals: false,
  journal_entries: false,
  products: false,
  devices: false,
  consumptions: false,
  sessions: false,
  purchases: false,
  inventory_items: false,
  ai_usage_records: false,
});
function validateFeatureFlags(flags: GenericHandlerFeatureFlags): void {
  for (const entityType of ENTITY_TYPES) {
    if (!(entityType in flags)) {
      throw new Error(
        `[SyncHandlerFactory] Feature flags missing key for entity: ${entityType}`
      );
    }
    if (typeof flags[entityType as keyof GenericHandlerFeatureFlags] !== 'boolean') {
      throw new Error(
        `[SyncHandlerFactory] Feature flag for ${entityType} must be boolean`
      );
    }
  }
}
export interface SyncHandlerFactoryDependencies {
  database: SQLiteDatabase;
  logger?: SyncLogger;
  featureFlags?: Partial<GenericHandlerFeatureFlags>;
  repositoryFactory?: <T>(entityType: EntityType) => SyncEntityRepository<T>;
  idMappingLookup?: IdMappingLookup;
}
export type LegacyHandlerFactory<T> = () => FrontendSyncEntityHandler<T>;
export type LegacyHandlerFactories = Partial<{
  [K in EntityType]: LegacyHandlerFactory<unknown>;
}>;
export class SyncHandlerFactory {
  private readonly database: SQLiteDatabase;
  private readonly logger: SyncLogger;
  private readonly featureFlags: GenericHandlerFeatureFlags;
  private readonly repositoryFactory?: <T>(entityType: EntityType) => SyncEntityRepository<T>;
  private readonly idMappingLookup?: IdMappingLookup;
  private readonly legacyFactories: LegacyHandlerFactories = {};
  constructor(deps: SyncHandlerFactoryDependencies) {
    if (!deps.database) {
      throw new Error('[SyncHandlerFactory] database is required');
    }
    this.database = deps.database;
    this.repositoryFactory = deps.repositoryFactory;
    this.idMappingLookup = deps.idMappingLookup;
    if (!deps.logger) {
      const isTestEnv =
        typeof process !== 'undefined' &&
        (process.env.NODE_ENV === 'test' || process.env.JEST_WORKER_ID !== undefined);
      if (!isTestEnv) {
        console.warn(
          '[SyncHandlerFactory] WARNING: No logger provided. ' +
          'This can hide errors in production. ' +
          'Please provide a logger for observability.'
        );
      }
      this.logger = {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      };
    } else {
      this.logger = deps.logger;
    }
    this.featureFlags = {
      ...DEFAULT_FEATURE_FLAGS,
      ...deps.featureFlags,
    };
    validateFeatureFlags(this.featureFlags);
    this.logger.debug('[SyncHandlerFactory] Initialized', {
      enabledEntities: this.getEnabledEntities(),
      hasRepositoryFactory: !!this.repositoryFactory,
    });
  }
  registerLegacyFactory<T>(
    entityType: EntityType,
    factory: LegacyHandlerFactory<T>
  ): void {
    this.legacyFactories[entityType] = factory as LegacyHandlerFactory<unknown>;
    this.logger.debug('[SyncHandlerFactory] Registered legacy factory', {
      entityType,
    });
  }
  registerLegacyFactories(factories: LegacyHandlerFactories): void {
    for (const [entityType, factory] of Object.entries(factories)) {
      if (factory) {
        this.legacyFactories[entityType as EntityType] = factory;
      }
    }
    this.logger.debug('[SyncHandlerFactory] Registered legacy factories', {
      entityTypes: Object.keys(factories),
    });
  }
  isGenericEnabled(entityType: EntityType): boolean {
    return this.featureFlags[entityType as keyof GenericHandlerFeatureFlags] ?? false;
  }
  getEnabledEntities(): EntityType[] {
    return ENTITY_TYPES.filter((et) => this.isGenericEnabled(et));
  }
  getLegacyEntities(): EntityType[] {
    return ENTITY_TYPES.filter((et) => !this.isGenericEnabled(et));
  }
  createHandler<T extends Record<string, unknown>>(
    entityType: EntityType
  ): FrontendSyncEntityHandler<T> | undefined {
    const isGeneric = this.isGenericEnabled(entityType);
    if (isGeneric) {
      return this.createGenericHandler<T>(entityType);
    } else {
      return this.createLegacyHandler<T>(entityType);
    }
  }
  private createGenericHandler<T extends Record<string, unknown>>(
    entityType: EntityType
  ): GenericSyncHandler<T> | undefined {
    if (!this.repositoryFactory) {
      this.logger.warn(
        '[SyncHandlerFactory] Cannot create GenericSyncHandler: no repositoryFactory',
        { entityType }
      );
      return undefined;
    }
    const repository = this.repositoryFactory<T>(entityType);
    if (!repository) {
      this.logger.warn(
        '[SyncHandlerFactory] Repository factory returned undefined',
        { entityType }
      );
      return undefined;
    }
    const customMerge = this.getCustomMerge<T>(entityType);
    const deps: GenericSyncHandlerDependencies<T> = {
      entityType,
      repository,
      database: this.database,
      logger: this.logger,
      customMerge,
      idMappingLookup: this.idMappingLookup,
    };
    const handler = new GenericSyncHandler(deps);
    this.logger.info('[SyncHandlerFactory] Created GenericSyncHandler', {
      entityType,
      handlerType: 'GenericSyncHandler',
      hasCustomMerge: !!customMerge,
    });
    return handler;
  }
  private getCustomMerge<T extends Record<string, unknown>>(
    entityType: EntityType
  ): ((local: T, server: T, context: MergeContext) => MergeResult<T>) | undefined {
    if (!requiresCustomMerge(entityType)) {
      return undefined;
    }
    if (!isCustomMergeEntityType(entityType)) {
      this.logger.warn(
        '[SyncHandlerFactory] Entity requires custom merge but no function in registry',
        { entityType }
      );
      return undefined;
    }
    const mergeFn = CUSTOM_MERGE_FUNCTIONS[entityType];
    return mergeFn as unknown as (local: T, server: T, context: MergeContext) => MergeResult<T>;
  }
  private createLegacyHandler<T>(
    entityType: EntityType
  ): FrontendSyncEntityHandler<T> | undefined {
    const factory = this.legacyFactories[entityType];
    if (!factory) {
      this.logger.debug(
        '[SyncHandlerFactory] No legacy factory registered',
        { entityType }
      );
      return undefined;
    }
    const handler = factory() as FrontendSyncEntityHandler<T>;
    this.logger.info('[SyncHandlerFactory] Created legacy handler', {
      entityType,
      handlerType: handler.constructor.name,
    });
    return handler;
  }
  populateRegistry(registry: FrontendSyncHandlerRegistry): number {
    let count = 0;
    for (const entityType of ENTITY_TYPES) {
      const handler = this.createHandler(entityType);
      if (handler) {
        registry.register(handler);
        count++;
      }
    }
    this.logger.info('[SyncHandlerFactory] Populated registry', {
      totalEntityTypes: ENTITY_TYPES.length,
      handlersRegistered: count,
      genericEnabled: this.getEnabledEntities(),
      legacyUsed: this.getLegacyEntities().filter(
        (et) => this.legacyFactories[et] !== undefined
      ),
    });
    return count;
  }
  createPopulatedRegistry(): FrontendSyncHandlerRegistry {
    const registry = new FrontendSyncHandlerRegistry();
    this.populateRegistry(registry);
    return registry;
  }
}
export function createSyncHandlerFactory(
  deps: SyncHandlerFactoryDependencies
): SyncHandlerFactory {
  return new SyncHandlerFactory(deps);
}
export function mergeFeatureFlags(
  overrides: Partial<GenericHandlerFeatureFlags>
): GenericHandlerFeatureFlags {
  return {
    ...DEFAULT_FEATURE_FLAGS,
    ...overrides,
  };
}
export function allGenericEnabled(): GenericHandlerFeatureFlags {
  const flags: Partial<GenericHandlerFeatureFlags> = {};
  for (const entityType of ENTITY_TYPES) {
    flags[entityType as keyof GenericHandlerFeatureFlags] = true;
  }
  return flags as GenericHandlerFeatureFlags;
}
export function enableGenericFor(
  ...entityTypes: EntityType[]
): GenericHandlerFeatureFlags {
  const flags = { ...DEFAULT_FEATURE_FLAGS };
  for (const entityType of entityTypes) {
    if (entityType in flags) {
      flags[entityType as keyof GenericHandlerFeatureFlags] = true;
    }
  }
  return flags;
}
export const MIGRATION_PHASE_1_FLAGS: Readonly<GenericHandlerFeatureFlags> = Object.freeze({
  ...DEFAULT_FEATURE_FLAGS,
  ai_usage_records: true,
  goals: true,
  purchases: true,
  inventory_items: true,
});
export const MIGRATION_PHASE_2_FLAGS: Readonly<GenericHandlerFeatureFlags> = Object.freeze({
  ...MIGRATION_PHASE_1_FLAGS,
  journal_entries: true,
});
export const MIGRATION_PHASE_3_FLAGS: Readonly<GenericHandlerFeatureFlags> = Object.freeze({
  ...MIGRATION_PHASE_2_FLAGS,
  sessions: true,
  consumptions: true,
  products: true,
  devices: true,
});
export function getMigrationPhaseFlags(
  phase: 1 | 2 | 3
): Readonly<GenericHandlerFeatureFlags> {
  switch (phase) {
    case 1:
      return MIGRATION_PHASE_1_FLAGS;
    case 2:
      return MIGRATION_PHASE_2_FLAGS;
    case 3:
      return MIGRATION_PHASE_3_FLAGS;
    default:
      throw new Error(
        `[getMigrationPhaseFlags] Invalid phase: ${phase}. Use 1, 2, or 3.`
      );
  }
}
export const CURRENT_MIGRATION_PHASE: 0 | 1 | 2 | 3 = 3;
export function getCurrentMigrationFlags(): GenericHandlerFeatureFlags {
  if (CURRENT_MIGRATION_PHASE === 0) {
    return { ...DEFAULT_FEATURE_FLAGS };
  }
  return { ...getMigrationPhaseFlags(CURRENT_MIGRATION_PHASE) };
}
let repositoryAdapters: typeof import('./repositories') | null = null;
async function getRepositoryAdapters() {
  if (!repositoryAdapters) {
    repositoryAdapters = await import('./repositories');
  }
  return repositoryAdapters;
}
export function createRepositoryFactory(
  db: SQLiteDatabase
): <T>(entityType: EntityType) => SyncEntityRepository<T> {
  const adapterCache = new Map<EntityType, SyncEntityRepository<unknown>>();
  return <T>(entityType: EntityType): SyncEntityRepository<T> => {
    if (adapterCache.has(entityType)) {
      return adapterCache.get(entityType) as SyncEntityRepository<T>;
    }
    const repos = require('./repositories');
    let adapter: SyncEntityRepository<unknown>;
    switch (entityType) {
      case 'sessions':
        adapter = repos.createSessionSyncRepositoryAdapter(db);
        break;
      case 'goals':
        adapter = repos.createGoalSyncRepositoryAdapter(db);
        break;
      case 'journal_entries':
        adapter = repos.createJournalEntrySyncRepositoryAdapter(db);
        break;
      case 'purchases':
        adapter = repos.createPurchaseSyncRepositoryAdapter(db);
        break;
      case 'inventory_items':
        adapter = repos.createInventoryItemSyncRepositoryAdapter(db);
        break;
      case 'ai_usage_records':
        adapter = repos.createAIUsageRecordSyncRepositoryAdapter(db);
        break;
      case 'consumptions':
        adapter = repos.createConsumptionSyncRepositoryAdapter(db);
        break;
      case 'products':
        adapter = repos.createProductSyncRepositoryAdapter(db);
        break;
      case 'devices':
        adapter = repos.createDeviceSyncRepositoryAdapter(db);
        break;
      default:
        throw new Error(
          `[createRepositoryFactory] Unknown entity type: ${entityType}`
        );
    }
    adapterCache.set(entityType, adapter);
    return adapter as SyncEntityRepository<T>;
  };
}
