# API Reference

Complete API documentation for Aegis API Gateway.

---

## Base URL

**Development**: `http://localhost:8080`
**Production**: `https://api.yourdomain.com`

---

## Authentication

### API Key

Include API key in header:
```http
X-API-Key: your-api-key-here
```

### JWT Bearer Token

Include JWT token in header:
```http
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

---

## Health Check

### GET /health

Check gateway health status.

**Request**:
```bash
curl http://localhost:8080/health
```

**Response** (200 OK):
```json
{
  "status": "healthy",
  "uptime": 3600,
  "timestamp": "2024-01-15T10:30:00Z",
  "dependencies": {
    "postgres": "connected",
    "redis": "connected",
    "mlApi": "connected"
  }
}
```

---

## Metrics API

### GET /api/metrics/latency

Get latency metrics for specified time range.

**Parameters**:
- `range` (required): Time range (`5m`, `15m`, `1h`, `6h`, `24h`, `7d`, `30d`)
- `path` (optional): Filter by path (e.g., `/api/users`)

**Request**:
```bash
curl "http://localhost:8080/api/metrics/latency?range=1h"
```

**Response** (200 OK):
```json
{
  "success": true,
  "data": [
    {
      "timestamp": "2024-01-15T10:00:00Z",
      "p50": 45.2,
      "p95": 120.5,
      "p99": 250.0,
      "max": 1500.0
    },
    {
      "timestamp": "2024-01-15T10:01:00Z",
      "p50": 48.0,
      "p95": 125.0,
      "p99": 280.0,
      "max": 1200.0
    }
  ],
  "meta": {
    "range": "1h",
    "points": 60,
    "bucket": "1m"
  }
}
```

---

### GET /api/metrics/throughput

Get request throughput (requests per second).

**Parameters**:
- `range` (required): Time range
- `path` (optional): Filter by path

**Request**:
```bash
curl "http://localhost:8080/api/metrics/throughput?range=15m"
```

**Response** (200 OK):
```json
{
  "success": true,
  "data": [
    {
      "timestamp": "2024-01-15T10:00:00Z",
      "total": 1250,
      "success": 1200,
      "errors": 50,
      "rate": 20.83
    }
  ],
  "meta": {
    "range": "15m",
    "points": 15
  }
}
```

---

### GET /api/metrics/errors

Get error rate metrics.

**Parameters**:
- `range` (required): Time range
- `path` (optional): Filter by path

**Request**:
```bash
curl "http://localhost:8080/api/metrics/errors?range=6h"
```

**Response** (200 OK):
```json
{
  "success": true,
  "data": [
    {
      "timestamp": "2024-01-15T10:00:00Z",
      "total": 1000,
      "errors_4xx": 20,
      "errors_5xx": 5,
      "error_rate": 0.025
    }
  ],
  "meta": {
    "range": "6h",
    "points": 360
  }
}
```

---

### GET /api/metrics/rate-limit-usage

Get rate limit usage statistics.

**Parameters**:
- `range` (required): Time range
- `clientId` (optional): Filter by client (IP or API key)

**Request**:
```bash
curl "http://localhost:8080/api/metrics/rate-limit-usage?range=1h"
```

**Response** (200 OK):
```json
{
  "success": true,
  "data": [
    {
      "timestamp": "2024-01-15T10:00:00Z",
      "allowed": 950,
      "rejected": 50,
      "usage": 0.95,
      "topClients": [
        { "clientId": "192.168.1.1", "requests": 100 },
        { "clientId": "api-key-abc", "requests": 80 }
      ]
    }
  ],
  "meta": {
    "range": "1h",
    "points": 60
  }
}
```

---

## Alerts API

### GET /api/alerts

Get active or historical alerts.

**Parameters**:
- `status` (optional): Filter by status (`active`, `resolved`, `acknowledged`)
- `severity` (optional): Filter by severity (`info`, `warning`, `critical`)
- `limit` (optional): Max results (default: 100)

**Request**:
```bash
curl "http://localhost:8080/api/alerts?status=active"
```

**Response** (200 OK):
```json
{
  "success": true,
  "data": [
    {
      "id": "alert-123",
      "name": "HighErrorRate",
      "message": "Error rate exceeded 5%",
      "severity": "critical",
      "status": "active",
      "triggeredAt": "2024-01-15T10:25:00Z",
      "acknowledgedAt": null,
      "resolvedAt": null,
      "metadata": {
        "error_rate": 0.07,
        "threshold": 0.05
      }
    }
  ],
  "meta": {
    "total": 1,
    "status": "active"
  }
}
```

---

### POST /api/alerts/acknowledge/:id

Acknowledge an alert.

**Request**:
```bash
curl -X POST "http://localhost:8080/api/alerts/acknowledge/alert-123" \
  -H "Content-Type: application/json" \
  -d '{"acknowledgedBy": "john@example.com", "notes": "Investigating"}'
```

**Response** (200 OK):
```json
{
  "success": true,
  "data": {
    "id": "alert-123",
    "status": "acknowledged",
    "acknowledgedAt": "2024-01-15T10:30:00Z",
    "acknowledgedBy": "john@example.com"
  }
}
```

---

### GET /api/alerts/history

Get alert history.

**Parameters**:
- `days` (optional): Number of days (default: 7)
- `severity` (optional): Filter by severity

**Request**:
```bash
curl "http://localhost:8080/api/alerts/history?days=30"
```

**Response** (200 OK):
```json
{
  "success": true,
  "data": [
    {
      "date": "2024-01-15",
      "total": 15,
      "bySeverity": {
        "critical": 2,
        "warning": 8,
        "info": 5
      },
      "avgResolutionTime": 1800
    }
  ],
  "meta": {
    "days": 30,
    "totalAlerts": 450
  }
}
```

---

## Natural Language Query API

### POST /api/nl-query

Query metrics using natural language.

**Request Body**:
```json
{
  "question": "What's the average latency for /api/users in the last hour?"
}
```

**Request**:
```bash
curl -X POST "http://localhost:8080/api/nl-query" \
  -H "Content-Type: application/json" \
  -d '{"question": "What is the average latency for /api/users in the last hour?"}'
```

**Response** (200 OK):
```json
{
  "success": true,
  "data": {
    "question": "What's the average latency for /api/users in the last hour?",
    "answer": "The average latency for /api/users in the last hour is 45.2ms (p50), with p95 at 120.5ms and p99 at 250ms.",
    "sql": "SELECT AVG(latency_ms) FROM request_metrics WHERE path = '/api/users' AND timestamp > NOW() - INTERVAL '1 hour'",
    "result": {
      "avg_latency": 45.2,
      "p95": 120.5,
      "p99": 250.0
    }
  }
}
```

**Error Response** (400 Bad Request):
```json
{
  "success": false,
  "error": "Question is required"
}
```

**Example Questions**:
- "Show me error rate for the last 24 hours"
- "Which endpoint has the highest latency?"
- "How many requests were rate limited today?"
- "What's the throughput for /api/users?"

---

## ML API

### POST /api/ml/predict/anomaly

Detect anomalies in traffic patterns.

**Request Body**:
```json
{
  "metrics": {
    "requestRate": 1000,
    "avgLatency": 150,
    "errorRate": 0.08,
    "uniquePaths": 50,
    "payloadSize": 2048
  }
}
```

**Response** (200 OK):
```json
{
  "success": true,
  "data": {
    "score": 0.85,
    "isAnomaly": true,
    "confidence": 0.92,
    "features": {
      "requestRate": 1000,
      "avgLatency": 150,
      "errorRate": 0.08
    },
    "explanation": "Unusual combination of high request rate and elevated error rate"
  }
}
```

---

### POST /api/ml/optimize/rate-limit

Get rate limit recommendations.

**Request Body**:
```json
{
  "endpoint": "/api/users",
  "currentLimit": 100,
  "historicalData": [
    {"timestamp": "2024-01-15T10:00:00Z", "requests": 95, "errors": 1},
    {"timestamp": "2024-01-15T11:00:00Z", "requests": 120, "errors": 15}
  ]
}
```

**Response** (200 OK):
```json
{
  "success": true,
  "data": {
    "endpoint": "/api/users",
    "currentLimit": 100,
    "recommendedLimit": 110,
    "forecast": [105, 108, 112, 115],
    "confidence": 0.88,
    "reasoning": "Traffic trending upward, recommend 10% increase to maintain <5% error rate"
  }
}
```

---

## WebSocket API

### WS /ws/metrics

Real-time metrics streaming via WebSocket.

**Connect**:
```javascript
const ws = new WebSocket('ws://localhost:8080/ws/metrics');

ws.onopen = () => {
  console.log('Connected to metrics stream');
};

ws.onmessage = (event) => {
  const metrics = JSON.parse(event.data);
  console.log('Real-time metrics:', metrics);
};

ws.onerror = (error) => {
  console.error('WebSocket error:', error);
};

ws.onclose = () => {
  console.log('Disconnected from metrics stream');
};
```

**Message Format**:
```json
{
  "timestamp": "2024-01-15T10:30:45Z",
  "latency": {
    "p50": 45.2,
    "p95": 120.5,
    "p99": 250.0
  },
  "throughput": 1250,
  "errorRate": 0.02,
  "rateLimitUsage": 0.75,
  "activeConnections": 150
}
```

**Broadcast Interval**: 1 second

---

## Error Codes

### Standard HTTP Status Codes

- **200 OK**: Success
- **400 Bad Request**: Invalid request parameters
- **401 Unauthorized**: Missing or invalid authentication
- **403 Forbidden**: Insufficient permissions
- **404 Not Found**: Resource not found
- **429 Too Many Requests**: Rate limit exceeded
- **500 Internal Server Error**: Server error
- **502 Bad Gateway**: Upstream service unavailable
- **503 Service Unavailable**: Gateway overloaded

### Custom Error Response

```json
{
  "success": false,
  "error": "Error message",
  "code": "ERROR_CODE",
  "details": {
    "field": "Additional context"
  },
  "requestId": "req-abc123"
}
```

---

## Rate Limiting

### Response Headers

Every response includes rate limit info:

```http
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 75
X-RateLimit-Reset: 1640000060
```

### Rate Limited Response

**Status**: 429 Too Many Requests

```json
{
  "success": false,
  "error": "Too Many Requests",
  "retryAfter": 45,
  "rateLimit": {
    "limit": 100,
    "remaining": 0,
    "reset": 1640000060
  }
}
```

---

## Pagination

For endpoints returning lists:

**Parameters**:
- `page` (default: 1): Page number
- `limit` (default: 100): Results per page

**Response**:
```json
{
  "success": true,
  "data": [...],
  "meta": {
    "page": 1,
    "limit": 100,
    "total": 523,
    "pages": 6
  }
}
```

---

## Examples

### cURL

**Get latency metrics**:
```bash
curl "http://localhost:8080/api/metrics/latency?range=1h" \
  -H "X-API-Key: your-api-key"
```

**Natural language query**:
```bash
curl -X POST "http://localhost:8080/api/nl-query" \
  -H "Content-Type: application/json" \
  -d '{"question": "What is the error rate for the last 24 hours?"}'
```

### JavaScript (Fetch API)

```javascript
// Get metrics
const response = await fetch('http://localhost:8080/api/metrics/latency?range=1h');
const data = await response.json();
console.log(data);

// Natural language query
const nlResponse = await fetch('http://localhost:8080/api/nl-query', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    question: 'What is the throughput for /api/users?'
  })
});
const nlData = await nlResponse.json();
console.log(nlData.data.answer);
```

### Python (Requests)

```python
import requests

# Get metrics
response = requests.get(
    'http://localhost:8080/api/metrics/latency',
    params={'range': '1h'},
    headers={'X-API-Key': 'your-api-key'}
)
data = response.json()
print(data)

# Natural language query
nl_response = requests.post(
    'http://localhost:8080/api/nl-query',
    json={'question': 'Show me error rate for last 6 hours'}
)
nl_data = nl_response.json()
print(nl_data['data']['answer'])
```

---

## OpenAPI Specification

Full OpenAPI 3.0 spec available at:

**JSON**: `/api/openapi.json`
**YAML**: `/api/openapi.yaml`

**Swagger UI**: `/api/docs`

---

## SDKs

### Official SDKs

- **JavaScript/TypeScript**: `npm install @aegis/client`
- **Python**: `pip install aegis-client`
- **Go**: `go get github.com/aegis/go-client`

### Example (TypeScript SDK)

```typescript
import { AegisClient } from '@aegis/client';

const client = new AegisClient({
  baseUrl: 'http://localhost:8080',
  apiKey: 'your-api-key'
});

// Get metrics
const latency = await client.metrics.getLatency({ range: '1h' });
console.log(latency.data);

// Natural language query
const result = await client.nlQuery('What is the error rate?');
console.log(result.answer);

// WebSocket stream
client.metrics.stream((metrics) => {
  console.log('Real-time:', metrics);
});
```

---

## Support

- **Documentation**: https://docs.aegis.dev
- **GitHub Issues**: https://github.com/yourusername/aegis/issues
- **Discord**: https://discord.gg/aegis
- **Email**: support@aegis.dev

---

For more details, see:
- [README.md](../README.md) - Quick start
- [ARCHITECTURE.md](./ARCHITECTURE.md) - System design
- [CODE_GUIDE.md](./CODE_GUIDE.md) - Implementation details
