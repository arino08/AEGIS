# 06. Monitoring & Metrics

## Overview

AEGIS provides comprehensive monitoring and observability through real-time metrics collection, time-series storage, WebSocket streaming, and configurable alerts. This allows you to understand API traffic patterns, identify issues, and optimize performance.

---

## 📁 Monitoring Module Structure

```
src/monitoring/
├── index.ts          # Module exports
├── collector.ts      # Main MetricsCollector class
├── middleware.ts     # Express middleware for request metrics
├── alerts.ts         # AlertManager for rule-based alerting
└── types.ts          # Metric type definitions

src/api/
├── websocket.ts      # Real-time WebSocket streaming
└── routes/
    ├── metrics.ts    # Metrics API endpoints
    └── alerts.ts     # Alerts API endpoints
```

---

## 📊 Metrics Collector

### `src/monitoring/collector.ts`

The `MetricsCollector` is responsible for:
- Collecting metrics from all requests
- Batching for efficient database writes
- Providing query APIs for dashboards
- Real-time aggregations

```typescript
export class MetricsCollector {
  private config: MetricsConfig;
  private db: PostgresClient | null = null;

  // Batched metrics awaiting flush
  private requestBatch: RequestMetric[] = [];
  private rateLimitBatch: RateLimitMetric[] = [];
  private backendBatch: BackendMetric[] = [];

  // Real-time counters (in-memory)
  private realtimeCounters = {
    totalRequests: 0,
    successfulRequests: 0,
    failedRequests: 0,
    rateLimitedRequests: 0,
    totalLatencyMs: 0,
    activeConnections: 0,
    healthyBackends: 0,
    totalBackends: 0
  };

  // Timers
  private flushTimer: NodeJS.Timeout | null = null;
  private cleanupTimer: NodeJS.Timeout | null = null;
}
```

### Initialization

```typescript
async initialize(db: PostgresClient): Promise<void> {
  this.db = db;

  // Verify database tables exist
  await this.verifyTables();

  // Start periodic flush timer
  this.startFlushTimer();

  // Start periodic cleanup timer
  this.startCleanupTimer();

  logger.info('MetricsCollector initialized');
}

private startFlushTimer(): void {
  this.flushTimer = setInterval(
    () => this.flush(),
    this.config.flushIntervalMs  // Default: 5000ms
  );
}

private startCleanupTimer(): void {
  // Clean old data once per day
  this.cleanupTimer = setInterval(
    () => this.cleanupOldData(),
    86400000  // 24 hours
  );
}
```

### Recording Request Metrics

```typescript
recordRequest(metric: RequestMetric): void {
  // Update real-time counters
  this.realtimeCounters.totalRequests++;
  this.realtimeCounters.totalLatencyMs += metric.durationMs;

  if (metric.statusCode >= 200 && metric.statusCode < 400) {
    this.realtimeCounters.successfulRequests++;
  } else {
    this.realtimeCounters.failedRequests++;
  }

  // Add to batch
  this.requestBatch.push(metric);

  // Flush if batch is full
  if (this.requestBatch.length >= this.config.batchSize) {
    void this.flush();
  }
}
```

### Batched Database Writes

```typescript
async flush(): Promise<void> {
  if (!this.db) return;

  // Swap batches to allow continued collection
  const requests = this.requestBatch;
  const rateLimits = this.rateLimitBatch;
  const backends = this.backendBatch;

  this.requestBatch = [];
  this.rateLimitBatch = [];
  this.backendBatch = [];

  // Parallel flush to database
  await Promise.all([
    this.flushRequestMetrics(requests),
    this.flushRateLimitMetrics(rateLimits),
    this.flushBackendMetrics(backends)
  ]);
}

private async flushRequestMetrics(batch: RequestMetric[]): Promise<void> {
  if (batch.length === 0) return;

  // Use bulk insert for efficiency
  const values = batch.map(m => [
    m.timestamp,
    m.method,
    m.path,
    m.statusCode,
    m.durationMs,
    m.backend,
    m.clientIp,
    m.errorMessage
  ]);

  await this.db!.query(`
    INSERT INTO request_metrics
      (timestamp, method, path, status_code, duration_ms, backend, client_ip, error_message)
    VALUES ${values.map((_, i) => `($${i*8+1}, $${i*8+2}, $${i*8+3}, $${i*8+4}, $${i*8+5}, $${i*8+6}, $${i*8+7}, $${i*8+8})`).join(', ')}
  `, values.flat());
}
```

---

## 📈 Dashboard Overview Queries

### Real-Time Overview

From in-memory counters for instant response:

```typescript
getRealtimeOverview(): DashboardOverview {
  const c = this.realtimeCounters;
  const avgLatency = c.totalRequests > 0
    ? c.totalLatencyMs / c.totalRequests
    : 0;

  return {
    timestamp: new Date().toISOString(),
    requestsPerSecond: this.calculateRps(),
    avgLatency,
    p95Latency: this.latencyPercentiles.p95,
    p99Latency: this.latencyPercentiles.p99,
    errorRate: this.calculateErrorRate(),
    totalRequests: c.totalRequests,
    successfulRequests: c.successfulRequests,
    failedRequests: c.failedRequests,
    rateLimitedRequests: c.rateLimitedRequests,
    activeConnections: c.activeConnections,
    healthyBackends: c.healthyBackends,
    totalBackends: c.totalBackends
  };
}
```

### Historical Overview

From database for time-range queries:

```typescript
async getOverview(range: TimeRange = '1h'): Promise<DashboardOverview> {
  const { startTime, endTime, bucket } = this.parseTimeRange(range);

  const result = await this.db!.queryOne(`
    SELECT
      COUNT(*) as total_requests,
      COUNT(*) FILTER (WHERE status_code >= 200 AND status_code < 400) as successful,
      COUNT(*) FILTER (WHERE status_code >= 400) as failed,
      AVG(duration_ms) as avg_latency,
      PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY duration_ms) as p95,
      PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY duration_ms) as p99,
      COUNT(*) FILTER (WHERE status_code = 429) as rate_limited
    FROM request_metrics
    WHERE timestamp >= $1 AND timestamp <= $2
  `, [startTime, endTime]);

  return {
    timestamp: new Date().toISOString(),
    totalRequests: result.total_requests,
    successfulRequests: result.successful,
    failedRequests: result.failed,
    avgLatency: result.avg_latency,
    p95Latency: result.p95,
    p99Latency: result.p99,
    rateLimitedRequests: result.rate_limited,
    errorRate: (result.failed / result.total_requests) * 100
  };
}
```

---

## 📉 Time-Series Data

### Request Rate Over Time

```typescript
async getRequestRate(range: TimeRange = '1h'): Promise<RequestRateMetric[]> {
  const { startTime, endTime, bucketSeconds } = this.parseTimeRange(range);

  const results = await this.db!.query(`
    SELECT
      time_bucket('${bucketSeconds} seconds', timestamp) as bucket,
      COUNT(*) as request_count,
      COUNT(*) / ${bucketSeconds}::float as requests_per_second
    FROM request_metrics
    WHERE timestamp >= $1 AND timestamp <= $2
    GROUP BY bucket
    ORDER BY bucket
  `, [startTime, endTime]);

  return results.map(r => ({
    timestamp: r.bucket,
    value: r.requests_per_second
  }));
}
```

### Latency Percentiles Over Time

```typescript
async getLatencyPercentiles(range: TimeRange = '1h'): Promise<LatencyPoint[]> {
  const { startTime, endTime, bucketSeconds } = this.parseTimeRange(range);

  return this.db!.query(`
    SELECT
      time_bucket('${bucketSeconds} seconds', timestamp) as bucket,
      PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY duration_ms) as p50,
      PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY duration_ms) as p95,
      PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY duration_ms) as p99,
      AVG(duration_ms) as avg
    FROM request_metrics
    WHERE timestamp >= $1 AND timestamp <= $2
    GROUP BY bucket
    ORDER BY bucket
  `, [startTime, endTime]);
}
```

### Status Code Distribution

```typescript
async getStatusDistribution(range: TimeRange = '1h'): Promise<StatusDistribution[]> {
  const { startTime, endTime, bucketSeconds } = this.parseTimeRange(range);

  return this.db!.query(`
    SELECT
      time_bucket('${bucketSeconds} seconds', timestamp) as bucket,
      COUNT(*) FILTER (WHERE status_code >= 200 AND status_code < 300) as status_2xx,
      COUNT(*) FILTER (WHERE status_code >= 300 AND status_code < 400) as status_3xx,
      COUNT(*) FILTER (WHERE status_code >= 400 AND status_code < 500) as status_4xx,
      COUNT(*) FILTER (WHERE status_code >= 500) as status_5xx
    FROM request_metrics
    WHERE timestamp >= $1 AND timestamp <= $2
    GROUP BY bucket
    ORDER BY bucket
  `, [startTime, endTime]);
}
```

---

## 🔌 WebSocket Server

### `src/api/websocket.ts`

Real-time metrics streaming via WebSocket:

```typescript
export class MetricsWebSocketServer {
  private wss: WebSocketServer | null = null;
  private clients: Map<string, MetricsWebSocket> = new Map();
  private updateTimer: NodeJS.Timeout | null = null;

  initialize(server: HttpServer): void {
    this.wss = new WebSocketServer({
      server,
      path: '/ws/metrics',
      verifyClient: this.verifyClient.bind(this)
    });

    this.wss.on('connection', this.handleConnection.bind(this));
    this.startUpdateTimer();
  }
}
```

### Client Connection

```typescript
private handleConnection(ws: WebSocket, req: IncomingMessage): void {
  const clientId = generateClientId();
  const client = ws as MetricsWebSocket;

  client.clientId = clientId;
  client.isAlive = true;
  client.subscription = {
    overview: true,
    requestRate: false,
    latencyPercentiles: false,
    statusDistribution: false,
    topEndpoints: false,
    alerts: true
  };

  this.clients.set(clientId, client);

  // Send initial data
  this.sendMetricsToClient(client);

  // Handle messages
  ws.on('message', (data) => this.handleMessage(client, data));

  // Handle disconnect
  ws.on('close', () => {
    this.clients.delete(clientId);
  });

  // Ping for keep-alive
  ws.on('pong', () => {
    client.isAlive = true;
  });
}
```

### Subscription Management

Clients can subscribe to specific metric types:

```typescript
// Client sends:
{
  "type": "subscribe",
  "data": {
    "overview": true,
    "requestRate": true,
    "latencyPercentiles": true,
    "alerts": true
  }
}

// Server updates subscription:
private handleSubscribe(ws: MetricsWebSocket, subscription: Partial<MetricSubscription>): void {
  ws.subscription = {
    ...ws.subscription,
    ...subscription
  };

  // Send confirmation and initial data
  this.sendMessage(ws, {
    type: 'subscribed',
    data: ws.subscription
  });

  this.sendMetricsToClient(ws);
}
```

### Broadcasting Updates

```typescript
async broadcastMetrics(): Promise<void> {
  if (this.clients.size === 0) return;

  // Get current metrics once
  const overview = metricsCollector.getRealtimeOverview();

  // Send to all connected clients
  for (const client of this.clients.values()) {
    await this.sendMetricsToClient(client, overview);
  }
}

private async sendMetricsToClient(
  ws: MetricsWebSocket,
  overview?: DashboardOverview
): Promise<void> {
  const sub = ws.subscription;

  // Build response based on subscription
  const response: any = {
    type: 'metrics',
    timestamp: new Date().toISOString(),
    data: {}
  };

  if (sub.overview) {
    response.data.overview = overview || metricsCollector.getRealtimeOverview();
  }

  if (sub.requestRate) {
    response.data.requestRate = await metricsCollector.getRequestRate('15m');
  }

  if (sub.latencyPercentiles) {
    response.data.latencyPercentiles = await metricsCollector.getLatencyPercentiles('15m');
  }

  if (sub.topEndpoints) {
    response.data.topEndpoints = await metricsCollector.getTopEndpoints('1h');
  }

  this.sendMessage(ws, response);
}
```

---

## 🔔 Alert System

### `src/monitoring/alerts.ts`

The AlertManager evaluates rules and triggers alerts:

```typescript
export class AlertManager {
  private rules: AlertRule[] = [];
  private activeAlerts: Map<string, Alert> = new Map();
  private checkTimer: NodeJS.Timeout | null = null;

  constructor(config: AlertConfig) {
    this.config = config;
    this.rules = config.rules || [];
  }
}
```

### Alert Rule Structure

```typescript
interface AlertRule {
  id: string;
  name: string;
  enabled: boolean;
  severity: 'info' | 'warning' | 'critical';
  condition: {
    metric: 'error_rate' | 'latency_p95' | 'latency_p99' |
            'request_rate' | 'rate_limit_rate';
    operator: '>' | '<' | '>=' | '<=' | '==';
    threshold: number;
    window: '1m' | '5m' | '15m' | '1h';
  };
  cooldownMs: number;  // Minimum time between alerts
  actions: AlertAction[];
}
```

### Rule Evaluation

```typescript
async checkRules(): Promise<void> {
  for (const rule of this.rules) {
    if (!rule.enabled) continue;

    try {
      const value = await this.getMetricValue(rule.condition.metric, rule.condition.window);
      const triggered = this.evaluateCondition(value, rule.condition);

      if (triggered) {
        await this.triggerAlert(rule, value);
      } else {
        this.resolveAlert(rule.id);
      }
    } catch (error) {
      logger.error('Error checking alert rule', { ruleId: rule.id, error });
    }
  }
}

private evaluateCondition(value: number, condition: AlertCondition): boolean {
  const { operator, threshold } = condition;

  switch (operator) {
    case '>': return value > threshold;
    case '<': return value < threshold;
    case '>=': return value >= threshold;
    case '<=': return value <= threshold;
    case '==': return value === threshold;
    default: return false;
  }
}
```

### Triggering Alerts

```typescript
private async triggerAlert(rule: AlertRule, value: number): Promise<void> {
  const existingAlert = this.activeAlerts.get(rule.id);

  // Check cooldown
  if (existingAlert) {
    const timeSince = Date.now() - existingAlert.triggeredAt.getTime();
    if (timeSince < rule.cooldownMs) {
      return; // Still in cooldown
    }
  }

  // Create alert
  const alert: Alert = {
    id: generateAlertId(),
    ruleId: rule.id,
    ruleName: rule.name,
    severity: rule.severity,
    status: 'active',
    message: this.formatMessage(rule, value),
    triggeredAt: new Date(),
    currentValue: value,
    threshold: rule.condition.threshold
  };

  this.activeAlerts.set(rule.id, alert);

  // Execute actions
  for (const action of rule.actions) {
    await this.executeAction(action, alert);
  }

  // Store in database
  await this.storeAlert(alert);

  // Broadcast to WebSocket clients
  wsServer?.broadcastAlert(alert);
}
```

### Alert Actions

```typescript
private async executeAction(action: AlertAction, alert: Alert): Promise<void> {
  switch (action.type) {
    case 'log':
      logger.warn(`Alert triggered: ${alert.ruleName}`, alert);
      break;

    case 'slack':
      await this.sendSlackNotification(alert, action.config);
      break;

    case 'webhook':
      await this.sendWebhookNotification(alert, action.config);
      break;

    case 'email':
      await this.sendEmailNotification(alert, action.config);
      break;
  }
}
```

---

## 📡 Metrics API

### `src/api/routes/metrics.ts`

```typescript
const router = Router();

// Dashboard overview
router.get('/overview', async (req, res) => {
  const range = (req.query.range as TimeRange) || '1h';
  const overview = await metricsCollector.getOverview(range);
  res.json({ success: true, data: overview });
});

// Real-time metrics
router.get('/realtime', (req, res) => {
  const overview = metricsCollector.getRealtimeOverview();
  res.json({ success: true, data: overview });
});

// Request rate time series
router.get('/request-rate', async (req, res) => {
  const range = (req.query.range as TimeRange) || '1h';
  const data = await metricsCollector.getRequestRate(range);
  res.json({ success: true, data });
});

// Latency percentiles time series
router.get('/latency', async (req, res) => {
  const range = (req.query.range as TimeRange) || '1h';
  const data = await metricsCollector.getLatencyPercentiles(range);
  res.json({ success: true, data });
});

// Top endpoints
router.get('/top-endpoints', async (req, res) => {
  const range = (req.query.range as TimeRange) || '1h';
  const limit = parseInt(req.query.limit as string) || 10;
  const data = await metricsCollector.getTopEndpoints(range, limit);
  res.json({ success: true, data });
});

// Backend health
router.get('/backends', (req, res) => {
  const backends = proxyServer.getHealthStatus();
  const circuitBreakers = proxyServer.getCircuitBreakerStates();

  res.json({
    success: true,
    data: {
      summary: {
        total: backends.length,
        healthy: backends.filter(b => b.status === 'healthy').length,
        unhealthy: backends.filter(b => b.status === 'unhealthy').length
      },
      backends: backends.map(b => ({
        ...b,
        circuitBreaker: circuitBreakers[b.name]
      }))
    }
  });
});
```

---

## 📦 Metric Types

### Request Metrics

```typescript
interface RequestMetric {
  timestamp: Date;
  method: string;        // GET, POST, etc.
  path: string;          // /api/users
  statusCode: number;    // 200, 404, 500, etc.
  durationMs: number;    // Response time
  backend?: string;      // Backend that handled request
  clientIp: string;      // Client IP address
  errorMessage?: string; // Error details if failed
}
```

### Rate Limit Metrics

```typescript
interface RateLimitMetric {
  timestamp: Date;
  key: string;           // Rate limit key
  allowed: boolean;      // Was request allowed?
  remaining: number;     // Remaining quota
  limit: number;         // Total limit
}
```

### Backend Metrics

```typescript
interface BackendMetric {
  timestamp: Date;
  backendName: string;
  status: 'healthy' | 'unhealthy';
  responseTimeMs?: number;
}
```

---

## 🔧 Configuration

```yaml
# aegis.config.yaml

metrics:
  enabled: true
  flushIntervalMs: 5000    # How often to write to DB
  batchSize: 100           # Max batch size before flush
  retentionDays: 30        # How long to keep data

  enabledMetrics:
    requests: true
    rateLimits: true
    backends: true
    system: true

  sampling:
    enabled: false         # Enable for high-traffic
    rate: 1.0              # 1.0 = 100%, 0.1 = 10%

dashboard:
  websocket:
    enabled: true
    path: /ws/metrics
    updateIntervalMs: 1000
    maxConnectionsPerIp: 10

alerts:
  enabled: true
  checkIntervalMs: 60000
  defaultCooldownMs: 300000

  rules:
    - id: high-error-rate
      name: 'High Error Rate'
      enabled: true
      severity: critical
      condition:
        metric: error_rate
        operator: '>'
        threshold: 5
        window: '5m'
      actions:
        - type: log
```

---

## 🚀 Next Steps

Now that you understand monitoring:
1. [Authentication](./07-auth.md) - User authentication and authorization
2. [Natural Language Query](./08-nl-query.md) - Query metrics with natural language
