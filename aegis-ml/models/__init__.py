"""
AEGIS ML - Models Package

This package contains machine learning models for:
- Anomaly detection in API traffic
- Rate limit optimization
"""

from .anomaly_detector import (
    AnomalyDetector,
    AnomalyResult,
    AnomalySeverity,
    AnomalyType,
    RealTimeAnomalyDetector,
    TrafficMetrics,
)
from .rate_limit_optimizer import (
    EndpointProfile,
    OptimizationStrategy,
    RateLimitOptimizer,
    RateLimitRecommendation,
    TierConfiguration,
    TierLevel,
)

__all__ = [
    # Anomaly Detection
    "AnomalyDetector",
    "RealTimeAnomalyDetector",
    "AnomalyResult",
    "AnomalyType",
    "AnomalySeverity",
    "TrafficMetrics",
    # Rate Limit Optimization
    "RateLimitOptimizer",
    "RateLimitRecommendation",
    "EndpointProfile",
    "OptimizationStrategy",
    "TierLevel",
    "TierConfiguration",
]
