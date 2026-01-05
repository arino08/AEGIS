# AEGIS Learning Documentation

Welcome to the comprehensive learning documentation for **AEGIS** - an Intelligent API Gateway with Rate Limiting & Observability.

## 📚 Documentation Structure

This documentation is designed to help you understand every aspect of the AEGIS project, from high-level architecture to individual code implementations.

### 📖 Table of Contents

| Document | Description |
|----------|-------------|
| [01. Project Overview](./01-project-overview.md) | High-level overview of AEGIS, its purpose, and key features |
| [02. Architecture](./02-architecture.md) | System architecture, component interactions, and data flow |
| [03. Backend Deep Dive](./03-backend-deep-dive.md) | Detailed explanation of the Node.js/TypeScript backend |
| [04. Gateway Core](./04-gateway-core.md) | Main gateway server, routing, and proxy functionality |
| [05. Rate Limiting](./05-rate-limiting.md) | Rate limiting algorithms, rules, and implementation |
| [06. Monitoring & Metrics](./06-monitoring-metrics.md) | Metrics collection, storage, and real-time monitoring |
| [07. Authentication & Authorization](./07-auth.md) | Auth service, RBAC, JWT, and API key handling |
| [08. Natural Language Query](./08-nl-query.md) | AI-powered natural language to SQL conversion |
| [09. ML Service](./09-ml-service.md) | Python ML service for anomaly detection and optimization |
| [10. Frontend Dashboard](./10-frontend.md) | Next.js dashboard implementation |
| [11. Storage Layer](./11-storage.md) | PostgreSQL and Redis clients and usage |
| [12. Configuration](./12-configuration.md) | Configuration system and hot reload |
| [13. Getting Started](./13-getting-started.md) | Step-by-step guide to run and develop AEGIS |

---

## 🎯 Learning Path

### Beginner Path
If you're new to the project, follow this order:
1. Start with [Project Overview](./01-project-overview.md) to understand what AEGIS does
2. Read [Getting Started](./13-getting-started.md) to set up your development environment
3. Explore [Architecture](./02-architecture.md) to understand how components connect
4. Dive into specific components as needed

### Developer Path
If you want to contribute or extend AEGIS:
1. [Backend Deep Dive](./03-backend-deep-dive.md) - Understand the codebase structure
2. [Gateway Core](./04-gateway-core.md) - The heart of the API gateway
3. Pick specific features to study based on what you want to work on

### DevOps Path
If you're focused on deployment and operations:
1. [Configuration](./12-configuration.md) - Configuration options and hot reload
2. [Monitoring & Metrics](./06-monitoring-metrics.md) - Observability features
3. [ML Service](./09-ml-service.md) - ML model training and deployment

---

## 📁 Project Directory Structure

```
aegis/
├── src/                    # Backend TypeScript source code
│   ├── api/               # REST API routes and WebSocket handlers
│   ├── auth/              # Authentication and authorization
│   ├── config/            # Configuration loading and validation
│   ├── gateway/           # Core gateway (server, proxy, router)
│   ├── ml/                # ML service client integration
│   ├── monitoring/        # Metrics collection and alerts
│   ├── nl-query/          # Natural language query processing
│   ├── rate-limiter/      # Rate limiting algorithms and rules
│   ├── storage/           # Database clients (PostgreSQL, Redis)
│   ├── utils/             # Shared utilities and types
│   └── index.ts           # Application entry point
├── frontend/              # Next.js dashboard
│   └── src/
│       ├── app/           # Next.js app router pages
│       ├── components/    # React components
│       └── lib/           # Utility functions
├── aegis-ml/              # Python ML service
│   ├── api/               # Flask REST API
│   ├── models/            # ML models (anomaly, optimizer)
│   └── scripts/           # Training and data generation scripts
├── config/                # Configuration files
├── docker/                # Docker compose and init scripts
├── tests/                 # Test files
└── docs/                  # Additional documentation
```

---

## 🛠️ Technology Stack

| Layer | Technology | Purpose |
|-------|------------|---------|
| **Backend Runtime** | Node.js 22+ | Server-side JavaScript execution |
| **Backend Language** | TypeScript 5.7 | Type-safe JavaScript |
| **Web Framework** | Express.js | HTTP server and middleware |
| **Proxy** | http-proxy | Request forwarding to backends |
| **WebSocket** | ws | Real-time communication |
| **Frontend Framework** | Next.js 15 | React-based dashboard |
| **Frontend UI** | React 19 + Tailwind CSS | UI components and styling |
| **Rate Limiting Store** | Redis | Fast in-memory data store |
| **Metrics Store** | PostgreSQL | Time-series metrics storage |
| **ML Runtime** | Python + Flask | Machine learning service |
| **ML Libraries** | scikit-learn, pandas, numpy | ML model implementation |
| **Containerization** | Docker + Docker Compose | Service orchestration |

---

## 🔑 Key Concepts

Before diving into the code, understand these core concepts:

### 1. API Gateway Pattern
AEGIS sits between clients and backend services, handling:
- Request routing to appropriate backends
- Authentication and authorization
- Rate limiting to prevent abuse
- Metrics collection for observability
- Request/response transformation

### 2. Reverse Proxy
AEGIS forwards requests to backend services and returns responses to clients, hiding the complexity of the backend infrastructure.

### 3. Circuit Breaker Pattern
When a backend becomes unhealthy, AEGIS "opens the circuit" to prevent cascading failures, giving the backend time to recover.

### 4. Rate Limiting Algorithms
AEGIS supports multiple algorithms:
- **Token Bucket**: Allows burst traffic with sustained rate control
- **Sliding Window**: Smooth rate limiting with precise windows
- **Fixed Window**: Simple time-based windows

### 5. Observability
Real-time visibility into system health through:
- Request metrics (latency, error rates)
- Rate limiting events
- Backend health status
- Custom alerts

---

## 📊 Data Flow Overview

```
Client Request
      │
      ▼
┌─────────────────────────────────────────────────────────────┐
│                     AEGIS Gateway                            │
│                                                              │
│  ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐ │
│  │ Request  │ → │   Auth   │ → │   Rate   │ → │  Proxy   │ │
│  │   ID     │   │  Check   │   │  Limit   │   │ Forward  │ │
│  └──────────┘   └──────────┘   └──────────┘   └──────────┘ │
│                                                     │        │
│  ┌──────────────────────────────────────────────────┼──────┐│
│  │                    Metrics Collection            │      ││
│  └──────────────────────────────────────────────────┼──────┘│
└─────────────────────────────────────────────────────┼───────┘
                                                      │
                                                      ▼
                                              Backend Services
```

---

## ✨ What Makes AEGIS Special

1. **Production-Ready**: Handles 50,000+ requests/second with <1ms overhead
2. **AI-Powered**: ML-based anomaly detection and rate limit optimization
3. **Natural Language Queries**: Ask questions about your API in plain English
4. **Real-Time Dashboard**: Live metrics with WebSocket streaming
5. **Flexible Configuration**: YAML config with hot reload support
6. **Multiple Rate Limiting Algorithms**: Choose the best fit for your use case
7. **Comprehensive Observability**: Time-series metrics with PostgreSQL

---

## 🚀 Quick Links

- **GitHub Repository**: [arino08/aegis](https://github.com/arino08/aegis)
- **Main README**: [README.md](../README.md)
- **Contributing Guide**: [CONTRIBUTING.md](../CONTRIBUTING.md)
- **API Reference**: [docs/API_REFERENCE.md](../docs/API_REFERENCE.md)

---

Happy Learning! 📖
