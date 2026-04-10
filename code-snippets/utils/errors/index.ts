import type { ErrorContext } from '../FrontendAppError';
import { toFrontendAppError, getRecoverySuggestions } from '../frontend-error-handler';
import { frontendLogger } from '../FrontendLoggerService';
export {
  FrontendAppError,
  FrontendErrorCodes,
  ErrorSeverity,
  ErrorContext,
  isOperationalError,
  isRetryableError,
  getErrorCorrelationId,
} from '../FrontendAppError';
export {
  isError,
  isFrontendAppError,
  hasMessage,
  hasStack,
  hasErrorCode,
  hasStatusCode,
  isNetworkError,
  isAPIError,
  isValidationError,
  getErrorMessage,
  extractUserMessage,
  serializeError,
  getErrorStack,
  getErrorCode,
  getStatusCode,
  formatErrorForLogging,
  toFrontendAppError,
  handleError,
  getUserFriendlyError,
  shouldNotifyUser,
  getRetryDelay,
  shouldEnterOfflineMode,
  extractCorrelationId,
  getRecoverySuggestions,
  useFrontendErrorHandler,
} from '../frontend-error-handler';
export {
  FrontendLoggerService,
  frontendLogger,
  LogLevel,
  LogCategory,
  LogEntry,
  LogError,
  APIRequestLog,
  APIResponseLog,
  LoggerConfig,
  LogMetrics,
} from '../FrontendLoggerService';
export function createErrorHandler(component: string) {
  return {
    handle: (error: unknown, context?: Partial<ErrorContext>) => {
      const fullContext: ErrorContext = {
        component,
        ...context,
      };
      const frontendError = toFrontendAppError(error, fullContext);
      const userDisplay = frontendError.toUserDisplay();
      const suggestions = getRecoverySuggestions(error);
      frontendLogger.error(
        `Error in ${component}`,
        error,
        {
          correlationId: fullContext.correlationId,
          component,
          operation: fullContext.operation,
        }
      );
      return {
        error: frontendError,
        userDisplay,
        suggestions,
        shouldNotify: frontendError.shouldNotifyUser(),
        retryable: frontendError.retryable,
        retryDelay: frontendError.getRetryDelay(),
        correlationId: frontendError.correlationId,
      };
    },
    logError: (message: string, error?: unknown, context?: Partial<ErrorContext>) => {
      frontendLogger.error(message, error, {
        component,
        ...context,
      });
    },
    logWarning: (message: string, data?: Record<string, unknown>, context?: Partial<ErrorContext>) => {
      frontendLogger.warn(message, data, {
        component,
        ...context,
      });
    },
    logInfo: (message: string, data?: Record<string, unknown>, context?: Partial<ErrorContext>) => {
      frontendLogger.info(message, data, {
        component,
        ...context,
      });
    },
  };
}
export function generateCorrelationId(): string {
  return `frontend_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}
export class GlobalErrorBoundary {
  static handleError(error: Error, errorInfo?: Record<string, unknown>): void {
    const frontendError = toFrontendAppError(error, {
      component: 'GlobalErrorBoundary',
      operation: 'react_error_boundary',
    });
    frontendLogger.fatal(
      'Unhandled React error',
      error,
      {
        component: 'GlobalErrorBoundary',
        operation: 'react_error_boundary',
      }
    );
    console.error('Global error boundary caught error:', frontendError.toJSON());
  }
}
export { logger as legacyLogger } from '../logger';