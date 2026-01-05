# 03. Backend Deep Dive

## Overview

The AEGIS backend is written in TypeScript and runs on Node.js. This document provides a detailed exploration of the codebase structure, key patterns, and how different modules work together.

---

## 📁 Source Code Structure

```
src/
├── index.ts              # Application entry point
├── api/                  # REST API and WebSocket handlers
│   ├── index.ts          # API router setup
│   ├── websocket.ts      # Real-time metrics WebSocket
│   └── routes/           # Individual API route handlers
│       ├── alerts.ts     # Alert management API
│       ├── health.ts     # Health check endpoints
│       ├── metrics.ts    # Metrics query API
│       ├── ml.ts         # ML service integration API
│       └── nl-query.ts   # Natural language query API
├── auth/                 # Authentication & Authorization
│   ├── auth-service.ts   # Main auth service
│   ├── middleware.ts     # Express auth middleware
│   ├── rbac-service.ts   # Role-Based Access Control
│   ├── transform.ts      # Header transformation
│   ├── types.ts          # Auth type definitions
│   └── index.ts          # Module exports
├── config/               # Configuration management
│   ├── index.ts          # Exports
│   ├── loader.ts         # Config loading & hot reload
│   └── schema.ts         # Zod validation schemas
├── gateway/              # Core gateway functionality
│   ├── index.ts          # Exports
│   ├── server.ts         # Main gateway server class
│   ├── proxy.ts          # HTTP proxy handler
│   ├── router.ts         # Route matching
│   ├── circuit-breaker.ts # Circuit breaker pattern
│   ├── health-checker.ts # Backend health checks
│   └── middleware/       # Gateway-specific middleware
│       ├── errorHandler.ts
│       ├── rateLimit.ts
│       ├── requestId.ts
│       └── requestLogger.ts
├── ml/                   # ML service client
│   ├── client.ts         # HTTP client for ML service
│   ├── middleware.ts     # ML-powered middleware
│   └── index.ts          # Exports
├── monitoring/           # Metrics & Alerting
│   ├── alerts.ts         # Alert rule evaluation
│   ├── collector.ts      # Metrics collection & storage
│   ├── middleware.ts     # Request metrics middleware
│   ├── types.ts          # Metric type definitions
│   └── index.ts          # Exports
├── nl-query/             # Natural Language Queries
│   ├── service.ts        # NL query processing
│   ├── sql-generator.ts  # NL to SQL conversion
│   ├── validator.ts      # SQL validation
│   ├── types.ts          # NL query types
│   └── index.ts          # Exports
├── rate-limiter/         # Rate Limiting
│   ├── index.ts          # Exports & factory
│   ├── limiter.ts        # Main rate limiter class
│   ├── middleware.ts     # Express middleware
│   ├── scripts.ts        # Redis Lua scripts
│   ├── types.ts          # Rate limit types
│   ├── algorithms/       # Rate limit algorithms
│   │   ├── token-bucket.ts
│   │   ├── sliding-window.ts
│   │   ├── fixed-window.ts
│   │   └── index.ts
│   └── rules/            # Rule matching
│       ├── bypass.ts     # Bypass logic
│       ├── matcher.ts    # Rule matching
│       └── index.ts
├── storage/              # Database clients
│   ├── index.ts          # Connection management
│   ├── postgres.ts       # PostgreSQL client
│   ├── redis.ts          # Redis client
│   └── migrations/       # Database migrations
└── utils/                # Shared utilities
    ├── helpers.ts        # Helper functions
    ├── logger.ts         # Winston logger setup
    ├── types.ts          # Shared type definitions
    └── index.ts          # Exports
```

---

## 🚀 Application Entry Point

### `src/index.ts`

This is where everything starts:

```typescript
// Main entry point - src/index.ts

import 'dotenv/config';  // Load environment variables first

import { GatewayServer, createGatewayServer } from './gateway/server.js';
import { loadConfig, getConfigLoader } from './config/loader.js';
import { initializeStorage, closeStorage } from './storage/index.js';
import logger, { logLifecycle } from './utils/logger.js';
import type { AegisConfig } from './utils/types.js';

// Global state
let gatewayServer: GatewayServer | null = null;
let isShuttingDown = false;

// Bootstrap function - initializes everything
async function bootstrap(): Promise<void> {
  logLifecycle('startup', 'AEGIS Gateway starting up...');

  try {
    // 1. Load configuration (YAML + environment variables)
    const config: AegisConfig = await loadConfig();

    // 2. Initialize database connections
    await initializeStorage({
      postgres: config.postgres,
      redis: config.redis,
    });

    // 3. Create and initialize gateway server
    gatewayServer = createGatewayServer({ config });
    await gatewayServer.initialize();

    // 4. Enable hot reload if configured
    if (config.hotReload) {
      const configLoader = getConfigLoader();
      configLoader.startWatching();
    }

    // 5. Start listening for requests
    await gatewayServer.start();

    // 6. Print startup banner
    printBanner(config);
  } catch (error) {
    logLifecycle('error', 'Failed to start AEGIS Gateway', { error });
    process.exit(1);
  }
}

// Start the application
bootstrap().catch((error) => {
  console.error('Fatal error during bootstrap:', error);
  process.exit(1);
});
```

**Key Points:**
- Uses ES modules (`.js` extensions in imports)
- Async bootstrap function for proper initialization order
- Graceful shutdown handling with signal handlers
- Startup banner for visual confirmation

---

## 📝 TypeScript Configuration

### `tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",           // Modern JavaScript
    "module": "NodeNext",          // ES module output
    "moduleResolution": "NodeNext",// Node.js module resolution
    "outDir": "./dist",            // Compiled output directory
    "rootDir": "./src",            // Source root
    "strict": true,                // Enable all strict checks
    "esModuleInterop": true,       // CommonJS/ES module interop
    "skipLibCheck": true,          // Skip type checking node_modules
    "forceConsistentCasingInFileNames": true,
    "declaration": true,           // Generate .d.ts files
    "declarationMap": true         // Source maps for declarations
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

**Important Notes:**
- Uses `.js` extension in imports (required for Node.js ESM)
- Strict mode enabled for maximum type safety
- Compiles to modern JavaScript (ES2022)

---

## 🔑 Key Programming Patterns

### 1. Singleton Pattern

Many services use singletons to ensure only one instance exists:

```typescript
// Example from src/gateway/router.ts

let routerInstance: Router | null = null;

export function getRouter(): Router {
  if (routerInstance === null) {
    routerInstance = new Router();
  }
  return routerInstance;
}

export function createRouter(): Router {
  return new Router();
}
```

**Usage:**
```typescript
// Get the same instance everywhere
const router = getRouter();

// Create a new instance (for testing)
const testRouter = createRouter();
```

### 2. Factory Pattern

Creates configured instances:

```typescript
// Example from src/rate-limiter/index.ts

export function createRateLimiter(
  redis: RedisClientWrapper,
  config: Partial<RateLimiterConfig> = {}
): RateLimiter {
  return new RateLimiter(redis, config);
}
```

### 3. Builder Pattern for Configuration

```typescript
// Example: Building configuration with defaults

const DEFAULT_CONFIG = {
  enabled: true,
  defaultAlgorithm: 'token-bucket',
  defaultRequests: 100,
  defaultWindowSeconds: 60,
};

constructor(config: Partial<RateLimiterConfig> = {}) {
  this.config = {
    ...DEFAULT_CONFIG,
    ...config,
  };
}
```

### 4. Middleware Pattern (Express)

```typescript
// Example middleware structure

export function createMiddleware(options: Options) {
  // Setup code runs once
  const processor = new Processor(options);

  // Return middleware function
  return (req: Request, res: Response, next: NextFunction) => {
    // Request handling code
    processor.handle(req, res)
      .then(() => next())
      .catch(next);
  };
}
```

### 5. Event Emitter Pattern

```typescript
// Example from src/gateway/circuit-breaker.ts

class CircuitBreaker extends EventEmitter {
  transitionTo(newState: CircuitState): void {
    const oldState = this.state;
    this.state = newState;

    // Emit event for listeners
    this.emit('stateChange', oldState, newState, this.serviceName);
  }
}

// Usage
circuitBreaker.on('stateChange', (from, to, service) => {
  logger.warn(`Circuit for ${service} changed: ${from} -> ${to}`);
});
```

---

## 📦 Module Export Patterns

### Barrel Exports (index.ts files)

Each module has an `index.ts` that re-exports public APIs:

```typescript
// src/rate-limiter/index.ts

// Re-export types
export * from './types.js';

// Re-export classes and functions
export { RateLimiter, createRateLimiter } from './limiter.js';
export { createRateLimitMiddleware, skipHealthChecks } from './middleware.js';
export { RuleMatcher } from './rules/matcher.js';
export { BypassChecker, type BypassResult } from './rules/bypass.js';
```

**Benefits:**
- Clean import statements: `import { RateLimiter } from './rate-limiter'`
- Hide internal implementation details
- Single place to manage public API

---

## 🔧 Common Utilities

### Logger (`src/utils/logger.ts`)

Uses Winston for structured logging:

```typescript
import winston from 'winston';

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )
    })
  ]
});

// Lifecycle logging helper
export function logLifecycle(
  event: 'startup' | 'shutdown' | 'ready' | 'error',
  message: string,
  meta?: object
): void {
  logger.info(message, { lifecycle: event, ...meta });
}

export default logger;
```

**Usage:**
```typescript
import logger from './utils/logger.js';

logger.info('Request received', { path: '/api/users', method: 'GET' });
logger.warn('Rate limit exceeded', { ip: '192.168.1.1' });
logger.error('Database error', { error: err.message });
```

### Helper Functions (`src/utils/helpers.ts`)

```typescript
// Generate unique IDs
export function generateRequestId(): string {
  return `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// Safe JSON parsing
export function safeJsonParse<T>(json: string, fallback: T): T {
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

// Delay helper for async operations
export function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// IP address normalization
export function normalizeIp(ip: string): string {
  // Handle IPv6 mapped IPv4
  if (ip.startsWith('::ffff:')) {
    return ip.substring(7);
  }
  return ip;
}
```

---

## 📊 Type Definitions

### Shared Types (`src/utils/types.ts`)

```typescript
// Backend configuration
export interface BackendConfig {
  name: string;
  url: string;
  routes: string[];
  healthCheck?: HealthCheckConfig;
  timeout?: number;
  retries?: number;
  weight?: number;
}

// Route match result
export interface RouteMatch {
  backend: BackendConfig;
  matchedPattern: string;
}

// Gateway status
export interface GatewayStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  uptime: number;
  version: string;
  backends: {
    total: number;
    healthy: number;
    unhealthy: number;
  };
}

// Request logging
export interface RequestLog {
  id?: number;
  timestamp: Date;
  method: string;
  path: string;
  statusCode: number;
  durationMs: number;
  backend?: string;
  clientIp: string;
  errorMessage?: string;
}
```

---

## 🔄 Async/Await Patterns

### Proper Error Handling

```typescript
// Good pattern - async function with try/catch
async function processRequest(): Promise<void> {
  try {
    const result = await someAsyncOperation();
    await anotherAsyncOperation(result);
  } catch (error) {
    if (error instanceof SpecificError) {
      // Handle specific error
    } else {
      // Re-throw unknown errors
      throw error;
    }
  }
}

// Promise.all for parallel operations
async function initializeServices(): Promise<void> {
  await Promise.all([
    initRedis(),
    initPostgres(),
    initMetrics()
  ]);
}

// Promise.allSettled when you need all results
async function checkAllBackends(): Promise<HealthResult[]> {
  const results = await Promise.allSettled(
    backends.map(b => checkHealth(b))
  );

  return results.map((r, i) => ({
    backend: backends[i].name,
    healthy: r.status === 'fulfilled' && r.value.ok
  }));
}
```

---

## 🧪 Testing Patterns

### Unit Test Structure

```typescript
// Example test file structure
import { describe, it, expect, beforeEach, afterEach } from 'jest';
import { Router } from '../src/gateway/router';

describe('Router', () => {
  let router: Router;

  beforeEach(() => {
    router = new Router();
  });

  afterEach(() => {
    router.clear();
  });

  describe('match', () => {
    it('should match exact routes', () => {
      router.registerBackends([{
        name: 'api',
        url: 'http://localhost:3000',
        routes: ['/api/users']
      }]);

      const match = router.match('/api/users');
      expect(match).not.toBeNull();
      expect(match!.backend.name).toBe('api');
    });

    it('should return null for no match', () => {
      const match = router.match('/unknown');
      expect(match).toBeNull();
    });
  });
});
```

---

## 📋 Code Organization Guidelines

### File Naming Conventions
- **Classes**: PascalCase (`GatewayServer.ts` for class, or lowercase with the class inside)
- **Utilities**: kebab-case (`rate-limiter.ts`)
- **Types**: Grouped in `types.ts` per module
- **Index**: Always `index.ts` for barrel exports

### Import Order
```typescript
// 1. Node.js built-in modules
import http from 'http';
import path from 'path';

// 2. External dependencies
import express from 'express';
import winston from 'winston';

// 3. Internal modules (absolute)
import logger from '../utils/logger.js';
import { BackendConfig } from '../utils/types.js';

// 4. Relative imports (same directory)
import { CircuitBreaker } from './circuit-breaker.js';
```

---

## 🚀 Next Steps

Now that you understand the backend structure:
1. [Gateway Core](./04-gateway-core.md) - Deep dive into server and proxy
2. [Rate Limiting](./05-rate-limiting.md) - Understand rate limiting implementation
