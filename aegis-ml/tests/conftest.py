"""
AEGIS ML - Pytest Fixtures

Shared fixtures for unit tests.
"""

import sys
from datetime import datetime
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

from models.anomaly_detector import (
    AnomalyDetector,
    RealTimeAnomalyDetector,
    TrafficMetrics,
)
from models.rate_limit_optimizer import RateLimitOptimizer


@pytest.fixture
def seed():
    """Set random seed for reproducibility."""
    np.random.seed(42)
    return 42


@pytest.fixture
def sample_training_data(seed):
    """Generate sample training data for anomaly detection."""
    n_samples = 1000

    # Generate normal traffic patterns
    data = pd.DataFrame(
        {
            "requests_per_second": np.random.normal(50, 10, n_samples),
            "avg_latency_ms": np.random.lognormal(3.5, 0.5, n_samples),
            "p95_latency_ms": np.random.lognormal(4.0, 0.5, n_samples),
            "p99_latency_ms": np.random.lognormal(4.5, 0.5, n_samples),
            "error_rate": np.abs(np.random.normal(0.02, 0.01, n_samples)),
        }
    )

    # Clip to reasonable ranges
    data["requests_per_second"] = data["requests_per_second"].clip(1, 200)
    data["error_rate"] = data["error_rate"].clip(0, 1)

    return data


@pytest.fixture
def trained_detector(sample_training_data):
    """Create a trained anomaly detector."""
    detector = AnomalyDetector(contamination=0.1)
    detector.train(sample_training_data)
    return detector


@pytest.fixture
def realtime_detector(trained_detector):
    """Create a realtime anomaly detector with trained base model."""
    return RealTimeAnomalyDetector(
        trained_detector, window_size=10, persistence_threshold=3
    )


@pytest.fixture
def sample_endpoint_data(seed):
    """Generate sample endpoint data for rate limit optimization."""
    n_samples = 5000
    endpoints = [
        "/api/users",
        "/api/orders",
        "/api/products",
        "/api/health",
        "/api/auth/login",
    ]
    methods = ["GET", "POST", "PUT", "DELETE"]

    timestamps = pd.date_range(
        end=datetime.utcnow(),
        periods=n_samples,
        freq="1s",
    )

    data = pd.DataFrame(
        {
            "timestamp": timestamps,
            "endpoint": np.random.choice(
                endpoints, n_samples, p=[0.3, 0.25, 0.25, 0.15, 0.05]
            ),
            "method": np.random.choice(methods, n_samples, p=[0.6, 0.25, 0.1, 0.05]),
            "response_time_ms": np.random.lognormal(3.5, 0.5, n_samples),
            "status_code": np.random.choice(
                [200, 201, 400, 404, 500],
                n_samples,
                p=[0.85, 0.05, 0.05, 0.03, 0.02],
            ),
            "user_id": [
                f"user_{i % 100:04d}" if np.random.random() > 0.2 else None
                for i in range(n_samples)
            ],
            "ip_address": [
                f"192.168.{i % 256}.{(i * 7) % 256}" for i in range(n_samples)
            ],
        }
    )

    return data


@pytest.fixture
def trained_optimizer(sample_endpoint_data):
    """Create a trained rate limit optimizer."""
    optimizer = RateLimitOptimizer()
    optimizer.analyze_traffic(sample_endpoint_data)
    return optimizer


@pytest.fixture
def normal_metrics():
    """Create normal traffic metrics."""
    return TrafficMetrics(
        timestamp=datetime.utcnow(),
        requests_per_second=50.0,
        avg_latency_ms=30.0,
        p95_latency_ms=60.0,
        p99_latency_ms=90.0,
        error_rate=0.02,
    )


@pytest.fixture
def anomalous_metrics():
    """Create anomalous traffic metrics (traffic spike)."""
    return TrafficMetrics(
        timestamp=datetime.utcnow(),
        requests_per_second=500.0,
        avg_latency_ms=200.0,
        p95_latency_ms=500.0,
        p99_latency_ms=1000.0,
        error_rate=0.15,
    )


@pytest.fixture
def normal_metrics_dict():
    """Create normal traffic metrics as dictionary."""
    return {
        "requests_per_second": 50.0,
        "avg_latency_ms": 30.0,
        "p95_latency_ms": 60.0,
        "p99_latency_ms": 90.0,
        "error_rate": 0.02,
    }


@pytest.fixture
def anomalous_metrics_dict():
    """Create anomalous traffic metrics as dictionary."""
    return {
        "requests_per_second": 500.0,
        "avg_latency_ms": 200.0,
        "p95_latency_ms": 500.0,
        "p99_latency_ms": 1000.0,
        "error_rate": 0.15,
    }
