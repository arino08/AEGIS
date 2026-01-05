# 02. Architecture

## System Overview

AEGIS follows a modular architecture where each component has a specific responsibility. Understanding these components and their interactions is key to working with the codebase.

---

## 🏛️ High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                                  CLIENTS                                     │
│                    (Web, Mobile, CLI, Other Services)                        │
└───────────────────────────────────┬─────────────────────────────────────────┘
                                    │ HTTP/WebSocket
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              AEGIS GATEWAY                                   │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │                         EXPRESS SERVER                                   ││
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐ ││
│  │  │ Request  │→ │   Auth   │→ │   Rate   │→ │ Metrics  │→ │  Proxy   │ ││
│  │  │   ID     │  │Middleware│  │ Limiter  │  │Collector │  │ Handler  │ ││
│  │  └──────────┘  └──────────┘  └──────────┘  └──────────┘  └──────────┘ ││
│  └─────────────────────────────────────────────────────────────────────────┘│
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │                           API ROUTES                                     ││
│  │  /api/metrics  │  /api/health  │  /api/alerts  │  /api/nl-query         ││
│  └─────────────────────────────────────────────────────────────────────────┘│
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │                        WEBSOCKET SERVER                                  ││
│  │                    Real-time metrics streaming                           ││
│  └─────────────────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────────────┘
         │                    │                    │                    │
         │                    │                    │                    │
         ▼                    ▼                    ▼                    ▼
    ┌─────────┐         ┌─────────┐         ┌─────────┐         ┌─────────┐
    │ Backend │         │  Redis  │         │Postgres │         │   ML    │
    │Services │         │         │         │         │         │ Service │
    └─────────┘         └─────────┘         └─────────┘         └─────────┘
```

---

## 📦 Component Breakdown

### 1. Gateway Server (`src/gateway/server.ts`)
The main orchestrator that:
- Creates and configures the Express application
- Initializes all services (Redis, PostgreSQL, Rate Limiter)
- Sets up middleware pipeline
- Manages graceful shutdown

### 2. Proxy Server (`src/gateway/proxy.ts`)
Handles request forwarding:
- Matches requests to backend routes
- Implements circuit breaker pattern
- Manages retries and timeouts
- Handles WebSocket upgrades

### 3. Router (`src/gateway/router.ts`)
Routes requests to backends:
- Compiles route patterns to regex
- Calculates route specificity
- Matches incoming paths

### 4. Rate Limiter (`src/rate-limiter/`)
Prevents API abuse:
- Multiple algorithms (Token Bucket, Sliding Window, Fixed Window)
- Rule-based rate limiting
- Bypass checking for trusted sources

### 5. Metrics Collector (`src/monitoring/collector.ts`)
Collects and stores metrics:
- Batches metrics for efficient storage
- Provides real-time and historical queries
- Calculates aggregations and percentiles

### 6. Auth Service (`src/auth/`)
Handles authentication:
- API key validation
- JWT verification
- OAuth 2.0 integration
- RBAC (Role-Based Access Control)

### 7. NL Query Service (`src/nl-query/`)
Processes natural language queries:
- Converts questions to SQL
- Executes queries safely
- Returns formatted responses

### 8. Storage Layer (`src/storage/`)
Database connections:
- PostgreSQL client for metrics
- Redis client for rate limiting

---

## 🔄 Request Lifecycle

Let's trace a request through the system:

```
1. CLIENT SENDS REQUEST
   GET /api/users
   │
   ▼
2. EXPRESS RECEIVES REQUEST
   - Parses headers, query, body
   │
   ▼
3. REQUEST ID MIDDLEWARE
   - Generates unique request ID
   - Adds X-Request-ID header
   │
   ▼
4. REQUEST LOGGER MIDDLEWARE
   - Logs request start
   - Records timing
   │
   ▼
5. AUTHENTICATION MIDDLEWARE
   - Checks auth requirements
   - Validates credentials
   - Returns 401 if unauthorized
   │
   ▼
6. RATE LIMIT MIDDLEWARE
   - Checks rate limit rules
   - Consumes quota if allowed
   - Returns 429 if limit exceeded
   │
   ▼
7. METRICS MIDDLEWARE
   - Records request start
   - Sets up response tracking
   │
   ▼
8. PROXY MIDDLEWARE
   - Matches route to backend
   - Checks circuit breaker state
   - Forwards request to backend
   - Receives response
   │
   ▼
9. RESPONSE PROCESSING
   - Records metrics
   - Updates circuit breaker
   - Transforms response headers
   │
   ▼
10. CLIENT RECEIVES RESPONSE
    HTTP 200 OK + data
```

---

## 🗄️ Data Storage Architecture

### PostgreSQL Schema

```sql
-- Request metrics table
CREATE TABLE request_metrics (
  id SERIAL PRIMARY KEY,
  timestamp TIMESTAMPTZ NOT NULL,
  method VARCHAR(10),
  path VARCHAR(500),
  status_code INTEGER,
  duration_ms REAL,
  backend VARCHAR(100),
  client_ip VARCHAR(50),
  error_message TEXT
);

-- Rate limit metrics table
CREATE TABLE rate_limit_metrics (
  id SERIAL PRIMARY KEY,
  timestamp TIMESTAMPTZ NOT NULL,
  key VARCHAR(500),
  allowed BOOLEAN,
  remaining INTEGER,
  limit_value INTEGER
);

-- Backend metrics table
CREATE TABLE backend_metrics (
  id SERIAL PRIMARY KEY,
  timestamp TIMESTAMPTZ NOT NULL,
  backend_name VARCHAR(100),
  status VARCHAR(20),
  response_time_ms REAL
);
```

### Redis Data Structures

```
Rate Limiting Keys:
├── ratelimit:token:{key}          # Token bucket data (hash)
├── ratelimit:sliding:{key}        # Sorted set of timestamps
├── ratelimit:fixed:{key}:{window} # Counter for fixed window
└── ratelimit:bypass:{key}         # Cached bypass decisions

Cache Keys:
├── auth:apikey:{hash}             # API key lookup cache
└── config:cache                   # Configuration cache
```

---

## 🔌 Service Communication

### Internal (TypeScript Modules)
Modules communicate through:
- **Direct imports**: `import { RateLimiter } from './rate-limiter'`
- **Singleton instances**: One shared instance per service
- **Event emitters**: For loose coupling (circuit breaker events)

### External (Network)

| From | To | Protocol | Purpose |
|------|-----|----------|---------|
| Gateway | Redis | TCP/6379 | Rate limiting |
| Gateway | PostgreSQL | TCP/5432 | Metrics storage |
| Gateway | ML Service | HTTP/5000 | Anomaly detection |
| Gateway | Backends | HTTP | Request forwarding |
| Dashboard | Gateway | WebSocket | Real-time metrics |
| Dashboard | Gateway | HTTP | API calls |

---

## 📊 Middleware Pipeline

The Express middleware executes in this order:

```typescript
// 1. Core middleware
app.use(helmet());           // Security headers
app.use(cors());            // CORS handling
app.use(compression());     // Response compression
app.use(express.json());    // Body parsing

// 2. Request tracking
app.use(requestIdMiddleware);   // Generate request ID
app.use(requestLoggerMiddleware); // Log requests

// 3. API routes (bypass proxy)
app.use('/api', apiRouter);     // Dashboard API
app.use('/_aegis', statusRoutes); // Gateway status

// 4. Gateway pipeline
app.use(authMiddleware);        // Authentication
app.use(rateLimitMiddleware);   // Rate limiting
app.use(metricsMiddleware);     // Metrics collection

// 5. Proxy (catch-all)
app.use(proxyMiddleware);       // Forward to backends

// 6. Error handling
app.use(errorHandler);          // Global error handler
```

---

## 🧱 Module Dependencies

```
                    ┌────────────────┐
                    │    index.ts    │ (Entry point)
                    └───────┬────────┘
                            │
                    ┌───────▼────────┐
                    │  GatewayServer │
                    └───────┬────────┘
          ┌─────────────────┼─────────────────┐
          │                 │                 │
   ┌──────▼───────┐  ┌──────▼───────┐  ┌──────▼───────┐
   │ ProxyServer  │  │ RateLimiter  │  │   Metrics    │
   │              │  │              │  │  Collector   │
   └──────┬───────┘  └──────┬───────┘  └──────┬───────┘
          │                 │                 │
   ┌──────▼───────┐  ┌──────▼───────┐  ┌──────▼───────┐
   │    Router    │  │ Algorithms   │  │  PostgreSQL  │
   │CircuitBreaker│  │   (Token,    │  │    Client    │
   │ HealthChecker│  │   Sliding,   │  └──────────────┘
   └──────────────┘  │   Fixed)     │
                     └──────┬───────┘
                            │
                     ┌──────▼───────┐
                     │    Redis     │
                     │    Client    │
                     └──────────────┘
```

---

## ⚙️ Configuration Flow

```
Environment Variables (.env)
        │
        ▼
┌───────────────────┐
│  ConfigLoader     │ ◀──── YAML File (aegis.config.yaml)
│                   │
│  - Loads from file│
│  - Merges env vars│
│  - Validates      │
│  - Hot reload     │
└───────┬───────────┘
        │
        ▼
┌───────────────────┐
│   AegisConfig     │ (Validated config object)
│                   │
│  - server         │
│  - backends       │
│  - rateLimit      │
│  - postgres       │
│  - redis          │
│  - auth           │
│  - metrics        │
└───────────────────┘
        │
        ▼
    All Services
```

---

## 🔄 Hot Reload Architecture

```
                    File System
                         │
                    ┌────▼────┐
                    │chokidar │ (File watcher)
                    └────┬────┘
                         │ (file changed)
                    ┌────▼────────────┐
                    │  ConfigLoader   │
                    │                 │
                    │ 1. Reload file  │
                    │ 2. Validate     │
                    │ 3. Diff changes │
                    └────┬────────────┘
                         │ (callbacks)
         ┌───────────────┼───────────────┐
         │               │               │
   ┌─────▼─────┐   ┌─────▼─────┐   ┌─────▼─────┐
   │ProxyServer│   │RateLimiter│   │  Router   │
   │.updateCfg │   │.setConfig │   │.register  │
   └───────────┘   └───────────┘   └───────────┘
```

---

## 🔒 Security Architecture

### Defense in Depth

```
Layer 1: Network
├── Firewall rules
├── TLS termination
└── IP filtering

Layer 2: Gateway
├── Rate limiting
├── Request size limits
├── Security headers (Helmet)
└── CORS policy

Layer 3: Authentication
├── API key validation
├── JWT verification
├── OAuth integration
└── Session management

Layer 4: Authorization
├── RBAC permissions
├── Path-based rules
└── Method restrictions

Layer 5: Backend
├── Request validation
├── Data sanitization
└── Business logic checks
```

---

## 📈 Scalability Considerations

### Horizontal Scaling

```
                    ┌──────────────┐
                    │ Load Balancer│
                    └──────┬───────┘
           ┌───────────────┼───────────────┐
           │               │               │
    ┌──────▼──────┐ ┌──────▼──────┐ ┌──────▼──────┐
    │   AEGIS 1   │ │   AEGIS 2   │ │   AEGIS 3   │
    └──────┬──────┘ └──────┬──────┘ └──────┬──────┘
           │               │               │
           └───────────────┼───────────────┘
                           │
                   ┌───────▼───────┐
                   │  Shared Redis │
                   └───────────────┘
```

Key for horizontal scaling:
- **Shared Redis**: Distributed rate limiting state
- **Stateless Gateway**: No session state in gateway
- **Database Connection Pooling**: Efficient PostgreSQL connections

### Vertical Scaling Tips
- Increase Node.js event loop throughput with clustering
- Tune PostgreSQL connection pool size
- Increase Redis max connections

---

## 🚀 Next Steps

Now that you understand the architecture:
1. [Backend Deep Dive](./03-backend-deep-dive.md) - Explore the codebase structure
2. [Gateway Core](./04-gateway-core.md) - Understand the main server implementation
