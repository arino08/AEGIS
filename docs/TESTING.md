# =============================================================================
# AEGIS - Testing & Demonstration Guide
# =============================================================================

This guide covers how to test and demonstrate all AEGIS capabilities.

## Quick Start

```bash
# 1. Start all services (in separate terminals or use docker-compose)
make dev            # Start AEGIS gateway
make frontend       # Start dashboard
make test-server    # Start echo test server

# 2. Run the stress test suite
./scripts/stress-test.sh --all

# 3. Open the dashboard
open http://localhost:3001
```

## Prerequisites

Install these tools for comprehensive testing:

```bash
# macOS
brew install curl jq wrk

# Ubuntu/Debian
sudo apt-get install curl jq apache2-utils

# For WebSocket testing (optional)
cargo install websocat
```

## Starting the Services

### Option 1: Using Docker Compose (Recommended)

```bash
# Start all services
docker compose -f docker/docker-compose.yml up -d

# View logs
docker compose -f docker/docker-compose.yml logs -f
```

### Option 2: Manual Start

**Terminal 1 - AEGIS Gateway:**
```bash
cd /path/to/aegis
npm run dev
# Gateway runs on http://localhost:8080
```

**Terminal 2 - Frontend Dashboard:**
```bash
cd /path/to/aegis/frontend
npm run dev
# Dashboard runs on http://localhost:3001
```

**Terminal 3 - Test Backend Server:**
```bash
cd /path/to/aegis
npx ts-node scripts/test-server.ts
# Echo server runs on http://localhost:3000
```

**Terminal 4 - ML Service (optional):**
```bash
cd /path/to/aegis/aegis-ml
python -m flask run --port 5001
# Or use Docker: docker compose up ml-service
```

## Test Scenarios

### 1. Rate Limiting Demonstration

```bash
# Test token bucket rate limiting
for i in {1..150}; do
  curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8080/api/test
done | sort | uniq -c

# Expected: ~100 successful (200/404), ~50 rate limited (429)
```

**Verify in dashboard:**
- Watch the "Rate Limited Requests" counter increase
- Check the "Rate Limit" section for details

### 2. Circuit Breaker Demonstration

```bash
# Hit an endpoint that randomly fails
for i in {1..100}; do
  curl -s http://localhost:8080/error/random
  sleep 0.1
done

# Check circuit breaker status
curl http://localhost:8080/api/health/circuit-breakers | jq
```

**Circuit states:**
- `CLOSED` - Normal operation
- `OPEN` - Blocking requests (backend unhealthy)
- `HALF_OPEN` - Testing if backend recovered

### 3. Health Check System

```bash
# Basic health check
curl http://localhost:8080/health | jq

# Detailed backend health
curl http://localhost:8080/api/health/backends | jq

# Readiness probe
curl http://localhost:8080/ready | jq
```

### 4. Metrics & Monitoring

```bash
# Real-time metrics
curl http://localhost:8080/api/metrics/realtime | jq

# Historical metrics (1 hour)
curl "http://localhost:8080/api/metrics/timeseries?period=1h" | jq

# Endpoint-specific metrics
curl "http://localhost:8080/api/metrics/endpoints?limit=10" | jq
```

### 5. Alerts System

```bash
# Get all alert rules
curl http://localhost:8080/api/alerts/rules | jq

# Get active alerts
curl http://localhost:8080/api/alerts | jq

# Get alert statistics
curl http://localhost:8080/api/alerts/stats | jq

# Create a test alert rule
curl -X POST http://localhost:8080/api/alerts/rules \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Test High Latency Alert",
    "condition": {
      "metric": "latency_p95",
      "operator": ">",
      "threshold": 500
    },
    "severity": "warning",
    "actions": [{"type": "log"}]
  }'
```

### 6. ML-Powered Features

```bash
# ML service health
curl http://localhost:8080/api/ml/health | jq

# Get rate limit recommendations
curl http://localhost:8080/api/ml/recommendations | jq

# Check for anomalies
curl http://localhost:8080/api/ml/anomalies | jq

# Trigger batch optimization
curl -X POST http://localhost:8080/api/ml/optimize | jq
```

### 7. Natural Language Queries

```bash
# Query metrics in natural language
curl -X POST http://localhost:8080/api/nl-query \
  -H "Content-Type: application/json" \
  -d '{"query": "What is the current request rate?"}'

curl -X POST http://localhost:8080/api/nl-query \
  -H "Content-Type: application/json" \
  -d '{"query": "Show me the top 5 slowest endpoints"}'

curl -X POST http://localhost:8080/api/nl-query \
  -H "Content-Type: application/json" \
  -d '{"query": "Are there any errors in the last hour?"}'
```

### 8. Authentication Testing

```bash
# Test with API Key
curl -H "X-API-Key: test-api-key" http://localhost:8080/api/test

# Test JWT (if configured)
TOKEN="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
curl -H "Authorization: Bearer $TOKEN" http://localhost:8080/api/test

# Access protected endpoint without auth
curl http://localhost:8080/api/admin/users
# Expected: 401 Unauthorized (if auth enabled)
```

### 9. Request/Response Transformation

```bash
# Check for injected headers
curl -v http://localhost:8080/echo 2>&1 | grep -i "x-request-id\|x-forwarded"

# Verify sensitive headers are stripped
curl -v http://localhost:8080/api/test 2>&1 | grep -i "server\|x-powered-by"
# Should NOT see these headers in response
```

## Load Testing

### Quick Load Test (1,000 requests)

```bash
./scripts/stress-test.sh --quick
```

### Standard Load Test (10,000 requests)

```bash
./scripts/stress-test.sh --standard
```

### Heavy Load Test (50,000 requests)

```bash
./scripts/stress-test.sh --heavy
```

### Using Apache Bench

```bash
# 10,000 requests, 100 concurrent
ab -n 10000 -c 100 http://localhost:8080/health

# With keep-alive
ab -n 10000 -c 100 -k http://localhost:8080/health
```

### Using wrk

```bash
# 30 seconds, 4 threads, 100 connections
wrk -t4 -c100 -d30s http://localhost:8080/health

# With custom script for POST requests
wrk -t4 -c100 -d30s -s scripts/wrk-post.lua http://localhost:8080/api/test
```

### Generating Demo Traffic

```bash
# Generate 2 minutes of varied traffic for dashboard demo
./scripts/stress-test.sh --demo
```

## Dashboard Features to Demonstrate

Open http://localhost:3001 and showcase:

1. **Real-time Metrics Panel**
   - Requests per second
   - Active connections
   - Error rate
   - p50/p95/p99 latency

2. **Rate Limiting Statistics**
   - Allowed vs blocked requests
   - Per-tier breakdown
   - Rate limit rule hits

3. **Backend Health**
   - Health status of each backend
   - Circuit breaker states
   - Response time trends

4. **Alerts Dashboard**
   - Active alerts
   - Alert history
   - Rule configuration

5. **ML Insights**
   - Anomaly detection results
   - Rate limit recommendations
   - Traffic pattern analysis

## Performance Benchmarks

Expected performance (on modern hardware):

| Metric | Target | Notes |
|--------|--------|-------|
| Requests/sec | 10,000+ | Health endpoint |
| Latency p50 | < 5ms | Without backend |
| Latency p99 | < 50ms | With backend |
| Memory | < 512MB | Under load |
| CPU | < 80% | Under load |

## Troubleshooting

### Gateway not responding

```bash
# Check if port is in use
lsof -i :8080

# Check logs
docker compose logs aegis-gateway
```

### Rate limiting not working

```bash
# Check Redis connection
docker compose exec redis redis-cli ping

# Check rate limit config
curl http://localhost:8080/_aegis/ratelimit | jq
```

### ML service errors

```bash
# Check ML service health
curl http://localhost:5001/health

# Check for Python dependencies
docker compose exec ml-service pip list
```

### Metrics not showing

```bash
# Check PostgreSQL connection
docker compose exec postgres psql -U aegis_user -d aegis -c "SELECT COUNT(*) FROM request_metrics;"

# Check metrics collector status
curl http://localhost:8080/_aegis/status | jq '.metrics'
```

## API Reference

### Gateway Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Basic health check |
| `/healthz` | GET | Kubernetes health probe |
| `/ready` | GET | Readiness probe |
| `/_aegis/status` | GET | Gateway status |
| `/_aegis/routes` | GET | Configured routes |
| `/_aegis/ratelimit` | GET | Rate limit status |

### Metrics API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/metrics/summary` | GET | Metrics summary |
| `/api/metrics/realtime` | GET | Real-time metrics |
| `/api/metrics/timeseries` | GET | Historical data |
| `/api/metrics/endpoints` | GET | Per-endpoint metrics |

### Alerts API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/alerts` | GET | List alerts |
| `/api/alerts/rules` | GET/POST | Manage rules |
| `/api/alerts/stats` | GET | Alert statistics |

### ML API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/ml/health` | GET | ML service health |
| `/api/ml/recommendations` | GET | Rate limit recommendations |
| `/api/ml/anomalies` | GET | Detected anomalies |
| `/api/ml/optimize` | POST | Trigger optimization |

### Health API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/health/backends` | GET | Backend health status |
| `/api/health/circuit-breakers` | GET | Circuit breaker states |
