# Monitoring & Observability

## Overview

Monitoring tracks system health, performance, and usage patterns in real-time. Observability goes deeper: it helps you understand *why* systems behave a certain way through metrics, logs, and traces.

## Why Monitoring Matters

**Without monitoring**:
- You discover outages when users complain
- Performance degradation goes unnoticed
- Root cause analysis relies on guesswork
- No data to optimize resource usage

**With monitoring**:
- Detect issues before users notice
- Quantify performance improvements
- Data-driven capacity planning
- Historical trends for forecasting

---

## Metrics Collected

### 1. Request Metrics

**Latency** (response time):
- **p50** (median): 50% of requests faster than this
- **p95**: 95% of requests faster than this
- **p99**: 99% of requests faster than this
- **Max**: Slowest request in window

**Why percentiles**:
- Average misleads (one slow request = high average)
- p95/p99 shows user experience for most users

**Example**:
```
100 requests with latencies:
  90 requests: 50ms
  9 requests: 100ms
  1 request: 5000ms

Average: 144ms (misleading, most users see 50ms)
p95: 100ms (accurate, 95% of users see <100ms)
```

**Throughput** (requests per second):
- Total requests in time window
- Success rate vs. error rate
- Broken down by HTTP method/status code

**Error Rate**:
- 4xx errors (client errors): bad requests, auth failures
- 5xx errors (server errors): crashes, timeouts
- Formula: `(4xx + 5xx) / total_requests * 100%`

---

### 2. Rate Limit Metrics

**Quota Usage**:
- Requests allowed vs. rejected
- Per-client quota usage
- Top clients by request volume

**Algorithm Performance**:
- Redis latency for rate limit checks
- Token refill accuracy
- False positives/negatives

**Business Metrics**:
- % of users hitting rate limits
- Revenue impact (users blocked from premium features)

---

### 3. System Metrics

**Resource Usage**:
- **CPU**: % utilization per core
- **Memory**: Used vs. available (MB/GB)
- **Disk I/O**: Read/write throughput
- **Network**: Inbound/outbound bandwidth

**Node.js Specific**:
- **Event loop lag**: Time blocked (should be <10ms)
- **Heap memory**: V8 JavaScript memory usage
- **GC pauses**: Garbage collection frequency/duration

**Database**:
- **PostgreSQL**: Connection pool usage, query latency
- **Redis**: Hit rate, memory usage, evictions

---

## Data Collection Pipeline

### 1. Middleware Capture

**Request logging** (`src/monitoring/middleware.ts`):
```typescript
export function monitoringMiddleware(collector: MetricsCollector) {
  return (req, res, next) => {
    const startTime = Date.now();

    // Capture response
    res.on('finish', () => {
      const latency = Date.now() - startTime;

      collector.recordRequest({
        timestamp: new Date(),
        path: req.path,
        method: req.method,
        statusCode: res.statusCode,
        latency,
        clientIp: req.ip,
        rateLimited: res.locals.rateLimited || false
      });
    });

    next();
  };
}
```

**What it captures**:
- Every request automatically tracked
- Start/end timestamps for latency calculation
- Response status code for error tracking
- Client IP for rate limiting correlation

---

### 2. Batch Aggregation

**In-memory buffer** (`src/monitoring/collector.ts`):
```typescript
export class MetricsCollector {
  private buffer: Metric[] = [];
  private flushInterval = 10000; // 10 seconds

  constructor() {
    // Flush buffer every 10 seconds
    setInterval(() => this.flush(), this.flushInterval);
  }

  recordRequest(metric: Metric) {
    this.buffer.push(metric);

    // Emergency flush if buffer too large
    if (this.buffer.length > 1000) {
      this.flush();
    }
  }

  async flush() {
    if (this.buffer.length === 0) return;

    const metrics = [...this.buffer];
    this.buffer = [];

    // Bulk insert to PostgreSQL
    await db.insert('request_metrics', metrics);
  }
}
```

**Why batch**:
- Reduces database load (100 inserts/sec vs. 10,000/sec)
- Better write throughput
- Lower latency impact on requests

---

### 3. Time-Series Storage

**PostgreSQL schema**:
```sql
CREATE TABLE request_metrics (
  id SERIAL PRIMARY KEY,
  timestamp TIMESTAMPTZ NOT NULL,
  path TEXT NOT NULL,
  method TEXT NOT NULL,
  status_code INTEGER NOT NULL,
  latency_ms FLOAT NOT NULL,
  client_ip TEXT,
  rate_limited BOOLEAN DEFAULT false
);

-- Index for fast time-range queries
CREATE INDEX idx_metrics_timestamp ON request_metrics(timestamp DESC);

-- Index for path filtering
CREATE INDEX idx_metrics_path ON request_metrics(path);
```

**Query example**:
```sql
-- Get p95 latency for last hour
SELECT
  PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY latency_ms) AS p95
FROM request_metrics
WHERE timestamp > NOW() - INTERVAL '1 hour';
```

**Partitioning** (for scale):
```sql
-- Partition by day
CREATE TABLE request_metrics_2024_01_15
  PARTITION OF request_metrics
  FOR VALUES FROM ('2024-01-15') TO ('2024-01-16');

-- Auto-drop old partitions
DROP TABLE request_metrics_2023_12_01; -- 30 days ago
```

---

## Real-Time Dashboard

### WebSocket Streaming

**Server** (`src/api/websocket.ts`):
```typescript
import { WebSocketServer } from 'ws';

export function startWebSocket(server, collector) {
  const wss = new WebSocketServer({ server, path: '/ws/metrics' });

  wss.on('connection', (ws) => {
    console.log('Client connected');

    // Broadcast metrics every second
    const interval = setInterval(async () => {
      const metrics = await collector.getRealtimeMetrics();
      ws.send(JSON.stringify(metrics));
    }, 1000);

    ws.on('close', () => {
      clearInterval(interval);
      console.log('Client disconnected');
    });
  });
}
```

**Client** (`frontend/src/hooks/useWebSocket.ts`):
```typescript
export function useWebSocket(url: string) {
  const [metrics, setMetrics] = useState(null);

  useEffect(() => {
    const ws = new WebSocket(url);

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      setMetrics(data);
    };

    ws.onerror = (error) => {
      console.error('WebSocket error:', error);
    };

    return () => ws.close();
  }, [url]);

  return metrics;
}
```

**Data format**:
```json
{
  "latency": {
    "p50": 45.2,
    "p95": 120.5,
    "p99": 250.0
  },
  "throughput": 1250,
  "errorRate": 0.02,
  "rateLimitUsage": 0.75
}
```

---

### Dashboard Components

**Latency chart** (`frontend/src/components/LatencyChart.tsx`):
```typescript
export function LatencyChart({ timeRange }: { timeRange: string }) {
  const [data, setData] = useState([]);

  useEffect(() => {
    async function fetchData() {
      const response = await fetch(`/api/metrics/latency?range=${timeRange}`);
      const json = await response.json();
      setData(json.data);
    }

    fetchData();
    const interval = setInterval(fetchData, 5000); // Refresh every 5s

    return () => clearInterval(interval);
  }, [timeRange]);

  return (
    <LineChart data={data}>
      <Line dataKey="p50" stroke="green" />
      <Line dataKey="p95" stroke="orange" />
      <Line dataKey="p99" stroke="red" />
    </LineChart>
  );
}
```

**Features**:
- Time range selector (5m, 15m, 1h, 6h, 24h)
- Auto-refresh every 5 seconds
- Multiple series (p50, p95, p99)
- Responsive design (mobile-friendly)

---

## Alerting

### Alert Rules

**Configuration** (`config/aegis.config.yaml`):
```yaml
monitoring:
  alerts:
    - name: HighErrorRate
      condition: error_rate > 0.05  # > 5%
      window: "5m"
      severity: critical
      channels: ["slack", "email"]

    - name: HighLatency
      condition: p95 > 500  # p95 > 500ms
      window: "5m"
      severity: warning
      channels: ["slack"]

    - name: RateLimitExhaustion
      condition: rate_limit_usage > 0.9  # > 90% quota used
      window: "1m"
      severity: info
      channels: ["log"]
```

### Alert Manager

**Implementation** (`src/monitoring/alerts.ts`):
```typescript
export class AlertManager {
  private activeAlerts = new Map<string, Alert>();

  async checkRules(metrics: Metrics) {
    for (const rule of config.monitoring.alerts) {
      const triggered = this.evaluateCondition(rule.condition, metrics);

      if (triggered && !this.activeAlerts.has(rule.name)) {
        // New alert
        await this.sendAlert(rule);
        this.activeAlerts.set(rule.name, {
          rule,
          triggeredAt: new Date()
        });
      } else if (!triggered && this.activeAlerts.has(rule.name)) {
        // Alert resolved
        await this.sendResolution(rule);
        this.activeAlerts.delete(rule.name);
      }
    }
  }

  evaluateCondition(condition: string, metrics: Metrics): boolean {
    // Parse condition (e.g., "error_rate > 0.05")
    const [metric, operator, threshold] = condition.split(' ');
    const value = metrics[metric];

    switch (operator) {
      case '>': return value > parseFloat(threshold);
      case '<': return value < parseFloat(threshold);
      case '>=': return value >= parseFloat(threshold);
      case '<=': return value <= parseFloat(threshold);
      default: return false;
    }
  }

  async sendAlert(rule: AlertRule) {
    for (const channel of rule.channels) {
      switch (channel) {
        case 'slack':
          await this.sendSlack(rule);
          break;
        case 'email':
          await this.sendEmail(rule);
          break;
        case 'log':
          logger.warn(`Alert: ${rule.name}`);
          break;
      }
    }
  }
}
```

### Alert Channels

**Slack integration**:
```typescript
async function sendSlack(rule: AlertRule) {
  await fetch(config.slack.webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: `🚨 Alert: ${rule.name}`,
      attachments: [{
        color: rule.severity === 'critical' ? 'danger' : 'warning',
        fields: [
          { title: 'Condition', value: rule.condition },
          { title: 'Severity', value: rule.severity }
        ]
      }]
    })
  });
}
```

**Email integration**:
```typescript
async function sendEmail(rule: AlertRule) {
  await emailClient.send({
    to: config.email.recipients,
    subject: `[${rule.severity.toUpperCase()}] ${rule.name}`,
    body: `
      Alert triggered: ${rule.name}
      Condition: ${rule.condition}
      Severity: ${rule.severity}
      Time: ${new Date().toISOString()}
    `
  });
}
```

---

## Logging

### Structured Logging

**Logger setup** (`src/utils/logger.ts`):
```typescript
import winston from 'winston';

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
    new winston.transports.File({ filename: 'logs/combined.log' })
  ]
});
```

**Usage**:
```typescript
logger.info('Request received', {
  requestId: req.id,
  path: req.path,
  method: req.method,
  ip: req.ip
});

logger.error('Database error', {
  error: err.message,
  stack: err.stack,
  query: sql
});
```

**Output**:
```json
{
  "level": "info",
  "message": "Request received",
  "timestamp": "2024-01-15T10:30:45.123Z",
  "requestId": "req-abc123",
  "path": "/api/users",
  "method": "GET",
  "ip": "192.168.1.1"
}
```

### Log Aggregation

**Ship to external service** (e.g., Datadog, Splunk):
```typescript
import { DatadogTransport } from 'winston-datadog';

logger.add(new DatadogTransport({
  apiKey: process.env.DATADOG_API_KEY,
  service: 'aegis-gateway',
  hostname: os.hostname()
}));
```

---

## Tracing

### Request ID Propagation

**Generate request ID** (`src/gateway/middleware/requestId.ts`):
```typescript
import { v4 as uuidv4 } from 'uuid';

export function requestIdMiddleware(req, res, next) {
  req.id = req.headers['x-request-id'] || uuidv4();
  res.setHeader('X-Request-Id', req.id);
  next();
}
```

**Propagate to upstream**:
```typescript
proxy.on('proxyReq', (proxyReq, req) => {
  proxyReq.setHeader('X-Request-Id', req.id);
});
```

**Log with request ID**:
```typescript
logger.info('Processing request', { requestId: req.id });
// Later in code...
logger.error('Database error', { requestId: req.id });
```

**Trace across services**:
```
Gateway (req-123) → User Service (req-123) → Database (req-123)
```

Now you can grep logs for `req-123` to see entire request flow.

---

## Performance Monitoring

### Metrics Endpoints

**Get latency** (`GET /api/metrics/latency`):
```bash
curl "http://localhost:8080/api/metrics/latency?range=1h"
```

Response:
```json
{
  "success": true,
  "data": [
    { "timestamp": "2024-01-15T10:00:00Z", "p50": 45, "p95": 120, "p99": 250 },
    { "timestamp": "2024-01-15T10:01:00Z", "p50": 50, "p95": 130, "p99": 280 }
  ],
  "meta": {
    "range": "1h",
    "points": 60
  }
}
```

**Get throughput** (`GET /api/metrics/throughput`):
```bash
curl "http://localhost:8080/api/metrics/throughput?range=15m"
```

**Get error rate** (`GET /api/metrics/errors`):
```bash
curl "http://localhost:8080/api/metrics/errors?range=6h"
```

---

## Advanced Features

### Custom Metrics

**Track business metrics**:
```typescript
collector.recordCustomMetric({
  name: 'user_signup',
  value: 1,
  tags: { source: 'web', plan: 'pro' }
});

collector.recordCustomMetric({
  name: 'revenue',
  value: 49.99,
  tags: { currency: 'USD', plan: 'pro' }
});
```

**Query**:
```sql
SELECT
  SUM(value) as total_revenue,
  tags->>'plan' as plan
FROM custom_metrics
WHERE name = 'revenue'
  AND timestamp > NOW() - INTERVAL '1 day'
GROUP BY tags->>'plan';
```

---

### Anomaly Detection

**ML-powered alerting** (see [ML_FEATURES.md](./ML_FEATURES.md)):
```typescript
const metrics = await collector.getMetrics('5m');
const anomalyScore = await mlClient.detectAnomaly(metrics);

if (anomalyScore > 0.8) {
  await alertManager.sendAlert({
    name: 'TrafficAnomaly',
    message: `Anomaly detected (score: ${anomalyScore})`,
    severity: 'warning'
  });
}
```

---

## Best Practices

### 1. Retention Policy

Don't store raw metrics forever:
```sql
-- Keep raw data for 7 days
DELETE FROM request_metrics
WHERE timestamp < NOW() - INTERVAL '7 days';

-- Aggregate to hourly for 30 days
CREATE TABLE metrics_hourly AS
SELECT
  DATE_TRUNC('hour', timestamp) as hour,
  path,
  AVG(latency_ms) as avg_latency,
  PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY latency_ms) as p95
FROM request_metrics
GROUP BY hour, path;

-- Aggregate to daily for 1 year
CREATE TABLE metrics_daily AS ...
```

### 2. Sampling

For ultra-high traffic (>100k req/s), sample requests:
```typescript
const SAMPLE_RATE = 0.1; // 10%

if (Math.random() < SAMPLE_RATE) {
  collector.recordRequest(metric);
}
```

### 3. Graceful Degradation

If monitoring fails, don't break the gateway:
```typescript
try {
  collector.recordRequest(metric);
} catch (error) {
  logger.error('Monitoring failed', { error });
  // Continue processing request
}
```

---

## Troubleshooting

### Issue: Dashboard shows "No data available"

**Causes**:
1. Backend not collecting metrics
2. Frontend time range unsupported
3. Database empty (no traffic yet)

**Debug**:
```bash
# Check database
docker exec -u postgres aegis-postgres psql -U aegis -c "SELECT COUNT(*) FROM request_metrics;"

# Check API endpoint
curl "http://localhost:8080/api/metrics/latency?range=1h"

# Check logs
docker logs aegis-gateway | grep "monitoring"
```

---

### Issue: WebSocket not connecting

**Symptoms**: Dashboard says "Disconnected"

**Causes**:
1. Wrong WebSocket URL in .env.local
2. Firewall blocking WebSocket
3. Nginx/proxy not forwarding WebSocket

**Solutions**:
```bash
# Check .env.local
cat frontend/.env.local
# Should have: NEXT_PUBLIC_WS_URL=ws://localhost:8080/ws/metrics

# Test WebSocket directly
websocat ws://localhost:8080/ws/metrics

# Nginx config (if using reverse proxy)
location /ws/metrics {
  proxy_pass http://localhost:8080;
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
}
```

---

## References

- [Prometheus Best Practices](https://prometheus.io/docs/practices/)
- [Grafana Dashboards](https://grafana.com/docs/grafana/latest/dashboards/)
- [OpenTelemetry](https://opentelemetry.io/)
- [The RED Method (Rate, Errors, Duration)](https://www.weave.works/blog/the-red-method-key-metrics-for-microservices-architecture/)

For more details, see:
- [ARCHITECTURE.md](../ARCHITECTURE.md) - System monitoring architecture
- [ML_FEATURES.md](./ML_FEATURES.md) - ML-powered anomaly detection
- [API Reference](../API_REFERENCE.md) - Metrics API endpoints
