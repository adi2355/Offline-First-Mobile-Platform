export const FrontendErrorCodes = {
  NETWORK_ERROR: 'NETWORK_ERROR',
  CONNECTION_TIMEOUT: 'CONNECTION_TIMEOUT',
  REQUEST_TIMEOUT: 'REQUEST_TIMEOUT',
  OFFLINE_ERROR: 'OFFLINE_ERROR',
  API_ERROR: 'API_ERROR',
  BAD_REQUEST: 'BAD_REQUEST',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  RATE_LIMIT_EXCEEDED: 'RATE_LIMIT_EXCEEDED',
  INTERNAL_SERVER_ERROR: 'INTERNAL_SERVER_ERROR',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  INVALID_INPUT: 'INVALID_INPUT',
  REQUIRED_FIELD_MISSING: 'REQUIRED_FIELD_MISSING',
  INVALID_FORMAT: 'INVALID_FORMAT',
  LOCAL_STORAGE_ERROR: 'LOCAL_STORAGE_ERROR',
  DATABASE_ERROR: 'DATABASE_ERROR',
  STORAGE_FULL: 'STORAGE_FULL',
  SYNC_ERROR: 'SYNC_ERROR',
  CONFLICT_RESOLUTION_ERROR: 'CONFLICT_RESOLUTION_ERROR',
  INVALID_OPERATION: 'INVALID_OPERATION',
  INSUFFICIENT_PERMISSIONS: 'INSUFFICIENT_PERMISSIONS',
  RESOURCE_NOT_AVAILABLE: 'RESOURCE_NOT_AVAILABLE',
  OPERATION_NOT_ALLOWED: 'OPERATION_NOT_ALLOWED',
  PREDICTION_INSUFFICIENT_DATA: 'PREDICTION_INSUFFICIENT_DATA',
  DEVICE_ERROR: 'DEVICE_ERROR',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  BLUETOOTH_ERROR: 'BLUETOOTH_ERROR',
  CAMERA_ERROR: 'CAMERA_ERROR',
  LOCATION_ERROR: 'LOCATION_ERROR',
  AI_SERVICE_ERROR: 'AI_SERVICE_ERROR',
  AI_RATE_LIMIT: 'AI_RATE_LIMIT',
  AI_PARSING_ERROR: 'AI_PARSING_ERROR',
  ANALYSIS_ERROR: 'ANALYSIS_ERROR',
  CONFIGURATION_ERROR: 'CONFIGURATION_ERROR',
  INITIALIZATION_ERROR: 'INITIALIZATION_ERROR',
  DEPENDENCY_ERROR: 'DEPENDENCY_ERROR',
  UNKNOWN_ERROR: 'UNKNOWN_ERROR',
  UNEXPECTED_ERROR: 'UNEXPECTED_ERROR',
  NOT_IMPLEMENTED: 'NOT_IMPLEMENTED',
} as const;
export type FrontendErrorCode = typeof FrontendErrorCodes[keyof typeof FrontendErrorCodes];
export enum ErrorSeverity {
  LOW = 'low',           
  MEDIUM = 'medium',     
  HIGH = 'high',         
  CRITICAL = 'critical', 
}
export interface ErrorContext {
  correlationId?: string;
  userId?: string;
  component?: string;
  operation?: string;
  endpoint?: string;
  requestId?: string;
  deviceInfo?: {
    platform?: string;
    version?: string;
    model?: string;
  };
  timestamp?: number;
  [key: string]: unknown;
}
export class FrontendAppError extends Error {
  public readonly code: FrontendErrorCode;
  public readonly severity: ErrorSeverity;
  public readonly isOperational: boolean;
  public readonly userMessage: string;
  public readonly context?: ErrorContext;
  public readonly originalError?: unknown;
  public readonly retryable: boolean;
  public readonly correlationId?: string;
  constructor(
    code: FrontendErrorCode,
    message: string,
    userMessage: string,
    severity: ErrorSeverity = ErrorSeverity.MEDIUM,
    isOperational: boolean = true,
    retryable: boolean = false,
    context?: ErrorContext,
    originalError?: unknown,
  ) {
    super(message);
    this.name = 'FrontendAppError';
    this.code = code;
    this.severity = severity;
    this.isOperational = isOperational;
    this.userMessage = userMessage;
    this.retryable = retryable;
    this.context = context;
    this.originalError = originalError;
    this.correlationId = context?.correlationId;
    Error.captureStackTrace?.(this, FrontendAppError);
  }
  static networkError(
    message: string = 'Network connection failed',
    context?: ErrorContext,
    originalError?: unknown,
  ): FrontendAppError {
    return new FrontendAppError(
      FrontendErrorCodes.NETWORK_ERROR,
      message,
      'Unable to connect to the server. Please check your internet connection and try again.',
      ErrorSeverity.HIGH,
      true,
      true,
      context,
      originalError,
    );
  }
  static timeout(
    message: string = 'Request timed out',
    context?: ErrorContext,
    originalError?: unknown,
  ): FrontendAppError {
    return new FrontendAppError(
      FrontendErrorCodes.REQUEST_TIMEOUT,
      message,
      'The request is taking longer than expected. Please try again.',
      ErrorSeverity.MEDIUM,
      true,
      true,
      context,
      originalError,
    );
  }
  static offline(
    message: string = 'Device is offline',
    context?: ErrorContext,
  ): FrontendAppError {
    return new FrontendAppError(
      FrontendErrorCodes.OFFLINE_ERROR,
      message,
      'You appear to be offline. Some features may be limited until you reconnect.',
      ErrorSeverity.MEDIUM,
      true,
      false,
      context,
    );
  }
  static unauthorized(
    message: string = 'Authentication failed',
    context?: ErrorContext,
    originalError?: unknown,
  ): FrontendAppError {
    return new FrontendAppError(
      FrontendErrorCodes.UNAUTHORIZED,
      message,
      'Authentication failed. Please log in again.',
      ErrorSeverity.CRITICAL,
      true,
      false,
      context,
      originalError,
    );
  }
  static forbidden(
    message: string = 'Access forbidden',
    context?: ErrorContext,
    originalError?: unknown,
  ): FrontendAppError {
    return new FrontendAppError(
      FrontendErrorCodes.FORBIDDEN,
      message,
      'You do not have permission to perform this action.',
      ErrorSeverity.HIGH,
      true,
      false,
      context,
      originalError,
    );
  }
  static notFound(
    resource: string,
    context?: ErrorContext,
    originalError?: unknown,
  ): FrontendAppError {
    return new FrontendAppError(
      FrontendErrorCodes.NOT_FOUND,
      `${resource} not found`,
      'The requested information could not be found.',
      ErrorSeverity.MEDIUM,
      true,
      false,
      context,
      originalError,
    );
  }
  static rateLimit(
    message: string = 'Rate limit exceeded',
    context?: ErrorContext,
    originalError?: unknown,
  ): FrontendAppError {
    return new FrontendAppError(
      FrontendErrorCodes.RATE_LIMIT_EXCEEDED,
      message,
      'Too many requests. Please wait a moment and try again.',
      ErrorSeverity.MEDIUM,
      true,
      true,
      context,
      originalError,
    );
  }
  static validation(
    message: string,
    field?: string,
    context?: ErrorContext,
    originalError?: unknown,
  ): FrontendAppError {
    const userMessage = field
      ? `Please check the ${field} field and try again.`
      : 'Please check your input and try again.';
    return new FrontendAppError(
      FrontendErrorCodes.VALIDATION_ERROR,
      message,
      userMessage,
      ErrorSeverity.LOW,
      true,
      true,
      { ...context, field },
      originalError,
    );
  }
  static invalidInput(
    field: string,
    value?: unknown,
    context?: ErrorContext,
  ): FrontendAppError {
    return new FrontendAppError(
      FrontendErrorCodes.INVALID_INPUT,
      `Invalid input for field: ${field}`,
      `Please enter a valid ${field}.`,
      ErrorSeverity.LOW,
      true,
      true,
      { ...context, field, value },
    );
  }
  static localStorage(
    operation: string,
    context?: ErrorContext,
    originalError?: unknown,
  ): FrontendAppError {
    return new FrontendAppError(
      FrontendErrorCodes.LOCAL_STORAGE_ERROR,
      `Local storage operation failed: ${operation}`,
      'Unable to save data locally. Please check your device storage and try again.',
      ErrorSeverity.HIGH,
      true,
      true,
      { ...context, operation },
      originalError,
    );
  }
  static syncError(
    message: string = 'Data synchronization failed',
    context?: ErrorContext,
    originalError?: unknown,
  ): FrontendAppError {
    return new FrontendAppError(
      FrontendErrorCodes.SYNC_ERROR,
      message,
      'Unable to sync your data. Your local data is safe, and we\'ll retry when connection improves.',
      ErrorSeverity.MEDIUM,
      true,
      true,
      context,
      originalError,
    );
  }
  static permissionDenied(
    permission: string,
    context?: ErrorContext,
    originalError?: unknown,
  ): FrontendAppError {
    return new FrontendAppError(
      FrontendErrorCodes.PERMISSION_DENIED,
      `Permission denied: ${permission}`,
      `This feature requires ${permission} permission. Please enable it in your device settings.`,
      ErrorSeverity.HIGH,
      true,
      false,
      { ...context, permission },
      originalError,
    );
  }
  static bluetooth(
    message: string = 'Bluetooth operation failed',
    context?: ErrorContext,
    originalError?: unknown,
  ): FrontendAppError {
    return new FrontendAppError(
      FrontendErrorCodes.BLUETOOTH_ERROR,
      message,
      'Unable to connect to your device. Please check Bluetooth settings and try again.',
      ErrorSeverity.HIGH,
      true,
      true,
      context,
      originalError,
    );
  }
  static aiService(
    message: string = 'AI service error',
    context?: ErrorContext,
    originalError?: unknown,
  ): FrontendAppError {
    return new FrontendAppError(
      FrontendErrorCodes.AI_SERVICE_ERROR,
      message,
      'AI analysis is temporarily unavailable. Your data is safe and other features continue to work normally.',
      ErrorSeverity.MEDIUM,
      true,
      true,
      context,
      originalError,
    );
  }
  static predictionInsufficientData(
    message: string = 'Not enough data for prediction',
    context?: ErrorContext,
    originalError?: unknown,
  ): FrontendAppError {
    return new FrontendAppError(
      FrontendErrorCodes.PREDICTION_INSUFFICIENT_DATA,
      message,
      'We need more consumption data to generate accurate predictions. Keep logging your sessions and check back soon!',
      ErrorSeverity.LOW,
      true,
      false,
      context,
      originalError,
    );
  }
  static unknown(
    message: string = 'Unknown error occurred',
    context?: ErrorContext,
    originalError?: unknown,
  ): FrontendAppError {
    return new FrontendAppError(
      FrontendErrorCodes.UNKNOWN_ERROR,
      message,
      'An unexpected error occurred. Please try again later.',
      ErrorSeverity.MEDIUM,
      false,
      true,
      context,
      originalError,
    );
  }
  static configuration(
    message: string,
    context?: ErrorContext,
    originalError?: unknown,
  ): FrontendAppError {
    return new FrontendAppError(
      FrontendErrorCodes.CONFIGURATION_ERROR,
      message,
      'App configuration error. Please restart the app and try again.',
      ErrorSeverity.HIGH,
      false,
      false,
      context,
      originalError,
    );
  }
  toJSON(): Record<string, unknown> {
    const result: Record<string, unknown> = {
      name: this.name,
      code: this.code,
      message: this.message,
      userMessage: this.userMessage,
      severity: this.severity,
      isOperational: this.isOperational,
      retryable: this.retryable,
      timestamp: Date.now(),
    };
    if (this.correlationId) {
      result.correlationId = this.correlationId;
    }
    if (this.context) {
      result.context = this.sanitizeContext(this.context);
    }
    if (__DEV__ && this.originalError) {
      if (this.originalError instanceof Error) {
        result.originalError = {
          name: this.originalError.name,
          message: this.originalError.message,
          stack: this.originalError.stack,
        };
      } else {
        result.originalError = String(this.originalError);
      }
    }
    return result;
  }
  toUserDisplay(): {
    title: string;
    message: string;
    severity: ErrorSeverity;
    actionable: boolean;
    retryable: boolean;
  } {
    return {
      title: this.getDisplayTitle(),
      message: this.userMessage,
      severity: this.severity,
      actionable: this.isOperational,
      retryable: this.retryable,
    };
  }
  shouldNotifyUser(): boolean {
    return this.severity === ErrorSeverity.HIGH || this.severity === ErrorSeverity.CRITICAL;
  }
  shouldAttemptRecovery(): boolean {
    return this.isOperational && this.retryable;
  }
  getRetryDelay(): number {
    switch (this.severity) {
      case ErrorSeverity.LOW:
        return 1000; 
      case ErrorSeverity.MEDIUM:
        return 3000; 
      case ErrorSeverity.HIGH:
        return 5000; 
      case ErrorSeverity.CRITICAL:
        return 10000; 
      default:
        return 3000;
    }
  }
  private getDisplayTitle(): string {
    switch (this.severity) {
      case ErrorSeverity.LOW:
        return 'Minor Issue';
      case ErrorSeverity.MEDIUM:
        return 'Something Went Wrong';
      case ErrorSeverity.HIGH:
        return 'Error';
      case ErrorSeverity.CRITICAL:
        return 'Critical Error';
      default:
        return 'Error';
    }
  }
  private sanitizeContext(context: ErrorContext): ErrorContext {
    const sanitized = { ...context };
    const sensitiveFields = ['password', 'token', 'key', 'secret', 'auth', 'credential', 'apiKey'];
    Object.keys(sanitized).forEach(key => {
      const lowerKey = key.toLowerCase();
      if (sensitiveFields.some(field => lowerKey.includes(field))) {
        sanitized[key] = '[REDACTED]';
      }
    });
    return sanitized;
  }
}
export function isOperationalError(error: Error): boolean {
  if (error instanceof FrontendAppError) {
    return error.isOperational;
  }
  return false;
}
export function isRetryableError(error: Error): boolean {
  if (error instanceof FrontendAppError) {
    return error.retryable;
  }
  return false;
}
export function getErrorCorrelationId(error: Error): string | undefined {
  if (error instanceof FrontendAppError) {
    return error.correlationId;
  }
  return undefined;
}