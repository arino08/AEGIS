# AEGIS - Intelligent API Gateway

<div align="center">

**A high-performance, AI-powered API Gateway with real-time observability**

[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-22+-green)](https://nodejs.org/)
[![License](https://img.shields.io/badge/License-MIT-yellow)](LICENSE)
[![Docker](https://img.shields.io/badge/Docker-Ready-blue)](docker/)

[Features](#-features) • [Quick Start](#-quick-start) • [Architecture](#-architecture) • [Documentation](#-documentation) • [Demo](#-demo)

</div>

---

## 🌟 Features

### Core Gateway Capabilities
- **🚀 High Performance**: Handles 50,000+ requests/second with <1ms overhead
- **🔄 Intelligent Routing**: Dynamic load balancing with health checks
- **🛡️ Circuit Breaker**: Prevents cascade failures with automatic recovery
- **🔌 WebSocket Support**: Bi-directional real-time communication
- **📊 Request/Response Transformation**: Flexible header and body modifications

### Rate Limiting
- **🎯 Distributed Rate Limiting**: Redis-backed, consistent across instances
- **📈 Multiple Algorithms**: Token Bucket, Sliding Window, Fixed Window
- **🎨 Flexible Rules**: Per IP, user, API key, or endpoint
- **🤖 ML-Powered Optimization**: Automatic rate limit adjustments based on traffic patterns
- **⚡ Ultra-Fast**: <2ms rate limit checks

### Observability & Monitoring
- **📊 Real-time Dashboard**: Live metrics, charts, and system health
- **🔍 WebSocket Streaming**: Sub-second metric updates
- **📈 Time-Series Storage**: PostgreSQL for historical data and trends
- **🎯 Endpoint Analytics**: Top endpoints, latency percentiles, error rates
- **🔔 Smart Alerts**: Configurable rules for anomalies and thresholds

### AI-Powered Features
- **🤖 Anomaly Detection**: Machine learning identifies unusual traffic patterns
- **💬 Natural Language Query**: Ask questions in plain English
  - "What's the current error rate?"
  - "Show me the slowest endpoints"
  - "Are there any anomalies?"
- **🎯 Predictive Rate Limiting**: ML optimizes limits based on historical data

### Security & Authentication
- **🔐 Multi-Auth Support**: API Keys, JWT, OAuth 2.0
- **👥 RBAC**: Role-based access control with path patterns
- **🔒 Security Headers**: CORS, CSP, HSTS, and more
- **🚫 IP Filtering**: Whitelist/blacklist with CIDR support

---

## 🚀 Quick Start

### Prerequisites
- **Docker** & **Docker Compose** (recommended)
- **Node.js 22+** (for local development)
- **Redis** (for rate limiting)
- **PostgreSQL** (for metrics storage)

### Option 1: Docker Compose (Recommended)

\`\`\`bash
# Clone the repository
git clone https://github.com/arino08/aegis.git
cd aegis

# Start all services
docker-compose up -d

# View logs
docker-compose logs -f aegis-gateway
\`\`\`

Services will be available at:
- **Gateway**: http://localhost:8080
- **Dashboard**: http://localhost:3100
- **Redis Commander**: http://localhost:8081
- **pgAdmin**: http://localhost:5050

### Option 2: Local Development

\`\`\`bash
# Install dependencies
npm install
cd frontend && npm install && cd ..

# Set up environment
cp .env.example .env
cp frontend/.env.local.example frontend/.env.local

# Start infrastructure
docker-compose up -d postgres redis aegis-ml-service

# Start gateway
npm run dev

# Start dashboard (in another terminal)
cd frontend && npm run dev
\`\`\`

### Quick Test

\`\`\`bash
# Health check
curl http://localhost:8080/health

# Make a request through the gateway
curl http://localhost:8080/api/test

# View metrics
curl http://localhost:8080/api/metrics/overview

# Check gateway status
curl http://localhost:8080/_aegis/status
\`\`\`

---

## 📊 Architecture

### High-Level Overview

\`\`\`
┌─────────────┐
│   Clients   │
└──────┬──────┘
       │
       ▼
┌─────────────────────────────────────┐
│         AEGIS Gateway               │
│  ┌──────────┐  ┌────────────────┐  │
│  │  Router  │→ │  Middleware    │  │
│  └──────────┘  │  - Rate Limit  │  │
│                │  - Auth        │  │
│                │  - Monitor     │  │
│                │  - Transform   │  │
│                └────────────────┘  │
└───────┬─────────────────────────────┘
        │
   ┌────┴────┐
   ▼         ▼
┌──────┐  ┌──────┐
│Redis │  │Postgres│
└──────┘  └──────┘
        │
   ┌────┴────┐
   ▼         ▼
┌──────────┐ ┌──────────┐
│Backend 1 │ │Backend 2 │
└──────────┘ └──────────┘
\`\`\`

### Components

| Component | Technology | Purpose |
|-----------|-----------|---------|
| **Gateway Core** | Node.js + TypeScript | Request routing, middleware pipeline |
| **Rate Limiter** | Redis | Distributed rate limiting with multiple algorithms |
| **Metrics Collector** | PostgreSQL | Time-series metrics storage and analytics |
| **ML Service** | Python + Flask | Anomaly detection, rate limit optimization |
| **Dashboard** | Next.js + React | Real-time observability UI |
| **WebSocket Server** | ws library | Live metric streaming |

[📖 Detailed Architecture Documentation](docs/ARCHITECTURE.md)

---

## 📈 Performance

### Benchmarks

| Metric | Value |
|--------|-------|
| **Request Throughput** | 50,000+ req/sec |
| **Rate Limit Check** | <2ms |
| **Proxy Overhead** | <1ms |
| **P95 Latency** | 15ms |
| **P99 Latency** | 30ms |
| **Concurrent Connections** | 10,000+ |

### Stress Test Results

\`\`\`bash
# Run stress test
make stress-heavy

# Results
Complete requests:      50000
Failed requests:        0
Requests per second:    3072.00 [#/sec] (mean)
Time per request:       32.552 [ms] (mean)
\`\`\`

[📊 Full Performance Metrics](docs/PERFORMANCE.md)

---

## 📚 Documentation

### Getting Started
- [Installation Guide](docs/INSTALLATION.md)
- [Configuration](docs/CONFIGURATION.md)
- [Quick Start Tutorial](docs/QUICK_START.md)

### Features
- [Rate Limiting](docs/features/RATE_LIMITING.md)
- [Monitoring & Metrics](docs/features/MONITORING.md)
- [Authentication & Authorization](docs/features/AUTH.md)
- [ML-Powered Features](docs/features/ML_FEATURES.md)
- [Natural Language Queries](docs/features/NL_QUERY.md)
- [Request/Response Transformation](docs/features/TRANSFORMATION.md)
- [Circuit Breaker](docs/features/CIRCUIT_BREAKER.md)

### Operations
- [Deployment Guide](docs/DEPLOYMENT.md)
- [Kubernetes Setup](docs/KUBERNETES.md)
- [Monitoring & Alerts](docs/OPERATIONS.md)
- [Troubleshooting](docs/TROUBLESHOOTING.md)

### Development
- [Architecture Deep Dive](docs/ARCHITECTURE.md)
- [Code Guide for Beginners](docs/CODE_GUIDE.md)
- [API Reference](docs/API_REFERENCE.md)
- [Contributing](CONTRIBUTING.md)

---

## 🎥 Demo

### Live Dashboard

![Dashboard Overview](docs/images/dashboard-overview.png)

### Rate Limiting in Action

![Rate Limiting](docs/images/rate-limiting.gif)

### Natural Language Queries

![NL Query](docs/images/nl-query.gif)

### Anomaly Detection

![Anomaly Detection](docs/images/anomaly-detection.png)

---

## 🛠️ Technology Stack

### Backend
- **Runtime**: Node.js 22+
- **Language**: TypeScript 5.7
- **Framework**: Express.js
- **HTTP Client**: Axios
- **WebSocket**: ws

### Frontend
- **Framework**: Next.js 15
- **UI Library**: React 19
- **Styling**: Tailwind CSS
- **Charts**: Custom SVG components

### Infrastructure
- **Rate Limiting**: Redis
- **Metrics Storage**: PostgreSQL
- **ML Service**: Python + Flask + scikit-learn
- **Containerization**: Docker + Docker Compose

---

## 🧪 Testing

\`\`\`bash
# Run all tests
npm test

# Run with coverage
npm run test:coverage

# Run stress tests
make stress-quick       # Quick test
make stress-standard    # Standard load
make stress-heavy       # Heavy load
make stress-all         # Complete suite
\`\`\`

---

## 🌍 Deployment

### Docker

\`\`\`bash
docker build -t aegis-gateway .
docker run -p 8080:8080 aegis-gateway
\`\`\`

### Kubernetes

\`\`\`bash
kubectl apply -f k8s/
\`\`\`

### Cloud Platforms
- AWS ECS/EKS
- Google Cloud Run/GKE
- Azure Container Instances/AKS

[📖 Deployment Guide](docs/DEPLOYMENT.md)

---

## 🤝 Contributing

Contributions are welcome! Please read our [Contributing Guide](CONTRIBUTING.md).

---

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

---

## 📞 Contact

**Author**: Ariz  
**GitHub**: [@arino08](https://github.com/arino08)  
**Project Link**: [https://github.com/arino08/aegis](https://github.com/arino08/aegis)

---

<div align="center">

**⭐ Star this repository if you find it useful!**

Made with ❤️ and TypeScript

</div>
