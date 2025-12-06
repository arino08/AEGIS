# Aegis Documentation

Complete documentation for the Aegis API Gateway.

---

## Quick Links

- [Quick Start](../README.md#quick-start)
- [API Reference](./API_REFERENCE.md)
- [Code Guide for Beginners](./CODE_GUIDE.md)

---

## Documentation Structure

### 📘 Core Documentation

- **[README](../README.md)** - Project overview, features, and quick start
- **[ARCHITECTURE](./ARCHITECTURE.md)** - System design, components, and data flow
- **[CODE_GUIDE](./CODE_GUIDE.md)** - File-by-file explanations for beginners
- **[DEPLOYMENT](./DEPLOYMENT.md)** - Docker, Kubernetes, cloud deployment
- **[API_REFERENCE](./API_REFERENCE.md)** - Complete REST API documentation
- **[CONTRIBUTING](../CONTRIBUTING.md)** - How to contribute to the project

### 🔧 Feature Documentation

- **[Rate Limiting](./features/RATE_LIMITING.md)**
  - Token Bucket, Sliding Window, Fixed Window algorithms
  - Configuration, testing, troubleshooting
  - Best practices and examples

- **[Monitoring & Observability](./features/MONITORING.md)**
  - Metrics collection (latency, throughput, errors)
  - Real-time dashboard with WebSocket
  - Alerting and logging
  - Performance monitoring

- **[Machine Learning Features](./features/ML_FEATURES.md)**
  - Anomaly detection (DDoS, bots, attacks)
  - Rate limit optimization
  - Training and deployment

### 🚀 Getting Started

**New to API Gateways?**
1. Start with [README](../README.md) for overview
2. Read [Quick Start](../README.md#quick-start) to run locally
3. Explore [CODE_GUIDE](./CODE_GUIDE.md) to understand the code

**Deploying to Production?**
1. Review [ARCHITECTURE](./ARCHITECTURE.md) for system design
2. Follow [DEPLOYMENT](./DEPLOYMENT.md) for your platform
3. Check [Production Checklist](./DEPLOYMENT.md#production-checklist)

**Want to Contribute?**
1. Read [CONTRIBUTING](../CONTRIBUTING.md) for guidelines
2. Pick an issue from [GitHub Issues](https://github.com/yourusername/aegis/issues)
3. Submit a Pull Request

---

## Topics

### Architecture & Design

- [System Overview](./ARCHITECTURE.md#system-overview)
- [Component Architecture](./ARCHITECTURE.md#component-architecture)
- [Data Flow](./ARCHITECTURE.md#data-flow)
- [Performance Characteristics](./ARCHITECTURE.md#performance-characteristics)

### Core Features

- [Gateway Routing](./ARCHITECTURE.md#gateway-core)
- [Rate Limiting Algorithms](./features/RATE_LIMITING.md#algorithms)
- [Metrics Collection](./features/MONITORING.md#metrics-collected)
- [ML Anomaly Detection](./features/ML_FEATURES.md#feature-1-anomaly-detection)

### Configuration

- [YAML Configuration](./ARCHITECTURE.md#configuration-management)
- [Environment Variables](./DEPLOYMENT.md#local-development)
- [Per-Route Rules](./features/RATE_LIMITING.md#per-route-rules)
- [Tiered Limits](./features/RATE_LIMITING.md#tiered-limits)

### API Reference

- [Metrics Endpoints](./API_REFERENCE.md#metrics-api)
- [Alerts Endpoints](./API_REFERENCE.md#alerts-api)
- [Natural Language Query](./API_REFERENCE.md#natural-language-query-api)
- [WebSocket Streaming](./API_REFERENCE.md#websocket-api)

### Deployment

- [Docker Compose](./DEPLOYMENT.md#docker-compose)
- [Kubernetes](./DEPLOYMENT.md#kubernetes)
- [AWS (EKS)](./DEPLOYMENT.md#aws-eks--rds--elasticache)
- [Google Cloud (GKE)](./DEPLOYMENT.md#google-cloud-gke--cloud-sql--memorystore)
- [Azure (AKS)](./DEPLOYMENT.md#azure-aks--azure-database--azure-cache)

### Operations

- [Monitoring Setup](./DEPLOYMENT.md#monitoring--operations)
- [Backup & Restore](./DEPLOYMENT.md#backup--restore)
- [Troubleshooting](./DEPLOYMENT.md#troubleshooting)
- [Performance Tuning](./ARCHITECTURE.md#performance-characteristics)

---

## Code Examples

### TypeScript (Gateway)

**Rate Limiting Middleware**:
```typescript
// src/rate-limiter/middleware.ts
export function rateLimitMiddleware(limiter: RateLimiter) {
  return async (req, res, next) => {
    const clientId = req.ip;
    const allowed = await limiter.checkLimit(clientId);

    if (!allowed) {
      return res.status(429).json({
        error: 'Too Many Requests',
        retryAfter: 60
      });
    }

    next();
  };
}
```

See: [CODE_GUIDE.md - Rate Limiting](./CODE_GUIDE.md#rate-limiting)

### Python (ML API)

**Anomaly Detection**:
```python
# aegis-ml/models/anomaly_detector.py
from sklearn.ensemble import IsolationForest

class AnomalyDetector:
    def __init__(self):
        self.model = IsolationForest(contamination=0.01)

    def predict(self, features):
        return self.model.predict([features])[0]
```

See: [ML_FEATURES.md - Anomaly Detection](./features/ML_FEATURES.md#feature-1-anomaly-detection)

### Configuration (YAML)

**Rate Limit Config**:
```yaml
rateLimiting:
  default:
    algorithm: "token-bucket"
    limit: 100
    window: "1m"
  rules:
    - path: "/api/critical"
      limit: 10
      window: "1m"
```

See: [RATE_LIMITING.md - Configuration](./features/RATE_LIMITING.md#configuration)

---

## Tutorials

### Setting Up Local Development

1. **Clone and install**:
   ```bash
   git clone https://github.com/yourusername/aegis.git
   cd aegis
   npm install
   ```

2. **Start dependencies**:
   ```bash
   docker-compose up -d postgres redis
   ```

3. **Run migrations**:
   ```bash
   npm run migrate
   ```

4. **Start gateway**:
   ```bash
   npm run dev
   ```

Full guide: [DEPLOYMENT.md - Local Development](./DEPLOYMENT.md#local-development)

---

### Adding a New Rate Limit Rule

1. **Edit config** (`config/aegis.config.yaml`):
   ```yaml
   rateLimiting:
     rules:
       - path: "/api/new-endpoint"
         limit: 50
         window: "1m"
   ```

2. **Restart gateway**:
   ```bash
   npm run dev
   ```

3. **Test**:
   ```bash
   for i in {1..60}; do curl http://localhost:8080/api/new-endpoint; done
   # Should see 429 after 50 requests
   ```

Full guide: [RATE_LIMITING.md - Configuration](./features/RATE_LIMITING.md#per-route-rules)

---

### Training ML Models

1. **Export training data**:
   ```bash
   python aegis-ml/scripts/export_training_data.py --days 30
   ```

2. **Train model**:
   ```bash
   python aegis-ml/models/train_anomaly_detector.py
   ```

3. **Test model**:
   ```bash
   pytest aegis-ml/tests/test_anomaly_detector.py
   ```

4. **Deploy**:
   ```bash
   docker build -t aegis-ml:latest aegis-ml/
   docker-compose up -d aegis-ml
   ```

Full guide: [ML_FEATURES.md - Training](./features/ML_FEATURES.md#training--deployment)

---

## FAQs

**Q: How do I add a new upstream service?**

A: Edit `config/aegis.config.yaml`:
```yaml
gateway:
  routes:
    - path: "/api/myservice"
      upstream: "http://myservice:3000"
      methods: ["GET", "POST"]
```

See: [ARCHITECTURE.md - Router](./ARCHITECTURE.md#gateway-core)

---

**Q: Why are my charts showing "No data available"?**

A: Check that the time range is supported. Frontend uses `5m`, `15m`, `1h`, `6h`, `24h`.

See: [Troubleshooting Dashboard](./features/MONITORING.md#issue-dashboard-shows-no-data-available)

---

**Q: How do I bypass rate limiting for localhost?**

A: It's already configured in `config/aegis.config.yaml`:
```yaml
rateLimiting:
  bypass:
    ips: ['127.0.0.1']
```

See: [RATE_LIMITING.md - Bypass Rules](./features/RATE_LIMITING.md#bypass-rules)

---

**Q: How do I deploy to production?**

A: Follow the production checklist and deployment guide for your platform.

See: [DEPLOYMENT.md - Production Checklist](./DEPLOYMENT.md#production-checklist)

---

## Additional Resources

### External Links

- **Express.js**: https://expressjs.com/
- **Redis**: https://redis.io/docs/
- **PostgreSQL**: https://www.postgresql.org/docs/
- **Scikit-learn**: https://scikit-learn.org/stable/
- **Docker**: https://docs.docker.com/
- **Kubernetes**: https://kubernetes.io/docs/

### Related Projects

- **NGINX**: Traditional reverse proxy
- **Kong**: Open-source API gateway
- **Traefik**: Cloud-native proxy
- **Istio**: Service mesh

### Community

- **GitHub**: https://github.com/yourusername/aegis
- **Discord**: https://discord.gg/aegis
- **Twitter**: @aegisgateway
- **Blog**: https://blog.aegis.dev

---

## Contributing to Documentation

Found a typo or want to improve docs?

1. Edit the markdown file
2. Submit a Pull Request
3. See [CONTRIBUTING.md](../CONTRIBUTING.md)

---

## License

Aegis is [MIT licensed](../LICENSE).

---

**Last Updated**: January 2024
**Version**: 1.0.0
