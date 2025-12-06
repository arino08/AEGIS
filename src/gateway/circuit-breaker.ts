/**
 * AEGIS - Circuit Breaker Implementation
 * Prevents cascading failures by fast-failing requests to unhealthy backends
 */

import { EventEmitter } from 'events';
import logger from '../utils/logger.js';

// =============================================================================
// Types
// =============================================================================

export enum CircuitState {
  CLOSED = 'CLOSED',     // Normal operation - requests flow through
  OPEN = 'OPEN',         // Circuit tripped - fail fast
  HALF_OPEN = 'HALF_OPEN' // Testing if service recovered
}

export interface CircuitBreakerConfig {
  /** Number of failures before opening circuit */
  failureThreshold: number;
  /** Number of successes needed to close circuit from half-open */
  successThreshold: number;
  /** Time in ms before attempting recovery (half-open) */
  resetTimeoutMs: number;
  /** Time window in ms for counting failures */
  failureWindowMs: number;
  /** Whether to use sliding window for failure rate calculation */
  useSlidingWindow: boolean;
  /** Failure rate percentage threshold (0-100) when using sliding window */
  failureRateThreshold: number;
  /** Minimum number of requests in window before evaluating failure rate */
  minimumRequestThreshold: number;
}

export interface CircuitBreakerStats {
  state: CircuitState;
  failures: number;
  successes: number;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  lastFailureTime: number | null;
  lastSuccessTime: number | null;
  lastStateChange: number;
  totalRequests: number;
  failedRequests: number;
  openCount: number;
  halfOpenCount: number;
}

interface RequestRecord {
  timestamp: number;
  success: boolean;
}

export interface CircuitBreakerEvents {
  stateChange: (from: CircuitState, to: CircuitState, serviceName: string) => void;
  failure: (serviceName: string, error: Error) => void;
  success: (serviceName: string) => void;
  rejected: (serviceName: string) => void;
}

// =============================================================================
// Circuit Breaker Class
// =============================================================================

export class CircuitBreaker extends EventEmitter {
  private state: CircuitState = CircuitState.CLOSED;
  private failures: number = 0;
  private successes: number = 0;
  private consecutiveFailures: number = 0;
  private consecutiveSuccesses: number = 0;
  private lastFailureTime: number | null = null;
  private lastSuccessTime: number | null = null;
  private lastStateChange: number = Date.now();
  private totalRequests: number = 0;
  private failedRequests: number = 0;
  private openCount: number = 0;
  private halfOpenCount: number = 0;
  private resetTimer: NodeJS.Timeout | null = null;
  private requestWindow: RequestRecord[] = [];

  constructor(
    private readonly serviceName: string,
    private readonly config: CircuitBreakerConfig
  ) {
    super();
    logger.info(`Circuit breaker initialized for ${serviceName}`, {
      component: 'circuit-breaker',
      service: serviceName,
      config: {
        failureThreshold: config.failureThreshold,
        successThreshold: config.successThreshold,
        resetTimeoutMs: config.resetTimeoutMs,
      }
    });
  }

  /**
   * Check if a request is allowed through the circuit
   */
  canRequest(): boolean {
    if (this.state === CircuitState.CLOSED) {
      return true;
    }

    if (this.state === CircuitState.OPEN) {
      // Check if reset timeout has passed
      const timeSinceOpen = Date.now() - this.lastStateChange;
      if (timeSinceOpen >= this.config.resetTimeoutMs) {
        this.transitionTo(CircuitState.HALF_OPEN);
        return true;
      }
      return false;
    }

    // HALF_OPEN: Allow limited requests for testing
    return true;
  }

  /**
   * Execute a request through the circuit breaker
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.canRequest()) {
      this.emit('rejected', this.serviceName);
      throw new CircuitOpenError(this.serviceName, this.getTimeUntilReset());
    }

    this.totalRequests++;

    try {
      const result = await fn();
      this.recordSuccess();
      return result;
    } catch (error) {
      this.recordFailure(error as Error);
      throw error;
    }
  }

  /**
   * Record a successful request
   */
  recordSuccess(): void {
    this.successes++;
    this.consecutiveSuccesses++;
    this.consecutiveFailures = 0;
    this.lastSuccessTime = Date.now();

    this.addRequestToWindow(true);

    if (this.state === CircuitState.HALF_OPEN) {
      if (this.consecutiveSuccesses >= this.config.successThreshold) {
        this.transitionTo(CircuitState.CLOSED);
      }
    }

    this.emit('success', this.serviceName);
  }

  /**
   * Record a failed request
   */
  recordFailure(error: Error): void {
    this.failures++;
    this.failedRequests++;
    this.consecutiveFailures++;
    this.consecutiveSuccesses = 0;
    this.lastFailureTime = Date.now();

    this.addRequestToWindow(false);

    if (this.state === CircuitState.HALF_OPEN) {
      // Any failure in half-open state opens the circuit again
      this.transitionTo(CircuitState.OPEN);
    } else if (this.state === CircuitState.CLOSED) {
      if (this.shouldOpen()) {
        this.transitionTo(CircuitState.OPEN);
      }
    }

    this.emit('failure', this.serviceName, error);
  }

  /**
   * Check if circuit should open based on failure threshold
   */
  private shouldOpen(): boolean {
    if (this.config.useSlidingWindow) {
      // Use sliding window failure rate
      this.pruneRequestWindow();
      const windowSize = this.requestWindow.length;

      if (windowSize < this.config.minimumRequestThreshold) {
        return false;
      }

      const failures = this.requestWindow.filter(r => !r.success).length;
      const failureRate = (failures / windowSize) * 100;

      return failureRate >= this.config.failureRateThreshold;
    }

    // Use consecutive failures
    return this.consecutiveFailures >= this.config.failureThreshold;
  }

  /**
   * Add request to sliding window
   */
  private addRequestToWindow(success: boolean): void {
    this.requestWindow.push({
      timestamp: Date.now(),
      success
    });
    this.pruneRequestWindow();
  }

  /**
   * Remove old entries from request window
   */
  private pruneRequestWindow(): void {
    const cutoff = Date.now() - this.config.failureWindowMs;
    this.requestWindow = this.requestWindow.filter(r => r.timestamp > cutoff);
  }

  /**
   * Transition to a new state
   */
  private transitionTo(newState: CircuitState): void {
    const oldState = this.state;
    if (oldState === newState) return;

    this.state = newState;
    this.lastStateChange = Date.now();

    // Clear any existing reset timer
    if (this.resetTimer) {
      clearTimeout(this.resetTimer);
      this.resetTimer = null;
    }

    switch (newState) {
      case CircuitState.OPEN:
        this.openCount++;
        logger.warn(`Circuit OPENED for ${this.serviceName}`, {
          component: 'circuit-breaker',
          service: this.serviceName,
          consecutiveFailures: this.consecutiveFailures,
          resetTimeoutMs: this.config.resetTimeoutMs
        });

        // Schedule automatic transition to half-open
        this.resetTimer = setTimeout(() => {
          if (this.state === CircuitState.OPEN) {
            this.transitionTo(CircuitState.HALF_OPEN);
          }
        }, this.config.resetTimeoutMs);
        break;

      case CircuitState.HALF_OPEN:
        this.halfOpenCount++;
        this.consecutiveSuccesses = 0;
        logger.info(`Circuit HALF-OPEN for ${this.serviceName} - testing recovery`, {
          component: 'circuit-breaker',
          service: this.serviceName
        });
        break;

      case CircuitState.CLOSED:
        this.consecutiveFailures = 0;
        this.failures = 0;
        this.requestWindow = [];
        logger.info(`Circuit CLOSED for ${this.serviceName} - service recovered`, {
          component: 'circuit-breaker',
          service: this.serviceName
        });
        break;
    }

    this.emit('stateChange', oldState, newState, this.serviceName);
  }

  /**
   * Get time until circuit attempts reset (for OPEN state)
   */
  getTimeUntilReset(): number {
    if (this.state !== CircuitState.OPEN) {
      return 0;
    }
    const elapsed = Date.now() - this.lastStateChange;
    return Math.max(0, this.config.resetTimeoutMs - elapsed);
  }

  /**
   * Get current circuit state
   */
  getState(): CircuitState {
    return this.state;
  }

  /**
   * Get circuit breaker statistics
   */
  getStats(): CircuitBreakerStats {
    this.pruneRequestWindow();
    return {
      state: this.state,
      failures: this.failures,
      successes: this.successes,
      consecutiveFailures: this.consecutiveFailures,
      consecutiveSuccesses: this.consecutiveSuccesses,
      lastFailureTime: this.lastFailureTime,
      lastSuccessTime: this.lastSuccessTime,
      lastStateChange: this.lastStateChange,
      totalRequests: this.totalRequests,
      failedRequests: this.failedRequests,
      openCount: this.openCount,
      halfOpenCount: this.halfOpenCount
    };
  }

  /**
   * Force circuit to open (manual intervention)
   */
  forceOpen(): void {
    logger.warn(`Circuit FORCE OPENED for ${this.serviceName}`, {
      component: 'circuit-breaker',
      service: this.serviceName
    });
    this.transitionTo(CircuitState.OPEN);
  }

  /**
   * Force circuit to close (manual intervention)
   */
  forceClose(): void {
    logger.info(`Circuit FORCE CLOSED for ${this.serviceName}`, {
      component: 'circuit-breaker',
      service: this.serviceName
    });
    this.transitionTo(CircuitState.CLOSED);
  }

  /**
   * Reset all statistics
   */
  reset(): void {
    this.state = CircuitState.CLOSED;
    this.failures = 0;
    this.successes = 0;
    this.consecutiveFailures = 0;
    this.consecutiveSuccesses = 0;
    this.lastFailureTime = null;
    this.lastSuccessTime = null;
    this.lastStateChange = Date.now();
    this.totalRequests = 0;
    this.failedRequests = 0;
    this.requestWindow = [];

    if (this.resetTimer) {
      clearTimeout(this.resetTimer);
      this.resetTimer = null;
    }
  }

  /**
   * Clean up resources
   */
  destroy(): void {
    if (this.resetTimer) {
      clearTimeout(this.resetTimer);
      this.resetTimer = null;
    }
    this.removeAllListeners();
  }
}

// =============================================================================
// Custom Error
// =============================================================================

export class CircuitOpenError extends Error {
  constructor(
    public readonly serviceName: string,
    public readonly retryAfterMs: number
  ) {
    super(`Circuit breaker is OPEN for service: ${serviceName}. Retry after ${retryAfterMs}ms`);
    this.name = 'CircuitOpenError';
  }
}

// =============================================================================
// Circuit Breaker Manager
// =============================================================================

export class CircuitBreakerManager {
  private breakers: Map<string, CircuitBreaker> = new Map();
  private defaultConfig: CircuitBreakerConfig;

  constructor(defaultConfig?: Partial<CircuitBreakerConfig>) {
    this.defaultConfig = {
      failureThreshold: 5,
      successThreshold: 3,
      resetTimeoutMs: 30000,
      failureWindowMs: 60000,
      useSlidingWindow: true,
      failureRateThreshold: 50,
      minimumRequestThreshold: 10,
      ...defaultConfig
    };
  }

  /**
   * Get or create a circuit breaker for a service
   */
  getBreaker(serviceName: string, config?: Partial<CircuitBreakerConfig>): CircuitBreaker {
    let breaker = this.breakers.get(serviceName);

    if (!breaker) {
      breaker = new CircuitBreaker(serviceName, {
        ...this.defaultConfig,
        ...config
      });
      this.breakers.set(serviceName, breaker);
    }

    return breaker;
  }

  /**
   * Get all circuit breakers
   */
  getAllBreakers(): Map<string, CircuitBreaker> {
    return this.breakers;
  }

  /**
   * Get stats for all circuit breakers
   */
  getAllStats(): Record<string, CircuitBreakerStats> {
    const stats: Record<string, CircuitBreakerStats> = {};
    for (const [name, breaker] of this.breakers) {
      stats[name] = breaker.getStats();
    }
    return stats;
  }

  /**
   * Check if any circuits are open
   */
  hasOpenCircuits(): boolean {
    for (const breaker of this.breakers.values()) {
      if (breaker.getState() === CircuitState.OPEN) {
        return true;
      }
    }
    return false;
  }

  /**
   * Get list of open circuits
   */
  getOpenCircuits(): string[] {
    const open: string[] = [];
    for (const [name, breaker] of this.breakers) {
      if (breaker.getState() === CircuitState.OPEN) {
        open.push(name);
      }
    }
    return open;
  }

  /**
   * Reset all circuit breakers
   */
  resetAll(): void {
    for (const breaker of this.breakers.values()) {
      breaker.reset();
    }
  }

  /**
   * Clean up all resources
   */
  destroy(): void {
    for (const breaker of this.breakers.values()) {
      breaker.destroy();
    }
    this.breakers.clear();
  }
}

// =============================================================================
// Default Export
// =============================================================================

export const defaultCircuitBreakerManager = new CircuitBreakerManager();
