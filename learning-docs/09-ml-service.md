# 09. ML Service

## Overview

AEGIS includes a Python-based Machine Learning service that provides intelligent features:
- **Anomaly Detection**: Identify unusual traffic patterns
- **Rate Limit Optimization**: Recommend optimal rate limits based on traffic analysis

---

## 📁 ML Service Structure

```
aegis-ml/
├── Dockerfile           # Container build configuration
├── requirements.txt     # Python dependencies
├── pytest.ini           # Test configuration
├── api/
│   ├── __init__.py
│   └── flask_server.py  # REST API server
├── models/
│   ├── __init__.py
│   ├── anomaly_detector.py    # Anomaly detection model
│   └── rate_limit_optimizer.py # Rate limit optimizer
├── scripts/
│   ├── export_training_data.py
│   └── generate_synthetic_data.py
├── tests/
│   └── ...
└── data/
    └── models/          # Saved model files
```

---

## 🔍 Anomaly Detection

### `aegis-ml/models/anomaly_detector.py`

The `AnomalyDetector` uses Isolation Forest and statistical methods to detect anomalies.

### Anomaly Types

```python
class AnomalyType(Enum):
    TRAFFIC_SPIKE = "traffic_spike"       # Sudden increase in RPS
    LATENCY_SPIKE = "latency_spike"       # Slow response times
    ERROR_RATE_SPIKE = "error_rate_spike" # Increased failures
    TRAFFIC_DROP = "traffic_drop"         # Unusual drop in traffic
    PATTERN_ANOMALY = "pattern_anomaly"   # Unusual behavior pattern
    MULTI_DIMENSIONAL = "multi_dimensional" # Multiple factors combined
```

### Severity Levels

```python
class AnomalySeverity(Enum):
    LOW = "low"           # Minor deviation, likely noise
    MEDIUM = "medium"     # Notable deviation, worth monitoring
    HIGH = "high"         # Significant deviation, investigate
    CRITICAL = "critical" # Severe deviation, immediate attention
```

### Training the Model

```python
class AnomalyDetector:
    FEATURE_NAMES = [
        'requests_per_second',
        'avg_latency_ms',
        'p95_latency_ms',
        'p99_latency_ms',
        'error_rate'
    ]

    def __init__(
        self,
        contamination: float = 0.1,
        n_estimators: int = 100,
        random_state: int = 42,
        threshold_multiplier: float = 2.0
    ):
        self.contamination = contamination
        self.model = IsolationForest(
            contamination=contamination,
            n_estimators=n_estimators,
            random_state=random_state,
            max_features=1.0,
            bootstrap=True
        )
        self.scaler = StandardScaler()
        self.baselines: dict = {}
        self.is_trained = False

    def train(self, data: pd.DataFrame | list[TrafficMetrics]) -> dict:
        """Train the anomaly detection model on historical data."""

        # Convert to DataFrame if needed
        if isinstance(data, list):
            data = pd.DataFrame([m.to_feature_array() for m in data],
                               columns=self.FEATURE_NAMES)

        # Ensure we have required columns
        df = data[self.FEATURE_NAMES].dropna()

        if len(df) < 100:
            raise ValueError("Need at least 100 samples for training")

        # Scale features
        X = self.scaler.fit_transform(df)

        # Train Isolation Forest
        self.model.fit(X)

        # Compute statistical baselines
        self._compute_baselines(df)

        self.is_trained = True

        return {
            "samples_used": len(df),
            "features": self.FEATURE_NAMES,
            "baselines": self.baselines
        }
```

### Computing Baselines

```python
def _compute_baselines(self, df: pd.DataFrame):
    """Compute statistical baselines for each feature."""
    for feature in self.FEATURE_NAMES:
        values = df[feature].values
        self.baselines[feature] = {
            'mean': float(np.mean(values)),
            'std': float(np.std(values)),
            'median': float(np.median(values)),
            'p95': float(np.percentile(values, 95)),
            'p99': float(np.percentile(values, 99)),
            'min': float(np.min(values)),
            'max': float(np.max(values))
        }
```

### Detecting Anomalies

```python
def detect(self, metrics: TrafficMetrics | dict) -> AnomalyResult:
    """Detect if given metrics represent an anomaly."""

    if not self.is_trained:
        raise RuntimeError("Model not trained. Call train() first.")

    # Convert to TrafficMetrics if dict
    if isinstance(metrics, dict):
        metrics = TrafficMetrics.from_dict(metrics)

    # Prepare features
    features = np.array([metrics.to_feature_array()])
    X = self.scaler.transform(features)

    # Get Isolation Forest score
    # Negative scores indicate anomalies
    raw_score = self.model.decision_function(X)[0]
    normalized_score = self._normalize_score(raw_score)

    # Predict (-1 for anomaly, 1 for normal)
    prediction = self.model.predict(X)[0]
    is_anomaly = prediction == -1

    # Identify specific anomaly type
    anomaly_type, type_confidence = self._identify_anomaly_type(metrics)

    # Determine severity
    severity = self._determine_severity(normalized_score) if is_anomaly else None

    # Calculate overall confidence
    confidence = self._calculate_confidence(raw_score, type_confidence)

    # Generate explanation
    explanation = self._generate_explanation(
        metrics, is_anomaly, anomaly_type, severity
    )

    return AnomalyResult(
        is_anomaly=is_anomaly,
        score=raw_score,
        normalized_score=normalized_score,
        anomaly_type=anomaly_type if is_anomaly else None,
        severity=severity,
        confidence=confidence,
        features=dict(zip(self.FEATURE_NAMES, metrics.to_feature_array())),
        explanation=explanation
    )
```

### Identifying Anomaly Type

```python
def _identify_anomaly_type(self, metrics: TrafficMetrics) -> tuple[AnomalyType, float]:
    """Identify the specific type of anomaly based on feature analysis."""

    z_scores = {}
    anomaly_factors = {}

    # Calculate z-scores for each feature
    for feature in self.FEATURE_NAMES:
        baseline = self.baselines[feature]
        value = getattr(metrics, feature.replace('_ms', 'Ms').replace('_', ''))
        z_scores[feature] = self._compute_z_score(
            value, baseline['mean'], baseline['std']
        )

    # Determine primary anomaly type based on z-scores
    rps_z = z_scores['requests_per_second']
    latency_z = z_scores['avg_latency_ms']
    error_z = z_scores['error_rate']

    # Traffic spike: High RPS z-score
    if rps_z > 2.5:
        anomaly_factors[AnomalyType.TRAFFIC_SPIKE] = rps_z

    # Traffic drop: Negative RPS z-score
    if rps_z < -2.5:
        anomaly_factors[AnomalyType.TRAFFIC_DROP] = abs(rps_z)

    # Latency spike: High latency z-score
    if latency_z > 2.0:
        anomaly_factors[AnomalyType.LATENCY_SPIKE] = latency_z

    # Error rate spike: High error z-score
    if error_z > 2.0:
        anomaly_factors[AnomalyType.ERROR_RATE_SPIKE] = error_z

    # Multi-dimensional: Multiple factors
    if len(anomaly_factors) > 1:
        return AnomalyType.MULTI_DIMENSIONAL, max(anomaly_factors.values())

    if anomaly_factors:
        primary_type = max(anomaly_factors, key=anomaly_factors.get)
        return primary_type, anomaly_factors[primary_type]

    # Default to pattern anomaly
    return AnomalyType.PATTERN_ANOMALY, 0.5
```

### Determining Severity

```python
def _determine_severity(self, normalized_score: float) -> AnomalySeverity:
    """Determine anomaly severity based on normalized score."""
    if normalized_score >= 0.9:
        return AnomalySeverity.CRITICAL
    elif normalized_score >= 0.75:
        return AnomalySeverity.HIGH
    elif normalized_score >= 0.5:
        return AnomalySeverity.MEDIUM
    else:
        return AnomalySeverity.LOW
```

---

## ⚡ Rate Limit Optimizer

### `aegis-ml/models/rate_limit_optimizer.py`

The optimizer analyzes traffic patterns to recommend optimal rate limits.

### Optimization Strategies

```python
class OptimizationStrategy(Enum):
    CONSERVATIVE = "conservative"  # Lower limits, prioritize safety
    BALANCED = "balanced"          # Balance between safety and throughput
    PERMISSIVE = "permissive"      # Higher limits, maximize throughput
    ADAPTIVE = "adaptive"          # Adjust based on patterns
```

### Tier Configurations

```python
DEFAULT_TIER_CONFIGS = {
    TierLevel.FREE: TierConfiguration(TierLevel.FREE, 60, 1.2, 100, 10),
    TierLevel.BASIC: TierConfiguration(TierLevel.BASIC, 100, 1.5, 300, 30),
    TierLevel.STANDARD: TierConfiguration(TierLevel.STANDARD, 300, 1.5, 1000, 100),
    TierLevel.PREMIUM: TierConfiguration(TierLevel.PREMIUM, 1000, 2.0, 5000, 300),
    TierLevel.ENTERPRISE: TierConfiguration(TierLevel.ENTERPRISE, 5000, 2.5, 50000, 1000),
}
```

### Analyzing Traffic

```python
class RateLimitOptimizer:
    def analyze_traffic(
        self,
        data: pd.DataFrame,
        time_column: str = "timestamp"
    ) -> dict[str, EndpointProfile]:
        """Analyze historical traffic data to build endpoint profiles."""

        # Group by endpoint
        endpoint_col = 'endpoint' if 'endpoint' in data.columns else 'path'

        profiles = {}
        for endpoint in data[endpoint_col].unique():
            endpoint_data = data[data[endpoint_col] == endpoint]
            profiles[endpoint] = self._build_endpoint_profile(endpoint, endpoint_data)

        self.endpoint_profiles = profiles
        return profiles

    def _build_endpoint_profile(
        self,
        endpoint: str,
        data: pd.DataFrame
    ) -> EndpointProfile:
        """Build traffic profile for a single endpoint."""

        # Resample to per-minute buckets
        data = data.set_index('timestamp')
        per_minute = data.resample('1T').size()

        return EndpointProfile(
            endpoint=endpoint,
            avg_requests_per_minute=per_minute.mean(),
            peak_requests_per_minute=per_minute.max(),
            p95_requests_per_minute=per_minute.quantile(0.95),
            p99_requests_per_minute=per_minute.quantile(0.99),
            error_rate=self._calculate_error_rate(data),
            total_requests=len(data),
            typical_burst_size=self._calculate_burst_size(per_minute),
            time_of_day_variance=per_minute.std() / per_minute.mean()
        )
```

### Recommending Limits

```python
def recommend(
    self,
    endpoint: str,
    tier: TierLevel = TierLevel.STANDARD,
    current_limit: int | None = None,
    strategy: OptimizationStrategy = OptimizationStrategy.BALANCED
) -> RateLimitRecommendation:
    """Get rate limit recommendation for an endpoint."""

    profile = self.endpoint_profiles.get(endpoint)
    tier_config = self.tier_configs.get(tier, self.tier_configs[TierLevel.STANDARD])

    if not profile:
        # No data - use tier defaults
        return RateLimitRecommendation(
            endpoint=endpoint,
            tier=tier.value,
            current_limit=current_limit,
            recommended_limit=tier_config.base_limit,
            recommended_burst=tier_config.get_burst_size(),
            confidence=0.3,
            reasoning="No traffic data available; using tier defaults"
        )

    # Calculate base recommendation from traffic data
    base_limit = self._calculate_base_limit(profile, strategy)

    # Apply headroom
    headroom_factor = 1 + (self.headroom_percent / 100)
    recommended = int(base_limit * headroom_factor)

    # Apply tier constraints
    recommended = max(tier_config.min_limit,
                     min(recommended, tier_config.max_limit))

    # Calculate burst size
    burst = self._calculate_burst(profile, recommended, tier_config)

    # Calculate confidence
    confidence = self._calculate_confidence(profile)

    # Generate reasoning
    reasoning = self._generate_reasoning(
        profile, recommended, current_limit, strategy
    )

    return RateLimitRecommendation(
        endpoint=endpoint,
        tier=tier.value,
        current_limit=current_limit,
        recommended_limit=recommended,
        recommended_burst=burst,
        confidence=confidence,
        reasoning=reasoning,
        profile=profile
    )

def _calculate_base_limit(
    self,
    profile: EndpointProfile,
    strategy: OptimizationStrategy
) -> float:
    """Calculate base rate limit from traffic profile."""

    if strategy == OptimizationStrategy.CONSERVATIVE:
        # Use P95 as base
        return profile.p95_requests_per_minute

    elif strategy == OptimizationStrategy.BALANCED:
        # Use P99 as base
        return profile.p99_requests_per_minute

    elif strategy == OptimizationStrategy.PERMISSIVE:
        # Use peak with headroom
        return profile.peak_requests_per_minute * 1.5

    elif strategy == OptimizationStrategy.ADAPTIVE:
        # Consider variance
        if profile.time_of_day_variance > 1.5:
            # High variance - use higher limit
            return profile.peak_requests_per_minute * 1.2
        else:
            # Low variance - use P99
            return profile.p99_requests_per_minute

    return profile.p99_requests_per_minute
```

### Endpoint Clustering

Group similar endpoints for group-based rate limiting:

```python
def cluster_endpoints(self, n_clusters: int = 5) -> dict[str, list[str]]:
    """Cluster endpoints by traffic characteristics."""

    if not self.endpoint_profiles:
        raise ValueError("No endpoint profiles. Call analyze_traffic first.")

    # Prepare feature matrix
    features = []
    endpoints = []

    for endpoint, profile in self.endpoint_profiles.items():
        features.append([
            profile.avg_requests_per_minute,
            profile.peak_requests_per_minute,
            profile.error_rate,
            profile.time_of_day_variance
        ])
        endpoints.append(endpoint)

    # Scale and cluster
    X = self.scaler.fit_transform(features)
    kmeans = KMeans(n_clusters=min(n_clusters, len(endpoints)))
    labels = kmeans.fit_predict(X)

    # Group endpoints by cluster
    clusters = {}
    for endpoint, label in zip(endpoints, labels):
        cluster_name = self._name_cluster(label, kmeans.cluster_centers_[label])
        if cluster_name not in clusters:
            clusters[cluster_name] = []
        clusters[cluster_name].append(endpoint)

    return clusters

def _name_cluster(self, label: int, center: np.array) -> str:
    """Assign descriptive name to a cluster."""

    avg_rps, peak_rps, error_rate, variance = center

    if avg_rps > 100:
        traffic = "high_traffic"
    elif avg_rps > 10:
        traffic = "medium_traffic"
    else:
        traffic = "low_traffic"

    if error_rate > 0.05:
        reliability = "_error_prone"
    else:
        reliability = ""

    return f"{traffic}{reliability}"
```

---

## 🌐 Flask REST API

### `aegis-ml/api/flask_server.py`

```python
from flask import Flask, request, jsonify
from flask_cors import CORS

app = Flask(__name__)
CORS(app)

# Global model instances
anomaly_detector: Optional[AnomalyDetector] = None
rate_optimizer: Optional[RateLimitOptimizer] = None


@app.route('/health', methods=['GET'])
def health_check():
    """Health check endpoint."""
    return jsonify({
        "success": True,
        "data": {
            "status": "healthy",
            "models": {
                "anomaly_detector": {
                    "loaded": anomaly_detector is not None,
                    "trained": anomaly_detector.is_trained if anomaly_detector else False
                },
                "rate_optimizer": {
                    "loaded": rate_optimizer is not None,
                    "trained": rate_optimizer.is_trained if rate_optimizer else False
                }
            }
        }
    })


@app.route('/detect', methods=['POST'])
@require_trained_model
def detect_anomaly():
    """Detect if given metrics represent an anomaly."""
    data = request.get_json()

    result = anomaly_detector.detect(data)

    return jsonify({
        "success": True,
        "data": result.to_dict()
    })


@app.route('/optimize', methods=['POST'])
def optimize_rate_limit():
    """Get rate limit recommendation for an endpoint."""
    data = request.get_json()

    endpoint = data.get('endpoint', '/api/default')
    tier = data.get('tier', 'default')
    strategy = data.get('strategy', 'balanced')
    current_limit = data.get('current_limit')

    recommendation = rate_optimizer.recommend(
        endpoint=endpoint,
        tier=TierLevel(tier) if tier in TierLevel.__members__ else TierLevel.STANDARD,
        current_limit=current_limit,
        strategy=OptimizationStrategy(strategy)
    )

    return jsonify({
        "success": True,
        "data": recommendation.to_dict()
    })


@app.route('/train', methods=['POST'])
def train_models():
    """Train ML models on historical data."""
    data = request.get_json()
    days = data.get('days', 7)
    models = data.get('models', ['anomaly', 'optimizer'])

    results = {}

    # Load training data from database
    training_data = load_training_data(days)

    if 'anomaly' in models:
        global anomaly_detector
        anomaly_detector = AnomalyDetector()
        results['anomaly'] = anomaly_detector.train(training_data)

    if 'optimizer' in models:
        global rate_optimizer
        rate_optimizer = RateLimitOptimizer()
        results['optimizer'] = rate_optimizer.analyze_traffic(training_data)

    return jsonify({
        "success": True,
        "data": results
    })
```

---

## 🔗 Gateway Integration

### `src/ml/client.ts`

TypeScript client for calling ML service:

```typescript
export class MLServiceClient {
  private baseUrl: string;
  private timeout: number;

  constructor(config: MLServiceConfig) {
    this.baseUrl = config.url || 'http://localhost:5000';
    this.timeout = config.timeout || 5000;
  }

  async detectAnomaly(metrics: TrafficMetrics): Promise<AnomalyResult> {
    const response = await fetch(`${this.baseUrl}/detect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(metrics),
      signal: AbortSignal.timeout(this.timeout)
    });

    const data = await response.json();
    return data.data;
  }

  async getOptimization(
    endpoint: string,
    options: OptimizationOptions = {}
  ): Promise<RateLimitRecommendation> {
    const response = await fetch(`${this.baseUrl}/optimize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        endpoint,
        tier: options.tier,
        strategy: options.strategy,
        current_limit: options.currentLimit
      }),
      signal: AbortSignal.timeout(this.timeout)
    });

    const data = await response.json();
    return data.data;
  }

  async healthCheck(): Promise<HealthStatus> {
    const response = await fetch(`${this.baseUrl}/health`);
    const data = await response.json();
    return data.data;
  }
}
```

---

## 🐳 Docker Configuration

### `aegis-ml/Dockerfile`

```dockerfile
FROM python:3.11-slim

WORKDIR /app

# Install dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY . .

# Create directories for data and models
RUN mkdir -p data/models

# Expose Flask port
EXPOSE 5000

# Run Flask server
CMD ["python", "-m", "api.flask_server"]
```

### `aegis-ml/requirements.txt`

```
flask>=2.3.0
flask-cors>=4.0.0
numpy>=1.24.0
pandas>=2.0.0
scikit-learn>=1.3.0
scipy>=1.10.0
joblib>=1.3.0
psycopg2-binary>=2.9.0
```

---

## 🧪 Training with Synthetic Data

### Generate Synthetic Data

```bash
# Via Makefile
make ml-synthetic

# Or directly
curl -X POST http://localhost:5000/generate/synthetic \
  -H "Content-Type: application/json" \
  -d '{
    "duration_hours": 168,
    "base_rps": 50,
    "include_anomalies": true,
    "anomaly_rate": 0.05
  }'
```

### Train Models

```bash
# Train on synthetic data
make ml-train-synthetic

# Train on database data
curl -X POST http://localhost:5000/train \
  -H "Content-Type: application/json" \
  -d '{
    "days": 7,
    "models": ["anomaly", "optimizer"]
  }'
```

---

## 📊 Example API Responses

### Anomaly Detection

```json
{
  "success": true,
  "data": {
    "is_anomaly": true,
    "score": -0.256,
    "normalized_score": 0.78,
    "anomaly_type": "latency_spike",
    "severity": "high",
    "confidence": 0.85,
    "features": {
      "requests_per_second": 150,
      "avg_latency_ms": 450,
      "p95_latency_ms": 800,
      "p99_latency_ms": 1200,
      "error_rate": 0.03
    },
    "explanation": "High latency detected. P95 latency (800ms) is 3.2x higher than baseline (250ms)."
  }
}
```

### Rate Limit Recommendation

```json
{
  "success": true,
  "data": {
    "endpoint": "/api/users",
    "tier": "standard",
    "current_limit": 100,
    "recommended_limit": 180,
    "recommended_burst": 30,
    "confidence": 0.82,
    "reasoning": "Based on traffic analysis: avg 120 req/min, P95 150 req/min. Recommended 180 req/min with 20% headroom.",
    "profile": {
      "avg_requests_per_minute": 120,
      "peak_requests_per_minute": 200,
      "p95_requests_per_minute": 150,
      "error_rate": 0.01
    }
  }
}
```

---

## 🚀 Next Steps

Now that you understand the ML service:
1. [Frontend Dashboard](./10-frontend.md) - See ML insights in the UI
2. [Storage Layer](./11-storage.md) - How metrics data is stored
