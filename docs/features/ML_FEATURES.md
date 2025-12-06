# Machine Learning Features

## Overview

Aegis integrates machine learning models to enhance traffic management through anomaly detection and intelligent rate limit optimization. The ML component runs as a separate Python service, exposing predictions via REST API.

## Architecture

```
┌────────────────────────────────────────────────────┐
│              Aegis Gateway (Node.js)               │
│  ┌──────────────────────────────────────────────┐  │
│  │     ML Middleware (src/ml/middleware.ts)     │  │
│  │  - Enriches requests with ML predictions    │  │
│  │  - Async calls (non-blocking)                │  │
│  └──────────────────┬───────────────────────────┘  │
│                     │ HTTP REST API                │
│                     │                              │
└─────────────────────┼──────────────────────────────┘
                      │
                      │
┌─────────────────────▼──────────────────────────────┐
│          ML API Service (aegis-ml/)                │
│  ┌──────────────────────────────────────────────┐  │
│  │  Flask API (api/flask_server.py)             │  │
│  │  - POST /predict/anomaly                     │  │
│  │  - POST /optimize/rate-limit                 │  │
│  └──────────────────┬───────────────────────────┘  │
│                     │                              │
│  ┌──────────────────▼───────────────────────────┐  │
│  │  Models (models/)                            │  │
│  │  - AnomalyDetector (Isolation Forest)       │  │
│  │  - RateLimitOptimizer (RL + Forecasting)    │  │
│  └──────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────┘
```

---

## Feature 1: Anomaly Detection

### What It Does

Detects unusual traffic patterns that may indicate:
- **DDoS attacks**: Sudden spike in requests from single IP
- **Bot traffic**: Non-human request patterns
- **Security breaches**: Abnormal access patterns
- **System bugs**: Client retry loops

### How It Works

**1. Feature Engineering**

Extract features from request metrics:
```python
features = [
    request_rate,      # Requests per second
    avg_latency,       # Average response time
    error_rate,        # % of failed requests
    unique_paths,      # Number of distinct endpoints
    payload_size       # Average request body size
]
```

**2. Isolation Forest Algorithm**

```python
from sklearn.ensemble import IsolationForest

class AnomalyDetector:
    def __init__(self):
        self.model = IsolationForest(
            n_estimators=100,       # Number of trees
            contamination=0.01,     # Expected % of anomalies
            random_state=42
        )

    def train(self, normal_traffic):
        """
        Train on historical normal traffic patterns
        normal_traffic: 2D array of [features] per time window
        """
        self.model.fit(normal_traffic)

    def predict(self, current_features):
        """
        Returns: 1 (normal) or -1 (anomaly)
        """
        return self.model.predict([current_features])[0]

    def score(self, current_features):
        """
        Returns: Anomaly score (0-1, higher = more anomalous)
        """
        # decision_function returns negative for anomalies
        raw_score = self.model.decision_function([current_features])[0]
        # Normalize to 0-1 range
        normalized = 1 / (1 + np.exp(raw_score))
        return normalized
```

**Why Isolation Forest**:
- Efficient for high-dimensional data
- Doesn't require labeled anomalies for training
- Robust to noise
- Fast predictions (<1ms)

**3. Training**

Export training data from PostgreSQL:
```bash
python aegis-ml/scripts/export_training_data.py --days 30 --output training_data.csv
```

Training script:
```python
import pandas as pd
from models.anomaly_detector import AnomalyDetector

# Load historical data (30 days of normal traffic)
df = pd.read_csv('training_data.csv')

# Extract features
features = df[['request_rate', 'avg_latency', 'error_rate', 'unique_paths', 'payload_size']]

# Train model
detector = AnomalyDetector()
detector.train(features.values)

# Save model
detector.save('models/anomaly_detector.pkl')
```

**4. Inference**

Gateway calls ML API:
```typescript
// src/ml/client.ts
export async function detectAnomaly(metrics: Metrics): Promise<number> {
  const response = await fetch('http://ml-api:5001/predict/anomaly', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      metrics: [
        metrics.requestRate,
        metrics.avgLatency,
        metrics.errorRate,
        metrics.uniquePaths,
        metrics.payloadSize
      ]
    })
  });

  const data = await response.json();
  return data.score; // 0-1 anomaly score
}
```

ML API endpoint:
```python
@app.route('/predict/anomaly', methods=['POST'])
def predict_anomaly():
    data = request.json
    features = np.array(data['metrics']).reshape(1, -1)

    score = detector.score(features)
    is_anomaly = score > 0.7  # Threshold

    return jsonify({
        'score': float(score),
        'is_anomaly': bool(is_anomaly),
        'features': data['metrics']
    })
```

### Integration

**ML Middleware** (`src/ml/middleware.ts`):
```typescript
export function mlMiddleware(mlClient: MLClient) {
  return async (req, res, next) => {
    // Collect metrics for current window
    const metrics = await collector.getRecentMetrics('1m');

    // Get anomaly score (async, non-blocking)
    const anomalyPromise = mlClient.detectAnomaly(metrics);

    // Attach score to request context
    anomalyPromise.then(score => {
      req.anomalyScore = score;

      // Log high anomaly scores
      if (score > 0.8) {
        logger.warn('High anomaly score detected', {
          score,
          clientIp: req.ip,
          path: req.path
        });
      }

      // Trigger alert if critical
      if (score > 0.9) {
        alertManager.sendAlert({
          name: 'CriticalAnomaly',
          message: `Anomaly score: ${score}`,
          severity: 'critical'
        });
      }
    }).catch(err => {
      logger.error('ML prediction failed', { error: err });
    });

    // Don't block request on ML prediction
    next();
  };
}
```

### Use Cases

**1. DDoS Detection**

Detect sudden traffic spikes:
```
Normal:   100 req/s, latency 50ms, error rate 1%
Anomaly:  10,000 req/s, latency 500ms, error rate 20%
          → Anomaly score: 0.95 (DDoS attack detected)
```

Action: Automatically trigger rate limiting or IP blocking.

**2. Bot Traffic**

Detect non-human patterns:
```
Normal:   Random paths, varied user agents, normal timing
Anomaly:  Sequential paths (/page1, /page2, ...), same user agent, rapid requests
          → Anomaly score: 0.82 (bot detected)
```

Action: Require CAPTCHA or block IP.

**3. Account Takeover**

Detect abnormal user behavior:
```
Normal:   User123 from NYC, login frequency 1/day
Anomaly:  User123 from Russia, login frequency 50/hour, different device
          → Anomaly score: 0.91 (potential account takeover)
```

Action: Trigger 2FA or lock account.

---

## Feature 2: Rate Limit Optimization

### What It Does

Automatically tunes rate limits based on:
- Historical traffic patterns
- Error rates at different limits
- Resource utilization
- Business objectives (maximize throughput vs. minimize errors)

### How It Works

**1. Data Collection**

Collect metrics at various rate limit settings:
```python
training_data = [
    {'limit': 100, 'throughput': 95, 'error_rate': 0.01, 'p95_latency': 50},
    {'limit': 200, 'throughput': 180, 'error_rate': 0.05, 'p95_latency': 120},
    {'limit': 300, 'throughput': 250, 'error_rate': 0.15, 'p95_latency': 300},
    # Higher limits → more throughput but higher error rate/latency
]
```

**2. Reinforcement Learning**

Model finds optimal limit that maximizes reward:
```python
reward = throughput - (error_rate * 1000) - (p95_latency / 100)
```

**3. Time-Series Forecasting**

Predict future traffic to adjust limits proactively:
```python
from statsmodels.tsa.arima.model import ARIMA

class RateLimitOptimizer:
    def forecast_traffic(self, historical_traffic):
        """
        Forecast next hour's traffic based on last 7 days
        """
        model = ARIMA(historical_traffic, order=(1, 1, 1))
        fitted = model.fit()
        forecast = fitted.forecast(steps=60)  # Next 60 minutes
        return forecast

    def optimize_limit(self, forecast, current_limit):
        """
        Adjust rate limit based on forecasted traffic
        """
        # If forecast shows spike, increase limit preemptively
        if forecast.max() > current_limit * 0.9:
            recommended_limit = int(forecast.max() * 1.2)
        else:
            recommended_limit = current_limit

        return recommended_limit
```

### Integration

**Optimization endpoint** (`POST /optimize/rate-limit`):
```python
@app.route('/optimize/rate-limit', methods=['POST'])
def optimize_rate_limit():
    data = request.json
    endpoint = data['endpoint']
    historical_data = data['historical_data']

    # Forecast traffic
    forecast = optimizer.forecast_traffic(historical_data)

    # Get current limit
    current_limit = config.get_limit(endpoint)

    # Optimize
    recommended_limit = optimizer.optimize_limit(forecast, current_limit)

    return jsonify({
        'endpoint': endpoint,
        'current_limit': current_limit,
        'recommended_limit': recommended_limit,
        'forecast': forecast.tolist(),
        'confidence': 0.85
    })
```

**Gateway integration**:
```typescript
// Run optimization daily
cron.schedule('0 0 * * *', async () => {
  const endpoints = config.gateway.routes.map(r => r.path);

  for (const endpoint of endpoints) {
    // Get historical data (last 7 days)
    const data = await db.query(`
      SELECT
        DATE_TRUNC('hour', timestamp) as hour,
        COUNT(*) as requests
      FROM request_metrics
      WHERE path = $1 AND timestamp > NOW() - INTERVAL '7 days'
      GROUP BY hour
      ORDER BY hour
    `, [endpoint]);

    // Call ML API
    const result = await mlClient.optimizeRateLimit(endpoint, data);

    // Update config if recommendation differs significantly
    if (Math.abs(result.recommended_limit - result.current_limit) > 10) {
      logger.info('Updating rate limit', {
        endpoint,
        old: result.current_limit,
        new: result.recommended_limit
      });

      await config.updateRateLimit(endpoint, result.recommended_limit);
    }
  }
});
```

### Use Cases

**1. Handling Traffic Spikes**

```
Historical pattern: 100 req/min (9am-5pm weekdays)
Forecast: 500 req/min (Black Friday sale at 12pm)

Action: Increase limit from 100 to 600 at 11:30am
Result: No user-facing errors during spike
```

**2. Resource Optimization**

```
Current limit: 1000 req/min
Actual usage: 200 req/min (80% idle capacity)

Action: Reduce limit to 300 req/min
Result: Free up Redis/CPU for other services
```

**3. Error Reduction**

```
Current limit: 500 req/min
Observed error rate: 10% (too high)

ML analysis: Optimal limit = 350 req/min (2% error rate)

Action: Reduce limit to 350
Result: Better user experience (fewer errors)
```

---

## Training & Deployment

### Training Pipeline

**1. Export data**:
```bash
python aegis-ml/scripts/export_training_data.py \
  --start-date 2024-01-01 \
  --end-date 2024-01-31 \
  --output data/training.csv
```

**2. Generate synthetic data** (for testing):
```bash
python aegis-ml/scripts/generate_synthetic_data.py \
  --samples 10000 \
  --anomaly-rate 0.01 \
  --output data/synthetic.csv
```

**3. Train models**:
```bash
# Anomaly detector
python aegis-ml/models/train_anomaly_detector.py --input data/training.csv

# Rate limit optimizer
python aegis-ml/models/train_rate_limit_optimizer.py --input data/training.csv
```

**4. Test models**:
```bash
pytest aegis-ml/tests/
```

**5. Deploy**:
```bash
docker build -t aegis-ml:latest aegis-ml/
docker run -p 5001:5001 aegis-ml:latest
```

### Model Versioning

**Save models with timestamps**:
```python
import pickle
from datetime import datetime

timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
filename = f'models/anomaly_detector_{timestamp}.pkl'

with open(filename, 'wb') as f:
    pickle.dump(detector, f)

# Symlink to latest
os.symlink(filename, 'models/anomaly_detector_latest.pkl')
```

**Load latest model**:
```python
with open('models/anomaly_detector_latest.pkl', 'rb') as f:
    detector = pickle.load(f)
```

---

## Configuration

**ML settings** (`config/aegis.config.yaml`):
```yaml
ml:
  enabled: true
  endpoint: "http://ml-api:5001"

  anomalyDetection:
    enabled: true
    threshold: 0.7  # Score > 0.7 = anomaly
    alertThreshold: 0.9  # Score > 0.9 = critical alert

  rateLimitOptimization:
    enabled: true
    schedule: "0 0 * * *"  # Daily at midnight
    minChangeThreshold: 10  # Don't update if diff < 10 req/min
```

---

## Monitoring ML Performance

### Metrics to Track

**1. Prediction Latency**:
```typescript
const start = Date.now();
const score = await mlClient.detectAnomaly(metrics);
const latency = Date.now() - start;

logger.info('ML prediction latency', { latency });
```

**2. False Positives**:
```sql
SELECT
  COUNT(*) FILTER (WHERE anomaly_score > 0.7 AND actual_anomaly = false) AS false_positives,
  COUNT(*) FILTER (WHERE anomaly_score <= 0.7 AND actual_anomaly = true) AS false_negatives
FROM ml_predictions;
```

**3. Model Accuracy**:
```python
from sklearn.metrics import accuracy_score, precision_score, recall_score

y_true = [0, 0, 1, 0, 1]  # Actual labels
y_pred = detector.predict(X_test)

accuracy = accuracy_score(y_true, y_pred)
precision = precision_score(y_true, y_pred)
recall = recall_score(y_true, y_pred)
```

### Dashboards

**ML metrics endpoint** (`GET /api/ml/metrics`):
```json
{
  "anomalyDetection": {
    "predictionsTotal": 10000,
    "anomaliesDetected": 150,
    "avgLatency": 1.2,
    "accuracy": 0.95
  },
  "rateLimitOptimization": {
    "optimizationsTotal": 30,
    "avgImprovement": 15.5,
    "lastRun": "2024-01-15T00:00:00Z"
  }
}
```

---

## Best Practices

### 1. Retrain Regularly

Traffic patterns change over time:
```bash
# Weekly retraining cron job
0 0 * * 0 python aegis-ml/models/train_anomaly_detector.py
```

### 2. A/B Testing

Test new models before full deployment:
```python
# Route 10% of traffic to new model
if random.random() < 0.1:
    score = new_detector.score(features)
else:
    score = old_detector.score(features)
```

### 3. Fallback on Failure

If ML API is down, continue without ML:
```typescript
try {
  const score = await mlClient.detectAnomaly(metrics);
} catch (error) {
  logger.error('ML API unavailable', { error });
  // Continue without anomaly detection
}
```

### 4. Feature Monitoring

Track feature distributions to detect drift:
```python
import matplotlib.pyplot as plt

# Plot feature distribution over time
plt.hist(request_rates_week1, alpha=0.5, label='Week 1')
plt.hist(request_rates_week2, alpha=0.5, label='Week 2')
plt.legend()
plt.savefig('feature_drift.png')
```

If distributions shift significantly, retrain model.

---

## Troubleshooting

### Issue: High false positive rate

**Symptoms**: Normal traffic flagged as anomalous

**Causes**:
1. Threshold too low (e.g., 0.5 instead of 0.7)
2. Model trained on insufficient data
3. Traffic patterns changed (model outdated)

**Solutions**:
1. Increase threshold: `anomalyDetection.threshold: 0.8`
2. Retrain with more data (30+ days)
3. Schedule regular retraining

---

### Issue: ML predictions too slow

**Symptoms**: ML API latency > 100ms

**Causes**:
1. Model too complex (too many trees in Isolation Forest)
2. Feature computation expensive
3. ML API overloaded

**Solutions**:
1. Reduce `n_estimators` in Isolation Forest
2. Cache feature computations
3. Scale ML API horizontally (more instances)

---

## Future Enhancements

1. **Deep Learning**: LSTM for time-series forecasting
2. **Graph Neural Networks**: Detect coordinated attacks
3. **AutoML**: Automated hyperparameter tuning
4. **Explainability**: SHAP values for anomaly explanations
5. **Online Learning**: Update models in real-time

---

## References

- [Isolation Forest Paper](https://cs.nju.edu.cn/zhouzh/zhouzh.files/publication/icdm08b.pdf)
- [Scikit-learn Docs](https://scikit-learn.org/stable/)
- [Time Series Forecasting](https://otexts.com/fpp2/)
- [Reinforcement Learning](https://www.andrew.cmu.edu/course/10-703/)

For more details, see:
- [ARCHITECTURE.md](../ARCHITECTURE.md) - ML component architecture
- [CODE_GUIDE.md](../CODE_GUIDE.md) - ML code explanations
- [MONITORING.md](./MONITORING.md) - ML metrics dashboards
