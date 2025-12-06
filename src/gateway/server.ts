/**
 * AEGIS - Gateway Server
 * Main Express server that handles all gateway functionality
 */

import http from 'http';
import { type AddressInfo } from 'net';

import compression from 'compression';
import cors from 'cors';
import express, { type Application, type Request, type Response } from 'express';
import helmet from 'helmet';

import { metricsRouter } from '../api/routes/metrics.js';
import { alertsRouter } from '../api/routes/alerts.js';
import { nlQueryRouter } from '../api/routes/nl-query.js';
import { mlRouter } from '../api/routes/ml.js';
import { healthRouter, setProxyServer } from '../api/routes/health.js';
import { initializeMetricsWebSocket, shutdownMetricsWebSocket } from '../api/websocket.js';
import {
  createAuthService,
  createRbacService,
  createAuthMiddleware,
  createRequestTransform,
  createResponseTransform,
  type AuthService,
  type RbacService,
  type AuthConfig,
} from '../auth/index.js';
import { type ConfigLoader, getConfigLoader } from '../config/loader.js';
import {
  type MetricsCollector,
  getMetricsCollector,
  initializeMetricsCollector,
  shutdownMetricsCollector,
  createMetricsMiddleware,
  createConnectionTrackingMiddleware,
  createServerTimingMiddleware,
} from '../monitoring/index.js';
import {
  type RateLimiter,
  createRateLimiter,
  createRateLimitMiddleware,
  skipHealthChecks,
} from '../rate-limiter/index.js';
import { type RedisClient, createRedisClient } from '../storage/redis.js';
import { type PostgresClient, initializePostgres, closePostgres } from '../storage/postgres.js';
import logger, { logLifecycle } from '../utils/logger.js';
import type { AegisConfig, GatewayStatus, BackendHealth } from '../utils/types.js';

import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { requestIdMiddleware } from './middleware/requestId.js';
import { requestLogger } from './middleware/requestLogger.js';
import { type ProxyServer, createProxyServer } from './proxy.js';
import { type Router, getRouter } from './router.js';

// =============================================================================
// Types
// =============================================================================

export interface GatewayServerOptions {
  config?: AegisConfig;
  configPath?: string;
}

// =============================================================================
// Gateway Server Class
// =============================================================================

export class GatewayServer {
  private app: Application;
  private server: http.Server | null = null;
  private config: AegisConfig | null = null;
  private configLoader: ConfigLoader;
  private proxyServer: ProxyServer | null = null;
  private router: Router;
  private startTime: Date | null = null;
  private isShuttingDown = false;

  // Rate limiting
  private redisClient: RedisClient | null = null;
  private rateLimiter: RateLimiter | null = null;

  // Metrics & observability
  private postgresClient: PostgresClient | null = null;
  private metricsCollector: MetricsCollector | null = null;

  // Authentication & Authorization
  private authService: AuthService | null = null;
  private rbacService: RbacService | null = null;

  constructor(options: GatewayServerOptions = {}) {
    this.app = express();
    this.configLoader = getConfigLoader(options.configPath);
    this.router = getRouter();

    if (options.config) {
      this.config = options.config;
    }
  }

  /**
   * Initialize the gateway server
   */
  public async initialize(): Promise<void> {
    // Load configuration if not provided
    if (this.config === null) {
      this.config = await this.configLoader.load();
    }

    // Register backends with router
    this.router.registerBackends(this.config.backends);

    // Initialize Redis client for rate limiting
    await this.initializeRedis();

    // Initialize rate limiter
    this.initializeRateLimiter();

    // Initialize PostgreSQL for metrics storage
    await this.initializePostgres();

    // Initialize metrics collector
    await this.initializeMetrics();

    // Initialize authentication and authorization
    this.initializeAuth();

    // Create proxy server
    this.proxyServer = createProxyServer({
      config: this.config,
      onRequestStart: (req) => {
        logger.debug('Request started', {
          requestId: req.requestId,
          path: req.path,
          method: req.method,
        });
      },
      onRequestEnd: (req, _res, durationMs) => {
        logger.debug('Request completed', {
          requestId: req.requestId,
          durationMs,
        });
      },
      onProxyError: (req, error) => {
        logger.error('Proxy error', {
          requestId: req.requestId,
          error: error.message,
        });
      },
    });

    // Set up Express middleware and routes
    this.setupMiddleware();
    this.setupRoutes();

    // Set up config hot reload if enabled
    if (this.config.hotReload) {
      this.setupHotReload();
    }

    logLifecycle('startup', 'Gateway server initialized', {
      backends: this.config.backends.map((b) => b.name),
      routes: this.router.getRoutes().length,
      rateLimitingEnabled: this.config.rateLimit?.enabled ?? false,
    });
  }

  /**
   * Initialize Redis client for rate limiting
   */
  private async initializeRedis(): Promise<void> {
    if (!this.config?.redis) {
      logger.warn('Redis configuration not found, rate limiting will be disabled');
      return;
    }

    try {
      this.redisClient = createRedisClient({
        config: this.config.redis,
        keyPrefix: 'aegis:',
      });

      await this.redisClient.connect();
      logLifecycle('startup', 'Redis client connected for rate limiting');
    } catch (error) {
      logger.error('Failed to connect to Redis', {
        error: error instanceof Error ? error.message : String(error),
      });
      logger.warn('Rate limiting will be disabled due to Redis connection failure');
      this.redisClient = null;
    }
  }

  /**
   * Initialize the rate limiter
   */
  private initializeRateLimiter(): void {
    if (!this.redisClient || !this.config?.rateLimit?.enabled) {
      logger.info('Rate limiting is disabled');
      return;
    }

    // Convert config to rate limiter config format
    const rateLimitConfig = this.config.rateLimit;

    this.rateLimiter = createRateLimiter(this.redisClient, {
      enabled: rateLimitConfig.enabled,
      defaultAlgorithm: rateLimitConfig.defaultAlgorithm ?? 'token-bucket',
      defaultRequests: rateLimitConfig.defaultRequests ?? 100,
      defaultWindowSeconds: rateLimitConfig.defaultWindowSeconds ?? 60,
      keyStrategy: rateLimitConfig.keyStrategy ?? 'composite',
      keyPrefix: rateLimitConfig.keyPrefix ?? 'ratelimit:',
      bypass: rateLimitConfig.bypass,
      tierLimits: rateLimitConfig.tierLimits,
      rules: rateLimitConfig.rules ?? [],
      algorithmConfig: rateLimitConfig.algorithmConfig,
      includeHeaders: rateLimitConfig.includeHeaders ?? true,
      errorMessage: rateLimitConfig.errorMessage,
    });

    logLifecycle('startup', 'Rate limiter initialized', {
      algorithm: rateLimitConfig.defaultAlgorithm ?? 'token-bucket',
      defaultRequests: rateLimitConfig.defaultRequests ?? 100,
      defaultWindowSeconds: rateLimitConfig.defaultWindowSeconds ?? 60,
      rulesCount: rateLimitConfig.rules?.length ?? 0,
    });
  }

  /**
   * Initialize PostgreSQL client for metrics storage
   */
  private async initializePostgres(): Promise<void> {
    if (!this.config?.postgres) {
      logger.warn('PostgreSQL configuration not found, metrics will use in-memory storage only');
      return;
    }

    try {
      this.postgresClient = await initializePostgres(this.config.postgres);
      logLifecycle('startup', 'PostgreSQL client connected for metrics storage');
    } catch (error) {
      logger.error('Failed to connect to PostgreSQL', {
        error: error instanceof Error ? error.message : String(error),
      });
      logger.warn('Metrics will use in-memory storage only due to PostgreSQL connection failure');
      this.postgresClient = null;
    }
  }

  /**
   * Initialize the metrics collector
   */
  private async initializeMetrics(): Promise<void> {
    if (!this.config?.metrics?.enabled) {
      logger.info('Metrics collection is disabled');
      return;
    }

    try {
      this.metricsCollector = getMetricsCollector({
        enabled: this.config.metrics.enabled,
        flushIntervalMs: this.config.metrics.flushIntervalMs ?? 5000,
        batchSize: 100,
        retentionDays: 30,
        enabledMetrics: {
          requests: true,
          rateLimits: true,
          backends: true,
          system: true,
        },
      });

      if (this.postgresClient) {
        await initializeMetricsCollector(this.postgresClient, {
          enabled: this.config.metrics.enabled,
          flushIntervalMs: this.config.metrics.flushIntervalMs ?? 5000,
        });
        logLifecycle('startup', 'Metrics collector initialized with PostgreSQL storage');
      } else {
        logLifecycle('startup', 'Metrics collector initialized with in-memory storage only');
      }

      // Update backend health in metrics collector
      this.updateBackendHealthMetrics();
    } catch (error) {
      logger.error('Failed to initialize metrics collector', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Initialize authentication and authorization services
   */
  private initializeAuth(): void {
    if (!this.config?.auth?.enabled) {
      logger.info('Authentication is disabled');
      return;
    }

    try {
      // Cast to auth module's AuthConfig type
      const authConfig = this.config.auth as unknown as AuthConfig;

      // Create auth service
      this.authService = createAuthService(authConfig);
      logLifecycle('startup', 'Authentication service initialized', {
        apiKey: authConfig.apiKey?.enabled ?? false,
        jwt: authConfig.jwt?.enabled ?? false,
        oauth: authConfig.oauth ? true : false,
      });

      // Create RBAC service if enabled
      if (authConfig.rbac?.enabled) {
        this.rbacService = createRbacService(authConfig.rbac);
        logLifecycle('startup', 'RBAC service initialized', {
          rolesCount: authConfig.rbac.roles?.length ?? 0,
        });
      }
    } catch (error) {
      logger.error('Failed to initialize authentication', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Update backend health counts in metrics collector
   */
  private updateBackendHealthMetrics(): void {
    if (!this.metricsCollector || !this.config) return;

    const totalBackends = this.config.backends.length;
    // For now, assume all configured backends are healthy
    // In a full implementation, this would check actual health status
    const healthyBackends = totalBackends;

    this.metricsCollector.setBackendHealth(healthyBackends, totalBackends);
  }

  /**
   * Set up Express middleware
   */
  private setupMiddleware(): void {
    // Security middleware
    this.app.use(
      helmet({
        contentSecurityPolicy: false, // Disable CSP for API gateway
      })
    );

    // CORS
    this.app.use(cors());

    // Compression
    this.app.use(compression());

    // Request ID assignment
    this.app.use(requestIdMiddleware());

    // Connection tracking for real-time stats
    this.app.use(createConnectionTrackingMiddleware());

    // Server timing header
    this.app.use(createServerTimingMiddleware());

    // Metrics collection middleware
    if (this.config?.metrics?.enabled) {
      this.app.use(
        createMetricsMiddleware({
          skipPaths: ['/health', '/healthz', '/ready', '/metrics', '/_aegis'],
          trustProxy: true,
          includeBodySizes: false,
        })
      );
    }

    // Request logging
    this.app.use(
      requestLogger({
        skipPaths: ['/health', '/healthz', '/ready', '/metrics'],
      })
    );

    // Rate limiting middleware (before body parsing for efficiency)
    if (this.rateLimiter) {
      this.app.use(
        createRateLimitMiddleware({
          limiter: this.rateLimiter,
          skip: skipHealthChecks,
          trustProxy: true,
          onRateLimitExceeded: (req, res, result) => {
            logger.warn('Rate limit exceeded', {
              ip: req.ip,
              path: req.path,
              method: req.method,
              limit: result.limit,
              retryAfter: result.retryAfter,
            });

            // Set headers
            res.setHeader('X-RateLimit-Limit', result.limit.toString());
            res.setHeader('X-RateLimit-Remaining', '0');
            res.setHeader('X-RateLimit-Reset', result.resetAt.toString());
            res.setHeader('Retry-After', result.retryAfter.toString());

            res.status(429).json({
              error: 'Rate limit exceeded',
              code: 'RATE_LIMIT_EXCEEDED',
              message:
                this.config?.rateLimit?.errorMessage ??
                'Too many requests. Please try again later.',
              limit: result.limit,
              remaining: 0,
              windowSeconds: result.retryAfter,
              retryAfter: result.retryAfter,
              resetAt: new Date(result.resetAt * 1000).toISOString(),
            });
          },
        })
      );
      logger.info('Rate limiting middleware enabled');
    }

    // Authentication and RBAC middleware
    if (this.authService && this.config?.auth?.enabled) {
      const authConfig = this.config.auth as unknown as AuthConfig;

      // Create a default no-op RBAC service if not initialized
      const rbacService = this.rbacService ?? createRbacService({
        enabled: false,
        defaultRole: 'user',
        roles: [],
        superAdminRoles: [],
      });

      this.app.use(
        createAuthMiddleware({
          authService: this.authService,
          rbacService,
          config: authConfig,
        })
      );
      logger.info('Authentication middleware enabled', {
        rbacEnabled: authConfig.rbac?.enabled ?? false,
      });
    }

    // Request transformation middleware
    if (this.config?.transform?.request) {
      this.app.use(
        createRequestTransform({
          config: this.config.transform.request,
          trustProxy: true,
        })
      );
      logger.info('Request transformation middleware enabled');
    }

    // Response transformation middleware
    if (this.config?.transform?.response) {
      this.app.use(
        createResponseTransform({
          config: this.config.transform.response,
        })
      );
      logger.info('Response transformation middleware enabled');
    }

    // Parse JSON bodies for non-proxied routes
    this.app.use(express.json({ limit: '10mb' }));
    this.app.use(express.urlencoded({ extended: true, limit: '10mb' }));

    // Trust proxy for accurate IP detection
    this.app.set('trust proxy', true);
  }

  /**
   * Set up Express routes
   */
  private setupRoutes(): void {
    // Health check endpoints
    this.app.get('/health', this.healthCheck.bind(this));
    this.app.get('/healthz', this.healthCheck.bind(this));
    this.app.get('/ready', this.readinessCheck.bind(this));

    // Gateway status endpoint
    this.app.get('/_aegis/status', this.getStatus.bind(this));

    // Gateway routes endpoint (for debugging)
    this.app.get('/_aegis/routes', this.getRoutes.bind(this));

    // Rate limiter status endpoint
    this.app.get('/_aegis/ratelimit', this.getRateLimitStatus.bind(this));

    // Metrics status endpoint
    this.app.get('/_aegis/metrics', this.getMetricsStatus.bind(this));

    // Dashboard API routes
    this.app.use('/api/metrics', metricsRouter);
    this.app.use('/api/alerts', alertsRouter);
    this.app.use('/api/nl-query', nlQueryRouter);
    this.app.use('/api/ml', mlRouter);
    this.app.use('/api/health', healthRouter);

    // Set proxy server reference for health routes
    if (this.proxyServer !== null) {
      setProxyServer(this.proxyServer);
    }

    // Proxy all other requests (must be after API routes)
    if (this.proxyServer !== null) {
      this.app.all('*', this.proxyServer.middleware());
    }

    // 404 handler for unmatched routes
    this.app.use(notFoundHandler);

    // Error handler (must be last)
    this.app.use(errorHandler);
  }

  /**
   * Set up configuration hot reload
   */
  private setupHotReload(): void {
    this.configLoader.onConfigChange((_oldConfig, newConfig) => {
      logger.info('Configuration changed, reloading...');

      this.config = newConfig;

      // Update router with new backends
      this.router.registerBackends(newConfig.backends);

      // Update proxy server configuration
      if (this.proxyServer !== null) {
        this.proxyServer.updateConfig(newConfig);
      }

      // Update rate limiter configuration
      if (this.rateLimiter && newConfig.rateLimit) {
        this.rateLimiter.setConfig({
          enabled: newConfig.rateLimit.enabled,
          defaultAlgorithm: newConfig.rateLimit.defaultAlgorithm,
          defaultRequests: newConfig.rateLimit.defaultRequests,
          defaultWindowSeconds: newConfig.rateLimit.defaultWindowSeconds,
          bypass: newConfig.rateLimit.bypass,
          tierLimits: newConfig.rateLimit.tierLimits,
          rules: newConfig.rateLimit.rules ?? [],
        });
        logger.info('Rate limiter configuration updated');
      }

      logLifecycle('startup', 'Configuration reloaded', {
        backends: newConfig.backends.map((b) => b.name),
      });
    });

    this.configLoader.startWatching();
  }

  /**
   * Health check endpoint handler
   */
  private healthCheck(_req: Request, res: Response): void {
    res.status(200).json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Readiness check endpoint handler
   */
  private readinessCheck(_req: Request, res: Response): void {
    // Check if we have backends configured
    const hasBackends = this.router.hasRoutes();

    // Check Redis connection if rate limiting is enabled
    const redisConnected = this.redisClient?.isConnected ?? true;

    if (hasBackends && redisConnected) {
      res.status(200).json({
        status: 'ready',
        timestamp: new Date().toISOString(),
      });
    } else {
      res.status(503).json({
        status: 'not_ready',
        reason: !hasBackends ? 'No backends configured' : 'Redis not connected',
        timestamp: new Date().toISOString(),
      });
    }
  }

  /**
   * Get gateway status
   */
  private getStatus(_req: Request, res: Response): void {
    const status = this.getGatewayStatus();
    res.status(200).json(status);
  }

  /**
   * Get registered routes
   */
  private getRoutes(_req: Request, res: Response): void {
    const routes = this.router.getRoutes();
    res.status(200).json({ routes });
  }

  /**
   * Get rate limiter status and metrics
   */
  private getRateLimitStatus(_req: Request, res: Response): void {
    if (!this.rateLimiter) {
      res.status(200).json({
        enabled: false,
        message: 'Rate limiting is disabled',
      });
      return;
    }

    const config = this.rateLimiter.getConfig();
    const metrics = this.rateLimiter.getMetrics();

    res.status(200).json({
      enabled: config.enabled,
      algorithm: config.defaultAlgorithm,
      defaultLimits: {
        requests: config.defaultRequests,
        windowSeconds: config.defaultWindowSeconds,
      },
      keyStrategy: config.keyStrategy,
      rulesCount: config.rules.length,
      tierLimits: config.tierLimits,
      metrics: {
        totalChecks: metrics.totalChecks,
        allowed: metrics.allowed,
        denied: metrics.denied,
        bypassed: metrics.bypassed,
        avgLatencyMs: Math.round(metrics.avgLatencyMs * 100) / 100,
        byAlgorithm: metrics.byAlgorithm,
        byTier: metrics.byTier,
      },
      bypass: {
        ipsCount: config.bypass.ips.length,
        userIdsCount: config.bypass.userIds.length,
        apiKeysCount: config.bypass.apiKeys.length,
        pathsCount: config.bypass.paths.length,
        internalBypass: config.bypass.internal,
      },
    });
  }

  /**
   * Get metrics collector status
   */
  private getMetricsStatus(_req: Request, res: Response): void {
    if (!this.metricsCollector) {
      res.status(200).json({
        enabled: false,
        message: 'Metrics collection is disabled',
      });
      return;
    }

    const stats = this.metricsCollector.getStats();

    res.status(200).json({
      enabled: true,
      storage: this.postgresClient ? 'postgresql' : 'memory',
      config: stats.config,
      batchSizes: stats.batchSizes,
      realtimeCounters: stats.realtimeCounters,
    });
  }

  /**
   * Build gateway status object
   */
  private getGatewayStatus(): GatewayStatus & {
    rateLimiting: { enabled: boolean; connected: boolean };
  } {
    const now = new Date();
    const uptime = this.startTime
      ? Math.floor((now.getTime() - this.startTime.getTime()) / 1000)
      : 0;

    // Build backend health status
    const backends: BackendHealth[] =
      this.config?.backends.map((backend) => ({
        name: backend.name,
        url: backend.url,
        healthy: true, // TODO: Implement actual health checks
        lastCheck: now,
        consecutiveFailures: 0,
        consecutiveSuccesses: 1,
      })) ?? [];

    // Determine overall status
    const healthyBackends = backends.filter((b) => b.healthy).length;
    const totalBackends = backends.length;

    let status: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';
    if (healthyBackends === 0 && totalBackends > 0) {
      status = 'unhealthy';
    } else if (healthyBackends < totalBackends) {
      status = 'degraded';
    }

    // Check Redis/rate limiting status
    if (this.config?.rateLimit?.enabled && !this.redisClient?.isConnected) {
      status = 'degraded';
    }

    return {
      status,
      uptime,
      startTime: this.startTime ?? now,
      backends,
      version: '1.0.0',
      rateLimiting: {
        enabled: this.rateLimiter?.isEnabled() ?? false,
        connected: this.redisClient?.isConnected ?? false,
      },
    };
  }

  /**
   * Start the gateway server
   */
  public async start(): Promise<void> {
    if (this.config === null) {
      await this.initialize();
    }

    const config = this.config!;
    const { port, host } = config.server;

    return new Promise((resolve, reject) => {
      try {
        this.server = http.createServer(this.app);

        // Initialize WebSocket server for real-time metrics
        if (config.metrics?.enabled) {
          initializeMetricsWebSocket(this.server, {
            updateInterval: 1000,
            path: '/ws/metrics',
          });
          logLifecycle('startup', 'WebSocket server initialized for real-time metrics');
        }

        // Handle WebSocket upgrades for proxy
        if (this.proxyServer !== null) {
          this.server.on('upgrade', (req, socket, head) => {
            // Don't proxy our own WebSocket connections
            if (req.url?.startsWith('/ws/')) {
              return;
            }
            this.proxyServer!.handleUpgrade(req, socket, head);
          });
        }

        this.server.listen(port, host, () => {
          this.startTime = new Date();
          const address = this.server!.address() as AddressInfo;

          logLifecycle('ready', `AEGIS Gateway listening on ${address.address}:${address.port}`, {
            host: address.address,
            port: address.port,
            backends: config.backends.length,
            environment: config.server.nodeEnv,
            rateLimiting: this.rateLimiter?.isEnabled() ?? false,
            metricsEnabled: config.metrics?.enabled ?? false,
          });

          resolve();
        });

        this.server.on('error', (error) => {
          logLifecycle('error', 'Server error', { error: error.message });
          reject(error);
        });

        // Graceful shutdown handlers
        this.setupGracefulShutdown();
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Set up graceful shutdown handlers
   */
  private setupGracefulShutdown(): void {
    const signals: NodeJS.Signals[] = ['SIGTERM', 'SIGINT'];

    for (const signal of signals) {
      process.on(signal, () => {
        void this.shutdown(signal);
      });
    }
  }

  /**
   * Gracefully shutdown the server
   */
  public async shutdown(signal?: string): Promise<void> {
    if (this.isShuttingDown) {
      return;
    }

    this.isShuttingDown = true;

    logLifecycle('shutdown', `Shutting down gateway${signal ? ` (${signal})` : ''}...`);

    // Shutdown WebSocket server
    shutdownMetricsWebSocket();
    logLifecycle('shutdown', 'WebSocket server shut down');

    // Shutdown metrics collector (flushes pending metrics)
    await shutdownMetricsCollector();
    logLifecycle('shutdown', 'Metrics collector shut down');

    // Stop accepting new connections
    if (this.server !== null) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => {
          resolve();
        });
      });
    }

    // Stop config file watching
    await this.configLoader.stopWatching();

    // Close proxy server
    if (this.proxyServer !== null) {
      this.proxyServer.close();
    }

    // Close Redis connection
    if (this.redisClient !== null) {
      try {
        await this.redisClient.disconnect();
        logLifecycle('shutdown', 'Redis client disconnected');
      } catch (error) {
        logger.error('Error disconnecting Redis', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Close PostgreSQL connection
    if (this.postgresClient !== null) {
      try {
        await closePostgres();
        logLifecycle('shutdown', 'PostgreSQL client disconnected');
      } catch (error) {
        logger.error('Error disconnecting PostgreSQL', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    logLifecycle('shutdown', 'Gateway shutdown complete');
  }

  /**
   * Get the Express application (for testing)
   */
  public getApp(): Application {
    return this.app;
  }

  /**
   * Get the HTTP server (for testing)
   */
  public getServer(): http.Server | null {
    return this.server;
  }

  /**
   * Get current configuration
   */
  public getConfig(): AegisConfig | null {
    return this.config;
  }

  /**
   * Get rate limiter instance (for testing)
   */
  public getRateLimiter(): RateLimiter | null {
    return this.rateLimiter;
  }

  /**
   * Get metrics collector instance (for testing)
   */
  public getMetricsCollector(): MetricsCollector | null {
    return this.metricsCollector;
  }
}

// =============================================================================
// Factory Function
// =============================================================================

export function createGatewayServer(options?: GatewayServerOptions): GatewayServer {
  return new GatewayServer(options);
}

export default GatewayServer;
