#!/usr/bin/env node

/**
 * Demo Data Generation Script
 *
 * Generates realistic traffic data for Aegis demo purposes.
 * Creates HTTP requests with varied patterns, errors, and latencies.
 *
 * Usage:
 *   node scripts/generate-demo-data.js
 *   node scripts/generate-demo-data.js --duration 60 --rate 100
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

// Configuration
const config = {
  baseUrl: process.env.AEGIS_URL || 'http://localhost:8080',
  duration: parseInt(process.argv[3]) || 300, // 5 minutes default
  requestsPerSecond: parseInt(process.argv[5]) || 50,
  // Realistic endpoint distribution
  endpoints: [
    { path: '/api/users', method: 'GET', weight: 30, errorRate: 0.01 },
    { path: '/api/users', method: 'POST', weight: 5, errorRate: 0.05 },
    { path: '/api/products', method: 'GET', weight: 25, errorRate: 0.02 },
    { path: '/api/orders', method: 'GET', weight: 15, errorRate: 0.03 },
    { path: '/api/orders', method: 'POST', weight: 10, errorRate: 0.08 },
    { path: '/api/analytics', method: 'GET', weight: 10, errorRate: 0.01 },
    { path: '/api/search', method: 'GET', weight: 5, errorRate: 0.15 },
  ],
  // Client IPs (simulate different users)
  clientIps: [
    '192.168.1.10',
    '192.168.1.11',
    '192.168.1.12',
    '10.0.0.50',
    '10.0.0.51',
  ],
  // User agents
  userAgents: [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 14_7_1 like Mac OS X)',
    'curl/7.68.0',
  ],
};

// Statistics
const stats = {
  total: 0,
  success: 0,
  errors: 0,
  rateLimited: 0,
  latencies: [],
  startTime: Date.now(),
};

/**
 * Select random endpoint based on weights
 */
function selectEndpoint() {
  const totalWeight = config.endpoints.reduce((sum, e) => sum + e.weight, 0);
  let random = Math.random() * totalWeight;

  for (const endpoint of config.endpoints) {
    random -= endpoint.weight;
    if (random <= 0) return endpoint;
  }

  return config.endpoints[0];
}

/**
 * Generate random payload for POST requests
 */
function generatePayload(endpoint) {
  if (endpoint.method === 'GET') return null;

  const payloads = {
    '/api/users': {
      name: `User ${Math.floor(Math.random() * 1000)}`,
      email: `user${Math.floor(Math.random() * 1000)}@example.com`,
      age: Math.floor(Math.random() * 60) + 18,
    },
    '/api/orders': {
      productId: Math.floor(Math.random() * 100),
      quantity: Math.floor(Math.random() * 10) + 1,
      total: (Math.random() * 500).toFixed(2),
    },
  };

  return payloads[endpoint.path] || { data: 'test' };
}

/**
 * Make HTTP request
 */
function makeRequest(endpoint) {
  return new Promise((resolve) => {
    const url = new URL(endpoint.path, config.baseUrl);
    const isHttps = url.protocol === 'https:';
    const client = isHttps ? https : http;

    const payload = generatePayload(endpoint);
    const body = payload ? JSON.stringify(payload) : null;

    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: endpoint.method,
      headers: {
        'User-Agent': config.userAgents[Math.floor(Math.random() * config.userAgents.length)],
        'X-Forwarded-For': config.clientIps[Math.floor(Math.random() * config.clientIps.length)],
      },
    };

    if (body) {
      options.headers['Content-Type'] = 'application/json';
      options.headers['Content-Length'] = Buffer.byteLength(body);
    }

    const startTime = Date.now();

    const req = client.request(options, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        const latency = Date.now() - startTime;
        stats.latencies.push(latency);

        stats.total++;

        if (res.statusCode === 429) {
          stats.rateLimited++;
        } else if (res.statusCode >= 400) {
          stats.errors++;
        } else {
          stats.success++;
        }

        resolve({
          statusCode: res.statusCode,
          latency,
          endpoint: endpoint.path,
        });
      });
    });

    req.on('error', (err) => {
      stats.total++;
      stats.errors++;
      resolve({
        statusCode: 0,
        latency: Date.now() - startTime,
        error: err.message,
      });
    });

    if (body) {
      req.write(body);
    }

    req.end();
  });
}

/**
 * Simulate error (force error response)
 */
function shouldSimulateError(endpoint) {
  return Math.random() < endpoint.errorRate;
}

/**
 * Print statistics
 */
function printStats() {
  const elapsed = (Date.now() - stats.startTime) / 1000;
  const avgLatency = stats.latencies.length > 0
    ? stats.latencies.reduce((a, b) => a + b, 0) / stats.latencies.length
    : 0;

  // Calculate percentiles
  const sorted = [...stats.latencies].sort((a, b) => a - b);
  const p50 = sorted[Math.floor(sorted.length * 0.5)] || 0;
  const p95 = sorted[Math.floor(sorted.length * 0.95)] || 0;
  const p99 = sorted[Math.floor(sorted.length * 0.99)] || 0;

  console.log('\n=== Demo Data Generation Statistics ===');
  console.log(`Duration: ${elapsed.toFixed(1)}s`);
  console.log(`Total Requests: ${stats.total}`);
  console.log(`Success: ${stats.success} (${((stats.success / stats.total) * 100).toFixed(1)}%)`);
  console.log(`Errors: ${stats.errors} (${((stats.errors / stats.total) * 100).toFixed(1)}%)`);
  console.log(`Rate Limited: ${stats.rateLimited} (${((stats.rateLimited / stats.total) * 100).toFixed(1)}%)`);
  console.log(`Throughput: ${(stats.total / elapsed).toFixed(1)} req/s`);
  console.log(`\nLatency Statistics:`);
  console.log(`  Average: ${avgLatency.toFixed(1)}ms`);
  console.log(`  p50: ${p50}ms`);
  console.log(`  p95: ${p95}ms`);
  console.log(`  p99: ${p99}ms`);
  console.log(`  Max: ${Math.max(...stats.latencies)}ms`);
  console.log('=======================================\n');
}

/**
 * Generate traffic spike (simulate sudden load)
 */
async function generateSpike() {
  console.log('\n🔥 Generating traffic spike...');
  const spikeRequests = config.requestsPerSecond * 5; // 5x normal rate
  const promises = [];

  for (let i = 0; i < spikeRequests; i++) {
    const endpoint = selectEndpoint();
    promises.push(makeRequest(endpoint));
  }

  await Promise.all(promises);
  console.log('✅ Traffic spike completed');
}

/**
 * Generate anomalous traffic (for ML testing)
 */
async function generateAnomalousTraffic() {
  console.log('\n⚠️  Generating anomalous traffic pattern...');

  // Rapid requests to single endpoint (bot-like behavior)
  const endpoint = config.endpoints[0];
  const promises = [];

  for (let i = 0; i < 100; i++) {
    promises.push(makeRequest(endpoint));
  }

  await Promise.all(promises);
  console.log('✅ Anomalous traffic completed');
}

/**
 * Main execution
 */
async function main() {
  console.log('🚀 Aegis Demo Data Generator');
  console.log(`Target: ${config.baseUrl}`);
  console.log(`Duration: ${config.duration}s`);
  console.log(`Rate: ${config.requestsPerSecond} req/s`);
  console.log('Starting in 3 seconds...\n');

  await new Promise(resolve => setTimeout(resolve, 3000));

  const interval = 1000 / config.requestsPerSecond;
  let requestCount = 0;
  const maxRequests = config.duration * config.requestsPerSecond;

  // Progress bar
  const progressInterval = setInterval(() => {
    const progress = (requestCount / maxRequests) * 100;
    const bar = '█'.repeat(Math.floor(progress / 2)) + '░'.repeat(50 - Math.floor(progress / 2));
    process.stdout.write(`\r[${bar}] ${progress.toFixed(1)}% | ${requestCount}/${maxRequests} requests | ${stats.rateLimited} rate limited`);
  }, 1000);

  // Generate traffic
  const requestTimer = setInterval(async () => {
    if (requestCount >= maxRequests) {
      clearInterval(requestTimer);
      clearInterval(progressInterval);
      console.log('\n\n✅ Demo data generation completed!');
      printStats();
      process.exit(0);
    }

    const endpoint = selectEndpoint();

    // Simulate errors based on endpoint error rate
    if (shouldSimulateError(endpoint)) {
      stats.total++;
      stats.errors++;
      requestCount++;
      return;
    }

    makeRequest(endpoint).then(() => {
      requestCount++;
    });
  }, interval);

  // Generate special patterns
  setTimeout(() => generateSpike(), (config.duration / 3) * 1000); // Spike at 1/3 duration
  setTimeout(() => generateAnomalousTraffic(), (config.duration * 2 / 3) * 1000); // Anomaly at 2/3 duration

  // Handle Ctrl+C
  process.on('SIGINT', () => {
    clearInterval(requestTimer);
    clearInterval(progressInterval);
    console.log('\n\n❌ Interrupted by user');
    printStats();
    process.exit(0);
  });
}

// Run
main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
