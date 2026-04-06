import { Platform } from 'react-native';
import type { IHealthIngestionDriver } from '../types/ingestion-driver.types';
import { NativeHealthIngestionDriver } from './NativeHealthIngestionDriver';
import { JsHealthIngestionDriver } from './JsHealthIngestionDriver';
import type { JsHealthIngestionDriverDeps } from './JsHealthIngestionDriver';
import { isFeatureEnabled } from '../../../config/featureFlags';
import { logger } from '../../../utils/logger';
export type DriverFallbackPolicy = 'allow-fallback' | 'fail-fast';
export type DriverInitFailureReason =
  | 'flag_disabled'
  | 'platform_not_ios'
  | 'healthkit_unavailable'
  | 'native_module_error';
export class HealthDriverInitError extends Error {
  readonly reason: DriverInitFailureReason;
  readonly platform: string;
  readonly nativeIngestEnabled: boolean;
  readonly fallbackPolicy: DriverFallbackPolicy;
  readonly cause?: Error;
  constructor(params: {
    reason: DriverInitFailureReason;
    message: string;
    platform: string;
    nativeIngestEnabled: boolean;
    fallbackPolicy: DriverFallbackPolicy;
    cause?: Error;
  }) {
    super(params.message);
    this.name = 'HealthDriverInitError';
    this.reason = params.reason;
    this.platform = params.platform;
    this.nativeIngestEnabled = params.nativeIngestEnabled;
    this.fallbackPolicy = params.fallbackPolicy;
    this.cause = params.cause;
  }
  toDiagnostics(): Readonly<{
    name: string;
    reason: DriverInitFailureReason;
    message: string;
    platform: string;
    nativeIngestEnabled: boolean;
    fallbackPolicy: DriverFallbackPolicy;
    causeMessage: string | null;
  }> {
    return {
      name: this.name,
      reason: this.reason,
      message: this.message,
      platform: this.platform,
      nativeIngestEnabled: this.nativeIngestEnabled,
      fallbackPolicy: this.fallbackPolicy,
      causeMessage: this.cause?.message ?? null,
    };
  }
}
export interface CreateHealthIngestionDriverOptions {
  readonly jsDeps: JsHealthIngestionDriverDeps;
  readonly fallbackPolicy?: DriverFallbackPolicy;
}
export async function createHealthIngestionDriver(
  options: CreateHealthIngestionDriverOptions
): Promise<IHealthIngestionDriver> {
  const { jsDeps, fallbackPolicy = 'fail-fast' } = options;
  const platform = Platform.OS;
  const nativeIngestEnabled = isFeatureEnabled('healthNativeIngest');
  if (!nativeIngestEnabled) {
    logger.info('[createHealthIngestionDriver] Native ingest disabled by feature flag, using JS driver');
    const driver = new JsHealthIngestionDriver(jsDeps);
    logDriverDegradation(driver);
    return driver;
  }
  if (platform !== 'ios') {
    logger.info('[createHealthIngestionDriver] Not iOS platform, using JS driver', {
      platform,
    });
    const driver = new JsHealthIngestionDriver(jsDeps);
    logDriverDegradation(driver);
    return driver;
  }
  try {
    const nativeDriver = new NativeHealthIngestionDriver();
    const available = await nativeDriver.isAvailable();
    if (available) {
      logger.info('[createHealthIngestionDriver] Native driver available and selected');
      logDriverDegradation(nativeDriver);
      return nativeDriver;
    }
    nativeDriver.dispose();
    return handleNativeFallback({
      reason: 'healthkit_unavailable',
      message: 'Native module exists but HealthKit is unavailable on this device',
      platform,
      nativeIngestEnabled,
      fallbackPolicy,
      jsDeps,
    });
  } catch (error: unknown) {
    if (error instanceof HealthDriverInitError) {
      throw error;
    }
    const cause = error instanceof Error ? error : new Error(String(error));
    return handleNativeFallback({
      reason: 'native_module_error',
      message: `Native driver initialization failed: ${cause.message}`,
      platform,
      nativeIngestEnabled,
      fallbackPolicy,
      jsDeps,
      cause,
    });
  }
}
export async function createHealthIngestionDriverLegacy(
  jsDeps: JsHealthIngestionDriverDeps
): Promise<IHealthIngestionDriver> {
  return createHealthIngestionDriver({
    jsDeps,
    fallbackPolicy: 'allow-fallback',
  });
}
function handleNativeFallback(params: {
  reason: DriverInitFailureReason;
  message: string;
  platform: string;
  nativeIngestEnabled: boolean;
  fallbackPolicy: DriverFallbackPolicy;
  jsDeps: JsHealthIngestionDriverDeps;
  cause?: Error;
}): IHealthIngestionDriver {
  const { reason, message, platform, nativeIngestEnabled, fallbackPolicy, jsDeps, cause } = params;
  if (fallbackPolicy === 'fail-fast') {
    const error = new HealthDriverInitError({
      reason,
      message: `[createHealthIngestionDriver] ${message}. Fallback to JS is disallowed (fallbackPolicy='fail-fast'). ` +
        'Set healthJsFallbackInProd=true as emergency kill switch, or fix native driver.',
      platform,
      nativeIngestEnabled,
      fallbackPolicy,
      cause,
    });
    logger.error('[createHealthIngestionDriver] Native driver failed, fallback DENIED', error.toDiagnostics());
    throw error;
  }
  logger.error('[createHealthIngestionDriver] Native driver failed, falling back to JS driver (DEGRADED MODE)', {
    reason,
    message,
    platform,
    nativeIngestEnabled,
    fallbackPolicy,
    ...(cause && { causeMessage: cause.message }),
    warning: 'JS driver lacks native OperationQueue parallelism and two-pass HOT catch-up. See ADR-001.',
  });
  const driver = new JsHealthIngestionDriver(jsDeps);
  logDriverDegradation(driver);
  return driver;
}
function logDriverDegradation(driver: IHealthIngestionDriver): void {
  const degradations = driver.getDegradation();
  if (degradations.size === 0) {
    logger.info('[createHealthIngestionDriver] Driver fully contract-compliant', {
      driverId: driver.driverId,
    });
    return;
  }
  for (const [lane, degradation] of degradations) {
    logger.warn('[createHealthIngestionDriver] Lane operating in DEGRADED mode', {
      driverId: driver.driverId,
      lane,
      reason: degradation.reason,
      description: degradation.description,
      functionallyCorrect: degradation.functionallyCorrect,
    });
  }
}
