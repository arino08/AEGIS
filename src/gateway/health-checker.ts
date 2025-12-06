/**
 * AEGIS - Health Check Service
 * Monitors backend service health with periodic checks
 */

import { EventEmitter } from 'events';
import logger from '../utils/logger.js';
import type { BackendConfig, HealthCheckConfig } from '../utils/types.js';

// =============================================================================
// Types
// =============================================================================

export enum HealthStatus {
  HEALTHY = 'healthy',
  UNHEALTHY = 'unhealthy',
  DEGRADED = 'degraded',
  UNKNOWN = 'unknown'
}

export interface HealthCheckResult {
  serviceName: string;
  status: HealthStatus;
  url: string;
  responseTimeMs: number | null;
  lastCheck: Date;
  lastSuccess: Date | null;
  lastError: string | null;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  totalChecks: number;
  successfulChecks: number;
  failedChecks: number;
  uptimePercentage: number;
}

export interface ServiceHealth {
  name: string;
  url: string;
  status: HealthStatus;
  lastCheck: Date | null;
  lastSuccess: Date | null;
  lastError: string | null;
  responseTimeMs: number | null;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  checks: {
    total: number;
    successful: number;
    failed: number;
  };
}

interface HealthCheckState {
  serviceName: string;
  url: string;
  healthPath: string;
  status: HealthStatus;
  lastCheck: Date | null;
  lastSuccess: Date | null;
  lastError: string | null;
  responseTimeMs: number | null;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  totalChecks: number;
  successfulChecks: number;
  failedChecks: number;
  intervalHandle: NodeJS.Timeout | null;
  config: HealthCheckConfig;
}

export interface HealthCheckerConfig {
  /** Default health check interval in ms */
  defaultIntervalMs: number;
  /** Default timeout for health checks in ms */
  defaultTimeoutMs: number;
  /** Number of consecutive failures before marking unhealthy */
  defaultUnhealthyThreshold: number;
  /** Number of consecutive successes before marking healthy */
  defaultHealthyThreshold: number;
  /** Whether to perform initial health check immediately */
  checkOnStart: boolean;
}

// =============================================================================
// Health Checker Class
// =============================================================================

export class HealthChecker extends EventEmitter {
  private services: Map<string, HealthCheckState> = new Map();
  private config: HealthCheckerConfig;
  private isRunning: boolean = false;

  constructor(config?: Partial<HealthCheckerConfig>) {
    super();
    this.config = {
      defaultIntervalMs: 30000,
      defaultTimeoutMs: 5000,
      defaultUnhealthyThreshold: 3,
      defaultHealthyThreshold: 2,
      checkOnStart: true,
      ...config
    };
  }

  /**
   * Register a backend service for health monitoring
   */
  registerService(backend: BackendConfig): void {
    const healthConfig = backend.healthCheck || {
      path: '/health',
      intervalMs: this.config.defaultIntervalMs,
      timeoutMs: this.config.defaultTimeoutMs,
      unhealthyThreshold: this.config.defaultUnhealthyThreshold,
      healthyThreshold: this.config.defaultHealthyThreshold
    };

    const state: HealthCheckState = {
      serviceName: backend.name,
      url: backend.url,
      healthPath: healthConfig.path,
      status: HealthStatus.UNKNOWN,
      lastCheck: null,
      lastSuccess: null,
      lastError: null,
      responseTimeMs: null,
      consecutiveFailures: 0,
      consecutiveSuccesses: 0,
      totalChecks: 0,
      successfulChecks: 0,
      failedChecks: 0,
      intervalHandle: null,
      config: healthConfig
    };

    this.services.set(backend.name, state);

    logger.info(`Health check registered for ${backend.name}`, {
      component: 'health-checker',
      service: backend.name,
      url: backend.url,
      healthPath: healthConfig.path,
      intervalMs: healthConfig.intervalMs
    });
  }

  /**
   * Start health checking for all registered services
   */
  start(): void {
    if (this.isRunning) {
      logger.warn('Health checker already running', { component: 'health-checker' });
      return;
    }

    this.isRunning = true;

    for (const [name, state] of this.services) {
      this.startServiceCheck(name, state);
    }

    logger.info('Health checker started', {
      component: 'health-checker',
      services: Array.from(this.services.keys())
    });
  }

  /**
   * Start health checking for a specific service
   */
  private startServiceCheck(name: string, state: HealthCheckState): void {
    // Perform initial check if configured
    if (this.config.checkOnStart) {
      this.performCheck(name);
    }

    // Set up interval for periodic checks
    state.intervalHandle = setInterval(() => {
      this.performCheck(name);
    }, state.config.intervalMs);
  }

  /**
   * Stop all health checks
   */
  stop(): void {
    if (!this.isRunning) {
      return;
    }

    for (const state of this.services.values()) {
      if (state.intervalHandle) {
        clearInterval(state.intervalHandle);
        state.intervalHandle = null;
      }
    }

    this.isRunning = false;
    logger.info('Health checker stopped', { component: 'health-checker' });
  }

  /**
   * Perform a health check for a specific service
   */
  async performCheck(serviceName: string): Promise<HealthCheckResult | null> {
    const state = this.services.get(serviceName);
    if (!state) {
      logger.warn(`Service not found for health check: ${serviceName}`, {
        component: 'health-checker'
      });
      return null;
    }

    const healthUrl = `${state.url}${state.healthPath}`;
    const startTime = Date.now();

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), state.config.timeoutMs);

      const response = await fetch(healthUrl, {
        method: 'GET',
        signal: controller.signal,
        headers: {
          'User-Agent': 'AEGIS-HealthChecker/1.0',
          'Accept': 'application/json'
        }
      });

      clearTimeout(timeoutId);

      const responseTimeMs = Date.now() - startTime;
      state.responseTimeMs = responseTimeMs;
      state.lastCheck = new Date();
      state.totalChecks++;

      if (response.ok) {
        return this.recordSuccess(state, responseTimeMs);
      } else {
        return this.recordFailure(state, `HTTP ${response.status}: ${response.statusText}`);
      }
    } catch (error) {
      const err = error as Error;
      let errorMessage = err.message;

      if (err.name === 'AbortError') {
        errorMessage = `Connection timeout after ${state.config.timeoutMs}ms`;
      }

      state.lastCheck = new Date();
      state.totalChecks++;
      state.responseTimeMs = Date.now() - startTime;

      return this.recordFailure(state, errorMessage);
    }
  }

  /**
   * Record a successful health check
   */
  private recordSuccess(state: HealthCheckState, responseTimeMs: number): HealthCheckResult {
    const previousStatus = state.status;

    state.consecutiveSuccesses++;
    state.consecutiveFailures = 0;
    state.successfulChecks++;
    state.lastSuccess = new Date();
    state.lastError = null;

    // Check if service should be marked healthy
    if (state.consecutiveSuccesses >= state.config.healthyThreshold) {
      state.status = HealthStatus.HEALTHY;
    } else if (state.status === HealthStatus.UNHEALTHY) {
      state.status = HealthStatus.DEGRADED;
    }

    const result = this.buildResult(state);

    if (previousStatus !== state.status) {
      this.emit('statusChange', state.serviceName, previousStatus, state.status);
      logger.info(`Service ${state.serviceName} status changed: ${previousStatus} → ${state.status}`, {
        component: 'health-checker',
        service: state.serviceName,
        responseTimeMs
      });
    }

    this.emit('checkComplete', result);
    return result;
  }

  /**
   * Record a failed health check
   */
  private recordFailure(state: HealthCheckState, errorMessage: string): HealthCheckResult {
    const previousStatus = state.status;

    state.consecutiveFailures++;
    state.consecutiveSuccesses = 0;
    state.failedChecks++;
    state.lastError = errorMessage;

    // Check if service should be marked unhealthy
    if (state.consecutiveFailures >= state.config.unhealthyThreshold) {
      state.status = HealthStatus.UNHEALTHY;
    } else if (state.status === HealthStatus.HEALTHY) {
      state.status = HealthStatus.DEGRADED;
    }

    const result = this.buildResult(state);

    if (previousStatus !== state.status) {
      this.emit('statusChange', state.serviceName, previousStatus, state.status);
      logger.warn(`Service ${state.serviceName} status changed: ${previousStatus} → ${state.status}`, {
        component: 'health-checker',
        service: state.serviceName,
        error: errorMessage,
        consecutiveFailures: state.consecutiveFailures
      });
    }

    this.emit('checkComplete', result);
    this.emit('checkFailed', state.serviceName, errorMessage);

    return result;
  }

  /**
   * Build health check result object
   */
  private buildResult(state: HealthCheckState): HealthCheckResult {
    return {
      serviceName: state.serviceName,
      status: state.status,
      url: state.url,
      responseTimeMs: state.responseTimeMs,
      lastCheck: state.lastCheck!,
      lastSuccess: state.lastSuccess,
      lastError: state.lastError,
      consecutiveFailures: state.consecutiveFailures,
      consecutiveSuccesses: state.consecutiveSuccesses,
      totalChecks: state.totalChecks,
      successfulChecks: state.successfulChecks,
      failedChecks: state.failedChecks,
      uptimePercentage: state.totalChecks > 0
        ? (state.successfulChecks / state.totalChecks) * 100
        : 0
    };
  }

  /**
   * Get health status for a specific service
   */
  getServiceHealth(serviceName: string): ServiceHealth | null {
    const state = this.services.get(serviceName);
    if (!state) return null;

    return {
      name: state.serviceName,
      url: state.url,
      status: state.status,
      lastCheck: state.lastCheck,
      lastSuccess: state.lastSuccess,
      lastError: state.lastError,
      responseTimeMs: state.responseTimeMs,
      consecutiveFailures: state.consecutiveFailures,
      consecutiveSuccesses: state.consecutiveSuccesses,
      checks: {
        total: state.totalChecks,
        successful: state.successfulChecks,
        failed: state.failedChecks
      }
    };
  }

  /**
   * Get health status for all services
   */
  getAllServiceHealth(): ServiceHealth[] {
    const results: ServiceHealth[] = [];
    for (const state of this.services.values()) {
      results.push({
        name: state.serviceName,
        url: state.url,
        status: state.status,
        lastCheck: state.lastCheck,
        lastSuccess: state.lastSuccess,
        lastError: state.lastError,
        responseTimeMs: state.responseTimeMs,
        consecutiveFailures: state.consecutiveFailures,
        consecutiveSuccesses: state.consecutiveSuccesses,
        checks: {
          total: state.totalChecks,
          successful: state.successfulChecks,
          failed: state.failedChecks
        }
      });
    }
    return results;
  }

  /**
   * Check if a service is healthy
   */
  isServiceHealthy(serviceName: string): boolean {
    const state = this.services.get(serviceName);
    return state?.status === HealthStatus.HEALTHY;
  }

  /**
   * Get list of healthy services
   */
  getHealthyServices(): string[] {
    const healthy: string[] = [];
    for (const [name, state] of this.services) {
      if (state.status === HealthStatus.HEALTHY) {
        healthy.push(name);
      }
    }
    return healthy;
  }

  /**
   * Get list of unhealthy services
   */
  getUnhealthyServices(): string[] {
    const unhealthy: string[] = [];
    for (const [name, state] of this.services) {
      if (state.status === HealthStatus.UNHEALTHY) {
        unhealthy.push(name);
      }
    }
    return unhealthy;
  }

  /**
   * Force a service status (manual override)
   */
  forceStatus(serviceName: string, status: HealthStatus): void {
    const state = this.services.get(serviceName);
    if (!state) return;

    const previousStatus = state.status;
    state.status = status;

    if (status === HealthStatus.HEALTHY) {
      state.consecutiveFailures = 0;
    } else if (status === HealthStatus.UNHEALTHY) {
      state.consecutiveSuccesses = 0;
    }

    this.emit('statusChange', serviceName, previousStatus, status);
    logger.info(`Service ${serviceName} status forced: ${previousStatus} → ${status}`, {
      component: 'health-checker',
      service: serviceName
    });
  }

  /**
   * Remove a service from health checking
   */
  unregisterService(serviceName: string): void {
    const state = this.services.get(serviceName);
    if (!state) return;

    if (state.intervalHandle) {
      clearInterval(state.intervalHandle);
    }

    this.services.delete(serviceName);
    logger.info(`Health check unregistered for ${serviceName}`, {
      component: 'health-checker'
    });
  }

  /**
   * Get summary of all services health
   */
  getSummary(): {
    total: number;
    healthy: number;
    unhealthy: number;
    degraded: number;
    unknown: number;
  } {
    let healthy = 0, unhealthy = 0, degraded = 0, unknown = 0;

    for (const state of this.services.values()) {
      switch (state.status) {
        case HealthStatus.HEALTHY:
          healthy++;
          break;
        case HealthStatus.UNHEALTHY:
          unhealthy++;
          break;
        case HealthStatus.DEGRADED:
          degraded++;
          break;
        default:
          unknown++;
      }
    }

    return {
      total: this.services.size,
      healthy,
      unhealthy,
      degraded,
      unknown
    };
  }

  /**
   * Clean up resources
   */
  destroy(): void {
    this.stop();
    this.services.clear();
    this.removeAllListeners();
  }
}

// =============================================================================
// Default Export
// =============================================================================

export const healthChecker = new HealthChecker();
