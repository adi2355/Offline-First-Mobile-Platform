export interface LogContext {
  correlationId?: string;
  userId?: string;
  component?: string;
  duration?: number;
  error?: {
    name: string;
    message: string;
    stack?: string;
    code?: string;
  };
  [key: string]: unknown; 
}
export function toLogError(error: unknown): NonNullable<LogContext['error']> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      code: 'code' in error && typeof (error as { code?: unknown }).code === 'string'
        ? (error as { code: string }).code
        : undefined
    };
  }
  if (typeof error === 'string') {
    return {
      name: 'Error',
      message: error,
      stack: undefined,
      code: undefined
    };
  }
  if (error !== null && typeof error === 'object') {
    const errorObj = error as Record<string, unknown>;
    return {
      name: typeof errorObj.name === 'string' ? errorObj.name : 'UnknownError',
      message: typeof errorObj.message === 'string' ? errorObj.message : String(error),
      stack: typeof errorObj.stack === 'string' ? errorObj.stack : undefined,
      code: typeof errorObj.code === 'string' ? errorObj.code : undefined
    };
  }
  return {
    name: 'UnknownError',
    message: String(error),
    stack: undefined,
    code: undefined
  };
}
interface LogEntry {
  timestamp: string;
  level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
  message: string;
  correlationId?: string;
  userId?: string;
  component?: string;
  duration?: number;
  error?: {
    name: string;
    message: string;
    stack?: string;
    code?: string;
  };
  context?: Record<string, unknown>; 
}
class Logger {
  private formatLogEntry(level: LogEntry['level'], message: string, context?: LogContext): LogEntry {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
    };
    if (context) {
      if (context.correlationId) entry.correlationId = context.correlationId;
      if (context.userId) entry.userId = context.userId;
      if (context.component) entry.component = context.component;
      if (context.duration) entry.duration = context.duration;
      if (context.error) entry.error = context.error;
      const { correlationId, userId, component, duration, error, ...restContext } = context;
      if (Object.keys(restContext).length > 0) {
        entry.context = restContext;
      }
    }
    return entry;
  }
  private sanitizeForProduction(entry: LogEntry): Partial<LogEntry> {
    return {
      timestamp: entry.timestamp,
      level: entry.level,
      message: entry.message,
      correlationId: entry.correlationId,
      component: entry.component,
      duration: entry.duration,
      error: entry.error ? {
        name: entry.error.name,
        message: entry.error.message,
        code: entry.error.code
      } : undefined
    };
  }
  private outputLog(entry: LogEntry): void {
    const logData = __DEV__ ? entry : this.sanitizeForProduction(entry);
    const formattedMessage = `[${entry.timestamp}] [${entry.level}] ${entry.message}`;
    switch (entry.level) {
      case 'DEBUG':
        if (__DEV__) {
          console.debug(formattedMessage, logData);
        }
        break;
      case 'INFO':
        if (__DEV__) {
          console.info(formattedMessage, logData);
        }
        break;
      case 'WARN':
        console.warn(formattedMessage, __DEV__ ? logData : undefined);
        break;
      case 'ERROR':
        console.error(formattedMessage, __DEV__ ? logData : { correlationId: entry.correlationId });
        break;
    }
  }
  warn(message: string, context?: LogContext): void {
    const entry = this.formatLogEntry('WARN', message, context);
    this.outputLog(entry);
  }
  error(message: string, context?: LogContext): void {
    const entry = this.formatLogEntry('ERROR', message, context);
    this.outputLog(entry);
  }
  info(message: string, context?: LogContext): void {
    const entry = this.formatLogEntry('INFO', message, context);
    this.outputLog(entry);
  }
  debug(message: string, context?: LogContext): void {
    const entry = this.formatLogEntry('DEBUG', message, context);
    this.outputLog(entry);
  }
  apiRequest(message: string, context: LogContext & {
    method?: string;
    endpoint?: string;
    statusCode?: number;
    requestId?: string;
  }): void {
    this.debug(`[API] ${message}`, context);
  }
  authEvent(message: string, context: LogContext & {
    event?: string;
    provider?: string;
    success?: boolean;
  }): void {
    this.info(`[AUTH] ${message}`, context);
  }
  syncEvent(message: string, context: LogContext & {
    operation?: string;
    recordCount?: number;
    conflicts?: number;
  }): void {
    this.debug(`[SYNC] ${message}`, context);
  }
}
export const logger = new Logger();