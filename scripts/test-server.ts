/**
 * AEGIS - Echo Test Server
 *
 * A simple backend server for testing the gateway.
 * Simulates various response patterns including delays,
 * errors, and different response sizes.
 */

import express, { Request, Response } from 'express';

const app = express();
const PORT = process.env.PORT || 3000;

// Parse JSON
app.use(express.json());

// Request counter for rate limit testing
let requestCount = 0;
let startTime = Date.now();

// Middleware to log requests
app.use((req, res, next) => {
  requestCount++;
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// =============================================================================
// Health Endpoints
// =============================================================================

app.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'healthy',
    service: 'echo-server',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    requestCount,
  });
});

// =============================================================================
// Echo Endpoints
// =============================================================================

// Simple echo - returns request info
app.all('/echo', (req: Request, res: Response) => {
  res.json({
    method: req.method,
    path: req.path,
    query: req.query,
    headers: req.headers,
    body: req.body,
    timestamp: new Date().toISOString(),
  });
});

// Echo with configurable delay
app.all('/echo/delay/:ms', (req: Request, res: Response) => {
  const delay = parseInt(req.params.ms) || 100;
  const safeDelay = Math.min(delay, 10000); // Max 10 seconds

  setTimeout(() => {
    res.json({
      message: `Delayed response after ${safeDelay}ms`,
      delay: safeDelay,
      timestamp: new Date().toISOString(),
    });
  }, safeDelay);
});

// Echo with random delay (for latency testing)
app.all('/echo/random-delay', (_req: Request, res: Response) => {
  const delay = Math.floor(Math.random() * 500) + 50; // 50-550ms

  setTimeout(() => {
    res.json({
      message: 'Random delay response',
      delay,
      timestamp: new Date().toISOString(),
    });
  }, delay);
});

// =============================================================================
// API Test Endpoints
// =============================================================================

app.get('/api/test', (_req: Request, res: Response) => {
  res.json({
    message: 'API test successful',
    timestamp: new Date().toISOString(),
    requestNumber: requestCount,
  });
});

app.get('/api/public/test', (_req: Request, res: Response) => {
  res.json({
    message: 'Public API endpoint',
    public: true,
    timestamp: new Date().toISOString(),
  });
});

app.get('/api/search', (req: Request, res: Response) => {
  const query = req.query.q || 'default';
  res.json({
    query,
    results: [
      { id: 1, name: 'Result 1' },
      { id: 2, name: 'Result 2' },
      { id: 3, name: 'Result 3' },
    ],
    total: 3,
    timestamp: new Date().toISOString(),
  });
});

app.post('/api/create-order', (req: Request, res: Response) => {
  res.status(201).json({
    orderId: `ORD-${Date.now()}`,
    status: 'created',
    data: req.body,
    timestamp: new Date().toISOString(),
  });
});

// =============================================================================
// Auth Test Endpoints
// =============================================================================

app.post('/auth/login', (req: Request, res: Response) => {
  const { username, password } = req.body;

  if (username === 'test' && password === 'test') {
    res.json({
      token: 'fake-jwt-token-' + Date.now(),
      user: { id: '1', username },
      expiresIn: 3600,
    });
  } else {
    res.status(401).json({
      error: 'Invalid credentials',
    });
  }
});

app.post('/auth/register', (req: Request, res: Response) => {
  const { username, email } = req.body;
  res.status(201).json({
    userId: `USR-${Date.now()}`,
    username,
    email,
    message: 'User registered successfully',
  });
});

// =============================================================================
// User Endpoints
// =============================================================================

app.get('/users/profile', (req: Request, res: Response) => {
  // Check for user info injected by gateway
  const userId = req.headers['x-user-id'] || 'anonymous';
  const userEmail = req.headers['x-user-email'] || 'unknown';

  res.json({
    id: userId,
    email: userEmail,
    name: 'Test User',
    tier: 'pro',
    createdAt: '2024-01-01T00:00:00Z',
  });
});

app.put('/users/profile', (req: Request, res: Response) => {
  res.json({
    message: 'Profile updated',
    data: req.body,
  });
});

// =============================================================================
// Error Simulation Endpoints
// =============================================================================

// Simulate server error
app.get('/error/500', (_req: Request, res: Response) => {
  res.status(500).json({
    error: 'Internal Server Error',
    message: 'Simulated server error',
  });
});

// Simulate timeout (no response)
app.get('/error/timeout', (_req: Request, _res: Response) => {
  // Don't respond - simulates timeout
});

// Simulate random errors (for circuit breaker testing)
app.get('/error/random', (_req: Request, res: Response) => {
  if (Math.random() < 0.3) { // 30% error rate
    res.status(500).json({
      error: 'Random failure',
      timestamp: new Date().toISOString(),
    });
  } else {
    res.json({
      success: true,
      timestamp: new Date().toISOString(),
    });
  }
});

// Simulate high latency (for circuit breaker testing)
app.get('/error/slow', (_req: Request, res: Response) => {
  const delay = Math.random() < 0.5 ? 5000 : 100; // 50% chance of 5s delay
  setTimeout(() => {
    res.json({
      message: delay > 1000 ? 'Slow response' : 'Fast response',
      delay,
    });
  }, delay);
});

// =============================================================================
// Load Test Endpoints
// =============================================================================

// Variable size response
app.get('/load/size/:kb', (req: Request, res: Response) => {
  const kb = Math.min(parseInt(req.params.kb) || 1, 1000); // Max 1MB
  const data = 'x'.repeat(kb * 1024);

  res.json({
    size: `${kb}KB`,
    data,
  });
});

// CPU-intensive endpoint
app.get('/load/cpu/:iterations', (req: Request, res: Response) => {
  const iterations = Math.min(parseInt(req.params.iterations) || 1000, 1000000);
  let result = 0;

  for (let i = 0; i < iterations; i++) {
    result += Math.sqrt(i);
  }

  res.json({
    iterations,
    result,
    timestamp: new Date().toISOString(),
  });
});

// =============================================================================
// Statistics Endpoint
// =============================================================================

app.get('/stats', (_req: Request, res: Response) => {
  const uptime = Date.now() - startTime;
  const rps = requestCount / (uptime / 1000);

  res.json({
    requestCount,
    uptime: uptime / 1000,
    requestsPerSecond: rps.toFixed(2),
    memoryUsage: process.memoryUsage(),
  });
});

// Reset stats
app.post('/stats/reset', (_req: Request, res: Response) => {
  requestCount = 0;
  startTime = Date.now();
  res.json({ message: 'Stats reset' });
});

// =============================================================================
// Admin Endpoints (for RBAC testing)
// =============================================================================

app.get('/api/admin/users', (_req: Request, res: Response) => {
  res.json({
    users: [
      { id: 1, name: 'Admin', role: 'admin' },
      { id: 2, name: 'User', role: 'user' },
    ],
    total: 2,
  });
});

app.delete('/api/admin/users/:id', (req: Request, res: Response) => {
  res.json({
    message: `User ${req.params.id} deleted`,
    deletedAt: new Date().toISOString(),
  });
});

// =============================================================================
// Catch-all for unmatched routes
// =============================================================================

app.all('*', (req: Request, res: Response) => {
  res.json({
    message: 'Echo server catch-all',
    method: req.method,
    path: req.path,
    timestamp: new Date().toISOString(),
  });
});

// =============================================================================
// Start Server
// =============================================================================

app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════════════╗
║                                                           ║
║   🧪 AEGIS Test Echo Server                               ║
║                                                           ║
║   Running on http://localhost:${PORT}                       ║
║                                                           ║
║   Endpoints:                                              ║
║   - GET  /health              Health check                ║
║   - ALL  /echo                Echo request info           ║
║   - ALL  /echo/delay/:ms      Delayed response            ║
║   - GET  /api/test            API test endpoint           ║
║   - GET  /api/public/test     Public API                  ║
║   - GET  /api/search          Search endpoint             ║
║   - POST /auth/login          Login simulation            ║
║   - GET  /error/500           500 error simulation        ║
║   - GET  /error/random        Random errors (30%)         ║
║   - GET  /stats               Request statistics          ║
║                                                           ║
╚═══════════════════════════════════════════════════════════╝
  `);
});
