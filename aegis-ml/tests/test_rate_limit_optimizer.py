"""
AEGIS ML - Rate Limit Optimizer Tests

Unit tests for the rate limit optimization module.
"""

import shutil
import sys
import tempfile
from datetime import datetime, timedelta
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

from models.rate_limit_optimizer import (
    EndpointProfile,
    OptimizationStrategy,
    RateLimitOptimizer,
    RateLimitRecommendation,
    TierConfiguration,
    TierLevel,
)


class TestEndpointProfile:
    """Tests for EndpointProfile dataclass."""

    def test_to_dict(self):
        """Test EndpointProfile serialization."""
        profile = EndpointProfile(
            endpoint="/api/users",
            method="GET",
            avg_requests_per_minute=100.0,
            peak_requests_per_minute=250.0,
            p95_requests_per_minute=180.0,
            avg_latency_ms=50.0,
            error_rate=0.02,
            unique_users=500,
            total_requests=10000,
            typical_burst_size=20,
            time_of_day_variance=0.3,
        )

        result = profile.to_dict()

        assert result["endpoint"] == "/api/users"
        assert result["method"] == "GET"
        assert result["avg_requests_per_minute"] == 100.0
        assert result["peak_requests_per_minute"] == 250.0
        assert result["p95_requests_per_minute"] == 180.0
        assert result["avg_latency_ms"] == 50.0
        assert result["error_rate"] == 0.02
        assert result["unique_users"] == 500
        assert result["total_requests"] == 10000
        assert result["typical_burst_size"] == 20
        assert result["time_of_day_variance"] == 0.3


class TestRateLimitRecommendation:
    """Tests for RateLimitRecommendation dataclass."""

    def test_to_dict_basic(self):
        """Test basic recommendation serialization."""
        rec = RateLimitRecommendation(
            endpoint="/api/users",
            tier="default",
            current_limit=100,
            recommended_limit=150,
            recommended_burst=25,
            confidence=0.85,
            reasoning="Based on traffic analysis",
            strategy=OptimizationStrategy.BALANCED,
            warnings=["Limited data available"],
        )

        result = rec.to_dict()

        assert result["endpoint"] == "/api/users"
        assert result["tier"] == "default"
        assert result["current_limit"] == 100
        assert result["recommended_limit"] == 150
        assert result["recommended_burst"] == 25
        assert result["confidence"] == 0.85
        assert result["strategy"] == "balanced"
        assert "Limited data available" in result["warnings"]

    def test_to_dict_with_profile(self):
        """Test recommendation serialization with profile."""
        profile = EndpointProfile(
            endpoint="/api/users",
            method="GET",
            avg_requests_per_minute=100.0,
            peak_requests_per_minute=250.0,
            p95_requests_per_minute=180.0,
            avg_latency_ms=50.0,
            error_rate=0.02,
            unique_users=500,
            total_requests=10000,
            typical_burst_size=20,
            time_of_day_variance=0.3,
        )

        rec = RateLimitRecommendation(
            endpoint="/api/users",
            tier="default",
            recommended_limit=150,
            recommended_burst=25,
            confidence=0.85,
            reasoning="Based on traffic analysis",
            strategy=OptimizationStrategy.BALANCED,
            profile=profile,
        )

        result = rec.to_dict()

        assert result["profile"] is not None
        assert result["profile"]["endpoint"] == "/api/users"


class TestTierConfiguration:
    """Tests for TierConfiguration."""

    def test_get_burst_size(self):
        """Test burst size calculation."""
        config = TierConfiguration(
            tier=TierLevel.STANDARD,
            base_limit=300,
            burst_multiplier=1.5,
        )

        burst = config.get_burst_size()

        assert burst == 450  # 300 * 1.5


class TestRateLimitOptimizer:
    """Tests for RateLimitOptimizer class."""

    @pytest.fixture
    def sample_endpoint_data(self):
        """Generate sample endpoint data for testing."""
        np.random.seed(42)
        n_samples = 5000
        endpoints = [
            "/api/users",
            "/api/orders",
            "/api/products",
            "/api/health",
            "/api/auth/login",
        ]

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
                "method": np.random.choice(
                    ["GET", "POST", "PUT", "DELETE"],
                    n_samples,
                    p=[0.6, 0.25, 0.1, 0.05],
                ),
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
    def trained_optimizer(self, sample_endpoint_data):
        """Create a trained optimizer."""
        optimizer = RateLimitOptimizer()
        optimizer.analyze_traffic(sample_endpoint_data)
        return optimizer

    def test_initialization(self):
        """Test optimizer initialization."""
        optimizer = RateLimitOptimizer(
            strategy=OptimizationStrategy.CONSERVATIVE,
            headroom_percent=30.0,
        )

        assert optimizer.strategy == OptimizationStrategy.CONSERVATIVE
        assert optimizer.headroom_percent == 30.0
        assert not optimizer.is_trained

    def test_analyze_traffic(self, sample_endpoint_data):
        """Test traffic analysis."""
        optimizer = RateLimitOptimizer()
        profiles = optimizer.analyze_traffic(sample_endpoint_data)

        assert optimizer.is_trained
        assert len(profiles) > 0
        assert "/api/users" in profiles

        profile = profiles["/api/users"]
        assert profile.total_requests > 0
        assert profile.avg_requests_per_minute >= 0
        assert profile.avg_latency_ms >= 0

    def test_recommend_with_profile(self, trained_optimizer):
        """Test recommendation for profiled endpoint."""
        rec = trained_optimizer.recommend(
            endpoint="/api/users",
            tier="default",
            current_limit=100,
        )

        assert rec.endpoint == "/api/users"
        assert rec.recommended_limit > 0
        assert rec.recommended_burst > 0
        assert 0 <= rec.confidence <= 1
        assert rec.profile is not None

    def test_recommend_without_profile(self):
        """Test recommendation for unknown endpoint."""
        optimizer = RateLimitOptimizer()
        rec = optimizer.recommend(
            endpoint="/api/unknown",
            tier="default",
        )

        assert rec.endpoint == "/api/unknown"
        assert rec.recommended_limit > 0
        assert rec.confidence < 0.5  # Low confidence without data
        assert "No traffic data" in rec.warnings[0]

    def test_recommend_different_tiers(self, trained_optimizer):
        """Test recommendations for different tiers."""
        tiers = ["free", "basic", "standard", "premium", "enterprise"]
        limits = []

        for tier in tiers:
            rec = trained_optimizer.recommend(
                endpoint="/api/users",
                tier=tier,
            )
            limits.append(rec.recommended_limit)

        # Higher tiers should have higher limits
        assert limits[0] <= limits[1] <= limits[2] <= limits[3] <= limits[4]

    def test_recommend_different_strategies(self, trained_optimizer):
        """Test recommendations with different strategies."""
        strategies = [
            OptimizationStrategy.CONSERVATIVE,
            OptimizationStrategy.BALANCED,
            OptimizationStrategy.PERMISSIVE,
        ]
        limits = []

        for strategy in strategies:
            rec = trained_optimizer.recommend(
                endpoint="/api/users",
                tier="default",
                strategy=strategy,
            )
            limits.append(rec.recommended_limit)

        # Conservative < Balanced < Permissive
        assert limits[0] <= limits[1] <= limits[2]

    def test_recommend_all(self, trained_optimizer):
        """Test batch recommendations."""
        recommendations = trained_optimizer.recommend_all(tier="default")

        assert len(recommendations) > 0
        for rec in recommendations:
            assert rec.recommended_limit > 0
            assert rec.recommended_burst > 0

    def test_cluster_endpoints(self, trained_optimizer):
        """Test endpoint clustering."""
        clusters = trained_optimizer.cluster_endpoints(n_clusters=3)

        assert len(clusters) > 0
        # All endpoints should be assigned to a cluster
        all_endpoints = []
        for endpoints in clusters.values():
            all_endpoints.extend(endpoints)
        assert len(all_endpoints) == len(trained_optimizer.endpoint_profiles)

    def test_save_and_load(self, trained_optimizer):
        """Test optimizer save and load."""
        with tempfile.TemporaryDirectory() as tmpdir:
            save_path = Path(tmpdir) / "optimizer"

            # Save
            trained_optimizer.save(save_path)

            assert (save_path / "optimizer_state.joblib").exists()

            # Load
            loaded_optimizer = RateLimitOptimizer.load(save_path)

            assert loaded_optimizer.is_trained
            assert len(loaded_optimizer.endpoint_profiles) == len(
                trained_optimizer.endpoint_profiles
            )

            # Verify recommendations are consistent
            orig_rec = trained_optimizer.recommend("/api/users", "default")
            loaded_rec = loaded_optimizer.recommend("/api/users", "default")
            assert orig_rec.recommended_limit == loaded_rec.recommended_limit

    def test_get_optimizer_info(self, trained_optimizer):
        """Test optimizer info retrieval."""
        info = trained_optimizer.get_optimizer_info()

        assert info["is_trained"]
        assert info["training_timestamp"] is not None
        assert info["strategy"] == "balanced"
        assert info["endpoint_count"] > 0
        assert len(info["endpoints"]) > 0

    def test_warnings_for_high_error_rate(self, sample_endpoint_data):
        """Test that high error rate generates warning."""
        # Modify data to have high error rate for one endpoint
        sample_endpoint_data.loc[
            sample_endpoint_data["endpoint"] == "/api/users", "status_code"
        ] = 500

        optimizer = RateLimitOptimizer()
        optimizer.analyze_traffic(sample_endpoint_data)

        rec = optimizer.recommend("/api/users", "default")

        # Should have warning about high error rate
        error_warnings = [w for w in rec.warnings if "error rate" in w.lower()]
        assert len(error_warnings) > 0

    def test_warnings_for_low_data(self):
        """Test that limited data generates warning."""
        # Create small dataset
        data = pd.DataFrame(
            {
                "timestamp": pd.date_range(
                    end=datetime.utcnow(), periods=50, freq="1s"
                ),
                "endpoint": ["/api/test"] * 50,
                "method": ["GET"] * 50,
                "response_time_ms": [50] * 50,
                "status_code": [200] * 50,
            }
        )

        optimizer = RateLimitOptimizer()
        optimizer.analyze_traffic(data)

        rec = optimizer.recommend("/api/test", "default")

        # Should have warning about limited data
        data_warnings = [w for w in rec.warnings if "Limited" in w or "limited" in w]
        assert len(data_warnings) > 0

    def test_round_to_nice_number(self):
        """Test nice number rounding."""
        optimizer = RateLimitOptimizer()

        assert optimizer._round_to_nice_number(7) == 7
        assert optimizer._round_to_nice_number(23) == 25
        assert optimizer._round_to_nice_number(67) == 70
        assert optimizer._round_to_nice_number(123) == 125
        assert optimizer._round_to_nice_number(780) == 800
        assert optimizer._round_to_nice_number(2340) == 2500


class TestOptimizationStrategies:
    """Tests for optimization strategy enum."""

    def test_strategy_values(self):
        """Test strategy enum values."""
        assert OptimizationStrategy.CONSERVATIVE.value == "conservative"
        assert OptimizationStrategy.BALANCED.value == "balanced"
        assert OptimizationStrategy.PERMISSIVE.value == "permissive"
        assert OptimizationStrategy.ADAPTIVE.value == "adaptive"


class TestTierLevels:
    """Tests for tier level enum."""

    def test_tier_values(self):
        """Test tier enum values."""
        assert TierLevel.FREE.value == "free"
        assert TierLevel.BASIC.value == "basic"
        assert TierLevel.STANDARD.value == "standard"
        assert TierLevel.PREMIUM.value == "premium"
        assert TierLevel.ENTERPRISE.value == "enterprise"


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
