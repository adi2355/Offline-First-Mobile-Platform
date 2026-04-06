import { DatabaseResponse } from '../types';
import * as Logger from '../services/ai/utils/logging';
export class DatabaseErrorHandler {
  private static readonly MODULE_NAME = 'DatabaseErrorHandler';
  public static handleDatabaseError(
    error: unknown,
    operation: string,
    context?: Record<string, unknown>
  ): UserFriendlyError {
    Logger.error(this.MODULE_NAME, `Database error in ${operation}:`, error);
    if (error && typeof error === 'object' && 'success' in error && !error.success) {
      return this.processDatabaseResponse(error as DatabaseResponse<unknown>, operation, context);
    }
    if (error instanceof Error) {
      return this.processDirectError(error, operation, context);
    }
    if (typeof error === 'string') {
      return this.processStringError(error, operation, context);
    }
    return {
      title: 'Unexpected Error',
      message: `An unexpected error occurred during ${operation}. Please try again.`,
      actionable: true,
      retryable: true,
      severity: 'error'
    };
  }
  private static processDatabaseResponse(
    response: DatabaseResponse<unknown>,
    operation: string,
    context?: Record<string, unknown>
  ): UserFriendlyError {
    const errorMessage = response.error?.toLowerCase() || '';
    if (errorMessage.includes('constraint') || errorMessage.includes('check constraint failed')) {
      return {
        title: 'Data Format Error',
        message: 'The data cannot be saved due to format restrictions. This may be a temporary issue.',
        actionable: true,
        retryable: true,
        severity: 'warning',
        technicalDetails: response.error
      };
    }
    if (errorMessage.includes('locked') || errorMessage.includes('busy')) {
      return {
        title: 'Database Busy',
        message: 'The app is currently processing other data. Please wait a moment and try again.',
        actionable: true,
        retryable: true,
        severity: 'warning',
        suggestedDelay: 2000
      };
    }
    if (errorMessage.includes('disk') || errorMessage.includes('storage') || errorMessage.includes('space')) {
      return {
        title: 'Storage Issue',
        message: 'Unable to save data due to storage issues. Please check available storage space.',
        actionable: true,
        retryable: false,
        severity: 'error',
        requiresUserAction: 'Check device storage space'
      };
    }
    return {
      title: 'Database Error',
      message: `Unable to complete ${operation}. Please try again later.`,
      actionable: true,
      retryable: true,
      severity: 'error',
      technicalDetails: response.error
    };
  }
  private static processDirectError(
    error: Error,
    operation: string,
    context?: Record<string, unknown>
  ): UserFriendlyError {
    const errorMessage = error.message?.toLowerCase() || '';
    if (errorMessage.includes('network') || errorMessage.includes('connection') || errorMessage.includes('fetch')) {
      return {
        title: 'Connection Error',
        message: 'Unable to connect to the service. Please check your internet connection and try again.',
        actionable: true,
        retryable: true,
        severity: 'warning',
        requiresUserAction: 'Check internet connection'
      };
    }
    if (errorMessage.includes('timeout') || errorMessage.includes('aborted')) {
      return {
        title: 'Request Timeout',
        message: 'The operation took too long to complete. Please try again.',
        actionable: true,
        retryable: true,
        severity: 'warning',
        suggestedDelay: 3000
      };
    }
    if (errorMessage.includes('permission') || errorMessage.includes('access') || errorMessage.includes('unauthorized')) {
      return {
        title: 'Access Error',
        message: 'Unable to access the required data. Please restart the app and try again.',
        actionable: true,
        retryable: false,
        severity: 'error',
        requiresUserAction: 'Restart the app'
      };
    }
    return {
      title: 'Operation Failed',
      message: `Unable to complete ${operation}. Please try again.`,
      actionable: true,
      retryable: true,
      severity: 'error',
      technicalDetails: error.message
    };
  }
  private static processStringError(
    error: string,
    operation: string,
    context?: Record<string, unknown>
  ): UserFriendlyError {
    const errorMessage = error.toLowerCase();
    if (errorMessage.includes('ai service') || errorMessage.includes('analysis')) {
      return {
        title: 'Analysis Service Error',
        message: 'The AI analysis service is temporarily unavailable. Your data is safe, please try again later.',
        actionable: true,
        retryable: true,
        severity: 'warning',
        suggestedDelay: 5000
      };
    }
    if (errorMessage.includes('validation') || errorMessage.includes('invalid')) {
      return {
        title: 'Data Validation Error',
        message: 'Some of your data could not be processed. Please check your entries and try again.',
        actionable: true,
        retryable: true,
        severity: 'warning'
      };
    }
    return {
      title: 'Error',
      message: error || `An error occurred during ${operation}. Please try again.`,
      actionable: true,
      retryable: true,
      severity: 'error'
    };
  }
  public static createRecoveryPlan(
    error: UserFriendlyError,
    context?: Record<string, unknown>
  ): RecoveryPlan {
    const actions: RecoveryAction[] = [];
    if (error.retryable) {
      actions.push({
        type: 'retry',
        label: 'Try Again',
        description: 'Attempt the operation again',
        delay: error.suggestedDelay || 1000,
        priority: 'high'
      });
    }
    if (error.requiresUserAction) {
      actions.push({
        type: 'user_action',
        label: 'Fix Issue',
        description: error.requiresUserAction,
        priority: 'high'
      });
    }
    if (error.title.includes('Data') || error.title.includes('Database')) {
      actions.push({
        type: 'refresh',
        label: 'Refresh Data',
        description: 'Reload the current screen',
        priority: 'medium'
      });
    }
    if (error.severity === 'error' && !error.retryable) {
      actions.push({
        type: 'contact_support',
        label: 'Contact Support',
        description: 'Get help with this issue',
        priority: 'low'
      });
    }
    return {
      error,
      actions,
      canRecover: actions.length > 0,
      recommendedAction: actions.find(a => a.priority === 'high') || actions[0]
    };
  }
  public static logErrorForDebugging(
    error: unknown,
    operation: string,
    context?: Record<string, unknown>
  ): void {
    const sanitizedContext = this.sanitizeContext(context);
    Logger.error(this.MODULE_NAME, `Error in ${operation}:`, {
      error: error instanceof Error ? error.message : error,
      operation,
      context: sanitizedContext,
      timestamp: new Date().toISOString()
    });
  }
  private static sanitizeContext(context: Record<string, unknown> | undefined): Record<string, unknown> {
    if (!context || typeof context !== 'object') {
      return {};
    }
    const sanitized: Record<string, unknown> = { ...context };
    const sensitiveFields = ['password', 'token', 'key', 'secret', 'auth', 'credential'];
    Object.keys(sanitized).forEach(key => {
      const lowerKey = key.toLowerCase();
      if (sensitiveFields.some(field => lowerKey.includes(field))) {
        sanitized[key] = '[REDACTED]';
      }
      if (typeof sanitized[key] === 'object' && sanitized[key] !== null) {
        sanitized[key] = this.sanitizeContext(sanitized[key] as Record<string, unknown>);
      }
    });
    return sanitized;
  }
}
export interface UserFriendlyError {
  title: string;
  message: string;
  actionable: boolean;
  retryable: boolean;
  severity: 'info' | 'warning' | 'error';
  technicalDetails?: string;
  suggestedDelay?: number;
  requiresUserAction?: string;
}
export interface RecoveryAction {
  type: 'retry' | 'refresh' | 'user_action' | 'contact_support';
  label: string;
  description: string;
  priority: 'high' | 'medium' | 'low';
  delay?: number;
}
export interface RecoveryPlan {
  error: UserFriendlyError;
  actions: RecoveryAction[];
  canRecover: boolean;
  recommendedAction?: RecoveryAction;
}
export const useDatabaseErrorHandler = () => {
  const handleError = (error: unknown, operation: string, context?: Record<string, unknown>) => {
    const userError = DatabaseErrorHandler.handleDatabaseError(error, operation, context);
    const recoveryPlan = DatabaseErrorHandler.createRecoveryPlan(userError, context);
    DatabaseErrorHandler.logErrorForDebugging(error, operation, context);
    return { userError, recoveryPlan };
  };
  return { handleError };
};