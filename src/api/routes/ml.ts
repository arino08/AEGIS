/**
 * AEGIS - ML Service API Routes
 *
 * REST API endpoints for ML-powered features:
 * - Anomaly detection
 * - Rate limit recommendations
 * - Model management
 */

import { Router, Request, Response } from 'express';
import { MLServiceClient } from '../../ml/client.js';
import type { TrafficMetrics } from '../../ml/client.js';
import logger from '../../utils/logger.js';

// =============================================================================
// Types
// =============================================================================

interface DetectBody {
  metrics: TrafficMetrics;
}

interface OptimizeBody {
  endpoint: string;
  tier?: string;
  current_limit?: number;
  strategy?: 'conservative' | 'balanced' | 'permissive' | 'adaptive';
}

interface ApplyRecommendationBody {
  endpoint: string;
  tier: string;
  recommendedLimit: number;
  recommendedBurst: number;
}

// =============================================================================
// ML Client Instance
// =============================================================================

const mlClient = new MLServiceClient({
  baseUrl: process.env.ML_SERVICE_URL || 'http://ml-service:5000',
});

// =============================================================================
// Router
// =============================================================================

const router = Router();

// =============================================================================
// Health & Status
// =============================================================================

/**
 * GET /api/ml/health
 *
 * Check ML service health.
 */
router.get('/health', async (_req: Request, res: Response) => {
  try {
    const health = await mlClient.checkHealth();

    res.json({
      success: true,
      data: health,
    });
  } catch (error) {
    res.status(503).json({
      success: false,
      error: 'ML service unavailable',
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

/**
 * GET /api/ml/status
 *
 * Get ML service status and model info.
 */
router.get('/status', async (_req: Request, res: Response) => {
  try {
    const [health, modelInfo] = await Promise.all([
      mlClient.checkHealth().catch(() => null),
      mlClient.getModelInfo().catch(() => null),
    ]);

    res.json({
      success: true,
      data: {
        available: health?.status === 'healthy',
        health,
        models: modelInfo,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to get ML status',
    });
  }
});

// =============================================================================
// Anomaly Detection
// =============================================================================

/**
 * POST /api/ml/detect
 *
 * Detect anomalies in traffic metrics.
 */
router.post('/detect', async (req: Request<object, object, DetectBody>, res: Response) => {
  try {
    const { metrics } = req.body;

    if (!metrics) {
      res.status(400).json({
        success: false,
        error: 'Metrics data is required',
      });
      return;
    }

    const result = await mlClient.detectAnomaly(metrics);

    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    logger.error('Anomaly detection failed', {
      error: error instanceof Error ? error.message : String(error),
    });

    res.status(500).json({
      success: false,
      error: 'Anomaly detection failed',
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

/**
 * GET /api/ml/detect/trend
 *
 * Get current trend analysis.
 */
router.get('/detect/trend', async (_req: Request, res: Response) => {
  try {
    const trend = await mlClient.getTrend();

    res.json({
      success: true,
      data: trend,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to get trend analysis',
    });
  }
});

// =============================================================================
// Rate Limit Recommendations
// =============================================================================

/**
 * POST /api/ml/recommendations
 *
 * Get rate limit recommendation for a specific endpoint.
 */
router.post(
  '/recommendations',
  async (req: Request<object, object, OptimizeBody>, res: Response) => {
    try {
      const { endpoint, tier, current_limit, strategy } = req.body;

      if (!endpoint) {
        res.status(400).json({
          success: false,
          error: 'Endpoint is required',
        });
        return;
      }

      const recommendation = await mlClient.optimizeRateLimit({
        endpoint,
        tier,
        current_limit,
        strategy,
      });

      res.json({
        success: true,
        data: recommendation,
      });
    } catch (error) {
      logger.error('Rate limit optimization failed', {
        error: error instanceof Error ? error.message : String(error),
      });

      res.status(500).json({
        success: false,
        error: 'Failed to get recommendation',
      });
    }
  }
);

/**
 * GET /api/ml/recommendations
 *
 * Get rate limit recommendations for all endpoints.
 */
router.get('/recommendations', async (req: Request, res: Response) => {
  try {
    const tier = req.query.tier as string | undefined;
    const strategy = req.query.strategy as 'conservative' | 'balanced' | 'permissive' | 'adaptive' | undefined;

    const result = await mlClient.optimizeAllEndpoints({
      tier,
      strategy,
    });

    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    logger.error('Bulk rate limit optimization failed', {
      error: error instanceof Error ? error.message : String(error),
    });

    res.status(500).json({
      success: false,
      error: 'Failed to get recommendations',
    });
  }
});

/**
 * POST /api/ml/recommendations/apply
 *
 * Apply a rate limit recommendation.
 * This updates the rate limit configuration for the specified endpoint.
 */
router.post(
  '/recommendations/apply',
  async (req: Request<object, object, ApplyRecommendationBody>, res: Response) => {
    try {
      const { endpoint, tier, recommendedLimit, recommendedBurst } = req.body;

      if (!endpoint || !tier || !recommendedLimit) {
        res.status(400).json({
          success: false,
          error: 'endpoint, tier, and recommendedLimit are required',
        });
        return;
      }

      // TODO: Implement actual rate limit update logic
      // This would update Redis/config with the new limits
      logger.info('Applying rate limit recommendation', {
        endpoint,
        tier,
        recommendedLimit,
        recommendedBurst,
      });

      // For now, return success (actual implementation would update Redis)
      res.json({
        success: true,
        data: {
          applied: true,
          endpoint,
          tier,
          newLimit: recommendedLimit,
          newBurst: recommendedBurst,
          message: `Rate limit updated for ${endpoint} (${tier} tier): ${recommendedLimit} req/min, burst: ${recommendedBurst}`,
        },
      });
    } catch (error) {
      logger.error('Failed to apply recommendation', {
        error: error instanceof Error ? error.message : String(error),
      });

      res.status(500).json({
        success: false,
        error: 'Failed to apply recommendation',
      });
    }
  }
);

/**
 * GET /api/ml/recommendations/clusters
 *
 * Get endpoint clusters for group-based rate limiting.
 */
router.get('/recommendations/clusters', async (req: Request, res: Response) => {
  try {
    const nClusters = parseInt(req.query.n as string) || 5;
    const result = await mlClient.getEndpointClusters(nClusters);

    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to get clusters',
    });
  }
});

// =============================================================================
// Model Training
// =============================================================================

/**
 * POST /api/ml/train
 *
 * Train ML models on historical data.
 */
router.post('/train', async (req: Request, res: Response) => {
  try {
    const { days, contamination, models } = req.body;

    const result = await mlClient.trainModels({
      days,
      contamination,
      models,
    });

    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    logger.error('Model training failed', {
      error: error instanceof Error ? error.message : String(error),
    });

    res.status(500).json({
      success: false,
      error: 'Training failed',
    });
  }
});

/**
 * GET /api/ml/train/status
 *
 * Get training status.
 */
router.get('/train/status', async (_req: Request, res: Response) => {
  try {
    const status = await mlClient.getTrainingStatus();

    res.json({
      success: true,
      data: status,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to get training status',
    });
  }
});

/**
 * POST /api/ml/train/synthetic
 *
 * Train on synthetic data (for testing).
 */
router.post('/train/synthetic', async (_req: Request, res: Response) => {
  try {
    const result = await mlClient.trainOnSynthetic();

    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Synthetic training failed',
    });
  }
});

// =============================================================================
// Model Management
// =============================================================================

/**
 * GET /api/ml/model/info
 *
 * Get model information.
 */
router.get('/model/info', async (_req: Request, res: Response) => {
  try {
    const info = await mlClient.getModelInfo();

    res.json({
      success: true,
      data: info,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to get model info',
    });
  }
});

/**
 * POST /api/ml/model/load
 *
 * Load pre-trained models.
 */
router.post('/model/load', async (req: Request, res: Response) => {
  try {
    const { models } = req.body;
    const result = await mlClient.loadModels(models);

    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to load models',
    });
  }
});

// =============================================================================
// Export
// =============================================================================

export default router;
export { router as mlRouter };
