# Aegis Architecture

## System Overview

Aegis is a high-performance API gateway built with a modular architecture that separates concerns across distinct layers. The system is designed for horizontal scalability, observability, and AI-enhanced traffic management.

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                         Client Layer                             │
│  (HTTP Clients, Web Apps, Mobile Apps, Third-party Services)    │
└───────────────────────────────┬─────────────────────────────────┘
                                │
                                │ HTTP/HTTPS
                                │
┌───────────────────────────────▼─────────────────────────────────┐
│                      Aegis API Gateway                           │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │              Middleware Pipeline                         │   │
│  │  Request ID → Logger → Auth → Rate Limit → ML → Monitor │   │
│  └──────────────────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                  Router & Proxy                          │   │
│  │  • Route Matching    • Load Balancing                    │   │
│  │  • Request Transform • Circuit Breaking                  │   │
│  └──────────────────────────────────────────────────────────┘   │
└────────┬─────────────┬────────────┬──────────────┬──────────────┘
         │             │            │              │
         │             │            │              │
    ┌────▼───┐    ┌───▼────┐  ┌────▼────┐    ┌───▼────┐
    │ Redis  │    │Postgres│  │ ML API  │    │  Log   │
    │(Cache/ │    │(Metrics│  │(Flask/  │    │ Stream │
    │Limiter)│    │& State)│  │Python)  │    │        │
    └────┬───┘    └───┬────┘  └────┬────┘    └───┬────┘
         │            │            │              │
         │            │            │              │
         └────────────┴────────────┴──────────────┘
                                │
                    ┌───────────▼────────────┐
                    │   Upstream Services    │
                    │  (Backend APIs/μSvcs)  │
                    └────────────────────────┘
```

## Component Architecture

### 1. Gateway Core (`src/gateway/`)

**Purpose**: HTTP server, routing, and proxying

**Key Files**:
- `server.ts` - Express server initialization, middleware registration
- `router.ts` - Route matching and upstream service selection
- `proxy.ts` - HTTP proxy with load balancing and circuit breaking

**Responsibilities**:
- Accept incoming HTTP requests
- Apply middleware pipeline in order
- Match routes to upstream services
- Forward requests with load balancing
- Return responses with proper error handling

**Technology**: Express.js for HTTP server, http-proxy-middleware for proxying

**Data Flow**:
```
Client Request → Express Server → Middleware Chain → Router
→ Proxy → Upstream Service → Proxy → Middleware Chain → Client Response
```

---

### 2. Rate Limiting (`src/rate-limiter/`)

**Purpose**: Traffic control with multiple algorithms

**Key Files**:
- `limiter.ts` - Rate limit algorithm implementations (Token Bucket, Sliding Window, Fixed Window)
- `middleware.ts` - Express middleware for rate limit enforcement
- `scripts.ts` - Lua scripts for atomic Redis operations
- `algorithms/` - Individual algorithm implementations
- `rules/` - Matching and bypass logic

**Algorithms**:

1. **Token Bucket** (`algorithms/token-bucket.ts`)
   - Tokens refill at constant rate
   - Burst traffic allowed up to bucket capacity
   - Best for: APIs needing burst tolerance

2. **Sliding Window** (`algorithms/sliding-window.ts`)
   - Rolling time window using Redis sorted sets
   - More precise than fixed window
   - Best for: Strict rate enforcement

3. **Fixed Window** (`algorithms/fixed-window.ts`)
   - Counter resets at window boundaries
   - Simple and performant
   - Best for: High-throughput scenarios

**Configuration**:
```yaml
rateLimiting:
  default:
    algorithm: "token-bucket"
    limit: 100
    window: "1m"
  rules:
    - path: "/api/critical"
      limit: 10
      window: "1m"
  bypass:
    ips: ['127.0.0.1']
```

**Redis Data Structures**:
- Token Bucket: Hash with `tokens`, `lastRefill`
- Sliding Window: Sorted set with timestamps
- Fixed Window: String counter with TTL

---

### 3. Monitoring & Observability (`src/monitoring/`)

**Purpose**: Real-time metrics, alerting, and analytics

**Key Files**:
- `collector.ts` - Metric collection and aggregation
- `middleware.ts` - Request/response metric capture
- `alerts.ts` - Threshold monitoring and alert generation
- `types.ts` - Metric type definitions

**Metrics Collected**:
- **Request Metrics**: Count, latency (p50, p95, p99), error rate
- **Rate Limit Metrics**: Allowed, rejected, quota usage
- **System Metrics**: CPU, memory, event loop lag
- **Business Metrics**: Custom metrics via API

**Storage**:
```sql
-- request_metrics table
CREATE TABLE request_metrics (
  timestamp TIMESTAMPTZ,
  path TEXT,
  method TEXT,
  status_code INTEGER,
  latency_ms FLOAT,
  client_ip TEXT,
  rate_limited BOOLEAN
);

-- Indexed for fast time-series queries
CREATE INDEX idx_metrics_timestamp ON request_metrics(timestamp);
```

**Alerting**:
- Error rate threshold (e.g., > 5% errors)
- Latency spikes (e.g., p95 > 500ms)
- Rate limit exhaustion
- Anomaly detection (ML-powered)

**Dashboard**:
- Real-time WebSocket streaming
- Time ranges: 5m, 15m, 1h, 6h, 24h
- Charts: Latency distribution, throughput, error rate, rate limit usage

---

### 4. Machine Learning (`src/ml/` and `aegis-ml/`)

**Purpose**: AI-powered traffic analysis and optimization

**Components**:

1. **Anomaly Detection** (`aegis-ml/models/anomaly_detector.py`)
   - Algorithm: Isolation Forest
   - Features: Request rate, latency, error rate, payload size
   - Output: Anomaly score (0-1) and predictions
   - Use Case: Detect DDoS attacks, bot traffic, unusual patterns

2. **Rate Limit Optimization** (`aegis-ml/models/rate_limit_optimizer.py`)
   - Algorithm: Time-series forecasting + reinforcement learning
   - Input: Historical traffic patterns, error rates
   - Output: Recommended rate limits per endpoint
   - Use Case: Auto-tune limits to maximize throughput without overload

**ML API** (`aegis-ml/api/flask_server.py`):
```python
POST /predict/anomaly
{
  "metrics": [
    {"request_rate": 100, "latency": 50, "error_rate": 0.01}
  ]
}

POST /optimize/rate-limit
{
  "endpoint": "/api/users",
  "historical_data": [...]
}
```

**Integration**:
- Gateway calls ML API asynchronously
- ML middleware enriches requests with scores
- Alerts triggered on high anomaly scores
- Rate limits adjusted based on optimization suggestions

**Training**:
- Export training data: `python aegis-ml/scripts/export_training_data.py`
- Generate synthetic data: `python aegis-ml/scripts/generate_synthetic_data.py`
- Models retrained weekly via cron job

---

### 5. Authentication & Authorization (`src/gateway/middleware/`)

**Purpose**: Secure API access control

**Methods**:
1. **API Keys** - Header-based `X-API-Key`
2. **JWT** - Bearer tokens with expiration
3. **OAuth 2.0** - Third-party authentication
4. **mTLS** - Certificate-based authentication

**RBAC (Role-Based Access Control)**:
```yaml
auth:
  rbac:
    roles:
      admin:
        permissions: ['*']
      user:
        permissions: ['read:metrics', 'write:requests']
    rules:
      - path: "/admin/*"
        roles: ['admin']
      - path: "/api/*"
        roles: ['user', 'admin']
```

**Implementation**:
- Middleware validates credentials
- Extracts user/role from token
- Checks permissions against route rules
- Returns 401 Unauthorized or 403 Forbidden on failure

---

### 6. Storage Layer

**Redis** (`src/storage/redis.ts`):
- **Purpose**: Rate limiting state, caching, session storage
- **Data**: Counters, sorted sets, hashes
- **Features**: TTL for auto-cleanup, Lua scripts for atomicity
- **Persistence**: RDB snapshots + AOF for durability

**PostgreSQL** (`src/storage/postgres.ts`):
- **Purpose**: Metrics, configuration, user data
- **Schema**: Time-series tables with partitioning
- **Features**: Indexes on timestamp, aggregation functions
- **Migrations**: Automated via `src/storage/migrations/`

**Data Flow**:
```
Hot Path (< 1ms):
  Request → Rate Limiter → Redis → Allow/Deny

Analytics Path (async):
  Request → Collector → Batch → PostgreSQL (every 10s)

ML Path (async):
  PostgreSQL → Export → ML Training → Model Update → Gateway
```

---

## API Layer

### REST API (`src/api/routes/`)

**Metrics API** (`routes/metrics.ts`):
```
GET  /api/metrics/latency?range=15m
GET  /api/metrics/throughput?range=1h
GET  /api/metrics/errors?range=24h
GET  /api/metrics/rate-limit-usage?range=6h
```

**Alerts API** (`routes/alerts.ts`):
```
GET  /api/alerts?status=active
POST /api/alerts/acknowledge/:id
GET  /api/alerts/history?days=7
```

**Natural Language Query** (`src/api/routes/`):
```
POST /api/nl-query
{
  "question": "What's the average latency for /api/users in the last hour?"
}
```

### WebSocket API (`src/api/websocket.ts`)

**Real-time Metrics Streaming**:
```javascript
const ws = new WebSocket('ws://localhost:8080/ws/metrics');
ws.onmessage = (event) => {
  const metrics = JSON.parse(event.data);
  // { latency: 45.2, throughput: 1250, errors: 2 }
};
```

**Features**:
- Broadcasts every 1 second
- Client subscribes to specific metrics
- Auto-reconnect on disconnect

---

## Configuration Management

**Config File** (`config/aegis.config.yaml`):
```yaml
gateway:
  port: 8080
  routes:
    - path: "/api/users"
      upstream: "http://localhost:3001"
      methods: ["GET", "POST"]

rateLimiting:
  default:
    algorithm: "token-bucket"
    limit: 100
    window: "1m"

monitoring:
  metricsEnabled: true
  retentionDays: 30

ml:
  enabled: true
  endpoint: "http://localhost:5001"
```

**Loading** (`src/config/loader.ts`):
- Validates YAML against schema (`schema.ts`)
- Merges environment variables
- Hot-reloads on file change (development mode)

---

## Deployment Architecture

### Docker Compose (Development)

```yaml
services:
  gateway:
    build: .
    ports: ["8080:8080"]
    depends_on: [postgres, redis, ml-api]

  postgres:
    image: postgres:15
    volumes: [./docker/init-scripts:/docker-entrypoint-initdb.d]

  redis:
    image: redis:7-alpine

  ml-api:
    build: ./aegis-ml
    ports: ["5001:5001"]
```

### Kubernetes (Production)

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: aegis-gateway
spec:
  replicas: 3
  selector:
    matchLabels:
      app: aegis
  template:
    spec:
      containers:
      - name: gateway
        image: aegis:latest
        resources:
          requests:
            memory: "512Mi"
            cpu: "500m"
          limits:
            memory: "1Gi"
            cpu: "1000m"
        livenessProbe:
          httpGet:
            path: /health
            port: 8080
```

**Scaling Strategy**:
- Horizontal Pod Autoscaler (HPA) based on CPU/memory
- Redis cluster for rate limiting state
- PostgreSQL read replicas for analytics
- ML API deployed separately with GPU nodes

---

## Performance Characteristics

**Latency**:
- Rate limit check: < 2ms (Redis roundtrip)
- Proxy overhead: < 5ms
- Total gateway latency: < 10ms (excluding upstream)

**Throughput**:
- Single instance: 50,000+ req/s (stress tested)
- Rate limited: 100 req/s per client (configurable)
- WebSocket: 1,000+ concurrent connections

**Scalability**:
- Stateless gateway → horizontal scaling
- Redis clustering → 1M+ rate limit checks/s
- PostgreSQL partitioning → 100M+ metrics/day

---

## Security Considerations

**Network Security**:
- TLS termination at gateway
- mTLS for upstream services
- IP whitelisting/blacklisting

**Data Security**:
- Encrypted credentials in config
- JWT with short expiration (15 min)
- API keys hashed in database

**DDoS Protection**:
- Rate limiting per IP/user/API key
- ML anomaly detection for bot traffic
- Automatic IP blocking on high anomaly scores

**Compliance**:
- GDPR: Client IP anonymization
- PCI DSS: No logging of sensitive data
- SOC 2: Audit logs for all actions

---

## Monitoring & Debugging

**Logging**:
- Structured JSON logs (`src/utils/logger.ts`)
- Correlation IDs for request tracing
- Log levels: DEBUG, INFO, WARN, ERROR
- Output: stdout (Docker) or files (local)

**Health Checks**:
```
GET /health
{
  "status": "healthy",
  "uptime": 3600,
  "dependencies": {
    "postgres": "connected",
    "redis": "connected",
    "ml-api": "connected"
  }
}
```

**Tracing**:
- Request ID header propagation
- Latency breakdown per middleware
- Distributed tracing (future: OpenTelemetry)

---

## Future Enhancements

1. **GraphQL Gateway**: Support GraphQL schema stitching
2. **gRPC Support**: Protocol buffer proxy
3. **Multi-Region**: Global load balancing with geo-routing
4. **Advanced ML**: Predictive scaling, auto-remediation
5. **Service Mesh Integration**: Istio/Linkerd compatibility
6. **Real-time Analytics**: ClickHouse for sub-second queries

---

## References

- [README.md](../README.md) - Quick start and features
- [CODE_GUIDE.md](./CODE_GUIDE.md) - File-by-file explanations
- [DEPLOYMENT.md](./DEPLOYMENT.md) - Production deployment
- [API Reference](./API_REFERENCE.md) - Complete API docs
- [Feature Docs](./features/) - Deep dives per feature
