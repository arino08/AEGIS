# Aegis Code Guide for Beginners

This guide explains the codebase file-by-file, designed for developers new to API gateways or TypeScript/Node.js. We'll cover what each file does, why it exists, and how it fits into the system.

---

## Table of Contents

1. [Project Structure Overview](#project-structure-overview)
2. [Entry Points](#entry-points)
3. [Core Gateway](#core-gateway)
4. [Rate Limiting](#rate-limiting)
5. [Monitoring](#monitoring)
6. [Machine Learning](#machine-learning)
7. [Storage](#storage)
8. [Configuration](#configuration)
9. [Testing](#testing)
10. [Frontend](#frontend)

---

## Project Structure Overview

```
aegis/
├── src/              # Backend TypeScript code (Node.js)
├── frontend/         # Next.js React dashboard
├── aegis-ml/         # Python ML models (Flask API)
├── config/           # YAML configuration
├── docker/           # Docker Compose setup
└── tests/            # Unit and integration tests
```

**Think of it as**:
- `src/` = The API gateway server (like a smart traffic cop)
- `frontend/` = The dashboard to watch traffic (like a control room)
- `aegis-ml/` = The AI brain (like a traffic analyst)
- `config/` = The rulebook (like traffic laws)

---

## Entry Points

### `src/index.ts`

**What it does**: Starts the entire application

**Code walkthrough**:
```typescript
import { startGateway } from './gateway';
import { loadConfig } from './config';
import logger from './utils/logger';

async function main() {
  // 1. Load configuration from YAML
  const config = await loadConfig();

  // 2. Start the gateway server
  await startGateway(config);

  logger.info('Aegis Gateway started');
}

main().catch((error) => {
  logger.error('Failed to start:', error);
  process.exit(1);
});
```

**Why it's needed**: Every Node.js app needs an entry point. This is where execution begins when you run `npm start`.

**Beginner concepts**:
- `async/await`: Waits for operations to complete (like loading files)
- `process.exit(1)`: Stops the program with an error code
- `logger.info()`: Writes messages to console/files for debugging

---

## Core Gateway

### `src/gateway/server.ts`

**What it does**: Creates the HTTP server that receives client requests

**Code walkthrough**:
```typescript
import express from 'express';
import { applyMiddleware } from './middleware';

export async function startGateway(config) {
  const app = express(); // Create web server

  // Apply middleware in order
  applyMiddleware(app, config);

  // Start listening for requests
  app.listen(config.gateway.port, () => {
    console.log(`Gateway running on port ${config.gateway.port}`);
  });
}
```

**Why it's needed**: Express is a web framework that handles HTTP requests. This file sets it up.

**Beginner concepts**:
- **Express**: A library that makes building web servers easy
- **Middleware**: Functions that process requests before they reach the final handler
- **Port**: A number (like 8080) that identifies which program receives network traffic

**Analogy**: Think of Express as a receptionist at a hotel. Middleware is the checklist the receptionist follows (check ID, check reservation, assign room).

---

### `src/gateway/router.ts`

**What it does**: Matches incoming requests to upstream services

**Code walkthrough**:
```typescript
interface Route {
  path: string;       // e.g., "/api/users"
  upstream: string;   // e.g., "http://localhost:3001"
  methods: string[];  // e.g., ["GET", "POST"]
}

export function findRoute(req, routes: Route[]) {
  for (const route of routes) {
    // Check if request path matches route path
    if (req.path.startsWith(route.path)) {
      // Check if HTTP method is allowed
      if (route.methods.includes(req.method)) {
        return route;
      }
    }
  }
  return null; // No matching route
}
```

**Why it's needed**: The gateway needs to know where to forward requests. This file contains the routing logic.

**Beginner concepts**:
- **Request path**: The URL part after the domain (e.g., `/api/users`)
- **HTTP method**: GET (read), POST (create), PUT (update), DELETE (remove)
- **Upstream**: The actual backend service that does the real work

**Analogy**: A phone switchboard operator. When a call comes in, they check which extension to forward it to.

---

### `src/gateway/proxy.ts`

**What it does**: Forwards requests to upstream services and returns responses

**Code walkthrough**:
```typescript
import { createProxyMiddleware } from 'http-proxy-middleware';

export function createProxy(route) {
  return createProxyMiddleware({
    target: route.upstream,  // Where to send requests
    changeOrigin: true,      // Change Host header to match upstream
    onProxyReq: (proxyReq, req) => {
      // Add custom headers before forwarding
      proxyReq.setHeader('X-Forwarded-By', 'Aegis');
    },
    onProxyRes: (proxyRes, req, res) => {
      // Modify response if needed
      proxyRes.headers['X-Proxied-By'] = 'Aegis';
    },
    onError: (err, req, res) => {
      // Handle proxy errors
      res.status(502).json({ error: 'Bad Gateway' });
    }
  });
}
```

**Why it's needed**: The gateway acts as a middleman. This file handles the actual forwarding.

**Beginner concepts**:
- **Proxy**: A middleman that forwards requests and responses
- **Headers**: Metadata sent with HTTP requests (like To/From on an envelope)
- **502 Bad Gateway**: HTTP error code meaning the upstream server is down

**Analogy**: A mail carrier. They pick up mail from you, deliver it to the recipient, and bring back the reply.

---

## Rate Limiting

### `src/rate-limiter/limiter.ts`

**What it does**: Controls how many requests a client can make

**Code walkthrough**:
```typescript
import { Redis } from '../storage/redis';

export class TokenBucketLimiter {
  constructor(
    private redis: Redis,
    private limit: number,      // Max tokens (e.g., 100)
    private refillRate: number  // Tokens per second (e.g., 10)
  ) {}

  async checkLimit(clientId: string): Promise<boolean> {
    const key = `ratelimit:${clientId}`;

    // Get current tokens
    const tokens = await this.redis.get(key);

    if (!tokens || parseFloat(tokens) < 1) {
      return false; // No tokens left, reject request
    }

    // Consume one token
    await this.redis.decr(key);
    return true; // Allow request
  }

  async refillTokens(clientId: string) {
    const key = `ratelimit:${clientId}`;
    const tokens = await this.redis.get(key);
    const newTokens = Math.min(
      parseFloat(tokens || '0') + this.refillRate,
      this.limit
    );
    await this.redis.set(key, newTokens);
  }
}
```

**Why it's needed**: Without rate limiting, a single user could overload the server with millions of requests.

**Beginner concepts**:
- **Token Bucket**: Imagine a bucket with 100 coins. Each request costs 1 coin. Coins refill over time.
- **Redis**: A fast database (in-memory) for storing rate limit counters
- **clientId**: Identifier for who's making the request (IP address, API key, etc.)

**Analogy**: A water bucket with a hole. Water drains (tokens consumed), but refills from a tap (refill rate). If empty, you wait.

---

### `src/rate-limiter/middleware.ts`

**What it does**: Integrates rate limiting into the request pipeline

**Code walkthrough**:
```typescript
import { Request, Response, NextFunction } from 'express';
import { RateLimiter } from './limiter';

export function rateLimitMiddleware(limiter: RateLimiter) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const clientId = req.ip; // Use IP address as identifier

    const allowed = await limiter.checkLimit(clientId);

    if (!allowed) {
      // Too many requests, reject
      return res.status(429).json({
        error: 'Too Many Requests',
        retryAfter: 60 // Try again in 60 seconds
      });
    }

    // Request allowed, continue to next middleware
    next();
  };
}
```

**Why it's needed**: This connects the rate limiter to Express, so every request gets checked.

**Beginner concepts**:
- **Middleware function**: Takes `(req, res, next)` and either responds or calls `next()`
- **429 Status Code**: HTTP error for "Too Many Requests"
- **next()**: Pass control to the next middleware in the chain

**Analogy**: A bouncer at a club. Checks if you're on the guest list (rate limit check). If yes, you enter (`next()`). If no, you're turned away (reject with 429).

---

### `src/rate-limiter/algorithms/`

This directory contains different rate limiting strategies:

**`token-bucket.ts`**:
- Allows bursts of traffic (like filling a bucket fast, then draining)
- Good for APIs with occasional spikes

**`sliding-window.ts`**:
- Counts requests in a rolling time window
- More accurate than fixed windows
- Example: 100 requests per minute, counted continuously

**`fixed-window.ts`**:
- Resets counter at fixed intervals (e.g., every minute at :00 seconds)
- Simpler and faster
- Example: 100 requests from 10:00:00 to 10:00:59, then counter resets

**When to use which**:
- Token Bucket: Most APIs (allows bursts)
- Sliding Window: Strict enforcement needed
- Fixed Window: High performance, less precision required

---

## Monitoring

### `src/monitoring/collector.ts`

**What it does**: Collects metrics about requests (latency, errors, etc.)

**Code walkthrough**:
```typescript
interface Metric {
  timestamp: Date;
  path: string;
  method: string;
  statusCode: number;
  latency: number; // milliseconds
}

export class MetricsCollector {
  private metrics: Metric[] = [];

  recordRequest(metric: Metric) {
    this.metrics.push(metric);

    // Flush to database every 10 seconds
    if (this.metrics.length >= 100) {
      this.flushToDatabase();
    }
  }

  async flushToDatabase() {
    // Insert all metrics into PostgreSQL
    await db.insert('request_metrics', this.metrics);
    this.metrics = []; // Clear buffer
  }

  async getLatency(range: string) {
    // Query database for latency in time range
    const rows = await db.query(`
      SELECT
        PERCENTILE_CONT(0.50) AS p50,
        PERCENTILE_CONT(0.95) AS p95,
        PERCENTILE_CONT(0.99) AS p99
      FROM request_metrics
      WHERE timestamp > NOW() - INTERVAL '${range}'
    `);
    return rows[0];
  }
}
```

**Why it's needed**: You can't improve what you don't measure. This collects performance data.

**Beginner concepts**:
- **Latency**: Time taken to process a request (lower is better)
- **Percentiles**: p50 = median, p95 = 95% of requests are faster than this
- **Buffer**: Collect metrics in memory, then write in batch (faster than writing one-by-one)

**Analogy**: A sports coach with a stopwatch. Records every player's sprint time, then analyzes stats (average, fastest, slowest).

---

### `src/monitoring/middleware.ts`

**What it does**: Measures request latency automatically

**Code walkthrough**:
```typescript
export function monitoringMiddleware(collector: MetricsCollector) {
  return (req: Request, res: Response, next: NextFunction) => {
    const startTime = Date.now(); // Record start time

    // Override res.send to capture when response is sent
    const originalSend = res.send;
    res.send = function(data) {
      const latency = Date.now() - startTime; // Calculate duration

      // Record metric
      collector.recordRequest({
        timestamp: new Date(),
        path: req.path,
        method: req.method,
        statusCode: res.statusCode,
        latency
      });

      // Call original send
      return originalSend.call(this, data);
    };

    next(); // Continue to next middleware
  };
}
```

**Why it's needed**: Automatically wraps every request to measure performance without manual code in every handler.

**Beginner concepts**:
- **Function override**: Replace `res.send` with custom version that adds timing
- **Date.now()**: Current time in milliseconds since 1970 (Unix timestamp)
- **Closure**: The `startTime` variable is captured and available later in the override

**Analogy**: A timer that starts when a runner leaves the starting line and stops when they cross the finish line. Happens automatically without the runner doing anything.

---

### `src/monitoring/alerts.ts`

**What it does**: Checks metrics and sends alerts when thresholds are exceeded

**Code walkthrough**:
```typescript
interface AlertRule {
  name: string;
  condition: (metrics: any) => boolean;
  message: string;
}

const rules: AlertRule[] = [
  {
    name: 'HighErrorRate',
    condition: (metrics) => metrics.errorRate > 0.05, // > 5% errors
    message: 'Error rate exceeded 5%'
  },
  {
    name: 'HighLatency',
    condition: (metrics) => metrics.p95 > 500, // p95 > 500ms
    message: 'Latency p95 exceeded 500ms'
  }
];

export async function checkAlerts(collector: MetricsCollector) {
  const metrics = await collector.getMetrics('5m');

  for (const rule of rules) {
    if (rule.condition(metrics)) {
      // Send alert (email, Slack, PagerDuty, etc.)
      await sendAlert(rule);
    }
  }
}
```

**Why it's needed**: Proactive monitoring. Get notified before users complain.

**Beginner concepts**:
- **Threshold**: A limit that triggers an alert (e.g., > 5% errors)
- **Error rate**: Percentage of requests that failed (4xx, 5xx status codes)
- **Alerting**: Sending notifications via email, Slack, SMS, etc.

**Analogy**: A fire alarm. Constantly checks temperature. If too hot, triggers alarm to notify firefighters.

---

## Machine Learning

### `aegis-ml/models/anomaly_detector.py`

**What it does**: Detects unusual traffic patterns (DDoS attacks, bots, etc.)

**Code walkthrough**:
```python
from sklearn.ensemble import IsolationForest
import numpy as np

class AnomalyDetector:
    def __init__(self):
        # Train model with normal traffic patterns
        self.model = IsolationForest(contamination=0.01)

    def train(self, normal_traffic):
        """
        normal_traffic: List of [request_rate, latency, error_rate]
        """
        X = np.array(normal_traffic)
        self.model.fit(X)

    def predict(self, current_traffic):
        """
        Returns: -1 (anomaly) or 1 (normal)
        """
        X = np.array([current_traffic])
        prediction = self.model.predict(X)
        return prediction[0]

    def score(self, current_traffic):
        """
        Returns: Anomaly score (higher = more anomalous)
        """
        X = np.array([current_traffic])
        score = self.model.decision_function(X)
        return -score[0]  # Negate so higher = more anomalous
```

**Why it's needed**: Humans can't watch traffic 24/7. ML automates detection of abnormal patterns.

**Beginner concepts**:
- **Isolation Forest**: ML algorithm that isolates outliers (unusual data points)
- **Training**: Teaching the model what "normal" looks like using historical data
- **Prediction**: Model decides if new data is normal or anomalous
- **Contamination**: Expected percentage of anomalies (1% = 1 in 100 requests)

**Analogy**: A security guard who knows all regular visitors. If a stranger appears, they're flagged as unusual.

---

### `aegis-ml/api/flask_server.py`

**What it does**: Exposes ML models as an HTTP API

**Code walkthrough**:
```python
from flask import Flask, request, jsonify
from models.anomaly_detector import AnomalyDetector

app = Flask(__name__)
detector = AnomalyDetector()

@app.route('/predict/anomaly', methods=['POST'])
def predict_anomaly():
    data = request.json
    metrics = data['metrics']  # [request_rate, latency, error_rate]

    score = detector.score(metrics)
    is_anomaly = score > 0.7  # Threshold for anomaly

    return jsonify({
        'score': score,
        'is_anomaly': is_anomaly
    })

if __name__ == '__main__':
    app.run(port=5001)
```

**Why it's needed**: Gateway (Node.js) needs to call ML models (Python). Flask provides the HTTP interface.

**Beginner concepts**:
- **Flask**: Python web framework (like Express for Node.js)
- **REST API**: HTTP endpoints that accept JSON and return JSON
- **@app.route**: Decorator that maps URL paths to functions

**Analogy**: A translator between two people who speak different languages (Node.js and Python).

---

## Storage

### `src/storage/redis.ts`

**What it does**: Connects to Redis for caching and rate limiting

**Code walkthrough**:
```typescript
import { createClient } from 'redis';

export class RedisClient {
  private client;

  async connect(url: string) {
    this.client = createClient({ url });
    await this.client.connect();
  }

  async get(key: string): Promise<string | null> {
    return await this.client.get(key);
  }

  async set(key: string, value: string, ttl?: number) {
    if (ttl) {
      // Set with expiration (in seconds)
      await this.client.setEx(key, ttl, value);
    } else {
      await this.client.set(key, value);
    }
  }

  async incr(key: string): Promise<number> {
    return await this.client.incr(key); // Increment counter
  }
}
```

**Why it's needed**: Redis is fast (in-memory) and perfect for rate limiting counters.

**Beginner concepts**:
- **Redis**: Key-value store (like a dictionary/hash map) in memory
- **TTL (Time To Live)**: Automatically delete key after X seconds
- **Atomic operations**: `incr` increments without race conditions (safe for concurrency)

**Analogy**: A whiteboard where you write numbers. Faster than looking up in a filing cabinet (database). Numbers auto-erase after timeout.

---

### `src/storage/postgres.ts`

**What it does**: Connects to PostgreSQL for persistent storage

**Code walkthrough**:
```typescript
import { Pool } from 'pg';

export class PostgresClient {
  private pool: Pool;

  constructor(config) {
    this.pool = new Pool({
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.user,
      password: config.password,
      max: 20  // Max 20 connections
    });
  }

  async query(sql: string, params?: any[]) {
    const client = await this.pool.connect();
    try {
      const result = await client.query(sql, params);
      return result.rows;
    } finally {
      client.release(); // Return connection to pool
    }
  }

  async insert(table: string, data: any[]) {
    const columns = Object.keys(data[0]).join(', ');
    const values = data.map(row =>
      `(${Object.values(row).map(v => `'${v}'`).join(', ')})`
    ).join(', ');

    await this.query(`INSERT INTO ${table} (${columns}) VALUES ${values}`);
  }
}
```

**Why it's needed**: PostgreSQL stores metrics permanently (Redis is temporary).

**Beginner concepts**:
- **Connection pool**: Reuse database connections instead of creating new ones (faster)
- **SQL**: Query language for databases (SELECT, INSERT, UPDATE, DELETE)
- **Transactions**: Group multiple queries into atomic operations

**Analogy**: A filing cabinet for long-term storage. Slower than a whiteboard (Redis) but data persists.

---

## Configuration

### `config/aegis.config.yaml`

**What it does**: Stores all configuration in one place

**Example**:
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
```

**Why it's needed**: Avoid hardcoding values in code. Easy to change without redeploying.

**Beginner concepts**:
- **YAML**: Human-readable config format (like JSON but simpler)
- **Environment-specific**: Different configs for dev, staging, production

**Analogy**: A settings menu in a video game. Change difficulty, volume, etc. without modifying game code.

---

### `src/config/loader.ts`

**What it does**: Loads and validates YAML config

**Code walkthrough**:
```typescript
import * as yaml from 'js-yaml';
import * as fs from 'fs';
import { configSchema } from './schema';

export async function loadConfig(): Promise<Config> {
  // Read YAML file
  const fileContents = fs.readFileSync('config/aegis.config.yaml', 'utf8');

  // Parse YAML to JavaScript object
  const config = yaml.load(fileContents);

  // Validate against schema
  const { error } = configSchema.validate(config);
  if (error) {
    throw new Error(`Invalid config: ${error.message}`);
  }

  return config;
}
```

**Why it's needed**: Validate config early (before starting server) to catch errors.

**Beginner concepts**:
- **Schema validation**: Define expected structure (types, required fields, etc.)
- **Fail fast**: If config is invalid, crash immediately with clear error message

**Analogy**: A spell checker for config files. Catches typos before you run the program.

---

## Testing

### `tests/gateway.test.ts`

**What it does**: Automated tests for gateway functionality

**Code walkthrough**:
```typescript
import { startGateway } from '../src/gateway';
import request from 'supertest';

describe('Gateway', () => {
  let app;

  beforeAll(async () => {
    // Start gateway with test config
    app = await startGateway(testConfig);
  });

  test('should proxy request to upstream', async () => {
    const response = await request(app)
      .get('/api/users')
      .expect(200);

    expect(response.body).toHaveProperty('users');
  });

  test('should return 404 for unknown routes', async () => {
    await request(app)
      .get('/unknown')
      .expect(404);
  });
});
```

**Why it's needed**: Automated tests catch bugs before they reach production.

**Beginner concepts**:
- **Unit test**: Test a single function/component in isolation
- **Integration test**: Test multiple components working together
- **supertest**: Library for testing HTTP servers
- **expect()**: Assert that result matches expectation

**Analogy**: A quality control inspector testing products before shipment. Rejects defective items.

---

## Frontend

### `frontend/src/app/page.tsx`

**What it does**: Main dashboard page (React component)

**Code walkthrough**:
```typescript
'use client';
import { useState, useEffect } from 'react';
import { fetchMetrics } from '@/lib/api';

export default function Dashboard() {
  const [metrics, setMetrics] = useState(null);

  useEffect(() => {
    // Fetch metrics every 5 seconds
    const interval = setInterval(async () => {
      const data = await fetchMetrics('15m');
      setMetrics(data);
    }, 5000);

    return () => clearInterval(interval); // Cleanup on unmount
  }, []);

  return (
    <div>
      <h1>Aegis Dashboard</h1>
      {metrics && (
        <div>
          <p>Latency p95: {metrics.latency.p95}ms</p>
          <p>Throughput: {metrics.throughput} req/s</p>
        </div>
      )}
    </div>
  );
}
```

**Why it's needed**: Visual interface for monitoring. Easier than reading logs.

**Beginner concepts**:
- **React**: Library for building user interfaces
- **useState**: React hook for storing component state
- **useEffect**: React hook for side effects (API calls, timers, etc.)
- **'use client'**: Next.js directive for client-side rendering

**Analogy**: A car dashboard showing speed, fuel, engine temperature. Easier than reading raw sensor data.

---

## Key Takeaways

1. **Separation of Concerns**: Each directory has a clear purpose (gateway, rate limiting, monitoring, etc.)
2. **Middleware Pattern**: Requests flow through a pipeline of functions
3. **Storage Strategy**: Redis for fast access, PostgreSQL for persistence
4. **Async/Await**: Node.js handles I/O operations asynchronously (non-blocking)
5. **Type Safety**: TypeScript catches errors at compile-time
6. **Testing**: Automated tests ensure code works correctly

---

## Next Steps for Beginners

1. **Read in this order**:
   - `src/index.ts` → `src/gateway/server.ts` → `src/gateway/middleware/`
   - Follow the request flow through the codebase

2. **Modify a feature**:
   - Change rate limit from 100 to 50 requests/min
   - Add a new metric (e.g., request body size)

3. **Add a new route**:
   - Edit `config/aegis.config.yaml`
   - Test with `curl` or Postman

4. **Run tests**:
   - `npm test` to run all tests
   - See which tests pass/fail

5. **Explore the database**:
   - Connect to PostgreSQL: `docker exec -it aegis-postgres psql -U aegis`
   - Query metrics: `SELECT * FROM request_metrics LIMIT 10;`

---

## Common Patterns Explained

### Dependency Injection

Instead of:
```typescript
// Bad: Hard to test
const redis = new RedisClient('localhost:6379');
```

Do:
```typescript
// Good: Inject dependency
function createLimiter(redis: RedisClient) {
  return new RateLimiter(redis);
}
```

**Why**: Easier to test (pass mock Redis) and configure.

---

### Error Handling

```typescript
try {
  await riskyOperation();
} catch (error) {
  logger.error('Operation failed:', error);
  // Return user-friendly error
  res.status(500).json({ error: 'Internal Server Error' });
}
```

**Why**: Prevent crashes and log errors for debugging.

---

### Async Patterns

```typescript
// Sequential (slow)
const users = await fetchUsers();
const posts = await fetchPosts();

// Parallel (fast)
const [users, posts] = await Promise.all([
  fetchUsers(),
  fetchPosts()
]);
```

**Why**: Run independent operations in parallel for better performance.

---

## Glossary

- **API Gateway**: Reverse proxy that routes requests to backend services
- **Middleware**: Function in the request-response pipeline
- **Rate Limiting**: Controlling request frequency per client
- **Latency**: Time taken to process a request
- **Throughput**: Requests processed per second
- **Percentile**: Statistical measure (p95 = 95th percentile)
- **Anomaly**: Unusual pattern in data
- **Upstream**: Backend service behind the gateway
- **Proxy**: Intermediary that forwards requests
- **TTL**: Time To Live (expiration time)

---

## Resources

- [Express.js Docs](https://expressjs.com/)
- [TypeScript Handbook](https://www.typescriptlang.org/docs/)
- [Redis Commands](https://redis.io/commands/)
- [PostgreSQL Tutorial](https://www.postgresql.org/docs/current/tutorial.html)
- [React Docs](https://react.dev/)

For more details, see:
- [ARCHITECTURE.md](./ARCHITECTURE.md) - System design
- [Feature Docs](./features/) - Deep dives per feature
- [API Reference](./API_REFERENCE.md) - Complete API documentation
