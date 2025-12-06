/**
 * AEGIS - Test Echo Server
 * A simple HTTP server that echoes back request information
 * Used for testing the gateway proxy functionality
 */

import http from 'http';
import os from 'os';
import { URL } from 'url';

// =============================================================================
// Configuration
// =============================================================================

const DEFAULT_PORT = 3000;
const port = parseInt(process.env['ECHO_PORT'] ?? String(DEFAULT_PORT), 10);
const serviceName = process.env['SERVICE_NAME'] ?? 'echo-service';

// =============================================================================
// Request Handler
// =============================================================================

interface EchoResponse {
  service: string;
  timestamp: string;
  request: {
    method: string;
    url: string;
    path: string;
    query: Record<string, string>;
    headers: Record<string, string | string[] | undefined>;
    body?: unknown;
  };
  server: {
    hostname: string;
    port: number;
    uptime: number;
  };
}

const startTime = Date.now();

function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
  const url = new URL(req.url ?? '/', `http://localhost:${port}`);

  // Handle health check endpoint
  if (url.pathname === '/health' || url.pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        status: 'healthy',
        service: serviceName,
        uptime: Math.floor((Date.now() - startTime) / 1000),
      })
    );
    return;
  }

  // Handle ready endpoint
  if (url.pathname === '/ready') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        status: 'ready',
        service: serviceName,
      })
    );
    return;
  }

  // Handle delay endpoint (for testing timeouts)
  if (url.pathname.startsWith('/delay/')) {
    const delayMs = parseInt(url.pathname.split('/')[2] ?? '1000', 10);
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          message: `Delayed response after ${delayMs}ms`,
          delayMs,
        })
      );
    }, delayMs);
    return;
  }

  // Handle error endpoint (for testing error handling)
  if (url.pathname.startsWith('/error/')) {
    const statusCode = parseInt(url.pathname.split('/')[2] ?? '500', 10);
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: `Simulated ${statusCode} error`,
        statusCode,
      })
    );
    return;
  }

  // Collect request body
  let body = '';
  req.on('data', (chunk: Buffer) => {
    body += chunk.toString();
  });

  req.on('end', () => {
    // Parse query parameters
    const query: Record<string, string> = {};
    url.searchParams.forEach((value, key) => {
      query[key] = value;
    });

    // Parse body if present
    let parsedBody: unknown = undefined;
    if (body) {
      try {
        parsedBody = JSON.parse(body);
      } catch {
        parsedBody = body;
      }
    }

    // Build echo response
    const response: EchoResponse = {
      service: serviceName,
      timestamp: new Date().toISOString(),
      request: {
        method: req.method ?? 'GET',
        url: req.url ?? '/',
        path: url.pathname,
        query,
        headers: req.headers,
        body: parsedBody,
      },
      server: {
        hostname: os.hostname(),
        port,
        uptime: Math.floor((Date.now() - startTime) / 1000),
      },
    };

    // Send response
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'X-Echo-Service': serviceName,
      'X-Request-Id': req.headers['x-request-id'] ?? 'none',
    });
    res.end(JSON.stringify(response, null, 2));
  });

  req.on('error', (error: Error) => {
    console.error(`Request error: ${error.message}`);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: error.message }));
  });
}

// =============================================================================
// Server Setup
// =============================================================================

const server = http.createServer(handleRequest);

server.listen(port, () => {
  console.log(`🔊 Echo server "${serviceName}" listening on port ${port}`);
  console.log(`   Health check: http://localhost:${port}/health`);
  console.log(`   Echo any request to see it reflected back`);
  console.log('');
  console.log('   Special endpoints:');
  console.log(`   - GET /health      - Health check`);
  console.log(`   - GET /ready       - Readiness check`);
  console.log(`   - GET /delay/:ms   - Delayed response`);
  console.log(`   - GET /error/:code - Simulated error response`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('\nReceived SIGTERM, shutting down gracefully...');
  server.close(() => {
    console.log('Echo server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('\nReceived SIGINT, shutting down gracefully...');
  server.close(() => {
    console.log('Echo server closed');
    process.exit(0);
  });
});

export default server;
