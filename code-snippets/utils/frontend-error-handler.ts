import { FrontendAppError, FrontendErrorCodes, ErrorSeverity, ErrorContext } from './FrontendAppError';
export function isError(error: unknown): error is Error {
  return error instanceof Error;
}
export function isFrontendAppError(error: unknown): error is FrontendAppError {
  return error instanceof FrontendAppError;
}
export function hasMessage(error: unknown): error is { message: string } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof (error as Record<string, unknown>).message === 'string'
  );
}
export function hasStack(error: unknown): error is { stack: string } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'stack' in error &&
    typeof (error as Record<string, unknown>).stack === 'string'
  );
}
export function hasErrorCode(error: unknown): error is { code: string } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof (error as Record<string, unknown>).code === 'string'
  );
}
export function hasStatusCode(error: unknown): error is { status?: number; statusCode?: number } {
  return (
    typeof error === 'object' &&
    error !== null &&
    ('status' in error || 'statusCode' in error)
  );
}
export function isNetworkError(error: unknown): boolean {
  if (!error) return false;
  const errorMessage = getErrorMessage(error).toLowerCase();
  const networkKeywords = [
    'network', 'connection', 'fetch', 'xhr', 'ajax', 'timeout',
    'offline', 'dns', 'unreachable', 'connectivity', 'abort'
  ];
  return networkKeywords.some(keyword => errorMessage.includes(keyword));
}
export function isAPIError(error: unknown): boolean {
  if (hasStatusCode(error)) {
    const err = error as { status?: number; statusCode?: number };
    const status = err.status || err.statusCode;
    return typeof status === 'number' && status >= 400;
  }
  return false;
}
export function isValidationError(error: unknown): boolean {
  const errorMessage = getErrorMessage(error).toLowerCase();
  const validationKeywords = ['validation', 'invalid', 'required', 'format', 'schema'];
  return validationKeywords.some(keyword => errorMessage.includes(keyword));
}
export function getErrorMessage(error: unknown): string {
  if (isError(error)) {
    return error.message;
  }
  if (hasMessage(error)) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  if (typeof error === 'object' && error !== null) {
    const err = error as Record<string, unknown>;
    if (err.data && typeof err.data === 'object' && err.data !== null) {
      const data = err.data as Record<string, unknown>;
      if (typeof data.message === 'string') return data.message;
    }
    if (err.response && typeof err.response === 'object' && err.response !== null) {
      const response = err.response as Record<string, unknown>;
      if (response.data && typeof response.data === 'object' && response.data !== null) {
        const data = response.data as Record<string, unknown>;
        if (typeof data.message === 'string') return data.message;
      }
    }
    if (err.error && typeof err.error === 'object' && err.error !== null) {
      const errorObj = err.error as Record<string, unknown>;
      if (typeof errorObj.message === 'string') return errorObj.message;
    }
    try {
      const stringified = JSON.stringify(error);
      if (stringified.length < 200) {
        return stringified;
      }
    } catch {
    }
  }
  return 'An unknown error occurred';
}
export function extractUserMessage(error: unknown, fallback = 'Something went wrong.'): string {
  if (error && typeof error === 'object') {
    const err = error as Record<string, unknown>;
    if (typeof err.userMessage === 'string' && err.userMessage) {
      return err.userMessage;
    }
    if (typeof err.message === 'string' && err.message) {
      return err.message;
    }
  }
  if (typeof error === 'string' && error) {
    return error;
  }
  return fallback;
}
export function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    const base: Record<string, unknown> = {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
    const rec = error as unknown as Record<string, unknown>;
    if (typeof rec.code === 'string') base.code = rec.code;
    if (typeof rec.statusCode === 'number') base.statusCode = rec.statusCode;
    if (typeof rec.userMessage === 'string') base.userMessage = rec.userMessage;
    if (rec.correlationId !== undefined) base.correlationId = rec.correlationId;
    return base;
  }
  if (error && typeof error === 'object') {
    return { ...(error as Record<string, unknown>) };
  }
  return { message: String(error) };
}
export function getErrorStack(error: unknown): string | undefined {
  if (isError(error)) {
    return error.stack;
  }
  if (hasStack(error)) {
    return error.stack;
  }
  return undefined;
}
export function getErrorCode(error: unknown): string | undefined {
  if (isFrontendAppError(error)) {
    return error.code;
  }
  if (hasErrorCode(error)) {
    return error.code;
  }
  return undefined;
}
export function getStatusCode(error: unknown): number | undefined {
  if (hasStatusCode(error)) {
    const err = error as { status?: number; statusCode?: number };
    return err.status || err.statusCode;
  }
  if (typeof error === 'object' && error !== null) {
    const err = error as Record<string, unknown>;
    if (err.response && typeof err.response === 'object' && err.response !== null) {
      const response = err.response as Record<string, unknown>;
      if (typeof response.status === 'number') return response.status;
      if (typeof response.statusCode === 'number') return response.statusCode;
    }
  }
  return undefined;
}
export function formatErrorForLogging(error: unknown, context?: ErrorContext): {
  message: string;
  code?: string;
  stack?: string;
  statusCode?: number;
  severity?: ErrorSeverity;
  correlationId?: string;
  context?: ErrorContext;
  originalError?: unknown;
} {
  const result = {
    message: getErrorMessage(error),
    code: getErrorCode(error),
    stack: getErrorStack(error),
    statusCode: getStatusCode(error),
    correlationId: context?.correlationId,
    context: context,
  };
  if (isFrontendAppError(error)) {
    return {
      ...result,
      severity: error.severity,
      correlationId: error.correlationId || context?.correlationId,
      originalError: error.originalError,
    };
  }
  return result;
}
export function toFrontendAppError(
  error: unknown,
  context?: ErrorContext,
  fallbackMessage?: string,
): FrontendAppError {
  if (isFrontendAppError(error)) {
    return error;
  }
  const message = getErrorMessage(error);
  const statusCode = getStatusCode(error);
  if (statusCode) {
    switch (statusCode) {
      case 400:
        return FrontendAppError.validation(message, undefined, context, error);
      case 401:
        return FrontendAppError.unauthorized(message, context, error);
      case 403:
        return FrontendAppError.forbidden(message, context, error);
      case 404:
        return FrontendAppError.notFound('Resource', context, error);
      case 409:
        return new FrontendAppError(
          FrontendErrorCodes.CONFLICT,
          message,
          'This operation conflicts with existing data. Please refresh and try again.',
          ErrorSeverity.MEDIUM,
          true,
          true,
          context,
          error,
        );
      case 429:
        return FrontendAppError.rateLimit(message, context, error);
      case 500:
      case 502:
      case 503:
      case 504:
        return new FrontendAppError(
          FrontendErrorCodes.INTERNAL_SERVER_ERROR,
          message,
          'Server error. Please try again later.',
          ErrorSeverity.HIGH,
          true,
          true,
          context,
          error,
        );
    }
  }
  if (isNetworkError(error)) {
    return FrontendAppError.networkError(message, context, error);
  }
  if (isValidationError(error)) {
    return FrontendAppError.validation(message, undefined, context, error);
  }
  const lowerMessage = message.toLowerCase();
  if (lowerMessage.includes('timeout')) {
    return FrontendAppError.timeout(message, context, error);
  }
  if (lowerMessage.includes('offline') || lowerMessage.includes('network')) {
    return FrontendAppError.offline(message, context);
  }
  if (lowerMessage.includes('permission') || lowerMessage.includes('access denied')) {
    return FrontendAppError.permissionDenied('required permission', context, error);
  }
  if (lowerMessage.includes('bluetooth')) {
    return FrontendAppError.bluetooth(message, context, error);
  }
  if (lowerMessage.includes('storage') || lowerMessage.includes('disk') || lowerMessage.includes('space')) {
    return FrontendAppError.localStorage('storage operation', context, error);
  }
  if (lowerMessage.includes('sync')) {
    return FrontendAppError.syncError(message, context, error);
  }
  if (lowerMessage.includes('ai') || lowerMessage.includes('analysis')) {
    return FrontendAppError.aiService(message, context, error);
  }
  return FrontendAppError.unknown(
    fallbackMessage || message || 'An unexpected error occurred',
    context,
    error,
  );
}
export function handleError(
  error: unknown,
  context?: ErrorContext,
  logger?: { error: (msg: string, data?: Record<string, unknown>) => void },
): FrontendAppError {
  const frontendError = toFrontendAppError(error, context);
  const errorInfo = formatErrorForLogging(frontendError, context);
  if (logger) {
    logger.error('Error occurred', errorInfo);
  } else {
    console.error('Error occurred', errorInfo);
  }
  return frontendError;
}
export function getUserFriendlyError(error: unknown, context?: ErrorContext): {
  title: string;
  message: string;
  severity: ErrorSeverity;
  retryable: boolean;
  actionable: boolean;
} {
  const frontendError = toFrontendAppError(error, context);
  return frontendError.toUserDisplay();
}
export function shouldNotifyUser(error: unknown): boolean {
  const frontendError = toFrontendAppError(error);
  return frontendError.shouldNotifyUser();
}
export function getRetryDelay(error: unknown): number {
  const frontendError = toFrontendAppError(error);
  return frontendError.getRetryDelay();
}
export function shouldEnterOfflineMode(error: unknown): boolean {
  return isNetworkError(error) || getStatusCode(error) === 503;
}
export function extractCorrelationId(error: unknown): string | undefined {
  if (isFrontendAppError(error)) {
    return error.correlationId;
  }
  if (typeof error === 'object' && error !== null) {
    const err = error as Record<string, unknown>;
    const patterns: unknown[] = [];
    if (err.response && typeof err.response === 'object' && err.response !== null) {
      const response = err.response as Record<string, unknown>;
      if (response.headers && typeof response.headers === 'object' && response.headers !== null) {
        const headers = response.headers as Record<string, unknown>;
        patterns.push(headers['x-correlation-id'], headers['correlation-id']);
      }
      if (response.data && typeof response.data === 'object' && response.data !== null) {
        const data = response.data as Record<string, unknown>;
        patterns.push(data.correlationId, data.requestId);
      }
    }
    if (err.headers && typeof err.headers === 'object' && err.headers !== null) {
      const headers = err.headers as Record<string, unknown>;
      patterns.push(headers['x-correlation-id']);
    }
    patterns.push(err.correlationId, err.requestId);
    for (const pattern of patterns) {
      if (typeof pattern === 'string') {
        return pattern;
      }
    }
  }
  return undefined;
}
export function getRecoverySuggestions(error: unknown): string[] {
  const frontendError = toFrontendAppError(error);
  const suggestions: string[] = [];
  switch (frontendError.code) {
    case FrontendErrorCodes.NETWORK_ERROR:
    case FrontendErrorCodes.OFFLINE_ERROR:
      suggestions.push('Check your internet connection');
      suggestions.push('Try again in a few moments');
      break;
    case FrontendErrorCodes.UNAUTHORIZED:
      suggestions.push('Log out and log in again');
      suggestions.push('Check your account status');
      break;
    case FrontendErrorCodes.PERMISSION_DENIED:
      suggestions.push('Check app permissions in device settings');
      suggestions.push('Restart the app');
      break;
    case FrontendErrorCodes.STORAGE_FULL:
      suggestions.push('Free up device storage space');
      suggestions.push('Clear app cache');
      break;
    case FrontendErrorCodes.BLUETOOTH_ERROR:
      suggestions.push('Check Bluetooth is enabled');
      suggestions.push('Try forgetting and re-pairing the device');
      break;
    case FrontendErrorCodes.RATE_LIMIT_EXCEEDED:
      suggestions.push('Wait a few minutes before trying again');
      break;
    default:
      if (frontendError.retryable) {
        suggestions.push('Try the operation again');
      }
      suggestions.push('Restart the app if the problem persists');
  }
  return suggestions;
}
export const useFrontendErrorHandler = () => {
  const handleError = (error: unknown, context?: ErrorContext) => {
    const frontendError = toFrontendAppError(error, context);
    const userDisplay = frontendError.toUserDisplay();
    const suggestions = getRecoverySuggestions(error);
    return {
      error: frontendError,
      userDisplay,
      suggestions,
      shouldNotify: frontendError.shouldNotifyUser(),
      retryable: frontendError.retryable,
      retryDelay: frontendError.getRetryDelay(),
    };
  };
  return { handleError };
};