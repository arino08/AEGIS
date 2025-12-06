import winston from 'winston';

const { combine, timestamp, printf, colorize, json, errors } = winston.format;

// Custom log format for development (human-readable)
const devFormat = printf(({ level, message, timestamp, ...metadata }) => {
  let msg = `${timestamp} [${level}]: ${message}`;

  if (Object.keys(metadata).length > 0) {
    // Filter out Symbol properties that Winston adds
    const cleanMetadata: Record<string, unknown> = {};
    for (const key of Object.keys(metadata)) {
      if (!key.startsWith('Symbol')) {
        cleanMetadata[key] = metadata[key];
      }
    }
    if (Object.keys(cleanMetadata).length > 0) {
      msg += ` ${JSON.stringify(cleanMetadata)}`;
    }
  }

  return msg;
});

// Determine log level from environment
const getLogLevel = (): string => {
  const envLevel = process.env['LOG_LEVEL'];
  if (envLevel) {
    return envLevel.toLowerCase();
  }
  return process.env['NODE_ENV'] === 'production' ? 'info' : 'debug';
};

// Determine log format from environment
const getLogFormat = (): winston.Logform.Format => {
  const format = process.env['LOG_FORMAT'];
  const isDev = process.env['NODE_ENV'] !== 'production';

  if (format === 'json' || !isDev) {
    return combine(timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }), errors({ stack: true }), json());
  }

  return combine(
    colorize({ all: true }),
    timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
    errors({ stack: true }),
    devFormat
  );
};

// Create transports array
const getTransports = (): winston.transport[] => {
  const transports: winston.transport[] = [new winston.transports.Console()];

  // Add file transport if enabled
  if (process.env['LOG_FILE_ENABLED'] === 'true') {
    const logFilePath = process.env['LOG_FILE_PATH'] ?? './logs/aegis.log';

    transports.push(
      new winston.transports.File({
        filename: logFilePath,
        maxsize: 10 * 1024 * 1024, // 10MB
        maxFiles: 5,
        tailable: true,
      })
    );

    // Separate error log file
    transports.push(
      new winston.transports.File({
        filename: logFilePath.replace('.log', '.error.log'),
        level: 'error',
        maxsize: 10 * 1024 * 1024,
        maxFiles: 5,
        tailable: true,
      })
    );
  }

  return transports;
};

// Create the main logger instance
const logger = winston.createLogger({
  level: getLogLevel(),
  format: getLogFormat(),
  transports: getTransports(),
  exitOnError: false,
});

// Request logger for HTTP requests
export interface RequestLogData {
  requestId: string;
  method: string;
  path: string;
  statusCode?: number;
  responseTimeMs?: number;
  userId?: string;
  ipAddress?: string;
  userAgent?: string;
  targetBackend?: string;
  error?: string;
}

export const logRequest = (data: RequestLogData): void => {
  const level = data.statusCode
    ? data.statusCode >= 500
      ? 'error'
      : data.statusCode >= 400
        ? 'warn'
        : 'info'
    : 'info';

  logger.log(level, `${data.method} ${data.path}`, {
    type: 'request',
    ...data,
  });
};

// Proxy event logger
export interface ProxyLogData {
  requestId: string;
  event: 'proxy_start' | 'proxy_complete' | 'proxy_error' | 'proxy_timeout' | 'circuit_breaker_open';
  target: string;
  path: string;
  durationMs?: number;
  error?: string;
  retryAfter?: number;
}

export const logProxy = (data: ProxyLogData): void => {
  const level = data.event === 'proxy_error' || data.event === 'proxy_timeout' || data.event === 'circuit_breaker_open' ? 'warn' : 'debug';

  logger.log(level, `Proxy ${data.event}: ${data.target}${data.path}`, {
    type: 'proxy',
    ...data,
  });
};

// Rate limit logger
export interface RateLimitLogData {
  requestId: string;
  identifier: string;
  endpoint: string;
  currentCount: number;
  limit: number;
  windowMs: number;
  blocked: boolean;
}

export const logRateLimit = (data: RateLimitLogData): void => {
  const level = data.blocked ? 'warn' : 'debug';

  logger.log(level, data.blocked ? 'Rate limit exceeded' : 'Rate limit check passed', {
    type: 'rate_limit',
    ...data,
  });
};

// Config logger
export const logConfig = (message: string, data?: Record<string, unknown>): void => {
  logger.info(message, {
    type: 'config',
    ...data,
  });
};

// Startup/shutdown logger
export const logLifecycle = (
  event: 'startup' | 'shutdown' | 'ready' | 'error',
  message: string,
  data?: Record<string, unknown>
): void => {
  const level = event === 'error' ? 'error' : 'info';

  logger.log(level, `[${event.toUpperCase()}] ${message}`, {
    type: 'lifecycle',
    event,
    ...data,
  });
};

// Create a child logger with additional context
export const createChildLogger = (context: Record<string, unknown>): winston.Logger => {
  return logger.child(context);
};

// Export the base logger for direct use
export default logger;
