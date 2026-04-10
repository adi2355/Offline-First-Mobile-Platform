import React, { createContext, useContext, useEffect, useState, useRef, ReactNode } from 'react';
import { View, Text, ActivityIndicator, Platform, TouchableOpacity, AppState, type AppStateStatus } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { QueryClient } from '@tanstack/react-query';
import { QueryClientProvider } from '@tanstack/react-query';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { Persister } from '@tanstack/react-query-persist-client';
import Constants from 'expo-constants';
import { DatabaseManager, databaseManager } from '../DatabaseManager';
import { DeviceEventRepository } from '../repositories/DeviceEventRepository';
import { VariantsRepository } from '../repositories/VariantsRepository';
import { JournalRepository } from '../repositories/JournalRepository';
import { AISummariesRepository } from '../repositories/AISummariesRepository';
import { PurchaseRepository } from '../repositories/PurchaseRepository';
import { InventoryRepository } from '../repositories/InventoryRepository';
import { UserConsumptionProfileRepository } from '../repositories/UserConsumptionProfileRepository';
import { DailyStatsRepository } from '../repositories/DailyStatsRepository';
import { SessionRepository } from '../repositories/SessionRepository';
import { DeviceRepository } from '../repositories/DeviceRepository';
import { ConsumptionRepository } from '../repositories/ConsumptionRepository';
import { UserConsumptionRepository } from '../repositories/UserConsumptionRepository';
import { UserProfilingAPIClient } from '../repositories/UserProfilingAPIClient';
import { UserRepository } from '../repositories/UserRepository';
import { BackendAPIClient } from '../services/api/BackendAPIClient';
import { StorageService } from '../services/StorageService';
import { secureStorage, DataSensitivity } from '../services/SecureStorageService';
import { DeviceService } from '../services/DeviceService';
import { BluetoothService } from '../services/BluetoothService';
import { AppSetupService } from '../services/AppSetupService';
import { UsageLearningService } from '../services/UsageLearningService';
import { EventForecastingService } from '../services/EventForecastingService';
import { InventoryPredictionService } from '../services/InventoryPredictionService';
import { AIService } from '../services/ai/AIService';
import { DataSyncService } from '../services/sync/DataSyncService';
import {
  HealthSyncService,
  createHealthKitAdapter,
  createHealthUploadHttpClient,
  getHealthKitMetricConfigs,
  type HealthPermissionStatus,
} from '../services/health';
import { FrontendConsumptionService } from '../services/domain/FrontendConsumptionService';
import { WebSocketClient } from '../services/realtime/WebSocketClient';
import { BleNotificationCoordinator } from '../services/BleNotificationCoordinator';
import { localNotificationService } from '../services/LocalNotificationService';
import { BLERestorationService } from '../services/BLERestorationService';
import { wipeKeychain, isKeychainWipeAvailable } from '../services/native/KeychainWipeService';
import { wipeAllLocalStorageNative, isFactoryResetAvailable } from '../services/native/FactoryResetService';
import { createSyncHandlerRegistry } from '../services/sync/createSyncHandlerRegistry';
import { LocalProductRepository } from '../repositories/LocalProductRepository';
import { LocalDailyStatsRepository } from '../repositories/LocalDailyStatsRepository';
import { FrontendProductService } from '../services/domain/FrontendProductService';
import { LocalDeviceRepository } from '../repositories/LocalDeviceRepository';
import { LocalSessionRepository } from '../repositories/LocalSessionRepository';
import { LocalJournalRepository } from '../repositories/LocalJournalRepository';
import { LocalJournalEffectsRepository } from '../repositories/LocalJournalEffectsRepository';
import { FrontendSessionService } from '../services/domain/FrontendSessionService';
import { FrontendJournalService } from '../services/domain/FrontendJournalService';
import { ActivePurchaseResolver } from '../services/domain/ActivePurchaseResolver';
import { ActiveProductService } from '../services/domain/ActiveProductService';
import { ProductSearchService } from '../services/domain/ProductSearchService';
import { CatalogStateService } from '../services/domain/CatalogStateService';
import { ProductCatalogCoordinator, createProductCatalogCoordinator } from '../services/domain/ProductCatalogCoordinator';
import {
  OutboxRepository,
  CursorRepository,
  IdMapRepository,
  TombstoneRepository,
} from '../repositories/offline';
import { initializeQueryClient } from '../config/queryClient';
import { DEVICE_HITS_DATABASE_NAME } from '../constants';
import { BluetoothHandler } from '../contexts/BluetoothContext';
import { DeviceIdManager } from '../utils/DeviceIdManager';
import { initializeWithConnection } from '../db/client';
import { dataChangeEmitter, dbEvents } from '../utils/EventEmitter';
import { logger } from '../utils/logger';
import { initializeFeatureFlags, isFeatureEnabled } from '../config/featureFlags';
import { metrics } from '../services/metrics/Metrics';
import { StartupOrchestrator, StartupPhase, type StartupAppState } from '../services/startup/StartupOrchestrator';
import { createMainThreadBlockMonitor, trackStartupMainThreadBlock, type MainThreadBlockStats } from '../services/startup/StartupMetrics';
import { SyncScheduler } from '../services/sync/SyncScheduler';
import { SyncLeaseManager } from '../services/sync/SyncLeaseManager';
import { HealthProjectionRefreshService } from '../services/health/HealthProjectionRefreshService';
import { HealthProjectionHydrationClient } from '../services/health/HealthProjectionHydrationClient';
import { LocalHealthRollupRepository } from '../repositories/health/LocalHealthRollupRepository';
import { LocalSleepNightSummaryRepository } from '../repositories/health/LocalSleepNightSummaryRepository';
import { LocalSessionImpactRepository } from '../repositories/health/LocalSessionImpactRepository';
import { LocalProductImpactRepository } from '../repositories/health/LocalProductImpactRepository';
import { LocalHealthInsightRepository } from '../repositories/health/LocalHealthInsightRepository';
import { LocalRollupDirtyKeyRepository } from '../repositories/health/LocalRollupDirtyKeyRepository';
import { LocalSleepDirtyNightRepository } from '../repositories/health/LocalSleepDirtyNightRepository';
import { CachedNetworkStatus } from '../utils/CachedNetworkStatus';
interface AppContextType {
  databaseManager: DatabaseManager;
  queryClient: QueryClient;
  queryPersister: Persister;
  queryUnsubscribe: () => void;
  apiClient: BackendAPIClient; 
  deviceRepository: DeviceRepository;
  consumptionRepository: ConsumptionRepository;
  inventoryRepository: InventoryRepository;
  userConsumptionRepository: UserConsumptionRepository;
  userProfilingClient: UserProfilingAPIClient;
  userRepository: UserRepository;
  deviceEventsRepository: DeviceEventRepository;
  strainsRepository: VariantsRepository;
  journalRepository: JournalRepository;
  aiSummariesRepository: AISummariesRepository;
  purchaseRepository: PurchaseRepository;
  userConsumptionProfileRepository: UserConsumptionProfileRepository;
  dailyStatsRepository: DailyStatsRepository;
  sessionRepository: SessionRepository;
  localDeviceRepository: LocalDeviceRepository;
  localSessionRepository: LocalSessionRepository;
  localJournalRepository: LocalJournalRepository;
  localProductRepository: LocalProductRepository;
  localDailyStatsRepository: LocalDailyStatsRepository;
  outboxRepository: OutboxRepository;
  cursorRepository: CursorRepository;
  idMapRepository: IdMapRepository;
  tombstoneRepository: TombstoneRepository;
  storageService: StorageService;
  deviceService: DeviceService;
  bluetoothService: BluetoothService;
  bleRestorationService: BLERestorationService | null;
  appSetupService: AppSetupService;
  usageLearningService: UsageLearningService;
  eventForecastingService: EventForecastingService;
  inventoryPredictionService: InventoryPredictionService;
  dataSyncService: DataSyncService;
  healthSyncService: HealthSyncService | null; 
  healthProjectionRefreshService: HealthProjectionRefreshService | null; 
  frontendConsumptionService: FrontendConsumptionService;
  frontendSessionService: FrontendSessionService;
  frontendJournalService: FrontendJournalService;
  frontendProductService: FrontendProductService;
  activeProductService: ActiveProductService;
  productSearchService: ProductSearchService;
  catalogStateService: CatalogStateService;
  productCatalogCoordinator: ProductCatalogCoordinator;
  webSocketClient: WebSocketClient;
  initialized: boolean;
}
const AppContext = createContext<AppContextType | null>(null);
interface AppProviderProps {
  children: ReactNode;
  bluetoothHandler?: BluetoothHandler;
}
export const AppProvider: React.FC<AppProviderProps> = ({ children, bluetoothHandler }) => {
  const [services, setServices] = useState<AppContextType | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resetCounter, setResetCounter] = useState(0);
  const [isResetting, setIsResetting] = useState(false);
  const initializationRef = useRef<{
    isInitializing: boolean;
    isInitialized: boolean;
  }>({ isInitializing: false, isInitialized: false });
  const startupOrchestratorRef = useRef<StartupOrchestrator | null>(null);
  useEffect(() => {
    let isMounted = true;
    let cachedNetworkStatus: CachedNetworkStatus | null = null;
    const appStateSubscription = AppState.addEventListener('change', (nextState: AppStateStatus) => {
      startupOrchestratorRef.current?.setAppState(nextState);
    });
    async function initializeApp() {
      const startupSessionId = `startup-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
      const startupStartTime = Date.now();
      const appVersion = Constants.expoConfig?.version ?? 'unknown';
      let criticalBlockStats: MainThreadBlockStats | null = null;
      const recordStartupStep = async <T,>(
        stepName: string,
        phase: 'critical' | 'essential' | 'background' | 'deferred',
        fn: () => Promise<T>
      ): Promise<T> => {
        const stepStart = Date.now();
        try {
          const result = await fn();
          const durationMs = Date.now() - stepStart;
          metrics.trackEvent('metricsStartup', 'startup_step_timing', {
            session_id: startupSessionId,
            step: stepName,
            phase,
            duration_ms: durationMs,
            success: true,
          });
          return result;
        } catch (error) {
          const durationMs = Date.now() - stepStart;
          metrics.trackEvent('metricsStartup', 'startup_step_timing', {
            session_id: startupSessionId,
            step: stepName,
            phase,
            duration_ms: durationMs,
            success: false,
            error: error instanceof Error ? error.name : 'UnknownError',
          });
          throw error;
        }
      };
      if (initializationRef.current.isInitialized || initializationRef.current.isInitializing) {
        console.log('[AppProvider] Already initialized or initializing, skipping', {
          isInitialized: initializationRef.current.isInitialized,
          isInitializing: initializationRef.current.isInitializing,
        });
        return;
      }
      initializationRef.current.isInitializing = true;
      let apiClient: BackendAPIClient | null = null;
      let dataSyncService: DataSyncService | null = null;
      let healthSyncService: HealthSyncService | null = null;
      let healthProjectionRefreshService: HealthProjectionRefreshService | null = null;
      let serviceContext: AppContextType | null = null;
      let resolvedFlags: ReturnType<typeof initializeFeatureFlags> | null = null;
      let syncScheduler: SyncScheduler | null = null;
      let syncLeaseManager: SyncLeaseManager | null = null;
      const initializeCriticalServices = async (): Promise<void> => {
        console.log('[AppProvider] Starting application-wide service initialization...');
        await recordStartupStep('database_manager_initialize', 'critical', async () => {
          await databaseManager.initialize();
        });
        console.log('[AppProvider] DatabaseManager initialized.');
        await recordStartupStep('secure_storage_initialize', 'critical', async () => {
          await secureStorage.initialize();
        });
        console.log('[AppProvider] SecureStorageService initialized.');
        apiClient = BackendAPIClient.getInstance();
        if (!apiClient) {
          throw new Error('AppProvider: BackendAPIClient instance unavailable');
        }
        await recordStartupStep('api_client_initialize_from_storage', 'critical', async () => {
          await apiClient!.initializeFromStorage();
        });
        console.log('[AppProvider] BackendAPIClient initialized from storage.');
        const deviceId = await recordStartupStep('device_id_initialize', 'critical', async () => {
          return await DeviceIdManager.getDeviceId();
        });
        apiClient.setDeviceId(deviceId);
        console.log('[AppProvider] Device ID initialized and set on API client:', deviceId.substring(0, 8) + '...');
        resolvedFlags = initializeFeatureFlags(deviceId);
        metrics.initialize(resolvedFlags);
      };
      const initializeEssentialServices = async (): Promise<void> => {
        if (!apiClient) {
          throw new Error('AppProvider: apiClient not initialized before essential services');
        }
        try {
          await recordStartupStep('local_notification_initialize', 'essential', async () => {
            await localNotificationService.initialize();
          });
          console.log('[AppProvider] LocalNotificationService initialized.');
        } catch (notificationError) {
          console.warn('[AppProvider] LocalNotificationService initialization failed', {
            error: notificationError instanceof Error ? notificationError.message : String(notificationError),
          });
        }
        try {
          const baseUrl = apiClient.getBaseUrl().replace('/api/v1', '');
          console.log('[AppProvider] Testing backend connectivity to:', baseUrl);
          const healthResponse = await fetch(`${baseUrl}/health`, {
            method: 'GET',
            headers: { 'Accept': 'application/json' },
          });
          const healthData = await healthResponse.json();
          console.log('[AppProvider] ✅ Backend health check SUCCESS:', healthData);
        } catch (networkError) {
          const platformName = Platform.OS === 'ios' ? 'iOS' : Platform.OS === 'android' ? 'Android' : Platform.OS;
          console.error(`[AppProvider] ❌ Backend health check FAILED - ${platformName} device cannot reach backend!`);
          console.error('[AppProvider] Network error details:', {
            message: networkError instanceof Error ? networkError.message : String(networkError),
            name: networkError instanceof Error ? networkError.name : 'Unknown',
            platform: Platform.OS,
            apiUrl: apiClient.getBaseUrl(),
          });
          console.error('[AppProvider] Possible causes:');
          if (Platform.OS === 'android') {
            console.error('  1. Android emulator: URL must be http://10.0.2.2:3001 (NOT localhost)');
            console.error('  2. Physical Android device: Must use tunnel or machine IP (NOT localhost/10.0.2.2)');
            console.error('  3. Backend server not running on port 3001');
            console.error('  4. Check .env.local - EXPO_PUBLIC_API_URL should be commented out for auto-detection');
          } else if (Platform.OS === 'ios') {
            console.error('  1. iOS device not on same WiFi network as backend server');
            console.error('  2. Backend server not running or firewall blocking port 3001');
            console.error('  3. iOS App Transport Security blocking HTTP connections');
            console.error('  4. Physical iOS device: Must use tunnel or machine IP (NOT localhost)');
          } else {
            console.error('  1. Backend server not running on port 3001');
            console.error('  2. Network connectivity issue');
          }
          console.error(`  Current API URL: ${apiClient.getBaseUrl()}`);
        }
        const db = await recordStartupStep('sqlite_open', 'essential', async () => {
          return await databaseManager.getDatabase(DEVICE_HITS_DATABASE_NAME);
        });
        const drizzleDb = await recordStartupStep('drizzle_initialize', 'essential', async () => {
          return initializeWithConnection(db);
        });
        console.log('[AppProvider] Drizzle ORM initialized with existing SQLite connection.');
        const deviceEventsRepository = new DeviceEventRepository(drizzleDb);
        console.log('[AppProvider] DeviceEventRepository initialized with Drizzle.');
        const aiSummariesRepository = new AISummariesRepository(db);
        const userConsumptionProfileRepository = new UserConsumptionProfileRepository(db);
        const strainsRepository = new VariantsRepository(apiClient);
        const journalRepository = new JournalRepository(apiClient);
        const purchaseRepository = new PurchaseRepository(apiClient);
        const inventoryRepository = new InventoryRepository(apiClient);
        const sessionRepository = new SessionRepository(apiClient);
        const deviceRepository = new DeviceRepository(apiClient);
        const consumptionRepository = new ConsumptionRepository(apiClient);
        const userConsumptionRepo = new UserConsumptionRepository(apiClient);
        const userProfilingClient = new UserProfilingAPIClient(apiClient);
        const userRepository = new UserRepository(apiClient);
        console.log('[AppProvider] UserRepository initialized with API-driven architecture.');
        const dailyStatsRepository = new DailyStatsRepository(apiClient);
        console.log('[AppProvider] Database includes sync tables (cursor_state, sync_metadata).');
        const storageService = new StorageService();
        console.log('[AppProvider] StorageService initialized.');
        const outboxRepo = new OutboxRepository(drizzleDb);
        const idMapRepo = new IdMapRepository(drizzleDb);
        const tombstoneRepo = new TombstoneRepository(drizzleDb);
        console.log('[AppProvider] Offline sync repositories created (all using Drizzle ORM).');
        const cursorRepo = new CursorRepository(drizzleDb);
        console.log('[AppProvider] CursorRepository initialized with Drizzle.');
        const localDeviceRepository = new LocalDeviceRepository({ drizzleDb });
        console.log('[AppProvider] LocalDeviceRepository initialized with Drizzle.');
        const localSessionRepository = new LocalSessionRepository(drizzleDb);
        console.log('[AppProvider] LocalSessionRepository initialized with Drizzle.');
        const localJournalRepository = new LocalJournalRepository(drizzleDb);
        console.log('[AppProvider] LocalJournalRepository initialized with Drizzle.');
        const localJournalEffectsRepository = new LocalJournalEffectsRepository(drizzleDb);
        console.log('[AppProvider] LocalJournalEffectsRepository initialized with Drizzle.');
        const localProductRepository = new LocalProductRepository(drizzleDb);
        console.log('[AppProvider] LocalProductRepository initialized with Drizzle.');
        const localDailyStatsRepository = new LocalDailyStatsRepository(drizzleDb);
        console.log('[AppProvider] LocalDailyStatsRepository initialized with Drizzle.');
        const { queryClient, persister, unsubscribe: queryUnsubscribe } = initializeQueryClient();
        console.log('[AppProvider] React Query initialized with offline support.');
        const frontendSessionService = new FrontendSessionService(
          localSessionRepository,
          outboxRepo
        );
        console.log('[AppProvider] FrontendSessionService initialized with LOCAL-FIRST architecture.');
        const activePurchaseResolver = new ActivePurchaseResolver(drizzleDb);
        console.log('[AppProvider] ActivePurchaseResolver initialized with Drizzle.');
        const frontendConsumptionService = new FrontendConsumptionService(
          consumptionRepository,
          outboxRepo,
          idMapRepo,
          tombstoneRepo,
          databaseManager,
          apiClient,
          storageService,
          deviceEventsRepository,
          queryClient,
          frontendSessionService,
          activePurchaseResolver
        );
        console.log('[AppProvider] FrontendConsumptionService initialized with LOCAL-FIRST architecture, session orchestration, and purchase linkage.');
        const frontendJournalService = new FrontendJournalService(
          localJournalRepository,
          localJournalEffectsRepository,
          outboxRepo,
          tombstoneRepo,
          storageService
        );
        console.log('[AppProvider] FrontendJournalService initialized with LOCAL-FIRST architecture.');
        const frontendProductService = new FrontendProductService(
          localProductRepository,
          outboxRepo
        );
        console.log('[AppProvider] FrontendProductService initialized with LOCAL-FIRST architecture.');
        const activeProductService = new ActiveProductService(
          localProductRepository,
          storageService,
          idMapRepo
        );
        console.log('[AppProvider] ActiveProductService initialized for selection invariant enforcement.');
        const productSearchService = new ProductSearchService(
          databaseManager,
          localProductRepository
        );
        const ftsStatus = await productSearchService.initializeFtsCapability();
        console.log('[AppProvider] ProductSearchService initialized with FTS5 support.', {
          ftsAvailable: ftsStatus.available,
          ftsIndexedCount: ftsStatus.indexedCount,
          ftsUnavailableReason: ftsStatus.unavailableReason,
        });
        const catalogStateService = new CatalogStateService(
          cursorRepo,
          databaseManager
        );
        console.log('[AppProvider] CatalogStateService initialized for catalog sync tracking.');
        const deviceService = new DeviceService(
          storageService,
          localDeviceRepository,
          outboxRepo
        );
        await recordStartupStep('device_service_initialize', 'essential', async () => {
          await deviceService.initialize();
        });
        console.log('[AppProvider] DeviceService initialized with offline-first architecture.');
        const bleNotificationCoordinator = new BleNotificationCoordinator(
          deviceService,
          localSessionRepository,
          localProductRepository
        );
        bleNotificationCoordinator.initialize();
        console.log('[AppProvider] BLE notification coordinator initialized.');
        const bleRestorationService = new BLERestorationService(deviceService, frontendSessionService);
        try {
          await bleRestorationService.initialize();
          console.log('[AppProvider] BLE restoration service initialized.');
        } catch (restorationError) {
          console.warn('[AppProvider] BLE restoration initialization failed', {
            error: restorationError instanceof Error ? restorationError.message : String(restorationError),
          });
        }
        const bluetoothService = new BluetoothService(deviceService, frontendConsumptionService);
        const usageLearningService = new UsageLearningService(
          purchaseRepository,
          userConsumptionRepo
        );
        const eventForecastingService = new EventForecastingService(userProfilingClient);
        const inventoryPredictionService = new InventoryPredictionService(
          purchaseRepository,
          inventoryRepository,
          userConsumptionRepo,
          dailyStatsRepository,
          userProfilingClient
        );
        const aiService = AIService.getInstance();
        await recordStartupStep('ai_service_initialize', 'essential', async () => {
          await aiService.initialize(
            journalRepository,
            deviceEventsRepository,
            strainsRepository,
            aiSummariesRepository
          );
        });
        console.log('[AppProvider] AIService initialized.');
        const appSetupService = new AppSetupService(
          databaseManager,
          strainsRepository,
          localProductRepository
        );
        await recordStartupStep('app_setup_initialize', 'essential', async () => {
          await appSetupService.ensureInitialized();
        });
        console.log('[AppProvider] AppSetupService check complete.');
        const syncHandlerRegistry = createSyncHandlerRegistry({
          databaseManager,
          localSessionRepository,
          localJournalRepository,
          localDeviceRepository,
          localProductRepository,
          logger,
          idMappingLookup: idMapRepo,
        });
        console.log('[AppProvider] FrontendSyncHandlerRegistry initialized.');
        syncScheduler = new SyncScheduler();
        syncLeaseManager = new SyncLeaseManager(apiClient);
        dataSyncService = DataSyncService.getInstance(
          databaseManager,
          apiClient,
          outboxRepo,
          cursorRepo,
          idMapRepo,
          tombstoneRepo,
          syncHandlerRegistry
        );
        if (!dataSyncService) {
          throw new Error('AppProvider: DataSyncService instance unavailable');
        }
        dataSyncService.setQueryClient(queryClient);
        dataSyncService.setSyncScheduler(syncScheduler);
        dataSyncService.setSyncLeaseManager(syncLeaseManager);
        console.log('[AppProvider] DataSyncService configured with QueryClient for automatic cache invalidation.');
        let healthPermissionStatusRef: HealthPermissionStatus = 'not_determined';
        const RECENT_FIRST_RESET_KEY = 'health_recent_first_reset_version';
        const healthDataProvider = createHealthKitAdapter();
        healthSyncService = null;
        if (healthDataProvider) {
          healthSyncService = HealthSyncService.getInstance({
            drizzleDb,
            httpClient: createHealthUploadHttpClient(),
            healthDataProvider,
            metricConfigs: getHealthKitMetricConfigs(),
            getUserId: () => dataSyncService?.getCurrentUserId() ?? null,
            getAuthToken: async () => apiClient?.getIdToken() ?? null,
            getPermissionStatus: () => healthPermissionStatusRef,
            appVersion,
            getRecentFirstResetVersion: () => storageService.getValue<string>(RECENT_FIRST_RESET_KEY),
            setRecentFirstResetVersion: (version: string) => storageService.setValue(RECENT_FIRST_RESET_KEY, version),
            syncScheduler: syncScheduler ?? undefined,
            syncLeaseManager: syncLeaseManager ?? undefined,
          });
          console.log('[AppProvider] HealthSyncService created (engines lazy-created when auth + permissions ready).');
        } else {
          console.log('[AppProvider] HealthSyncService not created - no health data provider available on this platform.');
        }
        if (databaseManager.healthProjectionTablesReady && apiClient) {
          try {
            const hydrationClient = new HealthProjectionHydrationClient({
              apiClient,
              rollupRepository: new LocalHealthRollupRepository(drizzleDb),
              sleepRepository: new LocalSleepNightSummaryRepository(drizzleDb),
              sessionImpactRepository: new LocalSessionImpactRepository(drizzleDb),
              productImpactRepository: new LocalProductImpactRepository(drizzleDb),
              insightRepository: new LocalHealthInsightRepository(drizzleDb),
              isTablesReady: () => databaseManager.healthProjectionTablesReady,
            });
            cachedNetworkStatus = new CachedNetworkStatus();
            healthProjectionRefreshService = new HealthProjectionRefreshService({
              hydrationClient,
              rollupDirtyKeyRepository: new LocalRollupDirtyKeyRepository(drizzleDb),
              sleepDirtyNightRepository: new LocalSleepDirtyNightRepository(drizzleDb),
              rollupRepository: new LocalHealthRollupRepository(drizzleDb),
              sleepRepository: new LocalSleepNightSummaryRepository(drizzleDb),
              sessionImpactRepository: new LocalSessionImpactRepository(drizzleDb),
              productImpactRepository: new LocalProductImpactRepository(drizzleDb),
              insightRepository: new LocalHealthInsightRepository(drizzleDb),
              isOnline: () => cachedNetworkStatus?.isOnline() ?? false,
              isTablesReady: () => databaseManager.healthProjectionTablesReady,
            });
            if (healthSyncService) {
              healthSyncService.setHealthProjectionRefreshService(healthProjectionRefreshService);
            }
            console.log('[AppProvider] HealthProjectionRefreshService created (Phase 3 read-model hydration).');
          } catch (projectionError) {
            console.warn('[AppProvider] HealthProjectionRefreshService creation failed (non-critical):', projectionError);
            healthProjectionRefreshService = null;
          }
        } else {
          console.log('[AppProvider] HealthProjectionRefreshService not created - projection tables not ready or no apiClient.');
        }
        const productCatalogCoordinator = createProductCatalogCoordinator(
          dataSyncService,
          catalogStateService,
          productSearchService
        );
        console.log('[AppProvider] ProductCatalogCoordinator initialized for catalog sync retry orchestration.');
        const webSocketClient = new WebSocketClient(
          dataSyncService,
          queryClient,
          { debug: true }
        );
        console.log('[AppProvider] WebSocketClient initialized. Call webSocketClient.initialize(userId, jwtToken) after authentication.');
        serviceContext = {
          databaseManager,
          queryClient,
          queryPersister: persister,
          queryUnsubscribe,
          apiClient,
          deviceRepository,
          consumptionRepository,
          inventoryRepository,
          userConsumptionRepository: userConsumptionRepo,
          userProfilingClient,
          userRepository,
          deviceEventsRepository,
          strainsRepository,
          journalRepository,
          aiSummariesRepository,
          purchaseRepository,
          userConsumptionProfileRepository,
          dailyStatsRepository,
          sessionRepository,
          localDeviceRepository,
          localSessionRepository,
          localJournalRepository,
          localProductRepository,
          localDailyStatsRepository,
          outboxRepository: outboxRepo,
          cursorRepository: cursorRepo,
          idMapRepository: idMapRepo,
          tombstoneRepository: tombstoneRepo,
          storageService,
          deviceService,
          bluetoothService,
          bleRestorationService,
          appSetupService,
          usageLearningService,
          eventForecastingService,
          inventoryPredictionService,
          dataSyncService,
          healthSyncService,
          healthProjectionRefreshService,
          frontendConsumptionService,
          frontendSessionService,
          frontendJournalService,
          frontendProductService,
          activeProductService,
          productSearchService,
          catalogStateService,
          productCatalogCoordinator,
          webSocketClient,
          initialized: true,
        };
      };
      const initializeBackgroundDataSync = async (): Promise<void> => {
        if (!dataSyncService) {
          throw new Error('AppProvider: DataSyncService not created before background init');
        }
        await recordStartupStep('data_sync_initialize', 'background', async () => {
          await dataSyncService!.initialize();
        });
        console.log('[AppProvider] DataSyncService initialized.');
      };
      const initializeBackgroundHealthSync = async (): Promise<void> => {
        if (!healthSyncService) {
          return;
        }
        await recordStartupStep('health_sync_initialize', 'background', async () => {
          await healthSyncService!.initialize();
        });
        console.log('[AppProvider] HealthSyncService initialized (engines lazy-created when auth + permissions ready).');
      };
      try {
        const orchestrator = new StartupOrchestrator({
          initialAppState: (AppState.currentState ?? 'active') as StartupAppState,
        });
        startupOrchestratorRef.current = orchestrator;
        orchestrator.setAppState((AppState.currentState ?? 'active') as StartupAppState);
        orchestrator.addTask({
          name: 'critical_services',
          phase: StartupPhase.CRITICAL,
          execute: initializeCriticalServices,
        });
        orchestrator.addTask({
          name: 'essential_services',
          phase: StartupPhase.ESSENTIAL,
          dependsOn: ['critical_services'],
          execute: initializeEssentialServices,
        });
        const criticalMonitor = createMainThreadBlockMonitor();
        criticalMonitor.start();
        try {
          await orchestrator.runPhases([StartupPhase.CRITICAL]);
        } finally {
          criticalBlockStats = criticalMonitor.stop();
        }
        const startupOrchestratorEnabled = resolvedFlags ? isFeatureEnabled('startupOrchestrator') : false;
        const allowBackgroundFailures = startupOrchestratorEnabled;
        DataSyncService.configureStartupGate(startupOrchestratorEnabled);
        if (criticalBlockStats) {
          trackStartupMainThreadBlock({
            sessionId: startupSessionId,
            phase: 'critical',
            stats: criticalBlockStats,
            appVersion,
            startupOrchestratorEnabled,
          });
        }
        orchestrator.addTask({
          name: 'background_data_sync_init',
          phase: StartupPhase.BACKGROUND,
          dependsOn: ['essential_services'],
          heavy: true,
          canFail: allowBackgroundFailures,
          execute: initializeBackgroundDataSync,
        });
        orchestrator.addTask({
          name: 'background_health_sync_init',
          phase: StartupPhase.BACKGROUND,
          dependsOn: ['essential_services'],
          heavy: true,
          canFail: allowBackgroundFailures,
          execute: initializeBackgroundHealthSync,
        });
        if (startupOrchestratorEnabled) {
          const essentialMonitor = createMainThreadBlockMonitor();
          essentialMonitor.start();
          try {
            await orchestrator.runPhases([StartupPhase.ESSENTIAL]);
          } finally {
            const essentialStats = essentialMonitor.stop();
            trackStartupMainThreadBlock({
              sessionId: startupSessionId,
              phase: 'essential',
              stats: essentialStats,
              appVersion,
              startupOrchestratorEnabled,
            });
          }
          if (!serviceContext) {
            throw new Error('AppProvider: service context not initialized after essential phase');
          }
          if (isMounted) {
            setServices(serviceContext);
            initializationRef.current.isInitialized = true;
            initializationRef.current.isInitializing = false;
            console.log('[AppProvider] Essential services initialized and context set.');
            metrics.trackEvent('metricsStartup', 'startup_total_timing', {
              session_id: startupSessionId,
              duration_ms: Date.now() - startupStartTime,
              success: true,
            });
            void orchestrator.runPhases([StartupPhase.BACKGROUND, StartupPhase.DEFERRED]).catch((error) => {
              console.warn('[AppProvider] Background startup tasks failed', {
                error: error instanceof Error ? error.message : String(error),
              });
            });
          }
        } else {
          orchestrator.markFirstPaintComplete();
          orchestrator.setAppState('active');
          const essentialMonitor = createMainThreadBlockMonitor();
          essentialMonitor.start();
          try {
            await orchestrator.runPhases([StartupPhase.ESSENTIAL]);
          } finally {
            const essentialStats = essentialMonitor.stop();
            trackStartupMainThreadBlock({
              sessionId: startupSessionId,
              phase: 'essential',
              stats: essentialStats,
              appVersion,
              startupOrchestratorEnabled,
            });
          }
          await orchestrator.runPhases([StartupPhase.BACKGROUND, StartupPhase.DEFERRED]);
          if (!serviceContext) {
            throw new Error('AppProvider: service context not initialized after startup');
          }
          if (isMounted) {
            setServices(serviceContext);
            initializationRef.current.isInitialized = true;
            initializationRef.current.isInitializing = false;
            console.log('[AppProvider] All services initialized and context set.');
            metrics.trackEvent('metricsStartup', 'startup_total_timing', {
              session_id: startupSessionId,
              duration_ms: Date.now() - startupStartTime,
              success: true,
            });
          }
        }
      } catch (err: unknown) {
        const error = err instanceof Error ? err : new Error(String(err));
        console.error('[AppProvider] CRITICAL ERROR during app initialization:', error);
        initializationRef.current.isInitializing = false;
        metrics.trackEvent('metricsStartup', 'startup_total_timing', {
          session_id: startupSessionId,
          duration_ms: Date.now() - startupStartTime,
          success: false,
          error: error.name,
        });
        if (isMounted) {
          setError(error.message || 'Failed to initialize application services.');
        }
      }
    }
    initializeApp();
    return () => {
      isMounted = false;
      appStateSubscription.remove();
      startupOrchestratorRef.current = null;
      DataSyncService.releaseStartupGate();
      if (services?.dataSyncService) {
        try {
          services.dataSyncService.cleanup();
          console.log('[AppProvider] DataSyncService cleanup triggered on unmount.');
        } catch (cleanupError) {
          console.error('[AppProvider] Error during DataSyncService cleanup:', cleanupError);
        }
      }
      if (HealthSyncService.hasInstance()) {
        try {
          HealthSyncService.reset();
          console.log('[AppProvider] HealthSyncService reset on unmount.');
        } catch (cleanupError) {
          console.error('[AppProvider] Error during HealthSyncService cleanup:', cleanupError);
        }
      }
      if (cachedNetworkStatus != null) {
        try {
          cachedNetworkStatus.dispose();
          cachedNetworkStatus = null;
          console.log('[AppProvider] CachedNetworkStatus disposed on unmount.');
        } catch (cleanupError) {
          console.error('[AppProvider] Error during CachedNetworkStatus cleanup:', cleanupError);
        }
      }
      if (services?.frontendConsumptionService) {
        try {
          services.frontendConsumptionService.cleanup();
          console.log('[AppProvider] FrontendConsumptionService cleanup triggered on unmount.');
        } catch (cleanupError) {
          console.error('[AppProvider] Error during FrontendConsumptionService cleanup:', cleanupError);
        }
      }
      if (services?.bleRestorationService) {
        try {
          services.bleRestorationService.dispose();
          console.log('[AppProvider] BLERestorationService cleanup triggered on unmount.');
        } catch (cleanupError) {
          console.error('[AppProvider] Error during BLERestorationService cleanup:', cleanupError);
        }
      }
      if (services?.productCatalogCoordinator) {
        try {
          services.productCatalogCoordinator.dispose();
          console.log('[AppProvider] ProductCatalogCoordinator cleanup triggered on unmount.');
        } catch (cleanupError) {
          console.error('[AppProvider] Error during ProductCatalogCoordinator cleanup:', cleanupError);
        }
      }
      if (services?.queryUnsubscribe) {
        try {
          services.queryUnsubscribe();
          console.log('[AppProvider] QueryClient network listener cleaned up on unmount.');
        } catch (cleanupError) {
          console.error('[AppProvider] Error during QueryClient cleanup:', cleanupError);
        }
      }
      initializationRef.current = { isInitializing: false, isInitialized: false };
    };
  }, [bluetoothHandler, resetCounter]); 
  useEffect(() => {
    if (!services?.initialized || !startupOrchestratorRef.current) {
      return;
    }
    let cancelled = false;
    requestAnimationFrame(() => {
      if (!cancelled) {
        startupOrchestratorRef.current?.markFirstPaintComplete();
        DataSyncService.releaseStartupGate();
      }
    });
    return () => {
      cancelled = true;
    };
  }, [services?.initialized]);
  useEffect(() => {
    const runSecureStorageMigration = async () => {
      const MIGRATION_KEY = 'migration_v2_secure_storage_complete';
      try {
        const isMigrationDone = await secureStorage.getValue<boolean>(MIGRATION_KEY, DataSensitivity.PUBLIC);
        if (isMigrationDone) {
          console.log('[Migration] Secure storage migration already completed. Skipping.');
          return;
        }
        console.log('[Migration] Starting one-time migration to SecureStorageService...');
        const keysToMigrate = [
          { key: 'appThemePreference', sensitivity: DataSensitivity.PUBLIC },
          { key: 'ai_onboarding_completed', sensitivity: DataSensitivity.PUBLIC },
          { key: 'ai_recommendations_cache', sensitivity: DataSensitivity.PRIVATE },
          { key: 'savedDevices', sensitivity: DataSensitivity.PRIVATE },
          { key: 'APP_PLATFORM_DEVICE_UUIDS', sensitivity: DataSensitivity.PRIVATE },
          { key: 'hasLaunched', sensitivity: DataSensitivity.PUBLIC },
        ];
        let migratedCount = 0;
        for (const { key, sensitivity } of keysToMigrate) {
          try {
            const oldValue = await AsyncStorage.getItem(key);
            if (oldValue !== null) {
              console.log(`[Migration] Found old data for key: ${key}. Migrating...`);
              try {
                const parsedValue = JSON.parse(oldValue);
                await secureStorage.setValue(key, parsedValue, { sensitivity });
              } catch (parseError) {
                await secureStorage.setValue(key, oldValue, { sensitivity });
              }
              await AsyncStorage.removeItem(key);
              console.log(`[Migration] Successfully migrated and removed old key: ${key}`);
              migratedCount++;
            }
          } catch (keyError) {
            console.warn(`[Migration] Error migrating key ${key}:`, keyError);
          }
        }
        await secureStorage.setValue(MIGRATION_KEY, true, { sensitivity: DataSensitivity.PUBLIC });
        console.log(`[Migration] Secure storage migration complete. Migrated ${migratedCount} keys.`);
      } catch (migrationError) {
        console.error('[Migration] Failed to run secure storage migration:', migrationError);
      }
    };
    if (services?.initialized) {
      runSecureStorageMigration();
    }
  }, [services?.initialized]); 
  useEffect(() => {
    if (!services?.queryClient || !services?.initialized) {
      return; 
    }
    let debounceTimeoutId: ReturnType<typeof setTimeout> | null = null;
    const relevantSources = [
      'DEVICE_HIT_RECORDED',
      'BATCH_DEVICE_HITS_RECORDED',
      'DEVICE_HIT_UPDATED',
      'DEVICE_HIT_DELETED',
      'CONSUMPTION_CREATED',
      'CONSUMPTION_CREATED_OFFLINE',
      'CONSUMPTION_UPDATED',
      'CONSUMPTION_UPDATED_OFFLINE',
      'CONSUMPTION_DELETED',
      'CONSUMPTION_DELETED_OFFLINE',
      'BATCH_CONSUMPTION_CREATED',
      'BATCH_CONSUMPTION_CREATED_OFFLINE',
      'SYNC_PULL_COMPLETED',
      'SYNC_COMPLETED',
      'WEBSOCKET_CONSUMPTION_CREATED',
      'WEBSOCKET_CONSUMPTION_UPDATED',
      'WEBSOCKET_CONSUMPTION_DELETED',
      'WEBSOCKET_SESSION_CREATED',
      'WEBSOCKET_SESSION_UPDATED',
      'WEBSOCKET_SESSION_COMPLETED',
    ];
    const handleGlobalDataChange = (data?: unknown) => {
      const eventData = data as { source?: string; payload?: unknown } | undefined;
      const eventSource = eventData?.source || 'unknown';
      const isRelevant = relevantSources.includes(eventSource) ||
        (typeof eventSource === 'string' && eventSource.startsWith('WEBSOCKET_'));
      if (!isRelevant) {
        logger.debug(`[AppProvider] Ignoring non-dashboard DATA_CHANGED event: ${eventSource}`);
        return;
      }
      if (debounceTimeoutId) {
        clearTimeout(debounceTimeoutId);
      }
      debounceTimeoutId = setTimeout(() => {
        logger.debug('[AppProvider] Invalidating dashboard caches (centralized, debounced)', {
          triggerSource: eventSource,
        });
        services.queryClient.invalidateQueries({
          queryKey: ['dashboard'],
        });
        services.queryClient.invalidateQueries({
          queryKey: ['unified-dashboard'],
          refetchType: 'none',
        });
        debounceTimeoutId = null;
      }, 300);
    };
    logger.info('[AppProvider] Registering centralized DATA_CHANGED listener');
    dataChangeEmitter.on(dbEvents.DATA_CHANGED, handleGlobalDataChange);
    return () => {
      logger.info('[AppProvider] Removing centralized DATA_CHANGED listener');
      dataChangeEmitter.off(dbEvents.DATA_CHANGED, handleGlobalDataChange);
      if (debounceTimeoutId) {
        clearTimeout(debounceTimeoutId);
      }
    };
  }, [services?.queryClient, services?.initialized]);
  if (error) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#000' }}>
        <Text style={{ color: '#ff4444', fontSize: 18, fontWeight: 'bold', marginBottom: 10 }}>
          Application Error
        </Text>
        <Text style={{ color: '#fff', textAlign: 'center', paddingHorizontal: 20 }}>
          {error}
        </Text>
        <Text style={{ color: '#aaa', textAlign: 'center', paddingHorizontal: 20, marginTop: 20 }}>
          You can retry initialization or reset local data if migrations failed.
        </Text>
        <View style={{ flexDirection: 'row', marginTop: 24 }}>
          <TouchableOpacity
            onPress={() => {
              if (isResetting) {
                return;
              }
              setError(null);
              setServices(null);
              setResetCounter((prev) => prev + 1);
            }}
            style={{
              paddingVertical: 10,
              paddingHorizontal: 16,
              borderRadius: 6,
              backgroundColor: '#2b2b2b',
              marginRight: 12,
            }}
          >
            <Text style={{ color: '#fff', fontSize: 14 }}>Retry Init</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={async () => {
              if (isResetting) {
                return;
              }
              setIsResetting(true);
              try {
                console.log('[AppProvider] Starting FULL FACTORY RESET (fail-fast)...');
                if (Platform.OS === 'ios') {
                  if (!isKeychainWipeAvailable()) {
                    throw new Error(
                      'Keychain wipe module not available on iOS. ' +
                      'This is a configuration error - please reinstall the app.'
                    );
                  }
                  console.log('[AppProvider] Step 1: Wiping Keychain...');
                  const keychainWiped = await wipeKeychain();
                  if (!keychainWiped) {
                    throw new Error(
                      'Keychain wipe failed. This is critical for recovery. ' +
                      'Please try again or reinstall the app.'
                    );
                  }
                  console.log('[AppProvider] Keychain wiped successfully');
                } else {
                  console.log('[AppProvider] Step 1: Skipping Keychain (not iOS)');
                }
                console.log('[AppProvider] Step 1.5: Closing SQLite connections...');
                try {
                  await databaseManager.cleanup();
                  console.log('[AppProvider] SQLite connections closed');
                } catch (cleanupError) {
                  console.warn('[AppProvider] Cleanup warning (continuing):', cleanupError);
                }
                if (isFactoryResetAvailable()) {
                  console.log('[AppProvider] Step 2: Native wipe (SQLite + AsyncStorage)...');
                  await wipeAllLocalStorageNative();
                  console.log('[AppProvider] Native wipe completed successfully');
                } else {
                  console.log('[AppProvider] Step 2: JS-only wipe (native not available)...');
                  await AsyncStorage.clear();
                  console.log('[AppProvider] AsyncStorage cleared');
                  await databaseManager.resetDatabase(undefined, { throwOnError: true });
                  console.log('[AppProvider] SQLite database reset');
                }
                console.log('[AppProvider] FULL FACTORY RESET complete - triggering re-initialization');
                setError(null);
                setServices(null);
                setResetCounter((prev) => prev + 1);
              } catch (resetError) {
                const err = resetError instanceof Error ? resetError : new Error(String(resetError));
                console.error('[AppProvider] Factory reset FAILED:', err);
                setError(`Factory reset failed: ${err.message}`);
              } finally {
                setIsResetting(false);
              }
            }}
            style={{
              paddingVertical: 10,
              paddingHorizontal: 16,
              borderRadius: 6,
              backgroundColor: '#ff4444',
            }}
          >
            <Text style={{ color: '#000', fontSize: 14, fontWeight: 'bold' }}>
              {isResetting ? 'Resetting...' : 'Factory Reset'}
            </Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }
  if (!services) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#000' }}>
        <ActivityIndicator size="large" color="#00e676" />
        <Text style={{ marginTop: 20, color: '#fff', fontSize: 16 }}>Initializing...</Text>
      </View>
    );
  }
  return (
    <PersistQueryClientProvider
      client={services.queryClient}
      persistOptions={{ persister: services.queryPersister }}
    >
      <AppContext.Provider value={services}>
        {children}
      </AppContext.Provider>
    </PersistQueryClientProvider>
  );
};
export function useAppContext(): AppContextType {
  const context = useContext(AppContext);
  if (context === null) {
    throw new Error('useAppContext must be used within an AppProvider');
  }
  return context;
}
export function useDeviceEventRepository(): DeviceEventRepository {
  return useAppContext().deviceEventsRepository;
}
export function useVariantsRepository(): VariantsRepository {
  return useAppContext().strainsRepository;
}
export function useJournalRepository(): JournalRepository {
  return useAppContext().journalRepository;
}
export function useStorageService(): StorageService {
  return useAppContext().storageService;
}
export function useDeviceService(): DeviceService {
  return useAppContext().deviceService;
}
export function useBluetoothService(): BluetoothService {
  return useAppContext().bluetoothService;
}
export function useAppSetupService(): AppSetupService {
  return useAppContext().appSetupService;
}
export function useAISummariesRepository(): AISummariesRepository {
  return useAppContext().aiSummariesRepository;
}
export function usePurchaseRepository(): PurchaseRepository {
  return useAppContext().purchaseRepository;
}
export function useUserConsumptionProfileRepository(): UserConsumptionProfileRepository {
  return useAppContext().userConsumptionProfileRepository;
}
export function useUsageLearningService(): UsageLearningService {
  return useAppContext().usageLearningService;
}
export function useEventForecastingService(): EventForecastingService {
  return useAppContext().eventForecastingService;
}
export function useInventoryPredictionService(): InventoryPredictionService {
  return useAppContext().inventoryPredictionService;
}
export function useSessionRepository(): SessionRepository {
  return useAppContext().sessionRepository;
}
export function useDailyStatsRepository(): DailyStatsRepository {
  return useAppContext().dailyStatsRepository;
}
export function useDeviceRepository(): DeviceRepository {
  return useAppContext().deviceRepository;
}
export function useConsumptionRepository(): ConsumptionRepository {
  return useAppContext().consumptionRepository;
}
export function useInventoryRepository(): InventoryRepository {
  return useAppContext().inventoryRepository;
}
export function useReactQueryClient(): QueryClient {
  return useAppContext().queryClient;
}
export function useQueryPersister(): Persister {
  return useAppContext().queryPersister;
}
export function useDataSyncService(): DataSyncService {
  return useAppContext().dataSyncService;
}
export function useHealthSyncService(): HealthSyncService | null {
  return useAppContext().healthSyncService;
}
export function useHealthProjectionRefreshService(): HealthProjectionRefreshService | null {
  return useAppContext().healthProjectionRefreshService;
}
export function useFrontendConsumptionService(): FrontendConsumptionService {
  return useAppContext().frontendConsumptionService;
}
export function useWebSocketClient(): WebSocketClient {
  return useAppContext().webSocketClient;
}
export function useOutboxRepository(): OutboxRepository {
  return useAppContext().outboxRepository;
}
export function useCursorRepository(): CursorRepository {
  return useAppContext().cursorRepository;
}
export function useIdMapRepository(): IdMapRepository {
  return useAppContext().idMapRepository;
}
export function useTombstoneRepository(): TombstoneRepository {
  return useAppContext().tombstoneRepository;
}
export function useBackendAPIClient(): BackendAPIClient {
  return useAppContext().apiClient;
}
export function useUserConsumptionRepository(): UserConsumptionRepository {
  return useAppContext().userConsumptionRepository;
}
export function useUserProfilingAPIClient(): UserProfilingAPIClient {
  return useAppContext().userProfilingClient;
}
export function useLocalDeviceRepository(): LocalDeviceRepository {
  return useAppContext().localDeviceRepository;
}
export function useLocalSessionRepository(): LocalSessionRepository {
  return useAppContext().localSessionRepository;
}
export function useFrontendSessionService(): FrontendSessionService {
  return useAppContext().frontendSessionService;
}
export function useLocalJournalRepository(): LocalJournalRepository {
  return useAppContext().localJournalRepository;
}
export function useFrontendJournalService(): FrontendJournalService {
  return useAppContext().frontendJournalService;
}
export function useLocalProductRepository(): LocalProductRepository {
  return useAppContext().localProductRepository;
}
export function useLocalDailyStatsRepository(): LocalDailyStatsRepository {
  return useAppContext().localDailyStatsRepository;
}
export function useFrontendProductService(): FrontendProductService {
  return useAppContext().frontendProductService;
}
export function useUserRepository(): UserRepository {
  return useAppContext().userRepository;
}
export function useActiveProductService(): ActiveProductService {
  return useAppContext().activeProductService;
}
export function useProductSearchService(): ProductSearchService {
  return useAppContext().productSearchService;
}
export function useCatalogStateService(): CatalogStateService {
  return useAppContext().catalogStateService;
}
export function useProductCatalogCoordinator(): ProductCatalogCoordinator {
  return useAppContext().productCatalogCoordinator;
}
export function useDatabaseManager(): DatabaseManager {
  return useAppContext().databaseManager;
}
