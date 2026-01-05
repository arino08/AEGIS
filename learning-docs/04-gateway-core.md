# 04. Gateway Core

## Overview

The gateway core is the heart of AEGIS. It handles all incoming requests, routes them to appropriate backends, and manages the entire request lifecycle. This document explains the three main components:

1. **GatewayServer** - The main server orchestrator
2. **ProxyServer** - Request forwarding with retry and circuit breaker
3. **Router** - Route matching and backend selection

---

## 🖥️ Gateway Server (`src/gateway/server.ts`)

The `GatewayServer` class is the main orchestrator that brings together all components.

### Class Structure

```typescript
export class GatewayServer {
  // Core components
  private app: Application;           // Express application
  private server: http.Server | null; // HTTP server instance
  private config: AegisConfig | null; // Configuration

  // Services
  private proxyServer: ProxyServer | null;
  private router: Router;
  private rateLimiter: RateLimiter | null;
  private metricsCollector: MetricsCollector | null;
  private authService: AuthService | null;
  private rbacService: RbacService | null;
  private alertManager: AlertManager | null;

  // Connections
  private redisClient: RedisClient | null;
  private postgresClient: PostgresClient | null;
  private wsServer: MetricsWebSocketServer | null;
}
```

### Initialization Flow

```typescript
async initialize(): Promise<void> {
  // 1. Load configuration if not provided
  if (!this.config) {
    this.config = await this.configLoader.load();
  }

  // 2. Initialize Redis for rate limiting
  await this.initializeRedis();

  // 3. Initialize PostgreSQL for metrics
  await this.initializePostgres();

  // 4. Initialize rate limiter (uses Redis)
  this.initializeRateLimiter();

  // 5. Initialize metrics collector (uses PostgreSQL)
  await this.initializeMetrics();

  // 6. Initialize authentication services
  this.initializeAuth();

  // 7. Set up Express middleware
  this.setupMiddleware();

  // 8. Set up API routes
  this.setupRoutes();

  // 9. Enable hot reload if configured
  if (this.config.hotReload) {
    this.setupHotReload();
  }
}
```

### Middleware Pipeline

The middleware is set up in a specific order - this order matters!

```typescript
private setupMiddleware(): void {
  const app = this.app;
  const config = this.config!;

  // ============ SECURITY & PARSING ============

  // Security headers (XSS, CSRF protection, etc.)
  app.use(helmet({
    contentSecurityPolicy: false  // Disable for API gateway
  }));

  // CORS - Allow cross-origin requests
  app.use(cors({
    origin: config.dashboard?.allowedOrigins || ['*'],
    credentials: true
  }));

  // Compress responses
  app.use(compression());

  // Parse JSON bodies
  app.use(express.json({ limit: '10mb' }));

  // ============ REQUEST TRACKING ============

  // Generate unique request ID for every request
  app.use(createRequestIdMiddleware());

  // Log all requests
  app.use(createRequestLoggerMiddleware());

  // ============ INTERNAL ROUTES ============

  // Health checks (bypass auth and rate limiting)
  app.get('/health', this.healthCheck.bind(this));
  app.get('/healthz', this.healthCheck.bind(this));
  app.get('/ready', this.readinessCheck.bind(this));

  // Gateway status endpoints
  app.get('/_aegis/status', this.getStatus.bind(this));
  app.get('/_aegis/routes', this.getRoutes.bind(this));
  app.get('/_aegis/rate-limit', this.getRateLimitStatus.bind(this));

  // Dashboard API routes
  app.use('/api', this.createApiRouter());

  // ============ GATEWAY PIPELINE ============

  // Authentication (if enabled)
  if (config.auth?.enabled) {
    app.use(createAuthMiddleware(this.authService!, this.rbacService!));
  }

  // Rate limiting (if enabled and Redis connected)
  if (this.rateLimiter && config.rateLimit?.enabled) {
    app.use(createRateLimitMiddleware(this.rateLimiter, {
      onExceeded: this.handleRateLimitExceeded.bind(this)
    }));
  }

  // Metrics collection
  if (this.metricsCollector) {
    app.use(createMetricsMiddleware(this.metricsCollector));
  }

  // ============ PROXY ============

  // All remaining requests go to proxy
  app.use(this.proxyServer!.middleware());

  // ============ ERROR HANDLING ============

  app.use(createErrorHandler());
}
```

### Starting the Server

```typescript
async start(): Promise<void> {
  const { port, host } = this.config!.server;

  return new Promise((resolve) => {
    // Create HTTP server
    this.server = http.createServer(this.app);

    // Handle WebSocket upgrades (for proxied WebSocket connections)
    this.server.on('upgrade', (req, socket, head) => {
      this.proxyServer?.handleUpgrade(req, socket, head);
    });

    // Initialize WebSocket server for dashboard
    if (this.config!.dashboard?.websocket?.enabled) {
      this.wsServer = new MetricsWebSocketServer({
        updateInterval: this.config!.dashboard.websocket.updateIntervalMs
      });
      this.wsServer.initialize(this.server);
    }

    // Start listening
    this.server.listen(port, host, () => {
      logLifecycle('ready', `Gateway listening on ${host}:${port}`);
      resolve();
    });
  });
}
```

### Graceful Shutdown

```typescript
async shutdown(signal?: string): Promise<void> {
  if (this.isShuttingDown) return;
  this.isShuttingDown = true;

  logLifecycle('shutdown', `Shutting down... (${signal})`);

  // 1. Stop accepting new connections
  if (this.server) {
    await new Promise<void>((resolve) => {
      this.server!.close(() => resolve());
    });
  }

  // 2. Shutdown WebSocket server
  this.wsServer?.shutdown();

  // 3. Flush pending metrics
  await this.metricsCollector?.shutdown();

  // 4. Close database connections
  await this.postgresClient?.close();
  await this.redisClient?.disconnect();

  logLifecycle('shutdown', 'Shutdown complete');
}
```

---

## 🔀 Proxy Server (`src/gateway/proxy.ts`)

The `ProxyServer` handles forwarding requests to backend services.

### Class Structure

```typescript
export class ProxyServer {
  private proxy: httpProxy;                    // http-proxy instance
  private config: AegisConfig;                 // Gateway configuration
  private stats: ProxyStats;                   // Request statistics
  private circuitBreakerManager: CircuitBreakerManager;
  private healthChecker: HealthChecker;

  // Event callbacks
  private onRequestStart?: (req: ProxyRequest) => void;
  private onRequestEnd?: (req: ProxyRequest, res: Response, duration: number) => void;
  private onProxyError?: (req: ProxyRequest, error: Error) => void;
}
```

### Proxy Middleware

```typescript
middleware(): (req: Request, res: Response, next: NextFunction) => void {
  return (req: Request, res: Response, next: NextFunction) => {
    const startTime = Date.now();

    // 1. Find matching backend for this request
    const match = this.findBackend(req.path);

    if (!match) {
      // No backend configured for this path
      res.status(404).json({
        error: 'Not Found',
        message: `No backend configured for path: ${req.path}`
      });
      return;
    }

    // 2. Attach match info to request
    (req as ProxyRequest).routeMatch = match;
    (req as ProxyRequest).backend = match.backend;

    // 3. Notify listeners of request start
    this.onRequestStart?.(req as ProxyRequest);

    // 4. Forward request to backend with retry and circuit breaker
    this.proxyWithRetry(req as ProxyRequest, res, match.backend)
      .then(() => {
        const duration = Date.now() - startTime;
        this.onRequestEnd?.(req as ProxyRequest, res, duration);
      })
      .catch((error) => {
        this.onProxyError?.(req as ProxyRequest, error);
        next(error);
      });
  };
}
```

### Find Backend Logic

```typescript
findBackend(path: string): RouteMatch | null {
  // Use the router to find matching backend
  return this.router.match(path);
}
```

### Proxy With Retry

```typescript
async proxyWithRetry(
  req: ProxyRequest,
  res: Response,
  backend: BackendConfig
): Promise<void> {
  const maxRetries = backend.retries ?? 2;
  const circuitBreaker = this.circuitBreakerManager.get(backend.name);

  // Check circuit breaker state
  if (!circuitBreaker.canRequest()) {
    throw new CircuitOpenError(
      backend.name,
      circuitBreaker.getTimeUntilReset()
    );
  }

  let lastError: Error | null = null;

  // Attempt with retries
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      await this.executeProxy(req, res, backend);

      // Success - record and return
      circuitBreaker.recordSuccess();
      return;

    } catch (error) {
      lastError = error as Error;

      // Record failure
      circuitBreaker.recordFailure(lastError);

      // Don't retry on client errors (4xx)
      if (this.isClientError(lastError)) {
        throw lastError;
      }

      // Log retry attempt
      if (attempt < maxRetries) {
        logger.warn(`Retry ${attempt + 1}/${maxRetries} for ${backend.name}`, {
          error: lastError.message
        });
        await delay(1000 * Math.pow(2, attempt)); // Exponential backoff
      }
    }
  }

  throw lastError;
}
```

### Execute Proxy

```typescript
async executeProxy(
  req: ProxyRequest,
  res: Response,
  backend: BackendConfig
): Promise<void> {
  return new Promise((resolve, reject) => {
    // Set timeout
    const timeout = backend.timeout ?? 30000;
    const timeoutId = setTimeout(() => {
      reject(new Error(`Request timeout after ${timeout}ms`));
    }, timeout);

    // Set up one-time error handler
    const onError = (err: Error) => {
      clearTimeout(timeoutId);
      reject(err);
    };
    this.proxy.once('error', onError);

    // Set up success handler
    const onProxyRes = () => {
      clearTimeout(timeoutId);
      this.proxy.removeListener('error', onError);
      resolve();
    };
    this.proxy.once('proxyRes', onProxyRes);

    // Execute proxy request
    this.proxy.web(req, res, {
      target: backend.url,
      changeOrigin: true,
      xfwd: true,  // Add X-Forwarded-* headers
    });
  });
}
```

### WebSocket Upgrade Handling

```typescript
handleUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
  const match = this.findBackend(req.url ?? '/');

  if (!match) {
    socket.destroy();
    return;
  }

  // Proxy the WebSocket connection
  this.proxy.ws(req, socket, head, {
    target: match.backend.url,
    changeOrigin: true
  });
}
```

---

## 🗺️ Router (`src/gateway/router.ts`)

The `Router` handles matching incoming requests to backend services.

### Route Pattern Compilation

```typescript
export class Router {
  private routes: CompiledRoute[] = [];
  private backends = new Map<string, BackendConfig>();

  registerBackends(backends: BackendConfig[]): void {
    this.routes = [];
    this.backends.clear();

    for (const backend of backends) {
      this.backends.set(backend.name, backend);

      for (const pattern of backend.routes) {
        const compiled = this.compileRoute(pattern, backend);
        this.routes.push(compiled);
      }
    }

    // Sort by specificity (most specific first)
    this.routes.sort((a, b) => b.specificity - a.specificity);
  }
}
```

### Specificity Calculation

More specific routes get higher priority:

```typescript
private compileRoute(pattern: string, backend: BackendConfig): CompiledRoute {
  const segments = pattern.split('/').filter(s => s.length > 0);
  let specificity = segments.length * 100;

  for (const segment of segments) {
    if (segment === '**') {
      specificity -= 50;  // Least specific
    } else if (segment === '*' || segment.includes('*')) {
      specificity -= 10;  // Somewhat specific
    } else if (segment.startsWith(':')) {
      specificity -= 5;   // Named parameter
    } else {
      specificity += 10;  // Literal segment bonus
    }
  }

  return {
    pattern,
    regex: new RegExp(this.patternToRegex(pattern)),
    specificity,
    backend
  };
}
```

### Pattern to Regex Conversion

```typescript
private patternToRegex(pattern: string): string {
  let regex = pattern
    // Escape special regex characters
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    // Replace ** with placeholder
    .replace(/\*\*/g, '<<<DOUBLE_STAR>>>')
    // Replace * with single segment match
    .replace(/\*/g, '[^/]+')
    // Replace named parameters :param with capture group
    .replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, '(?<$1>[^/]+)')
    // Replace ** placeholder with multi-segment match
    .replace(/<<<DOUBLE_STAR>>>/g, '.*');

  // Ensure pattern matches from start
  if (!regex.startsWith('^')) {
    regex = '^' + regex;
  }

  // Add optional trailing slash and end anchor
  regex = regex.replace(/\/$/, '') + '/?$';

  return regex;
}
```

### Route Matching

```typescript
match(path: string): RouteMatch | null {
  const normalizedPath = this.normalizePath(path);

  // Routes are sorted by specificity, so first match wins
  for (const route of this.routes) {
    if (route.regex.test(normalizedPath)) {
      return {
        backend: route.backend,
        matchedPattern: route.pattern
      };
    }
  }

  return null;
}
```

### Path Normalization

```typescript
private normalizePath(path: string): string {
  // Remove query string
  const queryIndex = path.indexOf('?');
  let normalized = queryIndex !== -1 ? path.substring(0, queryIndex) : path;

  // Remove fragment
  const fragmentIndex = normalized.indexOf('#');
  if (fragmentIndex !== -1) {
    normalized = normalized.substring(0, fragmentIndex);
  }

  // Ensure leading slash
  if (!normalized.startsWith('/')) {
    normalized = '/' + normalized;
  }

  // Remove trailing slash (except root)
  if (normalized.length > 1 && normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1);
  }

  // Collapse multiple slashes
  normalized = normalized.replace(/\/+/g, '/');

  return normalized;
}
```

### Example Route Matching

```
Configured routes:
1. /api/users/:id    (specificity: 215)
2. /api/users        (specificity: 220)
3. /api/*            (specificity: 100)
4. /api/**           (specificity: 50)

Incoming: /api/users/123
→ Matches: /api/users/:id (highest specificity that matches)

Incoming: /api/users
→ Matches: /api/users (exact match, highest specificity)

Incoming: /api/products
→ Matches: /api/* (single segment wildcard)

Incoming: /api/products/123/reviews
→ Matches: /api/** (multi-segment wildcard)
```

---

## 🔒 Circuit Breaker (`src/gateway/circuit-breaker.ts`)

Prevents cascade failures by failing fast when a backend is unhealthy.

### State Machine

```
      ┌─────────────┐
      │   CLOSED    │ ← Normal operation
      └──────┬──────┘
             │ (failures > threshold)
             ▼
      ┌─────────────┐
      │    OPEN     │ → Fail fast, reject requests
      └──────┬──────┘
             │ (after resetTimeout)
             ▼
      ┌─────────────┐
      │  HALF-OPEN  │ → Allow one test request
      └──────┬──────┘
       ↓           ↓
   (success)    (failure)
       ↓           ↓
    CLOSED       OPEN
```

### Implementation

```typescript
export class CircuitBreaker extends EventEmitter {
  private state: CircuitState = CircuitState.CLOSED;
  private failures: number = 0;
  private successThreshold: number;
  private failureThreshold: number;
  private resetTimeout: number;

  canRequest(): boolean {
    switch (this.state) {
      case CircuitState.CLOSED:
        return true;

      case CircuitState.OPEN:
        // Check if reset timeout has passed
        if (Date.now() > this.lastFailureTime + this.resetTimeout) {
          this.transitionTo(CircuitState.HALF_OPEN);
          return true;
        }
        return false;

      case CircuitState.HALF_OPEN:
        // Allow one test request
        return true;
    }
  }

  recordSuccess(): void {
    if (this.state === CircuitState.HALF_OPEN) {
      this.consecutiveSuccesses++;
      if (this.consecutiveSuccesses >= this.successThreshold) {
        this.transitionTo(CircuitState.CLOSED);
      }
    }
    this.failures = 0;
  }

  recordFailure(error: Error): void {
    this.failures++;
    this.lastFailureTime = Date.now();

    if (this.state === CircuitState.HALF_OPEN) {
      // Immediately open if test request fails
      this.transitionTo(CircuitState.OPEN);
    } else if (this.failures >= this.failureThreshold) {
      this.transitionTo(CircuitState.OPEN);
    }
  }

  private transitionTo(newState: CircuitState): void {
    const oldState = this.state;
    this.state = newState;

    logger.warn(`Circuit breaker ${this.serviceName}: ${oldState} → ${newState}`);
    this.emit('stateChange', oldState, newState, this.serviceName);
  }
}
```

---

## 🏥 Health Checker (`src/gateway/health-checker.ts`)

Monitors backend health and triggers circuit breakers.

```typescript
export class HealthChecker extends EventEmitter {
  private backends: Map<string, BackendConfig>;
  private healthStatus: Map<string, ServiceHealth>;
  private checkInterval: NodeJS.Timeout | null;

  start(): void {
    this.checkInterval = setInterval(() => {
      this.checkAllBackends();
    }, this.config.intervalMs);
  }

  async checkAllBackends(): Promise<void> {
    const checks = Array.from(this.backends.values()).map(
      backend => this.checkBackend(backend)
    );
    await Promise.all(checks);
  }

  private async checkBackend(backend: BackendConfig): Promise<void> {
    const healthPath = backend.healthCheck?.path ?? '/health';
    const timeout = backend.healthCheck?.timeoutMs ?? 5000;

    try {
      const response = await fetch(`${backend.url}${healthPath}`, {
        signal: AbortSignal.timeout(timeout)
      });

      if (response.ok) {
        this.recordHealthy(backend);
      } else {
        this.recordUnhealthy(backend, new Error(`Status ${response.status}`));
      }
    } catch (error) {
      this.recordUnhealthy(backend, error as Error);
    }
  }

  private recordHealthy(backend: BackendConfig): void {
    const status = this.healthStatus.get(backend.name);
    status.status = 'healthy';
    status.consecutiveFailures = 0;
    status.lastCheck = new Date();

    this.emit('healthy', backend.name);
  }

  private recordUnhealthy(backend: BackendConfig, error: Error): void {
    const status = this.healthStatus.get(backend.name);
    status.consecutiveFailures++;
    status.lastError = error.message;
    status.lastCheck = new Date();

    if (status.consecutiveFailures >= this.unhealthyThreshold) {
      status.status = 'unhealthy';
      this.emit('unhealthy', backend.name, error);
    }
  }
}
```

---

## 📊 Request Flow Summary

```
1. Request arrives at Express server
   ↓
2. Security middleware (helmet, cors)
   ↓
3. Request ID generated
   ↓
4. Request logged
   ↓
5. Check if internal route (/_aegis/*, /health)
   → If yes: Handle directly
   → If no: Continue
   ↓
6. Authentication check (if enabled)
   → If failed: Return 401/403
   ↓
7. Rate limit check (if enabled)
   → If exceeded: Return 429
   ↓
8. Metrics middleware starts timing
   ↓
9. Proxy middleware:
   a. Find matching backend
   b. Check circuit breaker
   c. Forward request (with retries)
   d. Receive response
   ↓
10. Metrics recorded
    ↓
11. Response sent to client
```

---

## 🚀 Next Steps

Now that you understand the gateway core:
1. [Rate Limiting](./05-rate-limiting.md) - Deep dive into rate limiting
2. [Monitoring & Metrics](./06-monitoring-metrics.md) - Metrics collection
