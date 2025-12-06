"""
AEGIS ML - Anomaly Detector Tests

Unit tests for the anomaly detection module.
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

from models.anomaly_detector import (
    AnomalyDetector,
    AnomalyResult,
    AnomalySeverity,
    AnomalyType,
    RealTimeAnomalyDetector,
    TrafficMetrics,
)


class TestTrafficMetrics:
    """Tests for TrafficMetrics dataclass."""

    def test_from_dict_basic(self):
        """Test creating TrafficMetrics from dictionary."""
        data = {
            "requests_per_second": 100.0,
            "avg_latency_ms": 50.0,
            "p95_latency_ms": 100.0,
            "p99_latency_ms": 150.0,
            "error_rate": 0.01,
        }
        metrics = TrafficMetrics.from_dict(data)

        assert metrics.requests_per_second == 100.0
        assert metrics.avg_latency_ms == 50.0
        assert metrics.p95_latency_ms == 100.0
        assert metrics.p99_latency_ms == 150.0
        assert metrics.error_rate == 0.01

    def test_from_dict_with_aliases(self):
        """Test creating TrafficMetrics with alternative key names."""
        data = {
            "requests_per_second": 100.0,
            "avg_latency": 50.0,  # alias
            "p95_latency": 100.0,  # alias
            "p99_latency": 150.0,  # alias
            "error_rate": 0.01,
            "status2xx": 900,  # alias
            "status4xx": 50,  # alias
            "status5xx": 50,  # alias
        }
        metrics = TrafficMetrics.from_dict(data)

        assert metrics.avg_latency_ms == 50.0
        assert metrics.status_2xx == 900
        assert metrics.status_4xx == 50
        assert metrics.status_5xx == 50

    def test_to_feature_array(self):
        """Test converting metrics to feature array."""
        metrics = TrafficMetrics(
            timestamp=datetime.utcnow(),
            requests_per_second=100.0,
            avg_latency_ms=50.0,
            p95_latency_ms=100.0,
            p99_latency_ms=150.0,
            error_rate=0.01,
        )
        features = metrics.to_feature_array()

        assert len(features) == 5
        assert features[0] == 100.0
        assert features[1] == 50.0
        assert features[2] == 100.0
        assert features[3] == 150.0
        assert features[4] == 0.01


class TestAnomalyDetector:
    """Tests for AnomalyDetector class."""

    @pytest.fixture
    def sample_training_data(self):
        """Generate sample training data."""
        np.random.seed(42)
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
    def trained_detector(self, sample_training_data):
        """Create a trained detector."""
        detector = AnomalyDetector(contamination=0.1)
        detector.train(sample_training_data)
        return detector

    def test_initialization(self):
        """Test detector initialization."""
        detector = AnomalyDetector(
            contamination=0.05,
            n_estimators=50,
            threshold_multiplier=2.5,
        )

        assert detector.contamination == 0.05
        assert detector.n_estimators == 50
        assert detector.threshold_multiplier == 2.5
        assert not detector.is_trained

    def test_train(self, sample_training_data):
        """Test model training."""
        detector = AnomalyDetector(contamination=0.1)
        summary = detector.train(sample_training_data)

        assert detector.is_trained
        assert detector.training_samples == len(sample_training_data)
        assert detector.training_timestamp is not None
        assert "samples" in summary
        assert "score_threshold" in summary
        assert "baselines" in summary
        assert len(detector.baselines) == 5  # 5 features

    def test_train_with_list_input(self):
        """Test training with list of TrafficMetrics."""
        np.random.seed(42)
        metrics_list = [
            TrafficMetrics(
                timestamp=datetime.utcnow(),
                requests_per_second=np.random.normal(50, 10),
                avg_latency_ms=np.random.lognormal(3.5, 0.5),
                p95_latency_ms=np.random.lognormal(4.0, 0.5),
                p99_latency_ms=np.random.lognormal(4.5, 0.5),
                error_rate=abs(np.random.normal(0.02, 0.01)),
            )
            for _ in range(100)
        ]

        detector = AnomalyDetector(contamination=0.1)
        summary = detector.train(metrics_list)

        assert detector.is_trained
        assert summary["samples"] == 100

    def test_train_insufficient_data(self):
        """Test that training fails with insufficient data."""
        data = pd.DataFrame(
            {
                "requests_per_second": [50, 60],
                "avg_latency_ms": [30, 40],
                "p95_latency_ms": [60, 80],
                "p99_latency_ms": [100, 120],
                "error_rate": [0.01, 0.02],
            }
        )

        detector = AnomalyDetector()
        with pytest.raises(ValueError, match="Insufficient training data"):
            detector.train(data)

    def test_detect_normal_traffic(self, trained_detector):
        """Test detection of normal traffic."""
        metrics = TrafficMetrics(
            timestamp=datetime.utcnow(),
            requests_per_second=50.0,
            avg_latency_ms=30.0,
            p95_latency_ms=60.0,
            p99_latency_ms=90.0,
            error_rate=0.02,
        )

        result = trained_detector.detect(metrics)

        assert isinstance(result, AnomalyResult)
        assert not result.is_anomaly
        assert 0 <= result.normalized_score <= 1
        assert result.explanation != ""

    def test_detect_traffic_spike(self, trained_detector):
        """Test detection of traffic spike."""
        metrics = TrafficMetrics(
            timestamp=datetime.utcnow(),
            requests_per_second=500.0,  # Much higher than normal
            avg_latency_ms=30.0,
            p95_latency_ms=60.0,
            p99_latency_ms=90.0,
            error_rate=0.02,
        )

        result = trained_detector.detect(metrics)

        assert result.is_anomaly
        assert result.anomaly_type == AnomalyType.TRAFFIC_SPIKE
        assert result.severity is not None

    def test_detect_latency_spike(self, trained_detector):
        """Test detection of latency spike."""
        metrics = TrafficMetrics(
            timestamp=datetime.utcnow(),
            requests_per_second=50.0,
            avg_latency_ms=500.0,  # Much higher than normal
            p95_latency_ms=1000.0,
            p99_latency_ms=2000.0,
            error_rate=0.02,
        )

        result = trained_detector.detect(metrics)

        assert result.is_anomaly
        assert result.anomaly_type == AnomalyType.LATENCY_SPIKE

    def test_detect_error_spike(self, trained_detector):
        """Test detection of error rate spike."""
        metrics = TrafficMetrics(
            timestamp=datetime.utcnow(),
            requests_per_second=50.0,
            avg_latency_ms=30.0,
            p95_latency_ms=60.0,
            p99_latency_ms=90.0,
            error_rate=0.5,  # 50% error rate
        )

        result = trained_detector.detect(metrics)

        assert result.is_anomaly
        assert result.anomaly_type == AnomalyType.ERROR_RATE_SPIKE

    def test_detect_with_dict_input(self, trained_detector):
        """Test detection with dictionary input."""
        metrics_dict = {
            "requests_per_second": 50.0,
            "avg_latency_ms": 30.0,
            "p95_latency_ms": 60.0,
            "p99_latency_ms": 90.0,
            "error_rate": 0.02,
        }

        result = trained_detector.detect(metrics_dict)

        assert isinstance(result, AnomalyResult)
        assert not result.is_anomaly

    def test_detect_batch(self, trained_detector):
        """Test batch detection."""
        metrics_list = [
            {
                "requests_per_second": 50.0,
                "avg_latency_ms": 30.0,
                "p95_latency_ms": 60.0,
                "p99_latency_ms": 90.0,
                "error_rate": 0.02,
            },
            {
                "requests_per_second": 500.0,  # Anomaly
                "avg_latency_ms": 30.0,
                "p95_latency_ms": 60.0,
                "p99_latency_ms": 90.0,
                "error_rate": 0.02,
            },
        ]

        results = trained_detector.detect_batch(metrics_list)

        assert len(results) == 2
        assert not results[0].is_anomaly
        assert results[1].is_anomaly

    def test_detect_untrained_model(self):
        """Test that detection fails on untrained model."""
        detector = AnomalyDetector()
        metrics = TrafficMetrics(
            timestamp=datetime.utcnow(),
            requests_per_second=50.0,
            avg_latency_ms=30.0,
            p95_latency_ms=60.0,
            p99_latency_ms=90.0,
            error_rate=0.02,
        )

        with pytest.raises(RuntimeError, match="Model must be trained"):
            detector.detect(metrics)

    def test_save_and_load(self, trained_detector):
        """Test model save and load."""
        with tempfile.TemporaryDirectory() as tmpdir:
            save_path = Path(tmpdir) / "model"

            # Save model
            trained_detector.save(save_path)

            # Verify files exist
            assert (save_path / "isolation_forest.joblib").exists()
            assert (save_path / "scaler.joblib").exists()
            assert (save_path / "metadata.joblib").exists()

            # Load model
            loaded_detector = AnomalyDetector.load(save_path)

            assert loaded_detector.is_trained
            assert loaded_detector.training_samples == trained_detector.training_samples

            # Test detection with loaded model
            metrics = TrafficMetrics(
                timestamp=datetime.utcnow(),
                requests_per_second=50.0,
                avg_latency_ms=30.0,
                p95_latency_ms=60.0,
                p99_latency_ms=90.0,
                error_rate=0.02,
            )
            result = loaded_detector.detect(metrics)
            assert isinstance(result, AnomalyResult)

    def test_get_model_info(self, trained_detector):
        """Test model info retrieval."""
        info = trained_detector.get_model_info()

        assert info["is_trained"]
        assert info["training_timestamp"] is not None
        assert info["training_samples"] > 0
        assert info["contamination"] == 0.1
        assert info["feature_names"] == AnomalyDetector.FEATURE_NAMES
        assert info["baselines"] is not None

    def test_anomaly_result_to_dict(self, trained_detector):
        """Test AnomalyResult serialization."""
        metrics = TrafficMetrics(
            timestamp=datetime.utcnow(),
            requests_per_second=500.0,
            avg_latency_ms=30.0,
            p95_latency_ms=60.0,
            p99_latency_ms=90.0,
            error_rate=0.02,
        )

        result = trained_detector.detect(metrics)
        result_dict = result.to_dict()

        assert "is_anomaly" in result_dict
        assert "score" in result_dict
        assert "normalized_score" in result_dict
        assert "anomaly_type" in result_dict
        assert "severity" in result_dict
        assert "confidence" in result_dict
        assert "features" in result_dict
        assert "explanation" in result_dict
        assert "timestamp" in result_dict


class TestRealTimeAnomalyDetector:
    """Tests for RealTimeAnomalyDetector class."""

    @pytest.fixture
    def realtime_detector(self, sample_training_data):
        """Create a realtime detector with trained base model."""
        base_detector = AnomalyDetector(contamination=0.1)
        base_detector.train(sample_training_data)
        return RealTimeAnomalyDetector(
            base_detector, window_size=10, persistence_threshold=3
        )

    @pytest.fixture
    def sample_training_data(self):
        """Generate sample training data."""
        np.random.seed(42)
        n_samples = 1000

        data = pd.DataFrame(
            {
                "requests_per_second": np.random.normal(50, 10, n_samples),
                "avg_latency_ms": np.random.lognormal(3.5, 0.5, n_samples),
                "p95_latency_ms": np.random.lognormal(4.0, 0.5, n_samples),
                "p99_latency_ms": np.random.lognormal(4.5, 0.5, n_samples),
                "error_rate": np.abs(np.random.normal(0.02, 0.01, n_samples)),
            }
        )

        data["requests_per_second"] = data["requests_per_second"].clip(1, 200)
        data["error_rate"] = data["error_rate"].clip(0, 1)

        return data

    def test_process_normal_traffic(self, realtime_detector):
        """Test processing normal traffic."""
        metrics = {
            "requests_per_second": 50.0,
            "avg_latency_ms": 30.0,
            "p95_latency_ms": 60.0,
            "p99_latency_ms": 90.0,
            "error_rate": 0.02,
        }

        result = realtime_detector.process(metrics)

        assert isinstance(result, AnomalyResult)
        assert not result.is_anomaly
        assert len(realtime_detector.window) == 1

    def test_sliding_window(self, realtime_detector):
        """Test sliding window behavior."""
        for i in range(15):
            metrics = {
                "requests_per_second": 50.0 + i,
                "avg_latency_ms": 30.0,
                "p95_latency_ms": 60.0,
                "p99_latency_ms": 90.0,
                "error_rate": 0.02,
            }
            realtime_detector.process(metrics)

        # Window should be capped at window_size
        assert len(realtime_detector.window) == 10

    def test_anomaly_persistence(self, realtime_detector):
        """Test anomaly persistence tracking."""
        # Send normal traffic
        for _ in range(5):
            metrics = {
                "requests_per_second": 50.0,
                "avg_latency_ms": 30.0,
                "p95_latency_ms": 60.0,
                "p99_latency_ms": 90.0,
                "error_rate": 0.02,
            }
            realtime_detector.process(metrics)

        assert realtime_detector.anomaly_streak == 0

        # Send anomalous traffic
        for i in range(5):
            metrics = {
                "requests_per_second": 500.0,  # Anomaly
                "avg_latency_ms": 30.0,
                "p95_latency_ms": 60.0,
                "p99_latency_ms": 90.0,
                "error_rate": 0.02,
            }
            result = realtime_detector.process(metrics)

            # After persistence_threshold, explanation should be "CONFIRMED"
            if i >= 2:  # persistence_threshold = 3
                assert (
                    "CONFIRMED" in result.explanation
                    or realtime_detector.anomaly_streak >= 3
                )

    def test_get_trend(self, realtime_detector):
        """Test trend analysis."""
        # Process some data points
        for i in range(10):
            metrics = {
                "requests_per_second": 50.0 + i * 5,  # Increasing
                "avg_latency_ms": 30.0,
                "p95_latency_ms": 60.0,
                "p99_latency_ms": 90.0,
                "error_rate": 0.02,
            }
            realtime_detector.process(metrics)

        trend = realtime_detector.get_trend()

        assert "window_size" in trend
        assert "anomaly_streak" in trend
        assert "rps_trend" in trend
        assert "latency_trend" in trend
        assert "error_trend" in trend
        assert trend["window_size"] == 10

    def test_reset(self, realtime_detector):
        """Test reset functionality."""
        # Process some data
        for _ in range(5):
            metrics = {
                "requests_per_second": 50.0,
                "avg_latency_ms": 30.0,
                "p95_latency_ms": 60.0,
                "p99_latency_ms": 90.0,
                "error_rate": 0.02,
            }
            realtime_detector.process(metrics)

        assert len(realtime_detector.window) == 5

        # Reset
        realtime_detector.reset()

        assert len(realtime_detector.window) == 0
        assert realtime_detector.anomaly_streak == 0
        assert len(realtime_detector.last_results) == 0


class TestAnomalyTypes:
    """Tests for anomaly type enums."""

    def test_anomaly_type_values(self):
        """Test AnomalyType enum values."""
        assert AnomalyType.TRAFFIC_SPIKE.value == "traffic_spike"
        assert AnomalyType.TRAFFIC_DROP.value == "traffic_drop"
        assert AnomalyType.LATENCY_SPIKE.value == "latency_spike"
        assert AnomalyType.ERROR_RATE_SPIKE.value == "error_rate_spike"
        assert AnomalyType.PATTERN_ANOMALY.value == "pattern_anomaly"
        assert AnomalyType.MULTI_DIMENSIONAL.value == "multi_dimensional"

    def test_anomaly_severity_values(self):
        """Test AnomalySeverity enum values."""
        assert AnomalySeverity.LOW.value == "low"
        assert AnomalySeverity.MEDIUM.value == "medium"
        assert AnomalySeverity.HIGH.value == "high"
        assert AnomalySeverity.CRITICAL.value == "critical"


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
