/**
 * AEGIS - Alerts API Routes
 *
 * REST API endpoints for alert management.
 * Provides CRUD operations for alert rules, alert actions, and alert history.
 */

import { Router, Request, Response } from 'express';

import {
  getAlertManager,
  type AlertRuleInput,
} from '../../monitoring/alerts.js';
import type {
  AlertSeverity,
  AlertStatus,
} from '../../monitoring/types.js';
import logger from '../../utils/logger.js';

// =============================================================================
// Types
// =============================================================================

/**
 * Query parameters for alerts list
 */
interface AlertsQuery {
  status?: AlertStatus;
  severity?: AlertSeverity;
  ruleId?: string;
  limit?: string;
  offset?: string;
}

/**
 * Query parameters for alert history
 */
interface AlertHistoryQuery {
  alertId?: string;
  limit?: string;
  offset?: string;
}

/**
 * Request body for acknowledging an alert
 */
interface AcknowledgeBody {
  userId: string;
  note?: string;
}

/**
 * Request body for resolving an alert
 */
interface ResolveBody {
  userId?: string;
  note?: string;
}

/**
 * Request body for muting an alert
 */
interface MuteBody {
  duration: string;
  userId?: string;
}

// =============================================================================
// Helper Functions
// =============================================================================

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

/**
 * Parse pagination parameters
 */
function parsePagination(query: { limit?: string; offset?: string }): { limit: number; offset: number } {
  const limit = Math.min(Math.max(parseInt(query.limit || '50', 10), 1), 100);
  const offset = Math.max(parseInt(query.offset || '0', 10), 0);
  return { limit, offset };
}

// =============================================================================
// Router
// =============================================================================

const router = Router();

// =============================================================================
// Alert Rules Endpoints
// =============================================================================

/**
 * GET /api/alerts/rules
 *
 * Get all alert rules
 */
router.get('/rules', (_req: Request, res: Response) => {
  try {
    const alertManager = getAlertManager();
    const rules = alertManager.getRules();

    successResponse(res, rules, {
      total: rules.length,
    });
  } catch (error) {
    logger.error('Failed to get alert rules', {
      error: error instanceof Error ? error.message : String(error),
    });
    errorResponse(res, 500, 'Failed to get alert rules');
  }
});

/**
 * GET /api/alerts/rules/:id
 *
 * Get a specific alert rule by ID
 */
router.get('/rules/:id', (req: Request<{ id: string }>, res: Response) => {
  try {
    const alertManager = getAlertManager();
    const rule = alertManager.getRule(req.params.id);

    if (!rule) {
      errorResponse(res, 404, 'Alert rule not found', { id: req.params.id });
      return;
    }

    successResponse(res, rule);
  } catch (error) {
    logger.error('Failed to get alert rule', {
      ruleId: req.params.id,
      error: error instanceof Error ? error.message : String(error),
    });
    errorResponse(res, 500, 'Failed to get alert rule');
  }
});

/**
 * POST /api/alerts/rules
 *
 * Create a new alert rule
 */
router.post(
  '/rules',
  async (req: Request<object, object, AlertRuleInput>, res: Response) => {
    try {
      const input = req.body;

      // Validate required fields
      if (!input.name || !input.severity || !input.condition || !input.actions) {
        errorResponse(res, 400, 'Missing required fields', {
          required: ['name', 'severity', 'condition', 'actions'],
        });
        return;
      }

      // Validate condition
      if (
        !input.condition.metric ||
        !input.condition.operator ||
        input.condition.threshold === undefined ||
        !input.condition.window
      ) {
        errorResponse(res, 400, 'Invalid condition', {
          required: ['metric', 'operator', 'threshold', 'window'],
        });
        return;
      }

      // Validate severity
      if (!['info', 'warning', 'critical'].includes(input.severity)) {
        errorResponse(res, 400, 'Invalid severity', {
          allowed: ['info', 'warning', 'critical'],
        });
        return;
      }

      // Validate operator
      if (!['>', '>=', '<', '<=', '==', '!='].includes(input.condition.operator)) {
        errorResponse(res, 400, 'Invalid operator', {
          allowed: ['>', '>=', '<', '<=', '==', '!='],
        });
        return;
      }

      const alertManager = getAlertManager();
      const rule = await alertManager.createRule(input);

      successResponse(res, rule, { created: true });
    } catch (error) {
      logger.error('Failed to create alert rule', {
        error: error instanceof Error ? error.message : String(error),
      });
      errorResponse(res, 500, 'Failed to create alert rule');
    }
  }
);

/**
 * PUT /api/alerts/rules/:id
 *
 * Update an existing alert rule
 */
router.put(
  '/rules/:id',
  async (req: Request<{ id: string }, object, Partial<AlertRuleInput>>, res: Response) => {
    try {
      const alertManager = getAlertManager();
      const rule = await alertManager.updateRule(req.params.id, req.body);

      if (!rule) {
        errorResponse(res, 404, 'Alert rule not found', { id: req.params.id });
        return;
      }

      successResponse(res, rule, { updated: true });
    } catch (error) {
      logger.error('Failed to update alert rule', {
        ruleId: req.params.id,
        error: error instanceof Error ? error.message : String(error),
      });
      errorResponse(res, 500, 'Failed to update alert rule');
    }
  }
);

/**
 * DELETE /api/alerts/rules/:id
 *
 * Delete an alert rule
 */
router.delete('/rules/:id', async (req: Request<{ id: string }>, res: Response) => {
  try {
    const alertManager = getAlertManager();
    const deleted = await alertManager.deleteRule(req.params.id);

    if (!deleted) {
      errorResponse(res, 404, 'Alert rule not found', { id: req.params.id });
      return;
    }

    successResponse(res, { deleted: true });
  } catch (error) {
    logger.error('Failed to delete alert rule', {
      ruleId: req.params.id,
      error: error instanceof Error ? error.message : String(error),
    });
    errorResponse(res, 500, 'Failed to delete alert rule');
  }
});

/**
 * POST /api/alerts/rules/:id/enable
 *
 * Enable an alert rule
 */
router.post('/rules/:id/enable', async (req: Request<{ id: string }>, res: Response) => {
  try {
    const alertManager = getAlertManager();
    const success = await alertManager.setRuleEnabled(req.params.id, true);

    if (!success) {
      errorResponse(res, 404, 'Alert rule not found', { id: req.params.id });
      return;
    }

    successResponse(res, { enabled: true });
  } catch (error) {
    logger.error('Failed to enable alert rule', {
      ruleId: req.params.id,
      error: error instanceof Error ? error.message : String(error),
    });
    errorResponse(res, 500, 'Failed to enable alert rule');
  }
});

/**
 * POST /api/alerts/rules/:id/disable
 *
 * Disable an alert rule
 */
router.post('/rules/:id/disable', async (req: Request<{ id: string }>, res: Response) => {
  try {
    const alertManager = getAlertManager();
    const success = await alertManager.setRuleEnabled(req.params.id, false);

    if (!success) {
      errorResponse(res, 404, 'Alert rule not found', { id: req.params.id });
      return;
    }

    successResponse(res, { disabled: true });
  } catch (error) {
    logger.error('Failed to disable alert rule', {
      ruleId: req.params.id,
      error: error instanceof Error ? error.message : String(error),
    });
    errorResponse(res, 500, 'Failed to disable alert rule');
  }
});

// =============================================================================
// Alerts Endpoints
// =============================================================================

/**
 * GET /api/alerts
 *
 * Get alerts list with optional filtering
 */
router.get(
  '/',
  async (req: Request<object, object, object, AlertsQuery>, res: Response) => {
    try {
      const alertManager = getAlertManager();
      const { limit, offset } = parsePagination(req.query);

      const { alerts, total } = await alertManager.getAlerts({
        status: req.query.status,
        severity: req.query.severity,
        ruleId: req.query.ruleId,
        limit,
        offset,
      });

      successResponse(res, alerts, {
        total,
        limit,
        offset,
        hasMore: offset + limit < total,
      });
    } catch (error) {
      logger.error('Failed to get alerts', {
        error: error instanceof Error ? error.message : String(error),
      });
      errorResponse(res, 500, 'Failed to get alerts');
    }
  }
);

/**
 * GET /api/alerts/active
 *
 * Get active alerts (status: active or acknowledged)
 */
router.get('/active', (_req: Request, res: Response) => {
  try {
    const alertManager = getAlertManager();
    const alerts = alertManager.getActiveAlerts();

    successResponse(res, alerts, {
      count: alerts.length,
    });
  } catch (error) {
    logger.error('Failed to get active alerts', {
      error: error instanceof Error ? error.message : String(error),
    });
    errorResponse(res, 500, 'Failed to get active alerts');
  }
});

/**
 * GET /api/alerts/stats
 *
 * Get alert statistics
 */
router.get('/stats', (_req: Request, res: Response) => {
  try {
    const alertManager = getAlertManager();
    const stats = alertManager.getStats();

    successResponse(res, stats);
  } catch (error) {
    logger.error('Failed to get alert stats', {
      error: error instanceof Error ? error.message : String(error),
    });
    errorResponse(res, 500, 'Failed to get alert stats');
  }
});

/**
 * GET /api/alerts/history
 *
 * Get alert history
 */
router.get(
  '/history',
  async (req: Request<object, object, object, AlertHistoryQuery>, res: Response) => {
    try {
      const alertManager = getAlertManager();
      const { limit, offset } = parsePagination(req.query);

      const history = await alertManager.getAlertHistory(req.query.alertId, limit, offset);

      successResponse(res, history, {
        limit,
        offset,
      });
    } catch (error) {
      logger.error('Failed to get alert history', {
        error: error instanceof Error ? error.message : String(error),
      });
      errorResponse(res, 500, 'Failed to get alert history');
    }
  }
);

/**
 * GET /api/alerts/:id
 *
 * Get a specific alert by ID
 */
router.get('/:id', (req: Request<{ id: string }>, res: Response) => {
  try {
    const alertManager = getAlertManager();
    const alert = alertManager.getAlert(req.params.id);

    if (!alert) {
      errorResponse(res, 404, 'Alert not found', { id: req.params.id });
      return;
    }

    successResponse(res, alert);
  } catch (error) {
    logger.error('Failed to get alert', {
      alertId: req.params.id,
      error: error instanceof Error ? error.message : String(error),
    });
    errorResponse(res, 500, 'Failed to get alert');
  }
});

/**
 * GET /api/alerts/:id/history
 *
 * Get history for a specific alert
 */
router.get(
  '/:id/history',
  async (req: Request<{ id: string }, object, object, { limit?: string; offset?: string }>, res: Response) => {
    try {
      const alertManager = getAlertManager();
      const { limit, offset } = parsePagination(req.query);

      const history = await alertManager.getAlertHistory(req.params.id, limit, offset);

      successResponse(res, history, {
        alertId: req.params.id,
        limit,
        offset,
      });
    } catch (error) {
      logger.error('Failed to get alert history', {
        alertId: req.params.id,
        error: error instanceof Error ? error.message : String(error),
      });
      errorResponse(res, 500, 'Failed to get alert history');
    }
  }
);

/**
 * POST /api/alerts/:id/acknowledge
 *
 * Acknowledge an alert
 */
router.post(
  '/:id/acknowledge',
  async (req: Request<{ id: string }, object, AcknowledgeBody>, res: Response) => {
    try {
      const { userId, note } = req.body;

      if (!userId) {
        errorResponse(res, 400, 'userId is required');
        return;
      }

      const alertManager = getAlertManager();
      const alert = await alertManager.acknowledge(req.params.id, userId, note);

      if (!alert) {
        errorResponse(res, 404, 'Alert not found or cannot be acknowledged', {
          id: req.params.id,
        });
        return;
      }

      successResponse(res, alert, { acknowledged: true });
    } catch (error) {
      logger.error('Failed to acknowledge alert', {
        alertId: req.params.id,
        error: error instanceof Error ? error.message : String(error),
      });
      errorResponse(res, 500, 'Failed to acknowledge alert');
    }
  }
);

/**
 * POST /api/alerts/:id/resolve
 *
 * Resolve an alert
 */
router.post(
  '/:id/resolve',
  async (req: Request<{ id: string }, object, ResolveBody>, res: Response) => {
    try {
      const { userId, note } = req.body;

      const alertManager = getAlertManager();
      const alert = await alertManager.resolve(req.params.id, userId, note);

      if (!alert) {
        errorResponse(res, 404, 'Alert not found', { id: req.params.id });
        return;
      }

      successResponse(res, alert, { resolved: true });
    } catch (error) {
      logger.error('Failed to resolve alert', {
        alertId: req.params.id,
        error: error instanceof Error ? error.message : String(error),
      });
      errorResponse(res, 500, 'Failed to resolve alert');
    }
  }
);

/**
 * POST /api/alerts/:id/mute
 *
 * Mute an alert for a specified duration
 */
router.post(
  '/:id/mute',
  async (req: Request<{ id: string }, object, MuteBody>, res: Response) => {
    try {
      const { duration, userId } = req.body;

      if (!duration) {
        errorResponse(res, 400, 'duration is required', {
          examples: ['30m', '1h', '6h', '24h'],
        });
        return;
      }

      const alertManager = getAlertManager();
      const alert = await alertManager.mute(req.params.id, duration, userId);

      if (!alert) {
        errorResponse(res, 404, 'Alert not found', { id: req.params.id });
        return;
      }

      successResponse(res, alert, { muted: true, duration });
    } catch (error) {
      logger.error('Failed to mute alert', {
        alertId: req.params.id,
        error: error instanceof Error ? error.message : String(error),
      });
      errorResponse(res, 500, 'Failed to mute alert');
    }
  }
);

/**
 * POST /api/alerts/:id/unmute
 *
 * Unmute an alert
 */
router.post(
  '/:id/unmute',
  async (req: Request<{ id: string }, object, { userId?: string }>, res: Response) => {
    try {
      const alertManager = getAlertManager();
      const alert = await alertManager.unmute(req.params.id, req.body.userId);

      if (!alert) {
        errorResponse(res, 404, 'Alert not found or not muted', { id: req.params.id });
        return;
      }

      successResponse(res, alert, { unmuted: true });
    } catch (error) {
      logger.error('Failed to unmute alert', {
        alertId: req.params.id,
        error: error instanceof Error ? error.message : String(error),
      });
      errorResponse(res, 500, 'Failed to unmute alert');
    }
  }
);

/**
 * POST /api/alerts/check
 *
 * Manually trigger an alert rules check
 */
router.post('/check', async (_req: Request, res: Response) => {
  try {
    const alertManager = getAlertManager();
    await alertManager.checkAllRules();

    successResponse(res, { checked: true });
  } catch (error) {
    logger.error('Failed to check alert rules', {
      error: error instanceof Error ? error.message : String(error),
    });
    errorResponse(res, 500, 'Failed to check alert rules');
  }
});

// =============================================================================
// Export
// =============================================================================

export default router;

export { router as alertsRouter };
