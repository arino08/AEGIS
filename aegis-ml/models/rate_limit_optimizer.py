"""
AEGIS ML - Rate Limit Optimizer Module

This module implements intelligent rate limiting optimization based on
historical traffic patterns and anomaly detection. It provides:
- Dynamic rate limit recommendations based on traffic patterns
- Per-endpoint optimization suggestions
- Tier-based rate limit tuning
- Burst capacity recommendations

The optimizer analyzes historical data to suggest optimal rate limits
that balance API protection with user experience.
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
from sklearn.cluster import KMeans
from sklearn.preprocessing import StandardScaler

# Configure logging
logger = logging.getLogger(__name__)


class OptimizationStrategy(Enum):
    """Rate limit optimization strategies."""

    CONSERVATIVE = "conservative"  # Lower limits, prioritize protection
    BALANCED = "balanced"  # Balance between protection and throughput
    PERMISSIVE = "permissive"  # Higher limits, prioritize throughput
    ADAPTIVE = "adaptive"  # Dynamically adjust based on conditions


class TierLevel(Enum):
    """Rate limit tier levels."""

    FREE = "free"
    BASIC = "basic"
    STANDARD = "standard"
    PREMIUM = "premium"
    ENTERPRISE = "enterprise"


@dataclass
class EndpointProfile:
    """Traffic profile for an endpoint."""

    endpoint: str
    method: str = "ALL"
    avg_requests_per_minute: float = 0.0
    peak_requests_per_minute: float = 0.0
    p95_requests_per_minute: float = 0.0
    avg_latency_ms: float = 0.0
    error_rate: float = 0.0
    unique_users: int = 0
    total_requests: int = 0
    typical_burst_size: int = 0
    time_of_day_variance: float = 0.0  # How much traffic varies by time

    @staticmethod
    def _safe_float(value: Any) -> Optional[float]:
        """Convert to float, returning None for NaN/Inf/None values."""
        import math
        if value is None:
            return None
        try:
            f = float(value)
            if math.isnan(f) or math.isinf(f):
                return None
            return f
        except (TypeError, ValueError):
            return None

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        return {
            "endpoint": self.endpoint,
            "method": self.method,
            "avg_requests_per_minute": self._safe_float(self.avg_requests_per_minute),
            "peak_requests_per_minute": self._safe_float(self.peak_requests_per_minute),
            "p95_requests_per_minute": self._safe_float(self.p95_requests_per_minute),
            "avg_latency_ms": self._safe_float(self.avg_latency_ms),
            "error_rate": self._safe_float(self.error_rate),
            "unique_users": self.unique_users,
            "total_requests": self.total_requests,
            "typical_burst_size": self.typical_burst_size,
            "time_of_day_variance": self._safe_float(self.time_of_day_variance),
        }


@dataclass
class RateLimitRecommendation:
    """Rate limit recommendation for an endpoint."""

    endpoint: str
    tier: str
    current_limit: Optional[int] = None
    recommended_limit: int = 100
    recommended_burst: int = 10
    confidence: float = 0.0
    reasoning: str = ""
    strategy: OptimizationStrategy = OptimizationStrategy.BALANCED
    warnings: list[str] = field(default_factory=list)
    profile: Optional[EndpointProfile] = None

    @staticmethod
    def _safe_float(value: Any) -> Optional[float]:
        """Convert to float, returning None for NaN/Inf/None values."""
        import math
        if value is None:
            return None
        try:
            f = float(value)
            if math.isnan(f) or math.isinf(f):
                return None
            return f
        except (TypeError, ValueError):
            return None

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        return {
            "endpoint": self.endpoint,
            "tier": self.tier,
            "current_limit": self.current_limit,
            "recommended_limit": self.recommended_limit,
            "recommended_burst": self.recommended_burst,
            "confidence": self._safe_float(self.confidence),
            "reasoning": self.reasoning,
            "strategy": self.strategy.value,
            "warnings": self.warnings,
            "profile": self.profile.to_dict() if self.profile else None,
        }


@dataclass
class TierConfiguration:
    """Configuration for a rate limit tier."""

    tier: TierLevel
    base_limit: int  # Requests per minute
    burst_multiplier: float = 1.5
    max_limit: int = 10000
    min_limit: int = 10

    def get_burst_size(self) -> int:
        """Calculate burst size from base limit."""
        return int(self.base_limit * self.burst_multiplier)


# Default tier configurations
DEFAULT_TIER_CONFIGS = {
    TierLevel.FREE: TierConfiguration(TierLevel.FREE, 60, 1.2, 100, 10),
    TierLevel.BASIC: TierConfiguration(TierLevel.BASIC, 100, 1.5, 300, 30),
    TierLevel.STANDARD: TierConfiguration(TierLevel.STANDARD, 300, 1.5, 1000, 100),
    TierLevel.PREMIUM: TierConfiguration(TierLevel.PREMIUM, 1000, 2.0, 5000, 300),
    TierLevel.ENTERPRISE: TierConfiguration(
        TierLevel.ENTERPRISE, 5000, 2.5, 50000, 1000
    ),
}


class RateLimitOptimizer:
    """
    Intelligent rate limit optimizer using traffic analysis and clustering.

    Analyzes historical traffic patterns to recommend optimal rate limits
    for different endpoints and user tiers.
    """

    # Default strategy multipliers
    STRATEGY_MULTIPLIERS = {
        OptimizationStrategy.CONSERVATIVE: 0.7,
        OptimizationStrategy.BALANCED: 1.0,
        OptimizationStrategy.PERMISSIVE: 1.3,
        OptimizationStrategy.ADAPTIVE: 1.0,  # Calculated dynamically
    }

    def __init__(
        self,
        strategy: OptimizationStrategy = OptimizationStrategy.BALANCED,
        headroom_percent: float = 20.0,
        tier_configs: Optional[dict[TierLevel, TierConfiguration]] = None,
    ):
        """
        Initialize the rate limit optimizer.

        Args:
            strategy: Optimization strategy to use
            headroom_percent: Percentage of headroom above normal traffic
            tier_configs: Custom tier configurations
        """
        self.strategy = strategy
        self.headroom_percent = headroom_percent
        self.tier_configs = tier_configs or DEFAULT_TIER_CONFIGS

        # Clustering model for endpoint classification
        self.endpoint_clusterer: Optional[KMeans] = None
        self.scaler = StandardScaler()

        # Stored profiles
        self.endpoint_profiles: dict[str, EndpointProfile] = {}

        # Training state
        self.is_trained = False
        self.training_timestamp: Optional[datetime] = None

    @staticmethod
    def _safe_value(value: Any, default: float = 0.0) -> float:
        """Safely convert a value to float, handling NaN/None/Inf."""
        import math
        if value is None:
            return default
        try:
            f = float(value)
            if math.isnan(f) or math.isinf(f):
                return default
            return f
        except (TypeError, ValueError):
            return default

    def analyze_traffic(
        self, data: pd.DataFrame, time_column: str = "timestamp"
    ) -> dict[str, EndpointProfile]:
        """
        Analyze historical traffic data to build endpoint profiles.

        Args:
            data: DataFrame with columns:
                - timestamp: Request timestamp
                - endpoint/path: Endpoint path
                - method: HTTP method
                - response_time_ms/latency: Response time
                - status_code: HTTP status code
                - user_id (optional): User identifier

        Returns:
            Dictionary of endpoint profiles
        """
        logger.info(f"Analyzing traffic data with {len(data)} records")

        # Normalize column names
        df = data.copy()

        # Handle column name variations
        if "path" in df.columns and "endpoint" not in df.columns:
            df["endpoint"] = df["path"]
        if "latency" in df.columns and "response_time_ms" not in df.columns:
            df["response_time_ms"] = df["latency"]

        # Ensure timestamp column exists
        if time_column in df.columns:
            df["timestamp"] = pd.to_datetime(df[time_column])

        profiles = {}

        # Group by endpoint
        for endpoint, group in df.groupby("endpoint"):
            profile = self._build_endpoint_profile(endpoint, group)
            profiles[str(endpoint)] = profile

        self.endpoint_profiles = profiles
        self.is_trained = True
        self.training_timestamp = datetime.utcnow()

        logger.info(f"Built profiles for {len(profiles)} endpoints")

        return profiles

    def _build_endpoint_profile(
        self, endpoint: str, data: pd.DataFrame
    ) -> EndpointProfile:
        """Build traffic profile for a single endpoint."""
        # Resample to per-minute buckets
        if "timestamp" in data.columns:
            data = data.set_index("timestamp")
            minute_counts = data.resample("1min").size()
        else:
            # Fallback: estimate from total records
            minute_counts = pd.Series([len(data)])

        # Helper to safely convert to float
        def safe_float(val: Any, default: float = 0.0) -> float:
            if val is None:
                return default
            try:
                f = float(val)
                if pd.isna(f) or np.isinf(f):
                    return default
                return f
            except (TypeError, ValueError):
                return default

        # Calculate statistics
        avg_rpm = safe_float(minute_counts.mean()) if len(minute_counts) > 0 else 0.0
        peak_rpm = safe_float(minute_counts.max()) if len(minute_counts) > 0 else 0.0
        p95_rpm = (
            safe_float(np.percentile(minute_counts, 95)) if len(minute_counts) > 0 else 0.0
        )

        # Calculate time-of-day variance
        if "timestamp" in data.index.names or isinstance(data.index, pd.DatetimeIndex):
            hourly = data.resample("1h").size()
            hourly_mean = safe_float(hourly.mean())
            hourly_std = safe_float(hourly.std())
            variance = hourly_std / hourly_mean if hourly_mean > 0 else 0.0
        else:
            variance = 0.0

        # Estimate typical burst size (max requests in 1-second window)
        # Approximate as peak_rpm / 60 * burst_factor
        burst_factor = 3.0  # Typical burst multiplier
        typical_burst = max(1, int((peak_rpm / 60) * burst_factor))

        # Latency stats
        avg_latency = (
            safe_float(data["response_time_ms"].mean())
            if "response_time_ms" in data.columns
            else 0.0
        )

        # Error rate
        if "status_code" in data.columns:
            error_count = (data["status_code"] >= 400).sum()
            error_rate = safe_float(error_count / len(data)) if len(data) > 0 else 0.0
        else:
            error_rate = 0.0

        # Unique users
        unique_users = (
            data["user_id"].nunique()
            if "user_id" in data.columns
            else data["ip_address"].nunique()
            if "ip_address" in data.columns
            else 0
        )

        # Method (most common)
        method = (
            data["method"].mode().iloc[0]
            if "method" in data.columns and len(data["method"].mode()) > 0
            else "ALL"
        )

        return EndpointProfile(
            endpoint=str(endpoint),
            method=method,
            avg_requests_per_minute=avg_rpm,
            peak_requests_per_minute=peak_rpm,
            p95_requests_per_minute=p95_rpm,
            avg_latency_ms=avg_latency,
            error_rate=error_rate,
            unique_users=int(unique_users),
            total_requests=len(data),
            typical_burst_size=typical_burst,
            time_of_day_variance=variance,
        )

    def recommend(
        self,
        endpoint: str,
        tier: str = "default",
        current_limit: Optional[int] = None,
        strategy: Optional[OptimizationStrategy] = None,
    ) -> RateLimitRecommendation:
        """
        Generate rate limit recommendation for an endpoint.

        Args:
            endpoint: Endpoint path
            tier: User tier (default, free, basic, standard, premium, enterprise)
            current_limit: Current rate limit (if any)
            strategy: Override default optimization strategy

        Returns:
            RateLimitRecommendation with suggested limits
        """
        strategy = strategy or self.strategy
        profile = self.endpoint_profiles.get(endpoint)

        # If no profile, use defaults
        if profile is None:
            return self._generate_default_recommendation(
                endpoint, tier, current_limit, strategy
            )

        # Calculate base recommendation
        base_limit = self._calculate_base_limit(profile)

        # Apply tier multiplier
        tier_multiplier = self._get_tier_multiplier(tier)
        tier_adjusted_limit = int(base_limit * tier_multiplier)

        # Apply strategy multiplier
        strategy_multiplier = self.STRATEGY_MULTIPLIERS.get(strategy, 1.0)
        if strategy == OptimizationStrategy.ADAPTIVE:
            strategy_multiplier = self._calculate_adaptive_multiplier(profile)

        recommended_limit = int(tier_adjusted_limit * strategy_multiplier)

        # Calculate burst size
        recommended_burst = self._calculate_burst_size(profile, recommended_limit)

        # Build confidence and reasoning
        confidence = self._calculate_confidence(profile)
        reasoning = self._build_reasoning(
            profile, base_limit, recommended_limit, strategy
        )

        # Generate warnings
        warnings = self._generate_warnings(profile, current_limit, recommended_limit)

        return RateLimitRecommendation(
            endpoint=endpoint,
            tier=tier,
            current_limit=current_limit,
            recommended_limit=recommended_limit,
            recommended_burst=recommended_burst,
            confidence=confidence,
            reasoning=reasoning,
            strategy=strategy,
            warnings=warnings,
            profile=profile,
        )

    def recommend_all(
        self,
        tier: str = "default",
        strategy: Optional[OptimizationStrategy] = None,
    ) -> list[RateLimitRecommendation]:
        """
        Generate recommendations for all profiled endpoints.

        Args:
            tier: User tier to optimize for
            strategy: Override default optimization strategy

        Returns:
            List of recommendations for all endpoints
        """
        return [
            self.recommend(endpoint, tier, strategy=strategy)
            for endpoint in self.endpoint_profiles
        ]

    def _calculate_base_limit(self, profile: EndpointProfile) -> int:
        """Calculate base rate limit from traffic profile."""
        # Use p95 as base with headroom
        headroom_multiplier = 1 + (self.headroom_percent / 100)
        p95_rpm = self._safe_value(profile.p95_requests_per_minute, 10.0)
        base = p95_rpm * headroom_multiplier

        # Ensure minimum viable limit
        base = max(base, 10)

        # Round to nice numbers
        return self._round_to_nice_number(base)

    def _calculate_burst_size(self, profile: EndpointProfile, rate_limit: int) -> int:
        """Calculate recommended burst size."""
        # Base burst on typical burst pattern
        typical_burst = int(self._safe_value(profile.typical_burst_size, 10))

        # At minimum, allow burst equal to rate limit / 6 (10 seconds of requests)
        min_burst = max(10, rate_limit // 6)

        # At maximum, don't exceed rate limit
        max_burst = rate_limit

        # Use typical burst with bounds
        burst = max(min_burst, min(typical_burst * 2, max_burst))

        return self._round_to_nice_number(burst)

    def _get_tier_multiplier(self, tier: str) -> float:
        """Get multiplier for a user tier."""
        tier_multipliers = {
            "free": 0.5,
            "basic": 0.75,
            "default": 1.0,
            "standard": 1.5,
            "premium": 2.5,
            "enterprise": 5.0,
        }
        return tier_multipliers.get(tier.lower(), 1.0)

    def _calculate_adaptive_multiplier(self, profile: EndpointProfile) -> float:
        """Calculate adaptive strategy multiplier based on profile."""
        # Higher variance = more conservative
        # Higher error rate = more conservative
        # Higher latency = more conservative

        # Safely handle potential NaN/None values from pandas
        variance = self._safe_value(profile.time_of_day_variance, 0.0)
        error_rate = self._safe_value(profile.error_rate, 0.0)
        avg_latency = self._safe_value(profile.avg_latency_ms, 0.0)

        variance_factor = max(0.5, 1.0 - variance * 0.3)
        error_factor = max(0.5, 1.0 - error_rate * 2)
        latency_factor = 1.0 if avg_latency < 100 else 0.8

        return variance_factor * error_factor * latency_factor

    def _calculate_confidence(self, profile: EndpointProfile) -> float:
        """Calculate confidence in the recommendation."""
        # More data = more confidence
        total_requests = self._safe_value(profile.total_requests, 0)
        data_confidence = min(1.0, total_requests / 10000) if total_requests > 0 else 0.0

        # Lower variance = more confidence
        variance = self._safe_value(profile.time_of_day_variance, 0.0)
        variance_confidence = max(0.3, 1.0 - variance)

        # Combine factors
        return data_confidence * 0.6 + variance_confidence * 0.4

    def _build_reasoning(
        self,
        profile: EndpointProfile,
        base_limit: int,
        recommended_limit: int,
        strategy: OptimizationStrategy,
    ) -> str:
        """Build explanation for the recommendation."""
        total_requests = int(self._safe_value(profile.total_requests, 0))
        avg_rpm = self._safe_value(profile.avg_requests_per_minute, 0)
        peak_rpm = self._safe_value(profile.peak_requests_per_minute, 0)
        error_rate = self._safe_value(profile.error_rate, 0)

        parts = [
            f"Based on {total_requests:,} historical requests.",
            f"Normal traffic: ~{avg_rpm:.0f} req/min,",
            f"Peak traffic: ~{peak_rpm:.0f} req/min.",
            f"Using {strategy.value} strategy with {self.headroom_percent}% headroom.",
        ]

        if error_rate > 0.05:
            parts.append(
                f"Note: High error rate ({error_rate:.1%}) suggests backend issues."
            )

        return " ".join(parts)

    def _generate_warnings(
        self,
        profile: EndpointProfile,
        current_limit: Optional[int],
        recommended_limit: int,
    ) -> list[str]:
        """Generate warnings for the recommendation."""
        warnings = []

        error_rate = self._safe_value(profile.error_rate, 0)
        variance = self._safe_value(profile.time_of_day_variance, 0)
        total_requests = int(self._safe_value(profile.total_requests, 0))

        # Warn if reducing limit significantly
        if current_limit and recommended_limit < current_limit * 0.7:
            warnings.append(
                f"Recommended limit is significantly lower than current ({current_limit}). "
                "This may affect some users."
            )

        # Warn if high error rate
        if error_rate > 0.1:
            warnings.append(
                f"High error rate ({error_rate:.1%}) detected. "
                "Consider investigating backend issues before adjusting limits."
            )

        # Warn if high variance
        if variance > 0.8:
            warnings.append(
                "Traffic has high time-of-day variance. "
                "Consider time-based rate limits."
            )

        # Warn if limited data
        if total_requests < 1000:
            warnings.append(
                f"Limited historical data ({total_requests} requests). "
                "Recommendation confidence is lower."
            )

        return warnings

    def _generate_default_recommendation(
        self,
        endpoint: str,
        tier: str,
        current_limit: Optional[int],
        strategy: OptimizationStrategy,
    ) -> RateLimitRecommendation:
        """Generate default recommendation when no profile exists."""
        # Map tier to TierLevel
        tier_mapping = {
            "free": TierLevel.FREE,
            "basic": TierLevel.BASIC,
            "default": TierLevel.STANDARD,
            "standard": TierLevel.STANDARD,
            "premium": TierLevel.PREMIUM,
            "enterprise": TierLevel.ENTERPRISE,
        }
        tier_level = tier_mapping.get(tier.lower(), TierLevel.STANDARD)
        config = self.tier_configs[tier_level]

        # Apply strategy
        strategy_multiplier = self.STRATEGY_MULTIPLIERS.get(strategy, 1.0)
        recommended_limit = int(config.base_limit * strategy_multiplier)

        return RateLimitRecommendation(
            endpoint=endpoint,
            tier=tier,
            current_limit=current_limit,
            recommended_limit=recommended_limit,
            recommended_burst=config.get_burst_size(),
            confidence=0.3,  # Low confidence without data
            reasoning=f"No historical data available for endpoint. Using default {tier} tier limits.",
            strategy=strategy,
            warnings=["No traffic data available. Using default tier configuration."],
            profile=None,
        )

    def _round_to_nice_number(self, value: float) -> int:
        """Round to a nice human-friendly number."""
        if value < 10:
            return max(1, int(round(value)))
        elif value < 50:
            return int(round(value / 5) * 5)
        elif value < 100:
            return int(round(value / 10) * 10)
        elif value < 500:
            return int(round(value / 25) * 25)
        elif value < 1000:
            return int(round(value / 50) * 50)
        elif value < 5000:
            return int(round(value / 100) * 100)
        else:
            return int(round(value / 500) * 500)

    def cluster_endpoints(self, n_clusters: int = 5) -> dict[str, list[str]]:
        """
        Cluster endpoints by traffic patterns for group-based rate limiting.

        Args:
            n_clusters: Number of clusters to create

        Returns:
            Dictionary mapping cluster names to endpoint lists
        """
        if not self.endpoint_profiles:
            return {}

        # Build feature matrix
        endpoints = list(self.endpoint_profiles.keys())
        features = []

        for endpoint in endpoints:
            profile = self.endpoint_profiles[endpoint]
            features.append(
                [
                    profile.avg_requests_per_minute,
                    profile.peak_requests_per_minute,
                    profile.avg_latency_ms,
                    profile.error_rate,
                    profile.time_of_day_variance,
                ]
            )

        X = np.array(features)

        # Handle edge cases
        if len(endpoints) < n_clusters:
            n_clusters = max(1, len(endpoints))

        # Scale features
        X_scaled = self.scaler.fit_transform(X)

        # Cluster
        self.endpoint_clusterer = KMeans(n_clusters=n_clusters, random_state=42)
        labels = self.endpoint_clusterer.fit_predict(X_scaled)

        # Group endpoints by cluster
        clusters: dict[str, list[str]] = {f"cluster_{i}": [] for i in range(n_clusters)}
        for endpoint, label in zip(endpoints, labels):
            clusters[f"cluster_{label}"].append(endpoint)

        # Name clusters based on characteristics
        named_clusters = self._name_clusters(clusters)

        return named_clusters

    def _name_clusters(self, clusters: dict[str, list[str]]) -> dict[str, list[str]]:
        """Assign descriptive names to endpoint clusters."""
        named = {}

        for cluster_id, endpoints in clusters.items():
            if not endpoints:
                continue

            # Calculate cluster characteristics
            avg_rpm = np.mean(
                [
                    self.endpoint_profiles[e].avg_requests_per_minute
                    for e in endpoints
                    if e in self.endpoint_profiles
                ]
            )
            avg_latency = np.mean(
                [
                    self.endpoint_profiles[e].avg_latency_ms
                    for e in endpoints
                    if e in self.endpoint_profiles
                ]
            )

            # Assign name based on characteristics
            if avg_rpm > 100:
                if avg_latency > 200:
                    name = "high_traffic_slow"
                else:
                    name = "high_traffic_fast"
            elif avg_rpm > 10:
                name = "medium_traffic"
            else:
                if avg_latency > 500:
                    name = "low_traffic_slow"
                else:
                    name = "low_traffic"

            # Ensure unique names
            base_name = name
            counter = 1
            while name in named:
                name = f"{base_name}_{counter}"
                counter += 1

            named[name] = endpoints

        return named

    def save(self, path: str | Path) -> None:
        """Save optimizer state to disk."""
        path = Path(path)
        path.mkdir(parents=True, exist_ok=True)

        state = {
            "strategy": self.strategy.value,
            "headroom_percent": self.headroom_percent,
            "endpoint_profiles": {
                k: v.to_dict() for k, v in self.endpoint_profiles.items()
            },
            "training_timestamp": (
                self.training_timestamp.isoformat() if self.training_timestamp else None
            ),
            "is_trained": self.is_trained,
        }

        joblib.dump(state, path / "optimizer_state.joblib")

        if self.endpoint_clusterer:
            joblib.dump(self.endpoint_clusterer, path / "clusterer.joblib")
            joblib.dump(self.scaler, path / "scaler.joblib")

        logger.info(f"Optimizer state saved to {path}")

    @classmethod
    def load(cls, path: str | Path) -> "RateLimitOptimizer":
        """Load optimizer state from disk."""
        path = Path(path)

        state = joblib.load(path / "optimizer_state.joblib")

        optimizer = cls(
            strategy=OptimizationStrategy(state["strategy"]),
            headroom_percent=state["headroom_percent"],
        )

        # Restore profiles
        for endpoint, profile_dict in state["endpoint_profiles"].items():
            optimizer.endpoint_profiles[endpoint] = EndpointProfile(
                endpoint=profile_dict["endpoint"],
                method=profile_dict.get("method", "ALL"),
                avg_requests_per_minute=profile_dict["avg_requests_per_minute"],
                peak_requests_per_minute=profile_dict["peak_requests_per_minute"],
                p95_requests_per_minute=profile_dict["p95_requests_per_minute"],
                avg_latency_ms=profile_dict["avg_latency_ms"],
                error_rate=profile_dict["error_rate"],
                unique_users=profile_dict["unique_users"],
                total_requests=profile_dict["total_requests"],
                typical_burst_size=profile_dict["typical_burst_size"],
                time_of_day_variance=profile_dict["time_of_day_variance"],
            )

        optimizer.training_timestamp = (
            datetime.fromisoformat(state["training_timestamp"])
            if state["training_timestamp"]
            else None
        )
        optimizer.is_trained = state["is_trained"]

        # Load clusterer if exists
        clusterer_path = path / "clusterer.joblib"
        if clusterer_path.exists():
            optimizer.endpoint_clusterer = joblib.load(clusterer_path)
            optimizer.scaler = joblib.load(path / "scaler.joblib")

        logger.info(f"Optimizer state loaded from {path}")

        return optimizer

    def get_optimizer_info(self) -> dict[str, Any]:
        """Get optimizer information and statistics."""
        return {
            "is_trained": self.is_trained,
            "training_timestamp": (
                self.training_timestamp.isoformat() if self.training_timestamp else None
            ),
            "strategy": self.strategy.value,
            "headroom_percent": self.headroom_percent,
            "endpoint_count": len(self.endpoint_profiles),
            "endpoints": list(self.endpoint_profiles.keys()),
        }
