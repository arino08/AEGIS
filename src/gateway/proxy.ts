/**
 * AEGIS - Proxy Server Module
 * Handles HTTP request proxying to backend services
 */

import type http from 'http';
import type { Duplex } from 'stream';
import { URL } from 'url';

import type { Request, Response, NextFunction } from 'express';
import httpProxy from 'http-proxy';

import logger, { logProxy } from '../utils/logger.js';
import type {
  AegisConfig,
  BackendConfig,
  ProxyRequest,
  ProxyResponse,
  RouteMatch,
} from '../utils/types.js';
import { matchesPattern, findBestMatch, generateRequestId, sleep } from '../utils/helpers.js';
import { CircuitBreaker, CircuitBreakerManager, CircuitState, CircuitOpenError } from './circuit-breaker.js';
import { HealthChecker, HealthStatus, type ServiceHealth } from './health-checker.js';

// =============================================================================
// Types
// =============================================================================

export interface ProxyServerOptions {
  config: AegisConfig;
  onRequestStart?: (req: ProxyRequest) => void;
  onRequestEnd?: (req: ProxyRequest, res: ProxyResponse, durationMs: number) => void;
  onProxyError?: (req: ProxyRequest, error: Error) => void;
  enableCircuitBreaker?: boolean;
  enableHealthChecks?: boolean;
}

export interface ProxyStats {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  totalResponseTimeMs: number;
  requestsByBackend: Map<string, number>;
  circuitBreakerRejections: number;
  healthCheckFailures: number;
}

// =============================================================================
// Proxy Server Class
// =============================================================================

export class ProxyServer {
  private proxy: httpProxy;
  private config: AegisConfig;
  private stats: ProxyStats;
  private options: ProxyServerOptions;
  private circuitBreakerManager: CircuitBreakerManager;
  private healthChecker: HealthChecker;

  constructor(options: ProxyServerOptions) {
    this.options = options;
    this.config = options.config;
    this.stats = this.initStats();

    // Initialize circuit breaker manager
    this.circuitBreakerManager = new CircuitBreakerManager({
      failureThreshold: options.config.proxy.circuitBreaker?.failureThreshold ?? 5,
      successThreshold: options.config.proxy.circuitBreaker?.successThreshold ?? 3,
      resetTimeoutMs: options.config.proxy.circuitBreaker?.resetTimeoutMs ?? 30000,
      failureWindowMs: options.config.proxy.circuitBreaker?.failureWindowMs ?? 60000,
      useSlidingWindow: true,
      failureRateThreshold: options.config.proxy.circuitBreaker?.failureRateThreshold ?? 50,
      minimumRequestThreshold: 10,
    });

    // Initialize health checker
    this.healthChecker = new HealthChecker({
      defaultIntervalMs: options.config.proxy.healthCheck?.intervalMs ?? 30000,
      defaultTimeoutMs: options.config.proxy.healthCheck?.timeoutMs ?? 5000,
      defaultUnhealthyThreshold: options.config.proxy.healthCheck?.unhealthyThreshold ?? 3,
      defaultHealthyThreshold: options.config.proxy.healthCheck?.healthyThreshold ?? 2,
      checkOnStart: true,
    });

    // Register backends for health checking and create circuit breakers
    for (const backend of this.config.backends) {
      this.circuitBreakerManager.getBreaker(backend.name);
      if (options.enableHealthChecks !== false) {
        this.healthChecker.registerService(backend);
      }
    }

    // Set up health check event handlers
    this.setupHealthCheckHandlers();

    // Create the HTTP proxy server
    this.proxy = httpProxy.createProxyServer({
      changeOrigin: true,
      xfwd: true, // Add x-forwarded headers
      ws: true, // Support WebSockets
      timeout: this.config.proxy.timeoutMs,
      proxyTimeout: this.config.proxy.timeoutMs,
    });

    // Set up proxy event handlers
    this.setupProxyEventHandlers();

    // Start health checks
    if (options.enableHealthChecks !== false) {
      this.healthChecker.start();
    }
  }

  /**
   * Set up health check event handlers
   */
  private setupHealthCheckHandlers(): void {
    this.healthChecker.on('statusChange', (serviceName: string, _from: HealthStatus, to: HealthStatus) => {
      // If service becomes unhealthy, consider opening circuit breaker
      if (to === HealthStatus.UNHEALTHY) {
        const breaker = this.circuitBreakerManager.getBreaker(serviceName);
        if (breaker.getState() === CircuitState.CLOSED) {
          logger.warn(`Opening circuit for ${serviceName} due to health check failures`, {
            component: 'proxy',
            service: serviceName
          });
          breaker.forceOpen();
        }
      }
    });

    this.healthChecker.on('checkFailed', (_serviceName: string, _error: string) => {
      this.stats.healthCheckFailures++;
    });
  }

  /**
   * Initialize statistics tracking
   */
  private initStats(): ProxyStats {
    return {
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      totalResponseTimeMs: 0,
      requestsByBackend: new Map(),
      circuitBreakerRejections: 0,
      healthCheckFailures: 0,
    };
  }

  /**
   * Set up proxy event handlers for logging and error handling
   */
  private setupProxyEventHandlers(): void {
    // Handle proxy response
    this.proxy.on('proxyRes', (_proxyRes, req, res) => {
      const proxyReq = req as ProxyRequest;
      const proxyResponse = res as ProxyResponse;
      const durationMs = Date.now() - proxyReq.startTime;

      proxyResponse.responseTime = durationMs;

      logProxy({
        requestId: proxyReq.requestId,
        event: 'proxy_complete',
        target: proxyReq.targetBackend?.url ?? 'unknown',
        path: proxyReq.path,
        durationMs,
      });

      this.stats.successfulRequests++;
      this.stats.totalResponseTimeMs += durationMs;

      if (this.options.onRequestEnd) {
        this.options.onRequestEnd(proxyReq, proxyResponse, durationMs);
      }
    });

    // Handle proxy errors
    this.proxy.on('error', (err, req, res) => {
      const proxyReq = req as ProxyRequest;
      const httpRes = res as http.ServerResponse;
      const durationMs = Date.now() - proxyReq.startTime;

      logProxy({
        requestId: proxyReq.requestId,
        event: 'proxy_error',
        target: proxyReq.targetBackend?.url ?? 'unknown',
        path: proxyReq.path,
        durationMs,
        error: err.message,
      });

      this.stats.failedRequests++;

      if (this.options.onProxyError) {
        this.options.onProxyError(proxyReq, err);
      }

      // Send error response if headers haven't been sent
      if (!httpRes.headersSent) {
        const statusCode = this.getErrorStatusCode(err);
        const errorMessage = this.getErrorMessage(err);

        httpRes.writeHead(statusCode, { 'Content-Type': 'application/json' });
        httpRes.end(
          JSON.stringify({
            error: errorMessage,
            code: 'PROXY_ERROR',
            requestId: proxyReq.requestId,
          })
        );
      }
    });

    // Handle timeout
    this.proxy.on('proxyReqWs', (proxyReq, req) => {
      const originalReq = req as ProxyRequest;
      proxyReq.setHeader('X-Request-ID', originalReq.requestId);
    });
  }

  /**
   * Get appropriate HTTP status code for proxy errors
   */
  private getErrorStatusCode(err: Error & { code?: string }): number {
    const errorCode = err.code;

    if (errorCode === 'ECONNREFUSED' || errorCode === 'ENOTFOUND') {
      return 502; // Bad Gateway
    }
    if (errorCode === 'ETIMEDOUT' || errorCode === 'ESOCKETTIMEDOUT') {
      return 504; // Gateway Timeout
    }
    if (errorCode === 'ECONNRESET') {
      return 502; // Bad Gateway
    }

    return 502; // Default to Bad Gateway
  }

  /**
   * Get user-friendly error message
   */
  private getErrorMessage(err: Error & { code?: string }): string {
    const errorCode = err.code;

    if (errorCode === 'ECONNREFUSED') {
      return 'Backend service is unavailable';
    }
    if (errorCode === 'ENOTFOUND') {
      return 'Backend service not found';
    }
    if (errorCode === 'ETIMEDOUT' || errorCode === 'ESOCKETTIMEDOUT') {
      return 'Request to backend timed out';
    }
    if (errorCode === 'ECONNRESET') {
      return 'Connection to backend was reset';
    }

    return 'Error connecting to backend service';
  }

  /**
   * Find the matching backend for a request path
   */
  public findBackend(path: string): RouteMatch | null {
    // Collect all patterns and their backends
    const patternToBackend = new Map<string, BackendConfig>();

    for (const backend of this.config.backends) {
      for (const route of backend.routes) {
        if (matchesPattern(path, route)) {
          patternToBackend.set(route, backend);
        }
      }
    }

    if (patternToBackend.size === 0) {
      return null;
    }

    // Find the best (most specific) match
    const patterns = Array.from(patternToBackend.keys());
    const bestPattern = findBestMatch(path, patterns);

    if (bestPattern === null) {
      return null;
    }

    const backend = patternToBackend.get(bestPattern);
    if (backend === undefined) {
      return null;
    }

    return {
      backend,
      matchedPattern: bestPattern,
    };
  }

  /**
   * Main proxy middleware handler
   */
  public middleware(): (req: Request, res: Response, next: NextFunction) => void {
    return (req: Request, res: Response, next: NextFunction): void => {
      // Augment request with proxy-specific properties
      const proxyReq = req as ProxyRequest;
      proxyReq.requestId = (req.headers['x-request-id'] as string) ?? generateRequestId();
      proxyReq.startTime = Date.now();

      // Add request ID to response headers
      res.setHeader('X-Request-ID', proxyReq.requestId);

      // Find matching backend
      const routeMatch = this.findBackend(req.path);

      if (routeMatch === null) {
        // No backend found - pass to next middleware (likely 404 handler)
        next();
        return;
      }

      proxyReq.targetBackend = routeMatch.backend;

      // Check circuit breaker state
      const breaker = this.circuitBreakerManager.getBreaker(routeMatch.backend.name);
      if (!breaker.canRequest()) {
        this.stats.circuitBreakerRejections++;
        const retryAfter = Math.ceil(breaker.getTimeUntilReset() / 1000);

        logProxy({
          requestId: proxyReq.requestId,
          event: 'circuit_breaker_open',
          target: routeMatch.backend.url,
          path: req.path,
          retryAfter,
        });

        res.setHeader('Retry-After', retryAfter.toString());
        res.status(503).json({
          error: 'Service temporarily unavailable',
          code: 'CIRCUIT_BREAKER_OPEN',
          message: `Backend service ${routeMatch.backend.name} is experiencing issues. Please retry after ${retryAfter} seconds.`,
          requestId: proxyReq.requestId,
          retryAfter,
        });
        return;
      }

      // Update stats
      this.stats.totalRequests++;
      const backendCount = this.stats.requestsByBackend.get(routeMatch.backend.name) ?? 0;
      this.stats.requestsByBackend.set(routeMatch.backend.name, backendCount + 1);

      // Trigger request start callback
      if (this.options.onRequestStart) {
        this.options.onRequestStart(proxyReq);
      }

      logProxy({
        requestId: proxyReq.requestId,
        event: 'proxy_start',
        target: routeMatch.backend.url,
        path: req.path,
      });

      // Proxy the request with retry logic
      void this.proxyWithRetry(proxyReq, res as ProxyResponse, routeMatch.backend);
    };
  }

  /**
   * Proxy request with retry logic and circuit breaker integration
   */
  private async proxyWithRetry(
    req: ProxyRequest,
    res: ProxyResponse,
    backend: BackendConfig
  ): Promise<void> {
    const maxRetries = backend.retries ?? this.config.proxy.retryAttempts;
    const retryDelay = this.config.proxy.retryDelayMs;
    const breaker = this.circuitBreakerManager.getBreaker(backend.name);
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        if (attempt > 0) {
          // Check circuit breaker before retry
          if (!breaker.canRequest()) {
            throw new CircuitOpenError(backend.name, breaker.getTimeUntilReset());
          }

          logger.debug(`Retry attempt ${attempt} for ${req.path}`, {
            requestId: req.requestId,
            backend: backend.name,
          });
          await sleep(retryDelay * attempt);
        }

        await this.executeProxy(req, res, backend);

        // Record success with circuit breaker
        breaker.recordSuccess();
        return; // Success
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // Record failure with circuit breaker (unless it's a client error)
        if (!lastError.message.includes('4') && !(lastError instanceof CircuitOpenError)) {
          breaker.recordFailure(lastError);
        }

        // Don't retry on client errors (4xx)
        if (lastError.message.includes('4')) {
          throw lastError;
        }

        // Don't retry if response has already started
        if (res.headersSent) {
          throw lastError;
        }

        // Don't retry if circuit is now open
        if (lastError instanceof CircuitOpenError) {
          throw lastError;
        }
      }
    }

    // All retries exhausted
    if (lastError !== null) {
      logger.error(`All retry attempts exhausted for ${req.path}`, {
        requestId: req.requestId,
        backend: backend.name,
        error: lastError.message,
        circuitState: breaker.getState(),
      });
    }
  }

  /**
   * Execute the actual proxy request
   */
  private executeProxy(
    req: ProxyRequest,
    res: ProxyResponse,
    backend: BackendConfig
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      // Set up one-time listeners for this request
      const onError = (err: Error): void => {
        cleanup();
        reject(err);
      };

      const onProxyRes = (): void => {
        cleanup();
        resolve();
      };

      const cleanup = (): void => {
        this.proxy.off('error', onError);
        this.proxy.off('proxyRes', onProxyRes);
      };

      this.proxy.once('error', onError);
      this.proxy.once('proxyRes', onProxyRes);

      // Execute proxy
      const targetUrl = new URL(backend.url);
      const port = targetUrl.port
        ? parseInt(targetUrl.port, 10)
        : targetUrl.protocol === 'https:'
          ? 443
          : 80;

      this.proxy.web(req, res, {
        target: {
          protocol: targetUrl.protocol,
          host: targetUrl.hostname,
          port: port,
        },
        timeout: backend.timeout ?? this.config.proxy.timeoutMs,
      });
    });
  }

  /**
   * Handle WebSocket upgrade requests
   */
  public handleUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    const path = req.url ?? '/';
    const routeMatch = this.findBackend(path);

    if (routeMatch === null) {
      socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
      return;
    }

    const targetUrl = new URL(routeMatch.backend.url);
    const port = targetUrl.port
      ? parseInt(targetUrl.port, 10)
      : targetUrl.protocol === 'https:'
        ? 443
        : 80;

    this.proxy.ws(req, socket, head, {
      target: {
        protocol: targetUrl.protocol === 'https:' ? 'wss:' : 'ws:',
        host: targetUrl.hostname,
        port: port,
      },
    });
  }

  /**
   * Update configuration (for hot reload)
   */
  public updateConfig(newConfig: AegisConfig): void {
    this.config = newConfig;

    // Update proxy timeout settings
    this.proxy = httpProxy.createProxyServer({
      changeOrigin: true,
      xfwd: true,
      ws: true,
      timeout: newConfig.proxy.timeoutMs,
      proxyTimeout: newConfig.proxy.timeoutMs,
    });

    this.setupProxyEventHandlers();

    logger.info('Proxy configuration updated', {
      backends: newConfig.backends.map((b) => b.name),
      timeout: newConfig.proxy.timeoutMs,
    });
  }

  /**
   * Get proxy statistics
   */
  public getStats(): ProxyStats {
    return { ...this.stats };
  }

  /**
   * Reset proxy statistics
   */
  public resetStats(): void {
    this.stats = this.initStats();
  }

  /**
   * Get health status for all backends
   */
  public getHealthStatus(): ServiceHealth[] {
    return this.healthChecker.getAllServiceHealth();
  }

  /**
   * Get health status for a specific backend
   */
  public getBackendHealth(backendName: string): ServiceHealth | null {
    return this.healthChecker.getServiceHealth(backendName);
  }

  /**
   * Get circuit breaker states for all backends
   */
  public getCircuitBreakerStates(): Record<string, {
    state: CircuitState;
    stats: ReturnType<CircuitBreaker['getStats']>;
  }> {
    const states: Record<string, { state: CircuitState; stats: ReturnType<CircuitBreaker['getStats']> }> = {};

    for (const [name, breaker] of this.circuitBreakerManager.getAllBreakers()) {
      states[name] = {
        state: breaker.getState(),
        stats: breaker.getStats(),
      };
    }

    return states;
  }

  /**
   * Get circuit breaker state for a specific backend
   */
  public getCircuitBreakerState(backendName: string): CircuitState {
    return this.circuitBreakerManager.getBreaker(backendName).getState();
  }

  /**
   * Force open a circuit breaker (manual intervention)
   */
  public forceOpenCircuit(backendName: string): void {
    this.circuitBreakerManager.getBreaker(backendName).forceOpen();
  }

  /**
   * Force close a circuit breaker (manual intervention)
   */
  public forceCloseCircuit(backendName: string): void {
    this.circuitBreakerManager.getBreaker(backendName).forceClose();
  }

  /**
   * Trigger a manual health check for a backend
   */
  public async triggerHealthCheck(backendName: string): Promise<ServiceHealth | null> {
    await this.healthChecker.performCheck(backendName);
    return this.healthChecker.getServiceHealth(backendName);
  }

  /**
   * Get combined health and circuit breaker status
   */
  public getBackendStatus(): Array<{
    name: string;
    url: string;
    health: ServiceHealth | null;
    circuitBreaker: {
      state: CircuitState;
      stats: ReturnType<CircuitBreaker['getStats']>;
    };
    isAvailable: boolean;
  }> {
    const status: Array<{
      name: string;
      url: string;
      health: ServiceHealth | null;
      circuitBreaker: { state: CircuitState; stats: ReturnType<CircuitBreaker['getStats']> };
      isAvailable: boolean;
    }> = [];

    for (const backend of this.config.backends) {
      const health = this.healthChecker.getServiceHealth(backend.name);
      const breaker = this.circuitBreakerManager.getBreaker(backend.name);
      const breakerState = breaker.getState();
      const breakerStats = breaker.getStats();

      const isAvailable =
        breakerState !== CircuitState.OPEN &&
        health?.status !== HealthStatus.UNHEALTHY;

      status.push({
        name: backend.name,
        url: backend.url,
        health,
        circuitBreaker: {
          state: breakerState,
          stats: breakerStats,
        },
        isAvailable,
      });
    }

    return status;
  }

  /**
   * Close the proxy server and cleanup
   */
  public close(): void {
    this.healthChecker.destroy();
    this.circuitBreakerManager.destroy();
    this.proxy.close();
  }
}

// =============================================================================
// Factory Function
// =============================================================================

export function createProxyServer(options: ProxyServerOptions): ProxyServer {
  return new ProxyServer(options);
}

export default ProxyServer;
