/**
 * AEGIS - Health & Circuit Breaker API Routes
 *
 * REST API endpoints for backend health status and circuit breaker management.
 * Provides visibility into service health and fault tolerance mechanisms.
 */

import { Router, Request, Response } from 'express';
import logger from '../../utils/logger.js';

// We'll import the proxy server instance to access health/circuit breaker status
// This will be injected via a setter function
let proxyServerInstance: any = null;

export function setProxyServer(proxy: any): void {
  proxyServerInstance = proxy;
}

// =============================================================================
// Router Setup
// =============================================================================

const router = Router();

// =============================================================================
// Helper Functions
// =============================================================================

function successResponse(res: Response, data: unknown, status = 200): void {
  res.status(status).json({
    success: true,
    data,
    timestamp: new Date().toISOString(),
  });
}

function errorResponse(res: Response, status: number, message: string): void {
  res.status(status).json({
    success: false,
    error: message,
    timestamp: new Date().toISOString(),
  });
}

// =============================================================================
// Backend Status Endpoints
// =============================================================================

/**
 * GET /api/health/backends
 *
 * Get comprehensive status of all backends including:
 * - Health check results
 * - Circuit breaker states
 * - Availability status
 */
router.get('/backends', (_req: Request, res: Response) => {
  try {
    if (!proxyServerInstance) {
      return errorResponse(res, 503, 'Proxy server not initialized');
    }

    const status = proxyServerInstance.getBackendStatus();

    // Calculate summary
    const summary = {
      total: status.length,
      available: status.filter((s: any) => s.isAvailable).length,
      unavailable: status.filter((s: any) => !s.isAvailable).length,
      healthy: status.filter((s: any) => s.health?.status === 'healthy').length,
      unhealthy: status.filter((s: any) => s.health?.status === 'unhealthy').length,
      degraded: status.filter((s: any) => s.health?.status === 'degraded').length,
      circuitOpen: status.filter((s: any) => s.circuitBreaker?.state === 'OPEN').length,
    };

    successResponse(res, {
      summary,
      backends: status,
    });
  } catch (error) {
    logger.error('Failed to get backend status', {
      error: error instanceof Error ? error.message : String(error),
    });
    errorResponse(res, 500, 'Failed to get backend status');
  }
});

/**
 * GET /api/health/backends/:name
 *
 * Get detailed status for a specific backend
 */
router.get('/backends/:name', (req: Request, res: Response) => {
  try {
    if (!proxyServerInstance) {
      return errorResponse(res, 503, 'Proxy server not initialized');
    }

    const { name } = req.params;
    if (!name) {
      return errorResponse(res, 400, 'Backend name is required');
    }

    const health = proxyServerInstance.getBackendHealth(name);
    const circuitStates = proxyServerInstance.getCircuitBreakerStates();
    const circuitState = circuitStates[name];

    if (!health && !circuitState) {
      return errorResponse(res, 404, `Backend '${name}' not found`);
    }

    const isAvailable =
      circuitState?.state !== 'OPEN' &&
      health?.status !== 'unhealthy';

    successResponse(res, {
      name,
      health,
      circuitBreaker: circuitState,
      isAvailable,
    });
  } catch (error) {
    logger.error('Failed to get backend status', {
      error: error instanceof Error ? error.message : String(error),
      backend: req.params.name,
    });
    errorResponse(res, 500, 'Failed to get backend status');
  }
});

/**
 * POST /api/health/backends/:name/check
 *
 * Trigger an immediate health check for a specific backend
 */
router.post('/backends/:name/check', async (req: Request, res: Response) => {
  try {
    if (!proxyServerInstance) {
      return errorResponse(res, 503, 'Proxy server not initialized');
    }

    const { name } = req.params;
    const result = await proxyServerInstance.triggerHealthCheck(name);

    if (!result) {
      return errorResponse(res, 404, `Backend '${name}' not found`);
    }

    logger.info(`Manual health check triggered for ${name}`, {
      component: 'health-api',
      backend: name,
      status: result.status,
    });

    successResponse(res, result);
  } catch (error) {
    logger.error('Failed to trigger health check', {
      error: error instanceof Error ? error.message : String(error),
      backend: req.params.name,
    });
    errorResponse(res, 500, 'Failed to trigger health check');
  }
});

// =============================================================================
// Circuit Breaker Endpoints
// =============================================================================

/**
 * GET /api/health/circuit-breakers
 *
 * Get status of all circuit breakers
 */
router.get('/circuit-breakers', (_req: Request, res: Response) => {
  try {
    if (!proxyServerInstance) {
      return errorResponse(res, 503, 'Proxy server not initialized');
    }

    const states = proxyServerInstance.getCircuitBreakerStates();

    // Calculate summary
    const breakers = Object.entries(states);
    const summary = {
      total: breakers.length,
      closed: breakers.filter(([_, s]: any) => s.state === 'CLOSED').length,
      open: breakers.filter(([_, s]: any) => s.state === 'OPEN').length,
      halfOpen: breakers.filter(([_, s]: any) => s.state === 'HALF_OPEN').length,
    };

    successResponse(res, {
      summary,
      circuitBreakers: states,
    });
  } catch (error) {
    logger.error('Failed to get circuit breaker states', {
      error: error instanceof Error ? error.message : String(error),
    });
    errorResponse(res, 500, 'Failed to get circuit breaker states');
  }
});

/**
 * POST /api/health/circuit-breakers/:name/open
 *
 * Force open a circuit breaker (manual intervention)
 */
router.post('/circuit-breakers/:name/open', (req: Request, res: Response) => {
  try {
    if (!proxyServerInstance) {
      return errorResponse(res, 503, 'Proxy server not initialized');
    }

    const { name } = req.params;
    proxyServerInstance.forceOpenCircuit(name);

    logger.warn(`Circuit breaker manually opened for ${name}`, {
      component: 'health-api',
      backend: name,
    });

    successResponse(res, {
      message: `Circuit breaker for '${name}' has been opened`,
      state: 'OPEN',
    });
  } catch (error) {
    logger.error('Failed to open circuit breaker', {
      error: error instanceof Error ? error.message : String(error),
      backend: req.params.name,
    });
    errorResponse(res, 500, 'Failed to open circuit breaker');
  }
});

/**
 * POST /api/health/circuit-breakers/:name/close
 *
 * Force close a circuit breaker (manual intervention)
 */
router.post('/circuit-breakers/:name/close', (req: Request, res: Response) => {
  try {
    if (!proxyServerInstance) {
      return errorResponse(res, 503, 'Proxy server not initialized');
    }

    const { name } = req.params;
    proxyServerInstance.forceCloseCircuit(name);

    logger.info(`Circuit breaker manually closed for ${name}`, {
      component: 'health-api',
      backend: name,
    });

    successResponse(res, {
      message: `Circuit breaker for '${name}' has been closed`,
      state: 'CLOSED',
    });
  } catch (error) {
    logger.error('Failed to close circuit breaker', {
      error: error instanceof Error ? error.message : String(error),
      backend: req.params.name,
    });
    errorResponse(res, 500, 'Failed to close circuit breaker');
  }
});

// =============================================================================
// Gateway Health Endpoint
// =============================================================================

/**
 * GET /api/health/gateway
 *
 * Get overall gateway health status
 */
router.get('/gateway', (_req: Request, res: Response) => {
  try {
    if (!proxyServerInstance) {
      return errorResponse(res, 503, 'Proxy server not initialized');
    }

    const backendStatus = proxyServerInstance.getBackendStatus();
    const stats = proxyServerInstance.getStats();

    const availableBackends = backendStatus.filter((s: any) => s.isAvailable).length;
    const totalBackends = backendStatus.length;

    // Determine overall status
    let status: 'healthy' | 'degraded' | 'unhealthy';
    if (availableBackends === totalBackends) {
      status = 'healthy';
    } else if (availableBackends > 0) {
      status = 'degraded';
    } else {
      status = 'unhealthy';
    }

    successResponse(res, {
      status,
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      backends: {
        total: totalBackends,
        available: availableBackends,
        unavailable: totalBackends - availableBackends,
      },
      stats: {
        totalRequests: stats.totalRequests,
        successfulRequests: stats.successfulRequests,
        failedRequests: stats.failedRequests,
        circuitBreakerRejections: stats.circuitBreakerRejections,
        healthCheckFailures: stats.healthCheckFailures,
      },
    });
  } catch (error) {
    logger.error('Failed to get gateway health', {
      error: error instanceof Error ? error.message : String(error),
    });
    errorResponse(res, 500, 'Failed to get gateway health');
  }
});

// =============================================================================
// Export
// =============================================================================

export default router;

export { router as healthRouter };
