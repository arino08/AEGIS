/**
 * AEGIS - Metrics API Routes
 *
 * REST API endpoints for the observability dashboard.
 * Provides access to metrics, analytics, and real-time stats.
 */

import { Router, Request, Response } from 'express';

import { getMetricsCollector } from '../../monitoring/collector.js';
import type {
  TimeRange,
  CustomTimeRange,
  DashboardOverview,
  EndpointMetrics,
  LatencyPercentiles,
  ErrorRateMetric,
  StatusCodeDistribution,
  RequestRateMetric,
  TopEndpoint,
} from '../../monitoring/types.js';
import logger from '../../utils/logger.js';

// =============================================================================
// Types
// =============================================================================

/**
 * Query parameters for time-based endpoints
 */
interface TimeRangeQuery {
  range?: TimeRange;
  start?: string;
  end?: string;
}

/**
 * Query parameters for paginated endpoints
 */
interface PaginationQuery {
  limit?: string;
  offset?: string;
}

/**
 * Query parameters for endpoint metrics
 */
interface EndpointMetricsQuery extends TimeRangeQuery, PaginationQuery {
  endpoint?: string;
  method?: string;
  backend?: string;
}

/**
 * Query parameters for latency endpoints
 */
interface LatencyQuery extends TimeRangeQuery {
  endpoint?: string;
  backend?: string;
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Parse time range from query parameters
 */
function parseTimeRange(query: TimeRangeQuery): TimeRange | CustomTimeRange {
  if (query.start && query.end) {
    return {
      start: new Date(query.start),
      end: new Date(query.end),
    };
  }

  return (query.range as TimeRange) || '1h';
}

/**
 * Parse pagination parameters
 */
function parsePagination(query: PaginationQuery): { limit: number; offset: number } {
  const limit = Math.min(Math.max(parseInt(query.limit || '20', 10), 1), 100);
  const offset = Math.max(parseInt(query.offset || '0', 10), 0);
  return { limit, offset };
}

/**
 * Standard error response
 */
function errorResponse(res: Response, status: number, message: string, details?: unknown): void {
  res.status(status).json({
    error: true,
    message,
    details,
  });
}

/**
 * Standard success response
 */
function successResponse<T>(res: Response, data: T, meta?: Record<string, unknown>): void {
  res.json({
    success: true,
    data,
    meta: {
      timestamp: new Date().toISOString(),
      ...meta,
    },
  });
}

// =============================================================================
// Router
// =============================================================================

const router = Router();

// =============================================================================
// Overview Endpoint
// =============================================================================

/**
 * GET /api/metrics/overview
 *
 * Get dashboard overview with key metrics:
 * - Requests per second
 * - Average/p95/p99 latency
 * - Error rate
 * - Active connections
 * - Total/successful/failed requests
 */
router.get(
  '/overview',
  async (req: Request<object, object, object, TimeRangeQuery>, res: Response) => {
    try {
      const range = parseTimeRange(req.query);
      const collector = getMetricsCollector();

      const overview: DashboardOverview = await collector.getOverview(range);

      successResponse(res, overview, {
        range: typeof range === 'string' ? range : 'custom',
      });
    } catch (error) {
      logger.error('Failed to get metrics overview', {
        error: error instanceof Error ? error.message : String(error),
      });
      errorResponse(res, 500, 'Failed to get metrics overview');
    }
  }
);

// =============================================================================
// Request Rate Endpoint
// =============================================================================

/**
 * GET /api/metrics/requests
 *
 * Get requests per second/minute over time.
 * Returns time-bucketed data suitable for charts.
 */
router.get(
  '/requests',
  async (req: Request<object, object, object, TimeRangeQuery>, res: Response) => {
    try {
      const range = parseTimeRange(req.query);
      const collector = getMetricsCollector();

      const data: RequestRateMetric[] = await collector.getRequestRate(range);

      successResponse(res, data, {
        range: typeof range === 'string' ? range : 'custom',
        points: data.length,
      });
    } catch (error) {
      logger.error('Failed to get request rate', {
        error: error instanceof Error ? error.message : String(error),
      });
      errorResponse(res, 500, 'Failed to get request rate');
    }
  }
);

// =============================================================================
// Latency Endpoints
// =============================================================================

/**
 * GET /api/metrics/latency
 *
 * Get latency percentiles over time (p50, p75, p90, p95, p99).
 * Returns time-bucketed data suitable for charts.
 */
router.get(
  '/latency',
  async (req: Request<object, object, object, LatencyQuery>, res: Response) => {
    try {
      const range = parseTimeRange(req.query);
      const collector = getMetricsCollector();

      const data: LatencyPercentiles[] = await collector.getLatencyPercentiles(range);

      successResponse(res, data, {
        range: typeof range === 'string' ? range : 'custom',
        points: data.length,
      });
    } catch (error) {
      logger.error('Failed to get latency metrics', {
        error: error instanceof Error ? error.message : String(error),
      });
      errorResponse(res, 500, 'Failed to get latency metrics');
    }
  }
);

/**
 * GET /api/metrics/latency/current
 *
 * Get current latency percentiles (snapshot, not time-series).
 */
router.get(
  '/latency/current',
  async (req: Request<object, object, object, TimeRangeQuery>, res: Response) => {
    try {
      const range = parseTimeRange(req.query);
      const collector = getMetricsCollector();

      const data = await collector.getLatencyPercentiles(range);

      // Return the most recent data point or aggregated values
      if (data.length === 0) {
        successResponse(res, {
          p50: 0,
          p75: 0,
          p90: 0,
          p95: 0,
          p99: 0,
          avg: 0,
          min: 0,
          max: 0,
        });
        return;
      }

      // Aggregate all data points
      const aggregated = {
        p50: data.reduce((sum, d) => sum + d.p50, 0) / data.length,
        p75: data.reduce((sum, d) => sum + d.p75, 0) / data.length,
        p90: data.reduce((sum, d) => sum + d.p90, 0) / data.length,
        p95: data.reduce((sum, d) => sum + d.p95, 0) / data.length,
        p99: data.reduce((sum, d) => sum + d.p99, 0) / data.length,
        avg: data.reduce((sum, d) => sum + d.avg, 0) / data.length,
        min: Math.min(...data.map((d) => d.min)),
        max: Math.max(...data.map((d) => d.max)),
      };

      successResponse(res, aggregated, {
        range: typeof range === 'string' ? range : 'custom',
      });
    } catch (error) {
      logger.error('Failed to get current latency', {
        error: error instanceof Error ? error.message : String(error),
      });
      errorResponse(res, 500, 'Failed to get current latency');
    }
  }
);

// =============================================================================
// Error Rate Endpoints
// =============================================================================

/**
 * GET /api/metrics/errors
 *
 * Get error rate over time (4xx and 5xx breakdown).
 * Returns time-bucketed data suitable for charts.
 */
router.get(
  '/errors',
  async (req: Request<object, object, object, TimeRangeQuery>, res: Response) => {
    try {
      const range = parseTimeRange(req.query);
      const collector = getMetricsCollector();

      const data: ErrorRateMetric[] = await collector.getErrorRate(range);

      successResponse(res, data, {
        range: typeof range === 'string' ? range : 'custom',
        points: data.length,
      });
    } catch (error) {
      logger.error('Failed to get error rate', {
        error: error instanceof Error ? error.message : String(error),
      });
      errorResponse(res, 500, 'Failed to get error rate');
    }
  }
);

/**
 * GET /api/metrics/status
 *
 * Get status code distribution over time.
 * Returns counts for 2xx, 3xx, 4xx, and 5xx status classes.
 */
router.get(
  '/status',
  async (req: Request<object, object, object, TimeRangeQuery>, res: Response) => {
    try {
      const range = parseTimeRange(req.query);
      const collector = getMetricsCollector();

      const data: StatusCodeDistribution[] = await collector.getStatusDistribution(range);

      successResponse(res, data, {
        range: typeof range === 'string' ? range : 'custom',
        points: data.length,
      });
    } catch (error) {
      logger.error('Failed to get status distribution', {
        error: error instanceof Error ? error.message : String(error),
      });
      errorResponse(res, 500, 'Failed to get status distribution');
    }
  }
);

// =============================================================================
// Endpoint Analytics
// =============================================================================

/**
 * GET /api/metrics/endpoints
 *
 * Get per-endpoint metrics including:
 * - Request count
 * - Average/p95/p99 latency
 * - Error rate
 * - Requests per second
 */
router.get(
  '/endpoints',
  async (req: Request<object, object, object, EndpointMetricsQuery>, res: Response) => {
    try {
      const range = parseTimeRange(req.query);
      const collector = getMetricsCollector();

      const data: EndpointMetrics[] = await collector.getEndpointMetrics(
        range,
        req.query.endpoint,
        req.query.method
      );

      const { limit, offset } = parsePagination(req.query);
      const paginated = data.slice(offset, offset + limit);

      successResponse(res, paginated, {
        range: typeof range === 'string' ? range : 'custom',
        total: data.length,
        limit,
        offset,
        hasMore: offset + limit < data.length,
      });
    } catch (error) {
      logger.error('Failed to get endpoint metrics', {
        error: error instanceof Error ? error.message : String(error),
      });
      errorResponse(res, 500, 'Failed to get endpoint metrics');
    }
  }
);

/**
 * GET /api/metrics/endpoints/top
 *
 * Get top endpoints by request count.
 */
router.get(
  '/endpoints/top',
  async (
    req: Request<object, object, object, TimeRangeQuery & { limit?: string }>,
    res: Response
  ) => {
    try {
      const range = parseTimeRange(req.query);
      const limit = Math.min(Math.max(parseInt(req.query.limit || '10', 10), 1), 50);
      const collector = getMetricsCollector();

      const data: TopEndpoint[] = await collector.getTopEndpoints(range, limit);

      successResponse(res, data, {
        range: typeof range === 'string' ? range : 'custom',
        limit,
      });
    } catch (error) {
      logger.error('Failed to get top endpoints', {
        error: error instanceof Error ? error.message : String(error),
      });
      errorResponse(res, 500, 'Failed to get top endpoints');
    }
  }
);

/**
 * GET /api/metrics/endpoints/:endpoint
 *
 * Get detailed metrics for a specific endpoint.
 */
router.get(
  '/endpoints/:endpoint(*)',
  async (req: Request<{ endpoint: string }, object, object, TimeRangeQuery>, res: Response) => {
    try {
      const range = parseTimeRange(req.query);
      const endpoint = '/' + req.params.endpoint;
      const collector = getMetricsCollector();

      const data = await collector.getEndpointMetrics(range, endpoint);

      if (data.length === 0) {
        errorResponse(res, 404, 'Endpoint not found in metrics', { endpoint });
        return;
      }

      successResponse(res, data[0], {
        range: typeof range === 'string' ? range : 'custom',
      });
    } catch (error) {
      logger.error('Failed to get endpoint metrics', {
        error: error instanceof Error ? error.message : String(error),
        endpoint: req.params.endpoint,
      });
      errorResponse(res, 500, 'Failed to get endpoint metrics');
    }
  }
);

// =============================================================================
// Collector Stats Endpoint
// =============================================================================

/**
 * GET /api/metrics/stats
 *
 * Get metrics collector internal stats (for debugging).
 */
router.get('/stats', (_req: Request, res: Response) => {
  try {
    const collector = getMetricsCollector();
    const stats = collector.getStats();

    successResponse(res, stats);
  } catch (error) {
    logger.error('Failed to get collector stats', {
      error: error instanceof Error ? error.message : String(error),
    });
    errorResponse(res, 500, 'Failed to get collector stats');
  }
});

// =============================================================================
// Flush Endpoint (Admin)
// =============================================================================

/**
 * POST /api/metrics/flush
 *
 * Force flush pending metrics to database.
 * Useful for testing or when shutting down.
 */
router.post('/flush', async (_req: Request, res: Response) => {
  try {
    const collector = getMetricsCollector();
    await collector.flush();

    successResponse(res, { flushed: true });
  } catch (error) {
    logger.error('Failed to flush metrics', {
      error: error instanceof Error ? error.message : String(error),
    });
    errorResponse(res, 500, 'Failed to flush metrics');
  }
});

// =============================================================================
// Export
// =============================================================================

export default router;

export { router as metricsRouter };
