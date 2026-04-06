import { BackendAPIClient } from '../api/BackendAPIClient';
import { logger } from '../../utils/logger';
import { metrics } from '../metrics/Metrics';
import type {
  BatchUpsertSamplesRequest,
  BatchUpsertSamplesResponse,
} from '@shared/contracts';
import type { HealthUploadHttpClient } from './HealthUploadEngine';
import { isFeatureEnabled } from '../../config/featureFlags';
import * as pako from 'pako';
const HEALTH_BATCH_UPSERT_ENDPOINT = '/health/samples/batch-upsert';
const GZIP_MIN_BYTES = 1024;
function utf8ByteLength(value: string): number {
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(value).length;
  }
  return unescape(encodeURIComponent(value)).length;
}
export class HealthUploadHttpClientImpl implements HealthUploadHttpClient {
  private readonly apiClient: BackendAPIClient;
  constructor(apiClient?: BackendAPIClient) {
    this.apiClient = apiClient ?? BackendAPIClient.getInstance();
  }
  async uploadBatch(
    request: BatchUpsertSamplesRequest,
    authToken: string
  ): Promise<BatchUpsertSamplesResponse> {
    const startTime = Date.now();
    const baseUrl = this.apiClient.getBaseUrl();
    const fullEndpoint = `${baseUrl}${HEALTH_BATCH_UPSERT_ENDPOINT}`;
    if (fullEndpoint.includes('/api/v1/api/v1')) {
      logger.error('[HealthUploadHttpClient] CRITICAL: Duplicate /api/v1 prefix detected!', {
        baseUrl,
        endpoint: HEALTH_BATCH_UPSERT_ENDPOINT,
        fullEndpoint,
        issue: 'URL misconfiguration will cause 404 errors',
        fix: 'Check EXPO_PUBLIC_API_URL - it should NOT include /api/v1 suffix if ApiConfig adds it',
      });
    }
    logger.debug('[HealthUploadHttpClient] Starting batch upload', {
      requestId: request.requestId,
      samplesCount: request.samples.length,
      deletionsCount: request.deleted?.length ?? 0,
      configVersion: request.configVersion,
      baseUrlHost: new URL(baseUrl).host,
      endpoint: HEALTH_BATCH_UPSERT_ENDPOINT,
    });
    try {
      const requestJson = JSON.stringify(request);
      const uncompressedBytes = utf8ByteLength(requestJson);
      let bodyType: 'json' | 'raw' = 'json';
      let requestBody: BatchUpsertSamplesRequest | Uint8Array = request;
      let contentEncoding = 'identity';
      let compressedBytes: number | undefined;
      const headers: Record<string, string> = {};
      const deviceTimezoneOffset = -new Date().getTimezoneOffset();
      headers['X-Timezone-Offset'] = String(deviceTimezoneOffset);
      if (isFeatureEnabled('healthGzip') && uncompressedBytes >= GZIP_MIN_BYTES) {
        const compressed = pako.gzip(requestJson);
        requestBody = compressed;
        bodyType = 'raw';
        contentEncoding = 'gzip';
        compressedBytes = compressed.byteLength;
        headers['Content-Encoding'] = 'gzip';
        headers['Content-Type'] = 'application/json';
      }
      if (metrics.isEnabled('metricsHealth')) {
        const effectiveBytes = compressedBytes ?? uncompressedBytes;
        const ratio = uncompressedBytes > 0 ? Number((effectiveBytes / uncompressedBytes).toFixed(4)) : 1;
        metrics.trackEvent('metricsHealth', 'health_upload_payload', {
          request_id: request.requestId,
          content_encoding: contentEncoding,
          bytes_uncompressed: uncompressedBytes,
          bytes_compressed: compressedBytes ?? uncompressedBytes,
          compression_ratio: ratio,
          samples_count: request.samples.length,
          deletions_count: request.deleted?.length ?? 0,
        });
      }
      const response = await this.apiClient.request<BatchUpsertSamplesResponse>({
        endpoint: HEALTH_BATCH_UPSERT_ENDPOINT,
        method: 'POST',
        body: requestBody,
        bodyType,
        headers: Object.keys(headers).length > 0 ? headers : undefined,
      });
      if (!response.success) {
        const apiError = response.error;
        if (apiError) {
          const error = new Error(apiError.message);
          Object.assign(error, apiError);
          throw error;
        }
        throw new Error('Request failed');
      }
      if (response.data === undefined) {
        throw new Error('API response missing data field');
      }
      const durationMs = Date.now() - startTime;
      type InnerResponseData = BatchUpsertSamplesResponse['data'];
      const innerData = response.data as unknown as InnerResponseData;
      if (!innerData || typeof innerData !== 'object') {
        logger.error('[HealthUploadHttpClient] Invalid response structure - innerData is null/undefined', {
          requestId: request.requestId,
          responseType: typeof response.data,
          durationMs,
        });
        throw new Error('Server returned invalid response structure: missing data');
      }
      if ('processing' in innerData && innerData.processing === true) {
        logger.info('[HealthUploadHttpClient] Batch accepted for async processing', {
          requestId: request.requestId,
          durationMs,
          retryAfterMs: innerData.retryAfterMs,
        });
        return {
          success: true,
          data: innerData,
          metadata: {
            requestId: request.requestId,
            timestamp: new Date().toISOString(),
          },
        };
      }
      type SuccessResponseData = Exclude<InnerResponseData, { processing: true }>;
      const successData = innerData as SuccessResponseData;
      if (!Array.isArray(successData.successful) || !Array.isArray(successData.failed)) {
        logger.error('[HealthUploadHttpClient] Invalid response structure - missing required arrays', {
          requestId: request.requestId,
          hasSuccessful: Array.isArray(successData.successful),
          hasFailed: Array.isArray(successData.failed),
          durationMs,
        });
        throw new Error('Server returned invalid response structure: missing successful/failed arrays');
      }
      const deletions = successData.deletions;
      logger.info('[HealthUploadHttpClient] Batch upload completed', {
        requestId: request.requestId,
        durationMs,
        samplesSuccessful: successData.successful.length,
        samplesFailed: successData.failed.length,
        deletionsSuccessful: deletions?.successful?.length ?? 0,
        deletionsFailed: deletions?.failed?.length ?? 0,
      });
      return {
        success: true,
        data: successData,
        metadata: {
          requestId: request.requestId,
          timestamp: new Date().toISOString(),
        },
      };
    } catch (error) {
      const durationMs = Date.now() - startTime;
      let errorInfo: { name: string; message: string; code?: string; statusCode?: number };
      if (error instanceof Error) {
        const errorWithProps = error as Error & { code?: string; statusCode?: number; status?: number };
        errorInfo = {
          name: error.name,
          message: error.message,
          code: typeof errorWithProps.code === 'string' ? errorWithProps.code : undefined,
          statusCode: errorWithProps.statusCode ?? errorWithProps.status,
        };
      } else {
        errorInfo = { name: 'Error', message: String(error) };
      }
      const is404Error = errorInfo.statusCode === 404 || errorInfo.message?.includes('404');
      logger.error('[HealthUploadHttpClient] Batch upload failed', {
        requestId: request.requestId,
        durationMs,
        error: errorInfo,
        ...(is404Error && {
          urlDebug: {
            baseUrl,
            endpoint: HEALTH_BATCH_UPSERT_ENDPOINT,
            fullEndpoint,
            possibleCause: 'Check for duplicate /api/v1 prefix in EXPO_PUBLIC_API_URL',
          },
        }),
      });
      throw error;
    }
  }
}
export function createHealthUploadHttpClient(): HealthUploadHttpClient {
  return new HealthUploadHttpClientImpl();
}
