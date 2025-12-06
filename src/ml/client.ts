/**
 * AEGIS - ML Service Client
 *
 * Client for communicating with the Python ML service.
 * Provides methods for:
 * - Anomaly detection
 * - Rate limit optimization
 * - Model training and management
 */

import logger from '../utils/logger.js';

// =============================================================================
// Types
// =============================================================================

export interface MLServiceConfig {
  /**
   * Base URL of the ML service
   */
  baseUrl: string;

  /**
   * Request timeout in milliseconds
   */
  timeout: number;

  /**
   * Enable the ML service integration
   */
  enabled: boolean;

  /**
   * Retry configuration
   */
  retry: {
    attempts: number;
    delayMs: number;
  };
}

export interface TrafficMetrics {
  timestamp?: string;
  requests_per_second: number;
  avg_latency_ms: number;
  p95_latency_ms: number;
  p99_latency_ms: number;
  error_rate: number;
  status_2xx?: number;
  status_4xx?: number;
  status_5xx?: number;
  total_requests?: number;
}

export interface AnomalyResult {
  anomaly: boolean;
  score: number;
  normalized_score: number;
  anomaly_type: string | null;
  severity: 'low' | 'medium' | 'high' | 'critical' | null;
  confidence: number;
  explanation: string;
  features: Record<string, number>;
  timestamp: string;
}

export interface BatchAnomalyResult {
  results: AnomalyResult[];
  summary: {
    total: number;
    anomalies: number;
    anomaly_rate: number;
  };
}

export interface TrendAnalysis {
  window_size: number;
  anomaly_streak: number;
  rps_trend: 'increasing' | 'decreasing' | 'stable';
  latency_trend: 'increasing' | 'decreasing' | 'stable';
  error_trend: 'increasing' | 'decreasing' | 'stable';
  recent_anomaly_rate: number;
}

export interface RateLimitRecommendation {
  endpoint: string;
  tier: string;
  current_limit: number | null;
  recommended_limit: number;
  recommended_burst: number;
  confidence: number;
  reasoning: string;
  strategy: string;
  warnings: string[];
  profile: EndpointProfile | null;
}

export interface EndpointProfile {
  endpoint: string;
  method: string;
  avg_requests_per_minute: number;
  peak_requests_per_minute: number;
  p95_requests_per_minute: number;
  avg_latency_ms: number;
  error_rate: number;
  unique_users: number;
  total_requests: number;
  typical_burst_size: number;
  time_of_day_variance: number;
}

export interface TrainingResult {
  anomaly_detector?: {
    trained: boolean;
    samples?: number;
    score_threshold?: number;
    timestamp?: string;
    error?: string;
  };
  rate_optimizer?: {
    trained: boolean;
    endpoints?: number;
    timestamp?: string;
    error?: string;
  };
}

export interface ModelInfo {
  anomaly_detector: {
    is_trained: boolean;
    training_timestamp: string | null;
    training_samples: number;
    contamination: number;
    score_threshold: number | null;
    feature_names: string[];
    baselines: Record<string, Record<string, number>> | null;
  } | null;
  rate_optimizer: {
    is_trained: boolean;
    training_timestamp: string | null;
    strategy: string;
    headroom_percent: number;
    endpoint_count: number;
    endpoints: string[];
  } | null;
}

export interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  service: string;
  timestamp: string;
  database: string;
  models: {
    anomaly_detector: {
      loaded: boolean;
      trained: boolean;
    };
    rate_optimizer: {
      loaded: boolean;
      trained: boolean;
    };
  };
}

interface APIResponse<T> {
  success: boolean;
  data: T;
  timestamp: string;
  error?: boolean;
  message?: string;
}

// =============================================================================
// Default Configuration
// =============================================================================

export const DEFAULT_ML_CONFIG: MLServiceConfig = {
  baseUrl: process.env.ML_SERVICE_URL || 'http://localhost:5000',
  timeout: 10000,
  enabled: process.env.ML_SERVICE_ENABLED !== 'false',
  retry: {
    attempts: 3,
    delayMs: 1000,
  },
};

// =============================================================================
// ML Service Client Class
// =============================================================================

export class MLServiceClient {
  private config: MLServiceConfig;
  private isAvailable: boolean = false;

  constructor(config: Partial<MLServiceConfig> = {}) {
    this.config = { ...DEFAULT_ML_CONFIG, ...config };
  }

  // ===========================================================================
  // HTTP Helpers
  // ===========================================================================

  private async request<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<T> {
    if (!this.config.enabled) {
      throw new Error('ML service is disabled');
    }

    const url = `${this.config.baseUrl}${endpoint}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.timeout);

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          ...options.headers,
        },
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({})) as Record<string, unknown>;
        throw new Error(
          (errorData.message as string) || `HTTP ${response.status}: ${response.statusText}`
        );
      }

      const data = await response.json() as APIResponse<T>;

      if (!data.success) {
        throw new Error(data.message || 'Request failed');
      }

      return data.data;
    } catch (error) {
      clearTimeout(timeoutId);

      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error('ML service request timed out');
      }

      throw error;
    }
  }

  private async requestWithRetry<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= this.config.retry.attempts; attempt++) {
      try {
        return await this.request<T>(endpoint, options);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (attempt < this.config.retry.attempts) {
          logger.warn(`ML service request failed, retrying...`, {
            endpoint,
            attempt,
            error: lastError.message,
          });
          await this.delay(this.config.retry.delayMs * attempt);
        }
      }
    }

    throw lastError;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ===========================================================================
  // Health Check
  // ===========================================================================

  /**
   * Check if the ML service is healthy and available
   */
  async checkHealth(): Promise<HealthStatus> {
    try {
      const health = await this.request<HealthStatus>('/health');
      this.isAvailable = health.status === 'healthy';
      return health;
    } catch (error) {
      this.isAvailable = false;
      throw error;
    }
  }

  /**
   * Check if the ML service is currently available
   */
  isServiceAvailable(): boolean {
    return this.isAvailable && this.config.enabled;
  }

  // ===========================================================================
  // Anomaly Detection
  // ===========================================================================

  /**
   * Detect if given metrics represent an anomaly
   */
  async detectAnomaly(metrics: TrafficMetrics): Promise<AnomalyResult> {
    return this.requestWithRetry<AnomalyResult>('/detect', {
      method: 'POST',
      body: JSON.stringify(metrics),
    });
  }

  /**
   * Detect anomalies in a batch of metrics
   */
  async detectBatch(metrics: TrafficMetrics[]): Promise<BatchAnomalyResult> {
    return this.requestWithRetry<BatchAnomalyResult>('/detect/batch', {
      method: 'POST',
      body: JSON.stringify({ metrics }),
    });
  }

  /**
   * Get current trend analysis from realtime detector
   */
  async getTrend(): Promise<TrendAnalysis> {
    return this.requestWithRetry<TrendAnalysis>('/detect/trend');
  }

  // ===========================================================================
  // Rate Limit Optimization
  // ===========================================================================

  /**
   * Get rate limit recommendation for an endpoint
   */
  async optimizeRateLimit(options: {
    endpoint: string;
    tier?: string;
    current_limit?: number;
    strategy?: 'conservative' | 'balanced' | 'permissive' | 'adaptive';
  }): Promise<RateLimitRecommendation> {
    return this.requestWithRetry<RateLimitRecommendation>('/optimize', {
      method: 'POST',
      body: JSON.stringify(options),
    });
  }

  /**
   * Get rate limit recommendations for all endpoints
   */
  async optimizeAllEndpoints(options: {
    tier?: string;
    strategy?: 'conservative' | 'balanced' | 'permissive' | 'adaptive';
  } = {}): Promise<{
    recommendations: RateLimitRecommendation[];
    summary: {
      total_endpoints: number;
      avg_confidence: number;
    };
  }> {
    return this.requestWithRetry('/optimize/all', {
      method: 'POST',
      body: JSON.stringify(options),
    });
  }

  /**
   * Get endpoint clusters for group-based rate limiting
   */
  async getEndpointClusters(n_clusters: number = 5): Promise<{
    clusters: Record<string, string[]>;
  }> {
    return this.requestWithRetry(`/optimize/clusters?n_clusters=${n_clusters}`);
  }

  // ===========================================================================
  // Model Training
  // ===========================================================================

  /**
   * Train ML models on historical data
   */
  async trainModels(options: {
    days?: number;
    contamination?: number;
    models?: ('anomaly' | 'optimizer')[];
  } = {}): Promise<TrainingResult> {
    return this.requestWithRetry<TrainingResult>('/train', {
      method: 'POST',
      body: JSON.stringify(options),
    });
  }

  /**
   * Get training status
   */
  async getTrainingStatus(): Promise<TrainingResult> {
    return this.requestWithRetry<TrainingResult>('/train/status');
  }

  /**
   * Train on synthetic data (for testing)
   */
  async trainOnSynthetic(): Promise<{
    trained: boolean;
    samples: number;
    score_threshold: number;
    timestamp: string;
  }> {
    return this.requestWithRetry('/train/synthetic', {
      method: 'POST',
    });
  }

  // ===========================================================================
  // Model Management
  // ===========================================================================

  /**
   * Get model information
   */
  async getModelInfo(): Promise<ModelInfo> {
    return this.requestWithRetry<ModelInfo>('/model/info');
  }

  /**
   * Load pre-trained models from disk
   */
  async loadModels(models?: ('anomaly' | 'optimizer')[]): Promise<{
    anomaly_detector?: { loaded: boolean; trained?: boolean; error?: string };
    rate_optimizer?: { loaded: boolean; trained?: boolean; error?: string };
  }> {
    return this.requestWithRetry('/model/load', {
      method: 'POST',
      body: JSON.stringify({ models }),
    });
  }

  /**
   * Reset models to untrained state
   */
  async resetModels(): Promise<{ reset: boolean }> {
    return this.requestWithRetry('/model/reset', {
      method: 'POST',
    });
  }

  // ===========================================================================
  // Data Export & Synthetic Data
  // ===========================================================================

  /**
   * Export training data
   */
  async exportTrainingData(options: {
    days?: number;
    format?: 'csv' | 'json';
  } = {}): Promise<Record<string, unknown>[] | string> {
    const { days = 7, format = 'json' } = options;
    return this.requestWithRetry(`/export/training-data?days=${days}&format=${format}`);
  }

  /**
   * Export endpoint profiles
   */
  async exportEndpointProfiles(): Promise<{
    profiles: Record<string, EndpointProfile>;
    count: number;
  }> {
    return this.requestWithRetry('/export/endpoint-profiles');
  }

  /**
   * Generate synthetic data for testing
   */
  async generateSyntheticData(options: {
    duration_hours?: number;
    base_rps?: number;
    include_anomalies?: boolean;
    anomaly_rate?: number;
  } = {}): Promise<{
    generated: boolean;
    samples: number;
    anomalies_injected: number;
    file: string;
  }> {
    return this.requestWithRetry('/generate/synthetic', {
      method: 'POST',
      body: JSON.stringify(options),
    });
  }
}

// =============================================================================
// Singleton Instance
// =============================================================================

let mlClientInstance: MLServiceClient | null = null;

/**
 * Get the ML service client instance
 */
export function getMLClient(config?: Partial<MLServiceConfig>): MLServiceClient {
  if (mlClientInstance === null) {
    mlClientInstance = new MLServiceClient(config);
  }
  return mlClientInstance;
}

/**
 * Initialize the ML service client
 */
export async function initializeMLClient(
  config?: Partial<MLServiceConfig>
): Promise<MLServiceClient> {
  const client = getMLClient(config);

  if (client.isServiceAvailable()) {
    return client;
  }

  try {
    const health = await client.checkHealth();
    logger.info('ML service connected', {
      status: health.status,
      anomalyDetectorTrained: health.models.anomaly_detector.trained,
      rateOptimizerTrained: health.models.rate_optimizer.trained,
    });
  } catch (error) {
    logger.warn('ML service not available', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return client;
}

export default MLServiceClient;
