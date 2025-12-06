"""
AEGIS ML - Anomaly Detection Module

This module implements anomaly detection for API traffic patterns using
Isolation Forest and statistical methods. It detects:
- Traffic spikes (sudden increases in request rate)
- Latency anomalies (unusual response times)
- Error rate anomalies (abnormal error patterns)
- Pattern anomalies (unusual traffic shapes)

The model is trained on historical metrics and can score new data points
in real-time.
"""

import logging
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from enum import Enum
from pathlib import Path
from typing import Any, Optional

import joblib
import numpy as np
import pandas as pd
from scipy import stats
from sklearn.ensemble import IsolationForest
from sklearn.preprocessing import StandardScaler

# Configure logging
logger = logging.getLogger(__name__)


class AnomalyType(Enum):
    """Types of anomalies that can be detected."""

    TRAFFIC_SPIKE = "traffic_spike"
    LATENCY_SPIKE = "latency_spike"
    ERROR_RATE_SPIKE = "error_rate_spike"
    TRAFFIC_DROP = "traffic_drop"
    PATTERN_ANOMALY = "pattern_anomaly"
    MULTI_DIMENSIONAL = "multi_dimensional"


class AnomalySeverity(Enum):
    """Severity levels for detected anomalies."""

    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    CRITICAL = "critical"


@dataclass
class AnomalyResult:
    """Result of anomaly detection for a single data point."""

    is_anomaly: bool
    score: float  # Anomaly score (lower = more anomalous for Isolation Forest)
    normalized_score: float  # Score normalized to 0-1 range (higher = more anomalous)
    anomaly_type: Optional[AnomalyType] = None
    severity: Optional[AnomalySeverity] = None
    confidence: float = 0.0
    features: dict[str, float] = field(default_factory=dict)
    explanation: str = ""
    timestamp: datetime = field(default_factory=datetime.utcnow)

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        return {
            "is_anomaly": self.is_anomaly,
            "score": float(self.score),
            "normalized_score": float(self.normalized_score),
            "anomaly_type": self.anomaly_type.value if self.anomaly_type else None,
            "severity": self.severity.value if self.severity else None,
            "confidence": float(self.confidence),
            "features": {k: float(v) for k, v in self.features.items()},
            "explanation": self.explanation,
            "timestamp": self.timestamp.isoformat(),
        }


@dataclass
class TrafficMetrics:
    """Traffic metrics data point for anomaly detection."""

    timestamp: datetime
    requests_per_second: float
    avg_latency_ms: float
    p95_latency_ms: float
    p99_latency_ms: float
    error_rate: float
    status_2xx: int = 0
    status_4xx: int = 0
    status_5xx: int = 0
    total_requests: int = 0

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "TrafficMetrics":
        """Create from dictionary."""
        return cls(
            timestamp=datetime.fromisoformat(
                data.get("timestamp", datetime.utcnow().isoformat())
            ),
            requests_per_second=float(data.get("requests_per_second", 0)),
            avg_latency_ms=float(
                data.get("avg_latency_ms", data.get("avg_latency", 0))
            ),
            p95_latency_ms=float(
                data.get("p95_latency_ms", data.get("p95_latency", 0))
            ),
            p99_latency_ms=float(
                data.get("p99_latency_ms", data.get("p99_latency", 0))
            ),
            error_rate=float(data.get("error_rate", 0)),
            status_2xx=int(data.get("status_2xx", data.get("status2xx", 0))),
            status_4xx=int(data.get("status_4xx", data.get("status4xx", 0))),
            status_5xx=int(data.get("status_5xx", data.get("status5xx", 0))),
            total_requests=int(data.get("total_requests", 0)),
        )

    def to_feature_array(self) -> np.ndarray:
        """Convert to feature array for ML model."""
        return np.array(
            [
                self.requests_per_second,
                self.avg_latency_ms,
                self.p95_latency_ms,
                self.p99_latency_ms,
                self.error_rate,
            ]
        )


class AnomalyDetector:
    """
    Multi-model anomaly detection system for API traffic.

    Uses Isolation Forest as the primary model with additional
    statistical methods for specific anomaly types.
    """

    # Feature names for the model
    FEATURE_NAMES = [
        "requests_per_second",
        "avg_latency_ms",
        "p95_latency_ms",
        "p99_latency_ms",
        "error_rate",
    ]

    def __init__(
        self,
        contamination: float = 0.1,
        n_estimators: int = 100,
        random_state: int = 42,
        threshold_multiplier: float = 2.0,
    ):
        """
        Initialize the anomaly detector.

        Args:
            contamination: Expected proportion of anomalies in training data
            n_estimators: Number of trees in Isolation Forest
            random_state: Random seed for reproducibility
            threshold_multiplier: Multiplier for statistical threshold detection
        """
        self.contamination = contamination
        self.n_estimators = n_estimators
        self.random_state = random_state
        self.threshold_multiplier = threshold_multiplier

        # Primary model: Isolation Forest
        self.model = IsolationForest(
            contamination=contamination,
            n_estimators=n_estimators,
            random_state=random_state,
            n_jobs=-1,  # Use all CPU cores
        )

        # Feature scaler for normalization
        self.scaler = StandardScaler()

        # Statistical baselines (computed during training)
        self.baselines: dict[str, dict[str, float]] = {}

        # Training state
        self.is_trained = False
        self.training_timestamp: Optional[datetime] = None
        self.training_samples: int = 0

        # Score thresholds (calibrated during training)
        self.score_threshold = -0.5  # Default threshold

    def train(self, data: pd.DataFrame | list[TrafficMetrics]) -> dict[str, Any]:
        """
        Train the anomaly detection model on historical data.

        Args:
            data: Historical traffic metrics (DataFrame or list of TrafficMetrics)

        Returns:
            Training summary with model statistics
        """
        logger.info("Starting anomaly detector training...")

        # Convert to DataFrame if needed
        if isinstance(data, list):
            df = pd.DataFrame(
                [
                    {
                        "requests_per_second": m.requests_per_second,
                        "avg_latency_ms": m.avg_latency_ms,
                        "p95_latency_ms": m.p95_latency_ms,
                        "p99_latency_ms": m.p99_latency_ms,
                        "error_rate": m.error_rate,
                    }
                    for m in data
                ]
            )
        else:
            df = data[self.FEATURE_NAMES].copy()

        # Handle missing values
        df = df.fillna(df.median())

        # Remove any infinite values
        df = df.replace([np.inf, -np.inf], np.nan).dropna()

        if len(df) < 10:
            raise ValueError("Insufficient training data. Need at least 10 samples.")

        logger.info(f"Training on {len(df)} samples")

        # Extract features
        X = df[self.FEATURE_NAMES].values

        # Fit scaler and transform
        X_scaled = self.scaler.fit_transform(X)

        # Train Isolation Forest
        self.model.fit(X_scaled)

        # Compute statistical baselines for each feature
        self._compute_baselines(df)

        # Calibrate score threshold
        scores = self.model.decision_function(X_scaled)
        self.score_threshold = np.percentile(scores, (1 - self.contamination) * 100)

        # Update training state
        self.is_trained = True
        self.training_timestamp = datetime.utcnow()
        self.training_samples = len(df)

        # Compute training summary
        training_summary = {
            "samples": len(df),
            "features": self.FEATURE_NAMES,
            "contamination": self.contamination,
            "score_threshold": float(self.score_threshold),
            "baselines": self.baselines,
            "timestamp": self.training_timestamp.isoformat(),
        }

        logger.info(f"Training complete. Score threshold: {self.score_threshold:.4f}")

        return training_summary

    def _compute_baselines(self, df: pd.DataFrame) -> None:
        """Compute statistical baselines for each feature."""
        self.baselines = {}

        for feature in self.FEATURE_NAMES:
            values = df[feature].values
            self.baselines[feature] = {
                "mean": float(np.mean(values)),
                "std": float(np.std(values)),
                "median": float(np.median(values)),
                "q25": float(np.percentile(values, 25)),
                "q75": float(np.percentile(values, 75)),
                "iqr": float(np.percentile(values, 75) - np.percentile(values, 25)),
                "min": float(np.min(values)),
                "max": float(np.max(values)),
            }

    def detect(self, metrics: TrafficMetrics | dict[str, Any]) -> AnomalyResult:
        """
        Detect if given metrics represent an anomaly.

        Args:
            metrics: Traffic metrics to analyze

        Returns:
            AnomalyResult with detection details
        """
        if not self.is_trained:
            raise RuntimeError(
                "Model must be trained before detection. Call train() first."
            )

        # Convert dict to TrafficMetrics if needed
        if isinstance(metrics, dict):
            metrics = TrafficMetrics.from_dict(metrics)

        # Extract features
        X = metrics.to_feature_array().reshape(1, -1)

        # Scale features
        X_scaled = self.scaler.transform(X)

        # Get Isolation Forest score
        raw_score = self.model.decision_function(X_scaled)[0]
        prediction = self.model.predict(X_scaled)[0]

        # Normalize score to 0-1 range (higher = more anomalous)
        # Isolation Forest scores: negative = anomaly, positive = normal
        normalized_score = self._normalize_score(raw_score)

        # Determine if it's an anomaly
        is_anomaly = bool(prediction == -1)

        # Identify specific anomaly type
        anomaly_type, type_score = self._identify_anomaly_type(metrics)

        # Determine severity
        severity = self._determine_severity(normalized_score) if is_anomaly else None

        # Calculate confidence
        confidence = self._calculate_confidence(raw_score, type_score)

        # Build explanation
        explanation = self._build_explanation(metrics, is_anomaly, anomaly_type)

        # Create feature dict for debugging
        features = {name: float(value) for name, value in zip(self.FEATURE_NAMES, X[0])}

        return AnomalyResult(
            is_anomaly=is_anomaly,
            score=float(raw_score),
            normalized_score=float(normalized_score),
            anomaly_type=anomaly_type if is_anomaly else None,
            severity=severity,
            confidence=confidence,
            features=features,
            explanation=explanation,
            timestamp=metrics.timestamp,
        )

    def detect_batch(
        self, metrics_list: list[TrafficMetrics | dict[str, Any]]
    ) -> list[AnomalyResult]:
        """
        Detect anomalies in a batch of metrics.

        Args:
            metrics_list: List of traffic metrics

        Returns:
            List of AnomalyResult objects
        """
        return [self.detect(m) for m in metrics_list]

    def _normalize_score(self, raw_score: float) -> float:
        """
        Normalize Isolation Forest score to 0-1 range.

        Isolation Forest scores:
        - Negative scores indicate anomalies
        - Positive scores indicate normal points
        - The more negative, the more anomalous
        """
        # Use sigmoid-like transformation centered around threshold
        # Map scores from roughly [-1, 1] to [0, 1] where higher = more anomalous
        normalized = 1 / (1 + np.exp(raw_score * 5))
        return float(np.clip(normalized, 0, 1))

    def _identify_anomaly_type(
        self, metrics: TrafficMetrics
    ) -> tuple[Optional[AnomalyType], float]:
        """
        Identify the specific type of anomaly based on feature analysis.

        Returns:
            Tuple of (AnomalyType, confidence score)
        """
        type_scores: dict[AnomalyType, float] = {}

        # Check for traffic spike
        if "requests_per_second" in self.baselines:
            baseline = self.baselines["requests_per_second"]
            z_score = self._compute_z_score(
                metrics.requests_per_second, baseline["mean"], baseline["std"]
            )
            if z_score > self.threshold_multiplier:
                type_scores[AnomalyType.TRAFFIC_SPIKE] = z_score
            elif z_score < -self.threshold_multiplier:
                type_scores[AnomalyType.TRAFFIC_DROP] = abs(z_score)

        # Check for latency spike
        if "avg_latency_ms" in self.baselines:
            baseline = self.baselines["avg_latency_ms"]
            z_score = self._compute_z_score(
                metrics.avg_latency_ms, baseline["mean"], baseline["std"]
            )
            if z_score > self.threshold_multiplier:
                type_scores[AnomalyType.LATENCY_SPIKE] = z_score

        # Check for p95 latency spike
        if "p95_latency_ms" in self.baselines:
            baseline = self.baselines["p95_latency_ms"]
            z_score = self._compute_z_score(
                metrics.p95_latency_ms, baseline["mean"], baseline["std"]
            )
            if z_score > self.threshold_multiplier:
                type_scores[AnomalyType.LATENCY_SPIKE] = max(
                    type_scores.get(AnomalyType.LATENCY_SPIKE, 0), z_score
                )

        # Check for error rate spike
        if "error_rate" in self.baselines:
            baseline = self.baselines["error_rate"]
            z_score = self._compute_z_score(
                metrics.error_rate, baseline["mean"], baseline["std"]
            )
            if z_score > self.threshold_multiplier:
                type_scores[AnomalyType.ERROR_RATE_SPIKE] = z_score

        # Determine primary anomaly type
        if not type_scores:
            return AnomalyType.PATTERN_ANOMALY, 0.5  # Unknown pattern

        if len(type_scores) > 2:
            return AnomalyType.MULTI_DIMENSIONAL, max(type_scores.values())

        # Return the type with highest score
        best_type = max(type_scores, key=type_scores.get)  # type: ignore
        return best_type, type_scores[best_type]

    def _compute_z_score(self, value: float, mean: float, std: float) -> float:
        """Compute z-score for a value."""
        if std == 0:
            return 0.0
        return (value - mean) / std

    def _determine_severity(self, normalized_score: float) -> AnomalySeverity:
        """Determine anomaly severity based on normalized score."""
        if normalized_score >= 0.9:
            return AnomalySeverity.CRITICAL
        elif normalized_score >= 0.75:
            return AnomalySeverity.HIGH
        elif normalized_score >= 0.6:
            return AnomalySeverity.MEDIUM
        else:
            return AnomalySeverity.LOW

    def _calculate_confidence(self, isolation_score: float, type_score: float) -> float:
        """Calculate confidence in the anomaly detection."""
        # Combine Isolation Forest score with type-specific score
        if_confidence = 1 / (1 + np.exp(isolation_score * 3))
        type_confidence = min(type_score / 5, 1.0) if type_score > 0 else 0.5

        # Weighted average
        confidence = 0.7 * if_confidence + 0.3 * type_confidence
        return float(np.clip(confidence, 0, 1))

    def _build_explanation(
        self,
        metrics: TrafficMetrics,
        is_anomaly: bool,
        anomaly_type: Optional[AnomalyType],
    ) -> str:
        """Build human-readable explanation of the detection."""
        if not is_anomaly:
            return "Traffic patterns are within normal parameters."

        explanations = {
            AnomalyType.TRAFFIC_SPIKE: (
                f"Detected traffic spike: {metrics.requests_per_second:.1f} req/s "
                f"(baseline: {self.baselines.get('requests_per_second', {}).get('mean', 0):.1f} req/s)"
            ),
            AnomalyType.TRAFFIC_DROP: (
                f"Detected unusual traffic drop: {metrics.requests_per_second:.1f} req/s "
                f"(baseline: {self.baselines.get('requests_per_second', {}).get('mean', 0):.1f} req/s)"
            ),
            AnomalyType.LATENCY_SPIKE: (
                f"Detected latency spike: avg={metrics.avg_latency_ms:.1f}ms, "
                f"p95={metrics.p95_latency_ms:.1f}ms "
                f"(baseline avg: {self.baselines.get('avg_latency_ms', {}).get('mean', 0):.1f}ms)"
            ),
            AnomalyType.ERROR_RATE_SPIKE: (
                f"Detected elevated error rate: {metrics.error_rate:.2%} "
                f"(baseline: {self.baselines.get('error_rate', {}).get('mean', 0):.2%})"
            ),
            AnomalyType.PATTERN_ANOMALY: (
                "Detected unusual traffic pattern that doesn't match normal behavior"
            ),
            AnomalyType.MULTI_DIMENSIONAL: (
                "Detected anomalies across multiple metrics simultaneously"
            ),
        }

        return (
            explanations.get(anomaly_type, "Anomaly detected in traffic patterns")
            if anomaly_type
            else "Anomaly detected in traffic patterns"
        )

    def save(self, path: str | Path) -> None:
        """
        Save the trained model to disk.

        Args:
            path: Directory path to save model files
        """
        if not self.is_trained:
            raise RuntimeError("Cannot save untrained model")

        path = Path(path)
        path.mkdir(parents=True, exist_ok=True)

        # Save model components
        joblib.dump(self.model, path / "isolation_forest.joblib")
        joblib.dump(self.scaler, path / "scaler.joblib")

        # Save metadata
        metadata = {
            "contamination": self.contamination,
            "n_estimators": self.n_estimators,
            "threshold_multiplier": self.threshold_multiplier,
            "score_threshold": self.score_threshold,
            "baselines": self.baselines,
            "training_timestamp": self.training_timestamp.isoformat()
            if self.training_timestamp
            else None,
            "training_samples": self.training_samples,
            "feature_names": self.FEATURE_NAMES,
        }
        joblib.dump(metadata, path / "metadata.joblib")

        logger.info(f"Model saved to {path}")

    @classmethod
    def load(cls, path: str | Path) -> "AnomalyDetector":
        """
        Load a trained model from disk.

        Args:
            path: Directory path containing model files

        Returns:
            Loaded AnomalyDetector instance
        """
        path = Path(path)

        # Load metadata
        metadata = joblib.load(path / "metadata.joblib")

        # Create instance
        detector = cls(
            contamination=metadata["contamination"],
            n_estimators=metadata["n_estimators"],
            threshold_multiplier=metadata["threshold_multiplier"],
        )

        # Load model components
        detector.model = joblib.load(path / "isolation_forest.joblib")
        detector.scaler = joblib.load(path / "scaler.joblib")

        # Restore state
        detector.score_threshold = metadata["score_threshold"]
        detector.baselines = metadata["baselines"]
        detector.training_timestamp = (
            datetime.fromisoformat(metadata["training_timestamp"])
            if metadata["training_timestamp"]
            else None
        )
        detector.training_samples = metadata["training_samples"]
        detector.is_trained = True

        logger.info(f"Model loaded from {path}")

        return detector

    def get_model_info(self) -> dict[str, Any]:
        """Get model information and statistics."""
        return {
            "is_trained": self.is_trained,
            "training_timestamp": (
                self.training_timestamp.isoformat() if self.training_timestamp else None
            ),
            "training_samples": self.training_samples,
            "contamination": self.contamination,
            "n_estimators": self.n_estimators,
            "threshold_multiplier": self.threshold_multiplier,
            "score_threshold": float(self.score_threshold) if self.is_trained else None,
            "feature_names": self.FEATURE_NAMES,
            "baselines": self.baselines if self.is_trained else None,
        }


class RealTimeAnomalyDetector:
    """
    Real-time anomaly detection with sliding window analysis.

    Extends the base AnomalyDetector with:
    - Sliding window for trend detection
    - Adaptive thresholds
    - Anomaly persistence tracking
    """

    def __init__(
        self,
        detector: AnomalyDetector,
        window_size: int = 60,
        persistence_threshold: int = 3,
    ):
        """
        Initialize real-time detector.

        Args:
            detector: Base AnomalyDetector instance
            window_size: Number of data points in sliding window
            persistence_threshold: Consecutive anomalies to confirm
        """
        self.detector = detector
        self.window_size = window_size
        self.persistence_threshold = persistence_threshold

        # Sliding window buffer
        self.window: list[TrafficMetrics] = []
        self.anomaly_streak: int = 0
        self.last_results: list[AnomalyResult] = []

    def process(self, metrics: TrafficMetrics | dict[str, Any]) -> AnomalyResult:
        """
        Process a new data point through the real-time detector.

        Args:
            metrics: Traffic metrics to analyze

        Returns:
            AnomalyResult with detection details
        """
        # Convert dict to TrafficMetrics if needed
        if isinstance(metrics, dict):
            metrics = TrafficMetrics.from_dict(metrics)

        # Add to sliding window
        self.window.append(metrics)
        if len(self.window) > self.window_size:
            self.window.pop(0)

        # Run base detection
        result = self.detector.detect(metrics)

        # Track anomaly persistence
        if result.is_anomaly:
            self.anomaly_streak += 1
        else:
            self.anomaly_streak = 0

        # Confirm persistent anomaly
        if self.anomaly_streak >= self.persistence_threshold:
            result.confidence = min(result.confidence * 1.2, 1.0)
            result.explanation = f"CONFIRMED: {result.explanation} (persisted for {self.anomaly_streak} intervals)"

        # Store result
        self.last_results.append(result)
        if len(self.last_results) > self.window_size:
            self.last_results.pop(0)

        return result

    def get_trend(self) -> dict[str, Any]:
        """Get trend analysis from sliding window."""
        if len(self.window) < 2:
            return {"trend": "insufficient_data"}

        # Calculate trends
        rps_values = [m.requests_per_second for m in self.window]
        latency_values = [m.avg_latency_ms for m in self.window]
        error_values = [m.error_rate for m in self.window]

        return {
            "window_size": len(self.window),
            "anomaly_streak": self.anomaly_streak,
            "rps_trend": self._calculate_trend(rps_values),
            "latency_trend": self._calculate_trend(latency_values),
            "error_trend": self._calculate_trend(error_values),
            "recent_anomaly_rate": (
                sum(1 for r in self.last_results if r.is_anomaly)
                / len(self.last_results)
                if self.last_results
                else 0
            ),
        }

    def _calculate_trend(self, values: list[float]) -> str:
        """Calculate trend direction from values."""
        if len(values) < 2:
            return "stable"

        # Simple linear regression slope
        x = np.arange(len(values))
        slope, _, _, _, _ = stats.linregress(x, values)

        std = np.std(values)
        if std == 0:
            return "stable"

        # Normalize slope by standard deviation
        normalized_slope = slope / std

        if normalized_slope > 0.5:
            return "increasing"
        elif normalized_slope < -0.5:
            return "decreasing"
        else:
            return "stable"

    def reset(self) -> None:
        """Reset the sliding window and counters."""
        self.window = []
        self.anomaly_streak = 0
        self.last_results = []
