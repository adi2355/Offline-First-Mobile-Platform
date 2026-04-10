import AsyncStorage from '@react-native-async-storage/async-storage';
import { ErrorSeverity, FrontendAppError } from './FrontendAppError';
import { formatErrorForLogging } from './frontend-error-handler';
export enum LogLevel {
  DEBUG = 'DEBUG',
  INFO = 'INFO',
  WARN = 'WARN',
  ERROR = 'ERROR',
  FATAL = 'FATAL'
}
export enum LogCategory {
  API_REQUEST = 'API_REQUEST',
  API_RESPONSE = 'API_RESPONSE',
  AUTHENTICATION = 'AUTHENTICATION',
  AUTHORIZATION = 'AUTHORIZATION',
  BLUETOOTH = 'BLUETOOTH',
  CACHE = 'CACHE',
  DATABASE = 'DATABASE',
  DEVICE = 'DEVICE',
  ERROR = 'ERROR',
  NAVIGATION = 'NAVIGATION',
  NETWORK = 'NETWORK',
  PERFORMANCE = 'PERFORMANCE',
  SECURITY = 'SECURITY',
  SYNC = 'SYNC',
  SYSTEM = 'SYSTEM',
  UI = 'UI',
  USER_INTERACTION = 'USER_INTERACTION',
  VALIDATION = 'VALIDATION',
  AI_SERVICE = 'AI_SERVICE',
}
export interface LogError {
  name: string;
  message: string;
  stack?: string;
  code?: string;
  severity?: ErrorSeverity;
}
export interface LogEntry {
  id: string;
  timestamp: Date;
  level: LogLevel;
  category: LogCategory;
  message: string;
  data?: Record<string, unknown>;
  correlationId?: string;
  userId?: string;
  sessionId?: string;
  component?: string;
  operation?: string;
  duration?: number;
  error?: LogError;
  deviceInfo?: {
    platform?: string;
    version?: string;
    model?: string;
    osVersion?: string;
  };
}
export interface APIRequestLog {
  requestId: string;
  method: string;
  endpoint: string;
  headers?: Record<string, string>;
  body?: unknown;
  userId?: string;
  timestamp: Date;
  size: number;
}
export interface APIResponseLog {
  requestId: string;
  statusCode: number;
  headers?: Record<string, string>;
  body?: unknown;
  size: number;
  duration: number;
  timestamp: Date;
  cached?: boolean;
  error?: LogError;
}
export interface LoggerConfig {
  level: LogLevel;
  enableConsole: boolean;
  enableStorage: boolean;
  maxStorageSize: number; 
  enableMetrics: boolean;
  enableBackgroundSync: boolean; 
  sanitizeData: boolean;
  includeStackTrace: boolean;
  includeDeviceInfo: boolean;
}
export interface LogMetrics {
  totalLogs: number;
  logsByLevel: Record<LogLevel, number>;
  logsByCategory: Record<LogCategory, number>;
  errorRate: number;
  averageResponseTime: number;
  recentErrors: LogEntry[];
  performanceMetrics: {
    slowestOperations: Array<{ operation: string; duration: number; timestamp: Date }>;
    mostFrequentErrors: Array<{ error: string; count: number }>;
    apiUsageStats: Array<{ endpoint: string; count: number; avgDuration: number }>;
  };
}
export class FrontendLoggerService {
  private static instance: FrontendLoggerService;
  private config: LoggerConfig;
  private logs: LogEntry[] = [];
  private apiRequests: Map<string, APIRequestLog> = new Map();
  private apiResponses: APIResponseLog[] = [];
  private readonly STORAGE_KEY = '@app_platform_logs';
  private readonly MAX_LOGS_IN_MEMORY = 1000;
  private readonly MAX_API_RESPONSES = 100;
  private constructor(config?: Partial<LoggerConfig>) {
    this.config = {
      level: __DEV__ ? LogLevel.DEBUG : LogLevel.INFO,
      enableConsole: true,
      enableStorage: true,
      maxStorageSize: 500,
      enableMetrics: true,
      enableBackgroundSync: false, 
      sanitizeData: true,
      includeStackTrace: __DEV__,
      includeDeviceInfo: true,
      ...config,
    };
    this.initializeDeviceInfo();
  }
  public static getInstance(config?: Partial<LoggerConfig>): FrontendLoggerService {
    if (!FrontendLoggerService.instance) {
      FrontendLoggerService.instance = new FrontendLoggerService(config);
    }
    return FrontendLoggerService.instance;
  }
  public debug(message: string, data?: Record<string, unknown>, context?: {
    correlationId?: string;
    component?: string;
    operation?: string;
  }): void {
    this.log(LogLevel.DEBUG, LogCategory.SYSTEM, message, data, context);
  }
  public info(message: string, data?: Record<string, unknown>, context?: {
    correlationId?: string;
    component?: string;
    operation?: string;
  }): void {
    this.log(LogLevel.INFO, LogCategory.SYSTEM, message, data, context);
  }
  public warn(message: string, data?: Record<string, unknown>, context?: {
    correlationId?: string;
    component?: string;
    operation?: string;
  }): void {
    this.log(LogLevel.WARN, LogCategory.SYSTEM, message, data, context);
  }
  public error(message: string, error?: unknown, context?: {
    correlationId?: string;
    component?: string;
    operation?: string;
  }): void {
    const errorData = this.formatError(error);
    this.log(LogLevel.ERROR, LogCategory.ERROR, message, undefined, context, errorData);
  }
  public fatal(message: string, error?: unknown, context?: {
    correlationId?: string;
    component?: string;
    operation?: string;
  }): void {
    const errorData = this.formatError(error);
    this.log(LogLevel.FATAL, LogCategory.ERROR, message, undefined, context, errorData);
  }
  public log(
    level: LogLevel,
    category: LogCategory,
    message: string,
    data?: Record<string, unknown>,
    context?: {
      correlationId?: string;
      userId?: string;
      sessionId?: string;
      component?: string;
      operation?: string;
      duration?: number;
    },
    error?: LogError,
  ): void {
    if (!this.shouldLog(level)) {
      return;
    }
    const logEntry: LogEntry = {
      id: this.generateLogId(),
      timestamp: new Date(),
      level,
      category,
      message: this.sanitizeMessage(message),
      data: this.sanitizeData(data),
      correlationId: context?.correlationId,
      userId: this.sanitizeUserId(context?.userId),
      sessionId: context?.sessionId,
      component: context?.component,
      operation: context?.operation,
      duration: context?.duration,
      error,
      deviceInfo: this.config.includeDeviceInfo ? this.getDeviceInfo() : undefined,
    };
    this.addLogEntry(logEntry);
    this.logToConsole(logEntry);
    if (this.config.enableStorage) {
      this.saveToStorage(logEntry);
    }
  }
  public logAPIRequest(
    method: string,
    endpoint: string,
    requestId: string,
    options?: {
      headers?: Record<string, string>;
      body?: unknown;
      userId?: string;
      correlationId?: string;
    }
  ): void {
    const requestLog: APIRequestLog = {
      requestId,
      method,
      endpoint,
      headers: this.sanitizeHeaders(options?.headers),
      body: this.sanitizeRequestBody(options?.body),
      userId: this.sanitizeUserId(options?.userId),
      timestamp: new Date(),
      size: this.calculateRequestSize(options?.body),
    };
    this.apiRequests.set(requestId, requestLog);
    this.log(
      LogLevel.INFO,
      LogCategory.API_REQUEST,
      `${method} ${endpoint}`,
      {
        requestId,
        method,
        endpoint,
        size: requestLog.size,
      },
      {
        correlationId: options?.correlationId,
        userId: options?.userId,
        operation: 'api_request',
      },
    );
  }
  public logAPIResponse(
    requestId: string,
    statusCode: number,
    startTime: number,
    options?: {
      headers?: Record<string, string>;
      body?: unknown;
      cached?: boolean;
      error?: Error;
      correlationId?: string;
    }
  ): void {
    const duration = Date.now() - startTime;
    const responseLog: APIResponseLog = {
      requestId,
      statusCode,
      headers: this.sanitizeHeaders(options?.headers),
      body: this.sanitizeResponseBody(options?.body),
      size: this.calculateResponseSize(options?.body),
      duration,
      timestamp: new Date(),
      cached: options?.cached,
      error: options?.error ? this.formatError(options.error) : undefined,
    };
    this.apiResponses.push(responseLog);
    this.trimAPIResponses();
    const requestLog = this.apiRequests.get(requestId);
    const level = statusCode >= 400 ? LogLevel.ERROR : LogLevel.INFO;
    this.log(
      level,
      LogCategory.API_RESPONSE,
      `${requestLog?.method || 'UNKNOWN'} ${requestLog?.endpoint || 'UNKNOWN'} - ${statusCode}`,
      {
        requestId,
        statusCode,
        duration,
        size: responseLog.size,
        cached: options?.cached,
      },
      {
        correlationId: options?.correlationId,
        userId: requestLog?.userId,
        operation: 'api_response',
        duration,
      },
      responseLog.error,
    );
    this.apiRequests.delete(requestId);
  }
  public logPerformance(
    operation: string,
    duration: number,
    metadata?: Record<string, unknown>,
    context?: {
      correlationId?: string;
      component?: string;
    }
  ): void {
    const level = duration > 3000 ? LogLevel.WARN : LogLevel.INFO; 
    this.log(
      level,
      LogCategory.PERFORMANCE,
      `Performance: ${operation} took ${duration}ms`,
      {
        operation,
        duration,
        ...metadata,
      },
      {
        ...context,
        operation: 'performance_tracking',
        duration,
      },
    );
  }
  public logAuth(
    event: string,
    success: boolean,
    context?: {
      correlationId?: string;
      userId?: string;
      provider?: string;
      method?: string;
    }
  ): void {
    const level = success ? LogLevel.INFO : LogLevel.WARN;
    this.log(
      level,
      LogCategory.AUTHENTICATION,
      `Auth: ${event} - ${success ? 'Success' : 'Failed'}`,
      {
        event,
        success,
        provider: context?.provider,
        method: context?.method,
      },
      {
        correlationId: context?.correlationId,
        userId: context?.userId,
        operation: 'authentication',
      },
    );
  }
  public logSync(
    operation: string,
    result: 'success' | 'partial' | 'failed',
    metadata?: {
      itemsProcessed?: number;
      conflicts?: number;
      errors?: number;
      duration?: number;
    },
    context?: {
      correlationId?: string;
      userId?: string;
    }
  ): void {
    const level = result === 'failed' ? LogLevel.ERROR : result === 'partial' ? LogLevel.WARN : LogLevel.INFO;
    this.log(
      level,
      LogCategory.SYNC,
      `Sync: ${operation} - ${result}`,
      {
        operation,
        result,
        ...metadata,
      },
      {
        ...context,
        operation: 'sync_operation',
        duration: metadata?.duration,
      },
    );
  }
  public logDevice(
    operation: string,
    deviceId?: string,
    success?: boolean,
    error?: Error,
    context?: {
      correlationId?: string;
      userId?: string;
    }
  ): void {
    const level = error ? LogLevel.ERROR : success === false ? LogLevel.WARN : LogLevel.INFO;
    this.log(
      level,
      LogCategory.DEVICE,
      `Device: ${operation}${deviceId ? ` for ${deviceId}` : ''}`,
      {
        operation,
        deviceId,
        success,
      },
      {
        ...context,
        operation: 'device_operation',
      },
      error ? this.formatError(error) : undefined,
    );
  }
  public logUserInteraction(
    action: string,
    component: string,
    metadata?: Record<string, unknown>,
    context?: {
      correlationId?: string;
      userId?: string;
      sessionId?: string;
    }
  ): void {
    this.log(
      LogLevel.INFO,
      LogCategory.USER_INTERACTION,
      `User: ${action} in ${component}`,
      {
        action,
        component,
        ...metadata,
      },
      {
        ...context,
        component,
        operation: 'user_interaction',
      },
    );
  }
  public logSecurity(
    event: string,
    severity: 'low' | 'medium' | 'high' | 'critical',
    details?: Record<string, unknown>,
    context?: {
      correlationId?: string;
      userId?: string;
    }
  ): void {
    const level = severity === 'critical' ? LogLevel.FATAL :
                  severity === 'high' ? LogLevel.ERROR :
                  severity === 'medium' ? LogLevel.WARN : LogLevel.INFO;
    this.log(
      level,
      LogCategory.SECURITY,
      `Security: ${event}`,
      {
        event,
        severity,
        ...details,
      },
      {
        ...context,
        operation: 'security_event',
      },
    );
  }
  public getLogMetrics(timeWindow?: number): LogMetrics {
    const now = Date.now();
    const windowStart = timeWindow ? now - timeWindow : 0;
    const relevantLogs = this.logs.filter(log =>
      log.timestamp.getTime() >= windowStart,
    );
    const relevantResponses = this.apiResponses.filter(response =>
      response.timestamp.getTime() >= windowStart,
    );
    const logsByLevel: Record<LogLevel, number> = {
      [LogLevel.DEBUG]: 0,
      [LogLevel.INFO]: 0,
      [LogLevel.WARN]: 0,
      [LogLevel.ERROR]: 0,
      [LogLevel.FATAL]: 0,
    };
    const logsByCategory: Record<LogCategory, number> = {
      [LogCategory.API_REQUEST]: 0,
      [LogCategory.API_RESPONSE]: 0,
      [LogCategory.AUTHENTICATION]: 0,
      [LogCategory.AUTHORIZATION]: 0,
      [LogCategory.BLUETOOTH]: 0,
      [LogCategory.CACHE]: 0,
      [LogCategory.DATABASE]: 0,
      [LogCategory.DEVICE]: 0,
      [LogCategory.ERROR]: 0,
      [LogCategory.NAVIGATION]: 0,
      [LogCategory.NETWORK]: 0,
      [LogCategory.PERFORMANCE]: 0,
      [LogCategory.SECURITY]: 0,
      [LogCategory.SYNC]: 0,
      [LogCategory.SYSTEM]: 0,
      [LogCategory.UI]: 0,
      [LogCategory.USER_INTERACTION]: 0,
      [LogCategory.VALIDATION]: 0,
      [LogCategory.AI_SERVICE]: 0,
    };
    relevantLogs.forEach(log => {
      logsByLevel[log.level]++;
      logsByCategory[log.category]++;
    });
    const totalRequests = relevantResponses.length;
    const errorRequests = relevantResponses.filter(r => r.statusCode >= 400).length;
    const errorRate = totalRequests > 0 ? (errorRequests / totalRequests) * 100 : 0;
    const totalDuration = relevantResponses.reduce((sum, r) => sum + r.duration, 0);
    const averageResponseTime = totalRequests > 0 ? totalDuration / totalRequests : 0;
    const recentErrors = relevantLogs
      .filter(log => log.level === LogLevel.ERROR || log.level === LogLevel.FATAL)
      .slice(-10);
    const slowestOperations = relevantLogs
      .filter(log => log.category === LogCategory.PERFORMANCE && log.duration)
      .sort((a, b) => (b.duration || 0) - (a.duration || 0))
      .slice(0, 10)
      .map(log => ({
        operation: log.operation || 'unknown',
        duration: log.duration || 0,
        timestamp: log.timestamp,
      }));
    const errorCounts: Record<string, number> = {};
    recentErrors.forEach(log => {
      const errorKey = log.error?.name || log.message;
      errorCounts[errorKey] = (errorCounts[errorKey] || 0) + 1;
    });
    const mostFrequentErrors = Object.entries(errorCounts)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 10)
      .map(([error, count]) => ({ error, count }));
    const endpointStats: Record<string, { count: number; totalDuration: number }> = {};
    relevantResponses.forEach(response => {
      const requestLog = Array.from(this.apiRequests.values())
        .find(req => req.requestId === response.requestId);
      const endpoint = requestLog?.endpoint || 'unknown';
      if (!endpointStats[endpoint]) {
        endpointStats[endpoint] = { count: 0, totalDuration: 0 };
      }
      endpointStats[endpoint].count++;
      endpointStats[endpoint].totalDuration += response.duration;
    });
    const apiUsageStats = Object.entries(endpointStats)
      .map(([endpoint, stats]) => ({
        endpoint,
        count: stats.count,
        avgDuration: stats.totalDuration / stats.count,
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);
    return {
      totalLogs: relevantLogs.length,
      logsByLevel,
      logsByCategory,
      errorRate,
      averageResponseTime,
      recentErrors,
      performanceMetrics: {
        slowestOperations,
        mostFrequentErrors,
        apiUsageStats,
      },
    };
  }
  public async exportLogs(format: 'json' | 'csv' = 'json'): Promise<string> {
    const logs = await this.getAllLogs();
    if (format === 'json') {
      return JSON.stringify(logs, null, 2);
    } else {
      const headers = ['timestamp', 'level', 'category', 'message', 'component', 'correlationId'];
      const csvRows = [headers.join(',')];
      logs.forEach(log => {
        const row = [
          log.timestamp.toISOString(),
          log.level,
          log.category,
          `"${log.message.replace(/"/g, '""')}"`,
          log.component || '',
          log.correlationId || '',
        ];
        csvRows.push(row.join(','));
      });
      return csvRows.join('\n');
    }
  }
  public async clearLogs(): Promise<void> {
    this.logs = [];
    this.apiRequests.clear();
    this.apiResponses = [];
    try {
      await AsyncStorage.removeItem(this.STORAGE_KEY);
    } catch (error) {
      console.warn('Failed to clear stored logs:', error);
    }
  }
  private shouldLog(level: LogLevel): boolean {
    const levels = [LogLevel.DEBUG, LogLevel.INFO, LogLevel.WARN, LogLevel.ERROR, LogLevel.FATAL];
    const configLevelIndex = levels.indexOf(this.config.level);
    const logLevelIndex = levels.indexOf(level);
    return logLevelIndex >= configLevelIndex;
  }
  private addLogEntry(logEntry: LogEntry): void {
    this.logs.push(logEntry);
    this.trimLogsInMemory();
  }
  private trimLogsInMemory(): void {
    if (this.logs.length > this.MAX_LOGS_IN_MEMORY) {
      this.logs = this.logs.slice(-this.MAX_LOGS_IN_MEMORY);
    }
  }
  private trimAPIResponses(): void {
    if (this.apiResponses.length > this.MAX_API_RESPONSES) {
      this.apiResponses = this.apiResponses.slice(-this.MAX_API_RESPONSES);
    }
  }
  private logToConsole(logEntry: LogEntry): void {
    if (!this.config.enableConsole) return;
    const message = this.formatLogLine(logEntry);
    const logData = __DEV__ ? logEntry : this.sanitizeForProduction(logEntry);
    switch (logEntry.level) {
      case LogLevel.FATAL:
      case LogLevel.ERROR:
        console.error(message, logData);
        break;
      case LogLevel.WARN:
        console.warn(message, logData);
        break;
      case LogLevel.INFO:
        console.info(message, logData);
        break;
      case LogLevel.DEBUG:
        if (__DEV__) {
          console.debug(message, logData);
        }
        break;
    }
  }
  private formatLogLine(logEntry: LogEntry): string {
    const timestamp = logEntry.timestamp.toISOString();
    const level = logEntry.level.padEnd(5);
    const category = logEntry.category.padEnd(15);
    const correlationId = logEntry.correlationId ? `[${logEntry.correlationId}]` : '';
    const component = logEntry.component ? `[${logEntry.component}]` : '';
    return `${timestamp} ${level} ${category} ${correlationId} ${component} ${logEntry.message}`;
  }
  private sanitizeForProduction(entry: LogEntry): Partial<LogEntry> {
    return {
      timestamp: entry.timestamp,
      level: entry.level,
      category: entry.category,
      message: entry.message,
      correlationId: entry.correlationId,
      component: entry.component,
      duration: entry.duration,
      error: entry.error ? {
        name: entry.error.name,
        message: entry.error.message,
        code: entry.error.code,
        severity: entry.error.severity,
      } : undefined
    };
  }
  private async saveToStorage(logEntry: LogEntry): Promise<void> {
    try {
      const storedLogs = await this.getStoredLogs();
      storedLogs.push(logEntry);
      if (storedLogs.length > this.config.maxStorageSize) {
        storedLogs.splice(0, storedLogs.length - this.config.maxStorageSize);
      }
      await AsyncStorage.setItem(this.STORAGE_KEY, JSON.stringify(storedLogs));
    } catch (error) {
      console.warn('Failed to save log to storage:', error);
    }
  }
  private async getStoredLogs(): Promise<LogEntry[]> {
    try {
      const stored = await AsyncStorage.getItem(this.STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored) as unknown[];
        return (parsed as LogEntry[]).map((log) => ({
          ...log,
          timestamp: new Date(log.timestamp),
        }));
      }
    } catch (error) {
      console.warn('Failed to load stored logs:', error);
    }
    return [];
  }
  private async getAllLogs(): Promise<LogEntry[]> {
    const storedLogs = await this.getStoredLogs();
    const allLogs = [...storedLogs, ...this.logs];
    const uniqueLogs = allLogs.filter((log, index, self) =>
      index === self.findIndex(l => l.id === log.id)
    );
    return uniqueLogs.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  }
  private generateLogId(): string {
    return `log_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
  private sanitizeMessage(message: string): string {
    return message
      .replace(/[\r\n]/g, ' ')
      .replace(/\t/g, ' ')
      .substring(0, 1000);
  }
  private sanitizeData(data?: Record<string, unknown>): Record<string, unknown> | undefined {
    if (!data || !this.config.sanitizeData) return data;
    const sanitized: Record<string, unknown> = {};
    Object.entries(data).forEach(([key, value]) => {
      if (this.isSensitiveKey(key)) {
        sanitized[key] = '[REDACTED]';
      } else if (typeof value === 'string' && value.length > 500) {
        sanitized[key] = `${value.substring(0, 500)}...`;
      } else {
        sanitized[key] = value;
      }
    });
    return sanitized;
  }
  private sanitizeUserId(userId?: string): string | undefined {
    if (!userId) return undefined;
    return this.config.sanitizeData ? this.maskSensitiveData(userId) : userId;
  }
  private sanitizeHeaders(headers?: Record<string, string>): Record<string, string> | undefined {
    if (!headers) return undefined;
    const sanitized: Record<string, string> = {};
    Object.entries(headers).forEach(([key, value]) => {
      const lowerKey = key.toLowerCase();
      if (this.isSensitiveHeader(lowerKey)) {
        sanitized[key] = '[REDACTED]';
      } else {
        sanitized[key] = value;
      }
    });
    return sanitized;
  }
  private sanitizeRequestBody(body?: unknown): unknown {
    if (!body || !this.config.sanitizeData) return body;
    const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
    if (bodyStr.length > 1000) {
      return '[BODY_TOO_LARGE]';
    }
    if (typeof body === 'object' && body !== null && !Array.isArray(body)) {
      return this.sanitizeData(body as Record<string, unknown>);
    }
    return body;
  }
  private sanitizeResponseBody(body?: unknown): unknown {
    if (!body || !this.config.sanitizeData) return body;
    const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
    if (bodyStr.length > 1000) {
      return '[BODY_TOO_LARGE]';
    }
    return body;
  }
  private isSensitiveKey(key: string): boolean {
    const sensitivePatterns = [
      /password/i,
      /secret/i,
      /key/i,
      /token/i,
      /auth/i,
      /credential/i,
      /api[_-]?key/i,
      /private/i,
    ];
    return sensitivePatterns.some(pattern => pattern.test(key));
  }
  private isSensitiveHeader(header: string): boolean {
    const sensitiveHeaders = [
      'authorization',
      'cookie',
      'set-cookie',
      'x-api-key',
      'x-auth-token',
      'x-access-token',
    ];
    return sensitiveHeaders.includes(header);
  }
  private maskSensitiveData(data: string): string {
    if (data.length <= 4) return '***';
    return data.substring(0, 2) + '*'.repeat(data.length - 4) + data.substring(data.length - 2);
  }
  private calculateRequestSize(body?: unknown): number {
    if (!body) return 0;
    return JSON.stringify(body).length;
  }
  private calculateResponseSize(body?: unknown): number {
    if (!body) return 0;
    return JSON.stringify(body).length;
  }
  private formatError(error?: unknown): LogError | undefined {
    if (!error) return undefined;
    if (error instanceof FrontendAppError) {
      return {
        name: error.name,
        message: error.message,
        code: error.code,
        severity: error.severity,
        stack: this.config.includeStackTrace ? error.stack : undefined,
      };
    }
    if (error instanceof Error) {
      return {
        name: error.name,
        message: error.message,
        stack: this.config.includeStackTrace ? error.stack : undefined,
      };
    }
    const errorInfo = formatErrorForLogging(error);
    return {
      name: 'UnknownError',
      message: errorInfo.message,
      code: errorInfo.code,
      stack: this.config.includeStackTrace ? errorInfo.stack : undefined,
    };
  }
  private deviceInfo: LogEntry['deviceInfo'] | undefined;
  private async initializeDeviceInfo(): Promise<void> {
    if (!this.config.includeDeviceInfo) return;
    try {
      this.deviceInfo = {
        platform: 'react-native', 
        version: '1.0.0', 
        model: 'unknown', 
        osVersion: 'unknown', 
      };
    } catch (error) {
      console.warn('Failed to initialize device info:', error);
    }
  }
  private getDeviceInfo(): LogEntry['deviceInfo'] {
    return this.deviceInfo;
  }
}
export const frontendLogger = FrontendLoggerService.getInstance();