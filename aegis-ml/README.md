# AEGIS ML Service

Machine Learning service for anomaly detection and rate limit optimization in the AEGIS API Gateway.

## Features

- **Anomaly Detection**: Uses Isolation Forest algorithm to detect unusual traffic patterns
  - Traffic spikes and drops
  - Latency anomalies
  - Error rate spikes
  - Multi-dimensional pattern anomalies

- **Rate Limit Optimization**: Intelligent rate limit recommendations based on traffic analysis
  - Per-endpoint traffic profiling
  - Tier-based optimization (free, basic, standard, premium, enterprise)
  - Multiple optimization strategies (conservative, balanced, permissive, adaptive)
  - Burst capacity recommendations

- **Real-time Analysis**: Sliding window analysis with trend detection
  - Anomaly persistence tracking
  - Traffic trend analysis (increasing, stable, decreasing)

## Quick Start

### Using Docker

```bash
# Start with Docker Compose (from project root)
docker compose -f docker/docker-compose.yml --profile ml up -d

# Check health
curl http://localhost:5000/health
```

### Local Development

```bash
# Create virtual environment
python -m venv venv
source venv/bin/activate  # On Windows: venv\Scripts\activate

# Install dependencies
pip install -r requirements.txt

# Start the service
python -m api.flask_server

# Or with gunicorn
gunicorn --bind 0.0.0.0:5000 api.flask_server:app
```

## API Endpoints

### Health Check

```bash
GET /health
```

Returns service health status and model information.

### Anomaly Detection

```bash
# Single detection
POST /detect
Content-Type: application/json

{
  "requests_per_second": 100,
  "avg_latency_ms": 50,
  "p95_latency_ms": 100,
  "p99_latency_ms": 150,
  "error_rate": 0.01
}

# Response
{
  "success": true,
  "data": {
    "anomaly": false,
    "score": 0.15,
    "normalized_score": 0.35,
    "anomaly_type": null,
    "severity": null,
    "confidence": 0.85,
    "explanation": "Traffic patterns are within normal parameters."
  }
}
```

```bash
# Batch detection
POST /detect/batch
Content-Type: application/json

{
  "metrics": [
    {"requests_per_second": 100, "avg_latency_ms": 50, ...},
    {"requests_per_second": 500, "avg_latency_ms": 200, ...}
  ]
}
```

```bash
# Get trend analysis
GET /detect/trend
```

### Rate Limit Optimization

```bash
# Get recommendation for endpoint
POST /optimize
Content-Type: application/json

{
  "endpoint": "/api/users",
  "tier": "default",
  "current_limit": 100,
  "strategy": "balanced"
}

# Response
{
  "success": true,
  "data": {
    "endpoint": "/api/users",
    "tier": "default",
    "recommended_limit": 150,
    "recommended_burst": 25,
    "confidence": 0.85,
    "reasoning": "Based on 10,000 historical requests..."
  }
}
```

```bash
# Get recommendations for all endpoints
POST /optimize/all
Content-Type: application/json

{
  "tier": "default",
  "strategy": "balanced"
}
```

```bash
# Get endpoint clusters
GET /optimize/clusters?n_clusters=5
```

### Model Training

```bash
# Train models on database data
POST /train
Content-Type: application/json

{
  "days": 7,
  "contamination": 0.1,
  "models": ["anomaly", "optimizer"]
}
```

```bash
# Generate synthetic data for testing
POST /generate/synthetic
Content-Type: application/json

{
  "duration_hours": 168,
  "base_rps": 50,
  "include_anomalies": true,
  "anomaly_rate": 0.05
}
```

```bash
# Train on synthetic data
POST /train/synthetic
```

### Model Management

```bash
# Get model information
GET /model/info

# Load pre-trained models
POST /model/load

# Reset models
POST /model/reset
```

### Data Export

```bash
# Export training data
GET /export/training-data?days=7&format=csv

# Export endpoint profiles
GET /export/endpoint-profiles
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ML_SERVICE_PORT` | `5000` | Port for the Flask server |
| `POSTGRES_HOST` | `localhost` | PostgreSQL host |
| `POSTGRES_PORT` | `5432` | PostgreSQL port |
| `POSTGRES_DB` | `aegis` | PostgreSQL database name |
| `POSTGRES_USER` | `aegis_user` | PostgreSQL user |
| `POSTGRES_PASSWORD` | `dev_password` | PostgreSQL password |
| `MODEL_PATH` | `./data/models` | Path to save/load models |
| `DATA_PATH` | `./data` | Path for data files |
| `FLASK_DEBUG` | `false` | Enable Flask debug mode |
| `CONTAMINATION` | `0.1` | Expected anomaly rate for training |
| `ANOMALY_THRESHOLD` | `-0.5` | Isolation Forest threshold |

## Scripts

### Export Training Data

```bash
# Export last 7 days of aggregated metrics
python scripts/export_training_data.py --days 7 --output training_data.csv

# Export with 5-minute buckets
python scripts/export_training_data.py --days 7 --bucket 5m --output data.csv

# Export endpoint summary
python scripts/export_training_data.py --type endpoint-summary --output endpoints.csv

# Show statistics only
python scripts/export_training_data.py --days 7 --stats --dry-run
```

### Generate Synthetic Data

```bash
# Generate 7 days of request logs
python scripts/generate_synthetic_data.py --days 7 --output logs.csv

# Generate aggregated metrics (faster)
python scripts/generate_synthetic_data.py --days 7 --type aggregated --output metrics.csv

# Insert directly into database
python scripts/generate_synthetic_data.py --days 7 --insert-db

# Generate with custom parameters
python scripts/generate_synthetic_data.py \
  --days 7 \
  --base-rps 100 \
  --anomaly-rate 0.1 \
  --output data.csv
```

## Integration with Node.js Backend

The AEGIS Node.js backend can integrate with this ML service using the provided client:

```typescript
import { getMLClient, initializeMLClient } from './ml/client';

// Initialize client
await initializeMLClient({
  baseUrl: 'http://ml-service:5000',
  enabled: true,
});

// Detect anomaly
const client = getMLClient();
const result = await client.detectAnomaly({
  requests_per_second: 100,
  avg_latency_ms: 50,
  p95_latency_ms: 100,
  p99_latency_ms: 150,
  error_rate: 0.01,
});

if (result.anomaly) {
  console.log(`Anomaly detected: ${result.explanation}`);
}
```

Use the ML middleware for automatic anomaly detection:

```typescript
import { createMLMiddleware, createMLRouter } from './ml/middleware';

// Add middleware to Express app
app.use(createMLMiddleware({
  enabled: true,
  aggregationIntervalMs: 60000,
  alertThreshold: 0.7,
  onAnomaly: (result, metrics) => {
    // Handle anomaly alert
    console.log('Anomaly alert:', result.explanation);
  },
}));

// Add ML API routes
app.use('/api/ml', createMLRouter());
```

## Model Architecture

### Anomaly Detection (Isolation Forest)

The anomaly detector uses an Isolation Forest algorithm with the following features:

1. **requests_per_second**: Traffic volume
2. **avg_latency_ms**: Average response time
3. **p95_latency_ms**: 95th percentile latency
4. **p99_latency_ms**: 99th percentile latency
5. **error_rate**: Proportion of error responses

The model is trained on historical "normal" traffic and identifies anomalies as data points that are isolated quickly (require fewer splits in the forest).

### Rate Limit Optimization

The optimizer analyzes endpoint traffic profiles to recommend optimal rate limits:

1. **Traffic Analysis**: Calculates avg/peak/p95 requests per minute
2. **Headroom Calculation**: Adds configurable buffer above normal traffic
3. **Tier Adjustment**: Multiplies based on user tier
4. **Strategy Application**: Adjusts based on conservative/balanced/permissive strategy
5. **Burst Sizing**: Recommends appropriate burst allowance

## Development

### Project Structure

```
aegis-ml/
├── api/
│   ├── __init__.py
│   └── flask_server.py      # Flask REST API
├── models/
│   ├── __init__.py
│   ├── anomaly_detector.py  # Isolation Forest model
│   └── rate_limit_optimizer.py
├── scripts/
│   ├── __init__.py
│   ├── export_training_data.py
│   └── generate_synthetic_data.py
├── data/
│   └── models/              # Saved model files
├── Dockerfile
├── requirements.txt
└── README.md
```

### Running Tests

```bash
pytest tests/ -v --cov=models --cov=api
```

### Code Formatting

```bash
black .
isort .
mypy .
```

## License

MIT