import { DeviceIdManager } from '../../utils/DeviceIdManager';
import { isFeatureEnabled } from '../../config/featureFlags';
import { logger } from '../../utils/logger';
export const HEALTHKIT_SOURCE_ID = 'apple_healthkit' as const;
export const HEALTH_CONNECT_SOURCE_ID = 'google_health_connect' as const;
export interface SourceResolutionInput {
  readonly baseSourceId: string;
}
export interface ResolvedSource {
  readonly sourceId: string;
  readonly isDeviceScoped: boolean;
  readonly baseSourceId: string;
  readonly deviceId: string | null;
}
export async function resolveHealthSourceId(
  input: SourceResolutionInput
): Promise<ResolvedSource> {
  const { baseSourceId } = input;
  if (!isFeatureEnabled('healthSourceDeviceScope')) {
    return {
      sourceId: baseSourceId,
      isDeviceScoped: false,
      baseSourceId,
      deviceId: null,
    };
  }
  const deviceId = await DeviceIdManager.getDeviceId();
  if (!deviceId) {
    throw new Error(
      '[HealthSourceRegistry] deviceId unavailable for device-scoped sourceId. ' +
      'healthSourceDeviceScope feature flag is enabled but DeviceIdManager returned null.'
    );
  }
  const scopedSourceId = `${baseSourceId}:${deviceId}`;
  logger.info('[HealthSourceRegistry] Resolved device-scoped sourceId', {
    baseSourceId,
    scopedSourceId: `${baseSourceId}:${deviceId.substring(0, 8)}...`,
  });
  return {
    sourceId: scopedSourceId,
    isDeviceScoped: true,
    baseSourceId,
    deviceId,
  };
}
