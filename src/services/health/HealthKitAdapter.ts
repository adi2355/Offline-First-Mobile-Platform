import { Platform } from 'react-native';
import {
  queryQuantitySamplesWithAnchor,
  queryCategorySamplesWithAnchor,
  queryQuantitySamples,
  queryCategorySamples,
  isHealthDataAvailable,
} from '@kingstinct/react-native-healthkit';
import type { QuantitySample } from '@kingstinct/react-native-healthkit';
import type {
  HealthDataProviderAdapter,
  AnchoredQueryResult,
  GenericQuantitySample,
  GenericCategorySample,
  MetricIngestionConfig,
} from './HealthIngestionEngine';
import { HEALTHKIT_SOURCE_ID } from './HealthIngestionEngine';
import type { HealthMetricCode, HealthMetricValueKind } from '@shared/contracts';
import { getValueKind } from '@shared/contracts';
import { logger } from '../../utils/logger';
type HealthKitDevice = {
  localIdentifier?: string | null;
  manufacturer?: string | null;
  hardwareVersion?: string | null;
  model?: string | null;
  softwareVersion?: string | null;
};
type HealthKitSourceRevision = {
  source?: {
    bundleIdentifier?: string;
    toJSON?: () => { bundleIdentifier?: string };
  } | null;
  version?: string | null;
  operatingSystemVersion?: string | null;
};
type HealthKitMetadataMap = {
  metadata?: Record<string, unknown>;
  deviceId?: string;
  externalUuid?: string;
};
function buildHealthKitMetadata(params: {
  identifier: string;
  isCategory: boolean;
  rawMetadata?: Record<string, unknown> | null;
  device?: HealthKitDevice | null;
  sourceRevision?: HealthKitSourceRevision | null;
}): HealthKitMetadataMap {
  const { identifier, isCategory, rawMetadata, device, sourceRevision } = params;
  const metadata: Record<string, unknown> = {};
  const source = sourceRevision?.source?.toJSON?.() ?? sourceRevision?.source;
  if (source?.bundleIdentifier) {
    metadata.sourceAppId = source.bundleIdentifier;
  }
  if (sourceRevision?.version) {
    metadata.sourceAppVersion = sourceRevision.version;
  }
  if (device?.manufacturer) {
    metadata.deviceManufacturer = device.manufacturer;
  }
  if (device?.hardwareVersion) {
    metadata.deviceModel = device.hardwareVersion;
  } else if (device?.model) {
    metadata.deviceModel = device.model;
  }
  if (sourceRevision?.operatingSystemVersion) {
    metadata.osVersion = sourceRevision.operatingSystemVersion;
  } else if (device?.softwareVersion) {
    metadata.osVersion = device.softwareVersion;
  }
  metadata.osName = 'iOS';
  if (isCategory) {
    metadata.hkCategoryType = identifier;
  } else {
    metadata.hkQuantityType = identifier;
  }
  const wasUserEntered = rawMetadata?.HKWasUserEntered;
  if (wasUserEntered === true) {
    metadata.isManualEntry = true;
    metadata.dataSource = 'manual';
  }
  const externalUuid = rawMetadata?.HKExternalUUID;
  const deviceId = device?.localIdentifier ?? undefined;
  return {
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    deviceId,
    externalUuid: externalUuid ? String(externalUuid) : undefined,
  };
}
export const HKCategoryValueSleepAnalysis = {
  inBed: 0,
  asleepUnspecified: 1,
  awake: 2,
  asleepCore: 3,  
  asleepDeep: 4,
  asleepREM: 5,
} as const;
export function mapSleepAnalysisToCategory(value: number): string | null {
  switch (value) {
    case HKCategoryValueSleepAnalysis.inBed:
      return 'unknown'; 
    case HKCategoryValueSleepAnalysis.asleepUnspecified:
      return 'unknown';
    case HKCategoryValueSleepAnalysis.awake:
      return 'awake';
    case HKCategoryValueSleepAnalysis.asleepCore:
      return 'light';
    case HKCategoryValueSleepAnalysis.asleepDeep:
      return 'deep';
    case HKCategoryValueSleepAnalysis.asleepREM:
      return 'rem';
    default:
      logger.warn('[HealthKitAdapter] Unknown sleep analysis value', { value });
      return null;
  }
}
export const HEALTHKIT_TO_CANONICAL_MAP: Readonly<Record<string, HealthMetricCode>> = Object.freeze({
  'HKQuantityTypeIdentifierHeartRate': 'heart_rate',
  'HKQuantityTypeIdentifierHeartRateVariabilitySDNN': 'heart_rate_variability',
  'HKQuantityTypeIdentifierRestingHeartRate': 'resting_heart_rate',
  'HKQuantityTypeIdentifierOxygenSaturation': 'blood_oxygen',
  'HKQuantityTypeIdentifierRespiratoryRate': 'respiratory_rate',
  'HKQuantityTypeIdentifierBodyTemperature': 'body_temperature',
  'HKQuantityTypeIdentifierStepCount': 'steps',
  'HKQuantityTypeIdentifierDistanceWalkingRunning': 'distance_walking_running',
  'HKQuantityTypeIdentifierActiveEnergyBurned': 'active_energy_burned',
  'HKQuantityTypeIdentifierBasalEnergyBurned': 'basal_energy_burned',
  'HKQuantityTypeIdentifierFlightsClimbed': 'flights_climbed',
  'HKQuantityTypeIdentifierAppleExerciseTime': 'exercise_minutes',
  'HKQuantityTypeIdentifierBodyMass': 'weight',
  'HKQuantityTypeIdentifierHeight': 'height',
  'HKQuantityTypeIdentifierBodyMassIndex': 'body_mass_index',
  'HKQuantityTypeIdentifierBodyFatPercentage': 'body_fat_percentage',
  'HKQuantityTypeIdentifierLeanBodyMass': 'lean_body_mass',
  'HKQuantityTypeIdentifierWaistCircumference': 'waist_circumference',
  'HKCategoryTypeIdentifierSleepAnalysis': 'sleep_stage',
  'HKCategoryTypeIdentifierAppleStandHour': 'stand_hours',
  'HKCategoryTypeIdentifierMindfulSession': 'mindful_minutes',
  'HKQuantityTypeIdentifierEnvironmentalAudioExposure': 'audio_exposure',
});
export const CANONICAL_TO_HEALTHKIT_MAP: Readonly<Record<HealthMetricCode, string>> = Object.freeze(
  Object.fromEntries(
    Object.entries(HEALTHKIT_TO_CANONICAL_MAP).map(([hk, canonical]) => [canonical, hk])
  ) as Record<HealthMetricCode, string>
);
export const HEALTHKIT_QUERY_UNITS: Readonly<Record<string, string>> = Object.freeze({
  'HKQuantityTypeIdentifierHeartRate': 'count/min',
  'HKQuantityTypeIdentifierHeartRateVariabilitySDNN': 'ms',
  'HKQuantityTypeIdentifierRestingHeartRate': 'count/min',
  'HKQuantityTypeIdentifierOxygenSaturation': '%',
  'HKQuantityTypeIdentifierRespiratoryRate': 'count/min',
  'HKQuantityTypeIdentifierBodyTemperature': 'degC',
  'HKQuantityTypeIdentifierStepCount': 'count',
  'HKQuantityTypeIdentifierDistanceWalkingRunning': 'm',
  'HKQuantityTypeIdentifierActiveEnergyBurned': 'kcal',
  'HKQuantityTypeIdentifierBasalEnergyBurned': 'kcal',
  'HKQuantityTypeIdentifierFlightsClimbed': 'count',
  'HKQuantityTypeIdentifierAppleExerciseTime': 'min',
  'HKQuantityTypeIdentifierBodyMass': 'kg',
  'HKQuantityTypeIdentifierHeight': 'cm',
  'HKQuantityTypeIdentifierBodyMassIndex': 'count', 
  'HKQuantityTypeIdentifierBodyFatPercentage': '%',
  'HKQuantityTypeIdentifierLeanBodyMass': 'kg',
  'HKQuantityTypeIdentifierWaistCircumference': 'cm',
  'HKQuantityTypeIdentifierEnvironmentalAudioExposure': 'dBASPL',
});
export function getHealthKitMetricConfigs(): MetricIngestionConfig[] {
  const configs: MetricIngestionConfig[] = [];
  const quantityTypes: Array<{
    identifier: string;
    metricCode: HealthMetricCode;
  }> = [
    { identifier: 'HKQuantityTypeIdentifierHeartRate', metricCode: 'heart_rate' },
    { identifier: 'HKQuantityTypeIdentifierHeartRateVariabilitySDNN', metricCode: 'heart_rate_variability' },
    { identifier: 'HKQuantityTypeIdentifierRestingHeartRate', metricCode: 'resting_heart_rate' },
    { identifier: 'HKQuantityTypeIdentifierOxygenSaturation', metricCode: 'blood_oxygen' },
    { identifier: 'HKQuantityTypeIdentifierRespiratoryRate', metricCode: 'respiratory_rate' },
    { identifier: 'HKQuantityTypeIdentifierBodyTemperature', metricCode: 'body_temperature' },
    { identifier: 'HKQuantityTypeIdentifierStepCount', metricCode: 'steps' },
    { identifier: 'HKQuantityTypeIdentifierDistanceWalkingRunning', metricCode: 'distance_walking_running' },
    { identifier: 'HKQuantityTypeIdentifierActiveEnergyBurned', metricCode: 'active_energy_burned' },
    { identifier: 'HKQuantityTypeIdentifierBasalEnergyBurned', metricCode: 'basal_energy_burned' },
    { identifier: 'HKQuantityTypeIdentifierFlightsClimbed', metricCode: 'flights_climbed' },
    { identifier: 'HKQuantityTypeIdentifierAppleExerciseTime', metricCode: 'exercise_minutes' },
    { identifier: 'HKQuantityTypeIdentifierBodyMass', metricCode: 'weight' },
    { identifier: 'HKQuantityTypeIdentifierHeight', metricCode: 'height' },
    { identifier: 'HKQuantityTypeIdentifierBodyMassIndex', metricCode: 'body_mass_index' },
    { identifier: 'HKQuantityTypeIdentifierBodyFatPercentage', metricCode: 'body_fat_percentage' },
    { identifier: 'HKQuantityTypeIdentifierLeanBodyMass', metricCode: 'lean_body_mass' },
    { identifier: 'HKQuantityTypeIdentifierWaistCircumference', metricCode: 'waist_circumference' },
    { identifier: 'HKQuantityTypeIdentifierEnvironmentalAudioExposure', metricCode: 'audio_exposure' },
  ];
  for (const { identifier, metricCode } of quantityTypes) {
    configs.push({
      metricCode,
      providerIdentifier: identifier,
      valueKind: getValueKind(metricCode),
      queryUnit: HEALTHKIT_QUERY_UNITS[identifier],
      isCategory: false,
    });
  }
  configs.push({
    metricCode: 'sleep_stage',
    providerIdentifier: 'HKCategoryTypeIdentifierSleepAnalysis',
    valueKind: 'CATEGORY',
    isCategory: true,
    categoryCodeMapper: mapSleepAnalysisToCategory,
  });
  configs.push({
    metricCode: 'stand_hours',
    providerIdentifier: 'HKCategoryTypeIdentifierAppleStandHour',
    valueKind: 'CUMULATIVE_NUM', 
    isCategory: true,
  });
  return configs;
}
export class HealthKitAdapter implements HealthDataProviderAdapter {
  async queryQuantitySamplesWithAnchor(
    identifier: string,
    options: { anchor?: string | null; unit?: string; limit?: number }
  ): Promise<AnchoredQueryResult<GenericQuantitySample>> {
    try {
      const result = await queryQuantitySamplesWithAnchor(
        identifier as any, 
        {
          anchor: options.anchor ?? undefined,
          unit: options.unit,
          limit: options.limit,
        }
      );
      const samples: GenericQuantitySample[] = result.samples.map((sample) => {
        const mapped = buildHealthKitMetadata({
          identifier,
          isCategory: false,
          rawMetadata: sample.metadata as Record<string, unknown> | undefined,
          device: sample.device ?? null,
          sourceRevision: sample.sourceRevision ?? null,
        });
        return {
          uuid: sample.uuid,
          startDate: new Date(sample.startDate),
          endDate: new Date(sample.endDate),
          quantity: sample.quantity,
          unit: options.unit ?? '',
          device: sample.device ? { name: sample.device.name ?? undefined } : undefined,
          metadata: mapped.metadata,
          deviceId: mapped.deviceId,
          externalUuid: mapped.externalUuid,
        };
      });
      const deletedSamples = result.deletedSamples.map((d) => ({ uuid: d.uuid }));
      logger.debug('[HealthKitAdapter] Quantity query completed', {
        identifier,
        samplesCount: samples.length,
        deletedCount: deletedSamples.length,
        hasNewAnchor: !!result.newAnchor,
      });
      return {
        samples,
        deletedSamples,
        newAnchor: result.newAnchor,
      };
    } catch (error) {
      logger.error('[HealthKitAdapter] Quantity query failed', {
        identifier,
        error: error instanceof Error
          ? { name: error.name, message: error.message }
          : { name: 'Error', message: String(error) },
      });
      throw error;
    }
  }
  async queryCategorySamplesWithAnchor(
    identifier: string,
    options: { anchor?: string | null; limit?: number }
  ): Promise<AnchoredQueryResult<GenericCategorySample>> {
    try {
      const result = await queryCategorySamplesWithAnchor(
        identifier as any, 
        {
          anchor: options.anchor ?? undefined,
          limit: options.limit,
        }
      );
      const samples: GenericCategorySample[] = result.samples.map((sample) => {
        const mapped = buildHealthKitMetadata({
          identifier,
          isCategory: true,
          rawMetadata: sample.metadata as Record<string, unknown> | undefined,
          device: sample.device ?? null,
          sourceRevision: sample.sourceRevision ?? null,
        });
        return {
          uuid: sample.uuid,
          startDate: new Date(sample.startDate),
          endDate: new Date(sample.endDate),
          value: sample.value,
          device: sample.device ? { name: sample.device.name ?? undefined } : undefined,
          metadata: mapped.metadata,
          deviceId: mapped.deviceId,
          externalUuid: mapped.externalUuid,
        };
      });
      const deletedSamples = result.deletedSamples.map((d) => ({ uuid: d.uuid }));
      logger.debug('[HealthKitAdapter] Category query completed', {
        identifier,
        samplesCount: samples.length,
        deletedCount: deletedSamples.length,
        hasNewAnchor: !!result.newAnchor,
      });
      return {
        samples,
        deletedSamples,
        newAnchor: result.newAnchor,
      };
    } catch (error) {
      logger.error('[HealthKitAdapter] Category query failed', {
        identifier,
        error: error instanceof Error
          ? { name: error.name, message: error.message }
          : { name: 'Error', message: String(error) },
      });
      throw error;
    }
  }
  async queryRecentQuantitySamples(
    identifier: string,
    options: {
      fromDate: Date;
      toDate?: Date;
      unit?: string;
      limit?: number;
      ascending?: boolean;
    }
  ): Promise<{ samples: GenericQuantitySample[] }> {
    try {
      const result = await queryQuantitySamples(
        identifier as any, 
        {
          filter: {
            startDate: options.fromDate,
            endDate: options.toDate ?? new Date(),
          },
          unit: options.unit,
          limit: options.limit,
          ascending: options.ascending ?? false, 
        }
      );
      const samples: GenericQuantitySample[] = result.map((sample) => {
        const mapped = buildHealthKitMetadata({
          identifier,
          isCategory: false,
          rawMetadata: sample.metadata as Record<string, unknown> | undefined,
          device: sample.device ?? null,
          sourceRevision: sample.sourceRevision ?? null,
        });
        return {
          uuid: sample.uuid,
          startDate: new Date(sample.startDate),
          endDate: new Date(sample.endDate),
          quantity: sample.quantity,
          unit: options.unit ?? '',
          device: sample.device ? { name: sample.device.name ?? undefined } : undefined,
          metadata: mapped.metadata,
          deviceId: mapped.deviceId,
          externalUuid: mapped.externalUuid,
        };
      });
      logger.info('[HealthKitAdapter] Recent data query completed', {
        identifier,
        samplesCount: samples.length,
        fromDate: options.fromDate.toISOString(),
        toDate: (options.toDate ?? new Date()).toISOString(),
        ascending: options.ascending ?? false,
      });
      return { samples };
    } catch (error) {
      logger.error('[HealthKitAdapter] Recent data query failed', {
        identifier,
        error: error instanceof Error
          ? { name: error.name, message: error.message }
          : { name: 'Error', message: String(error) },
      });
      throw error;
    }
  }
  async queryRecentCategorySamples(
    identifier: string,
    options: {
      fromDate: Date;
      toDate?: Date;
      limit?: number;
      ascending?: boolean;
    }
  ): Promise<{ samples: GenericCategorySample[] }> {
    try {
      const result = await (queryCategorySamples as any)(
        identifier,
        {
          filter: {
            startDate: options.fromDate,
            endDate: options.toDate ?? new Date(),
          },
          limit: options.limit,
          ascending: options.ascending ?? false, 
        }
      );
      const samples: GenericCategorySample[] = (result as any[]).map((sample: any) => {
        const mapped = buildHealthKitMetadata({
          identifier,
          isCategory: true,
          rawMetadata: sample.metadata as Record<string, unknown> | undefined,
          device: sample.device ?? null,
          sourceRevision: sample.sourceRevision ?? null,
        });
        return {
          uuid: sample.uuid,
          startDate: new Date(sample.startDate),
          endDate: new Date(sample.endDate),
          value: sample.value,
          device: sample.device ? { name: sample.device.name ?? undefined } : undefined,
          metadata: mapped.metadata,
          deviceId: mapped.deviceId,
          externalUuid: mapped.externalUuid,
        };
      });
      logger.info('[HealthKitAdapter] Recent category data query completed', {
        identifier,
        samplesCount: samples.length,
        fromDate: options.fromDate.toISOString(),
        toDate: (options.toDate ?? new Date()).toISOString(),
        ascending: options.ascending ?? false,
      });
      return { samples };
    } catch (error) {
      logger.error('[HealthKitAdapter] Recent category data query failed', {
        identifier,
        error: error instanceof Error
          ? { name: error.name, message: error.message }
          : { name: 'Error', message: String(error) },
      });
      throw error;
    }
  }
  getSourceId(): string {
    return HEALTHKIT_SOURCE_ID;
  }
  isAvailable(): boolean {
    if (Platform.OS !== 'ios') {
      return false;
    }
    try {
      return true;
    } catch {
      return false;
    }
  }
  async isAvailableAsync(): Promise<boolean> {
    if (Platform.OS !== 'ios') {
      return false;
    }
    try {
      return await isHealthDataAvailable();
    } catch {
      return false;
    }
  }
}
export function createHealthKitAdapter(): HealthKitAdapter | null {
  if (Platform.OS !== 'ios') {
    logger.debug('[HealthKitAdapter] Not creating adapter - not iOS platform');
    return null;
  }
  return new HealthKitAdapter();
}
