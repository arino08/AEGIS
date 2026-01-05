# 01. Project Overview

## What is AEGIS?

**AEGIS** (Intelligent API Gateway) is a high-performance, AI-powered API Gateway built with TypeScript and Node.js. It acts as a single entry point for your microservices architecture, handling:

- **Request Routing**: Directing traffic to appropriate backend services
- **Rate Limiting**: Protecting your APIs from abuse and overload
- **Authentication**: Verifying client identities (API keys, JWT, OAuth)
- **Monitoring**: Collecting and displaying real-time metrics
- **AI Features**: Anomaly detection and natural language queries

---

## 🎯 Core Purpose

In a microservices architecture, clients shouldn't directly communicate with individual services. AEGIS sits in front of all your services, providing:

```
                          ┌─────────────────┐
                          │  API Service 1  │
                          └─────────────────┘
┌─────────┐              ┌─────────────────┐
│ Clients │  ──────────▶ │     AEGIS       │ ──────▶  API Service 2
└─────────┘              │    Gateway      │
                          └─────────────────┘
                          ┌─────────────────┐
                          │  Auth Service   │
                          └─────────────────┘
```

---

## 🌟 Key Features Explained

### 1. High-Performance Proxying
AEGIS can handle **50,000+ requests per second** with less than 1 millisecond of overhead. This is achieved through:
- Efficient request routing with compiled regex patterns
- Connection pooling to backend services
- Minimal middleware overhead
- Streaming responses without buffering

### 2. Intelligent Rate Limiting
Prevent API abuse with multiple algorithms:

| Algorithm | Best For | How It Works |
|-----------|----------|--------------|
| **Token Bucket** | Burst-friendly traffic | Tokens refill over time, allowing bursts |
| **Sliding Window** | Precise rate control | Counts requests in a moving time window |
| **Fixed Window** | Simple use cases | Resets counter at fixed intervals |

Rate limits can be applied by:
- IP address
- User ID
- API key
- Endpoint
- Custom combinations

### 3. Real-Time Observability
The dashboard provides live metrics:
- **Requests per second**: Current throughput
- **Latency percentiles**: P50, P95, P99 response times
- **Error rates**: 4xx and 5xx response tracking
- **Backend health**: Status of all upstream services
- **Rate limit hits**: When clients are throttled

### 4. Circuit Breaker Pattern
When a backend becomes unhealthy:

```
Normal: CLOSED → requests flow through
        ↓ (failures exceed threshold)
Failure: OPEN → requests fail immediately (fast-fail)
        ↓ (after recovery timeout)
Testing: HALF-OPEN → allow one request to test
        ↓ (success)
Recovered: CLOSED → normal operation resumes
```

This prevents cascading failures across your system.

### 5. AI-Powered Features

#### Anomaly Detection
The ML service monitors for unusual patterns:
- **Traffic Spikes**: Sudden increases in request rate
- **Latency Anomalies**: Slow response times
- **Error Rate Spikes**: Increased failures
- **Pattern Anomalies**: Unusual usage patterns

#### Natural Language Queries
Ask questions about your API in plain English:
- "What's the current error rate?"
- "Show me the slowest endpoints"
- "How many rate-limited requests in the last hour?"

The system converts these to SQL queries and returns visual results.

### 6. Multi-Auth Support
Flexible authentication options:
- **API Keys**: Simple key-based auth with SHA256 hashing
- **JWT**: JSON Web Token validation with configurable algorithms
- **OAuth 2.0**: Integration with identity providers (Auth0, Okta, etc.)

### 7. Hot Configuration Reload
Change configuration without restarting:
- Edit `aegis.config.yaml`
- AEGIS automatically detects changes
- New configuration applies immediately

---

## 📊 Performance Characteristics

| Metric | Value |
|--------|-------|
| Request Throughput | 50,000+ req/sec |
| Rate Limit Check | <2ms |
| Proxy Overhead | <1ms |
| P95 Latency | ~15ms |
| P99 Latency | ~30ms |
| Concurrent Connections | 10,000+ |

---

## 🏗️ Technology Choices

### Why TypeScript?
- **Type Safety**: Catches errors at compile time
- **Better IDE Support**: Autocomplete and refactoring
- **Documentation**: Types serve as documentation
- **Ecosystem**: Full access to Node.js ecosystem

### Why Express.js?
- **Mature**: Battle-tested in production
- **Middleware**: Extensible plugin system
- **Simple**: Easy to understand and modify
- **Performance**: Good enough for high throughput

### Why Redis for Rate Limiting?
- **Speed**: In-memory, sub-millisecond operations
- **Atomicity**: Lua scripts for atomic operations
- **Distributed**: Works across multiple gateway instances
- **TTL Support**: Automatic expiration of rate limit keys

### Why PostgreSQL for Metrics?
- **Time-Series**: Efficient storage of timestamped data
- **SQL**: Powerful querying capabilities
- **Reliability**: ACID compliance for data integrity
- **Scalability**: Supports large datasets

### Why Python for ML?
- **ML Ecosystem**: Best libraries (scikit-learn, pandas)
- **Fast Prototyping**: Quick model development
- **Flask**: Simple REST API for model serving
- **Isolation**: Separate service for CPU-intensive ML tasks

---

## 🔌 Integration Points

AEGIS integrates with:

| System | Purpose | Port/Connection |
|--------|---------|-----------------|
| Backend APIs | Request forwarding | HTTP (configurable) |
| Redis | Rate limiting data | 6379 |
| PostgreSQL | Metrics storage | 5432 |
| ML Service | Anomaly detection | 5000 |
| WebSocket Clients | Real-time metrics | 8080/ws |

---

## 📈 Use Cases

### 1. API Gateway for Microservices
Route requests to multiple backend services through a single entry point.

### 2. Rate Limiting Service
Protect public APIs from abuse with distributed rate limiting.

### 3. API Monitoring Platform
Collect and visualize metrics for all your API traffic.

### 4. Security Layer
Add authentication without modifying backend services.

### 5. Development Tool
Test and debug API traffic with detailed request logging.

---

## 🆚 Comparison with Alternatives

| Feature | AEGIS | Kong | Nginx | AWS API Gateway |
|---------|-------|------|-------|-----------------|
| Open Source | ✅ | ✅ | ✅ | ❌ |
| Self-Hosted | ✅ | ✅ | ✅ | ❌ |
| ML Features | ✅ | ❌ | ❌ | ❌ |
| NL Queries | ✅ | ❌ | ❌ | ❌ |
| TypeScript | ✅ | ❌ | ❌ | ❌ |
| Real-time Dashboard | ✅ | Plugin | External | CloudWatch |
| Rate Limiting | Multiple Algorithms | Plugin | Limited | Built-in |
| Easy to Extend | ✅ | Plugins | Modules | Limited |

---

## 📁 Repository Structure Overview

```
aegis/
├── src/                 # TypeScript backend source
├── frontend/            # Next.js dashboard
├── aegis-ml/            # Python ML service
├── config/              # Configuration files
├── docker/              # Docker setup
├── tests/               # Test files
├── docs/                # Additional docs
├── package.json         # Node.js dependencies
├── Makefile             # Developer commands
└── README.md            # Project readme
```

---

## 🚀 Next Steps

Now that you understand what AEGIS does, continue to:
1. [Architecture](./02-architecture.md) - Understand how components interact
2. [Getting Started](./13-getting-started.md) - Set up your development environment
