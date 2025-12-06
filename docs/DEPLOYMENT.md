# Deployment Guide

This guide covers deploying Aegis in various environments, from local development to production Kubernetes clusters.

---

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Local Development](#local-development)
3. [Docker Compose](#docker-compose)
4. [Kubernetes](#kubernetes)
5. [Cloud Platforms](#cloud-platforms)
6. [Production Checklist](#production-checklist)
7. [Monitoring & Operations](#monitoring--operations)

---

## Prerequisites

### System Requirements

**Minimum** (development):
- CPU: 2 cores
- RAM: 4 GB
- Disk: 20 GB
- OS: Linux, macOS, or Windows (WSL2)

**Recommended** (production):
- CPU: 4+ cores
- RAM: 8+ GB
- Disk: 100+ GB (SSD)
- OS: Linux (Ubuntu 22.04 or similar)

### Software Dependencies

- **Node.js**: v20+ ([download](https://nodejs.org/))
- **Python**: 3.11+ ([download](https://python.org/))
- **Docker**: v24+ ([download](https://docker.com/))
- **Docker Compose**: v2+ (included with Docker Desktop)
- **Make**: For build automation
- **Git**: For version control

**Optional**:
- **Kubernetes**: kubectl + k9s (cluster management)
- **Helm**: v3+ (Kubernetes package manager)
- **Terraform**: v1.5+ (infrastructure as code)

---

## Local Development

### Quick Start

**1. Clone repository**:
```bash
git clone https://github.com/yourusername/aegis.git
cd aegis
```

**2. Install dependencies**:
```bash
# Backend
npm install

# Frontend
cd frontend && npm install && cd ..

# ML API
cd aegis-ml && pip install -r requirements.txt && cd ..
```

**3. Configure environment**:
```bash
# Copy example config
cp config/aegis.config.example.yaml config/aegis.config.yaml

# Create frontend .env.local
cat > frontend/.env.local <<EOF
NEXT_PUBLIC_API_URL=http://localhost:8080
NEXT_PUBLIC_WS_URL=ws://localhost:8080/ws/metrics
NEXT_PUBLIC_ENABLE_REALTIME=true
EOF
```

**4. Start dependencies** (PostgreSQL, Redis):
```bash
docker-compose up -d postgres redis
```

**5. Run migrations**:
```bash
npm run migrate
```

**6. Start services**:
```bash
# Terminal 1: Gateway
npm run dev

# Terminal 2: Frontend
cd frontend && npm run dev

# Terminal 3: ML API
cd aegis-ml && python api/flask_server.py
```

**7. Verify**:
```bash
# Gateway health check
curl http://localhost:8080/health

# Frontend
open http://localhost:3000

# ML API
curl http://localhost:5001/health
```

### Development Workflow

**Hot reload**:
- Backend: Watches `src/**/*.ts` and recompiles on change
- Frontend: Next.js dev server auto-reloads
- ML API: Flask debug mode restarts on file change

**Run tests**:
```bash
# Backend unit tests
npm test

# Backend integration tests
npm run test:integration

# Frontend tests
cd frontend && npm test

# ML tests
cd aegis-ml && pytest
```

**Linting**:
```bash
# TypeScript/JavaScript
npm run lint

# Python
cd aegis-ml && pylint **/*.py
```

---

## Docker Compose

### Full Stack Deployment

**1. Build images**:
```bash
docker-compose build
```

**2. Start all services**:
```bash
docker-compose up -d
```

Services started:
- `aegis-gateway`: API gateway (port 8080)
- `aegis-frontend`: Next.js dashboard (port 3000)
- `aegis-ml`: ML API (port 5001)
- `postgres`: PostgreSQL database (port 5432)
- `redis`: Redis cache (port 6379)

**3. Check logs**:
```bash
# All services
docker-compose logs -f

# Specific service
docker-compose logs -f aegis-gateway
```

**4. Stop services**:
```bash
docker-compose down
```

**5. Clean up (including volumes)**:
```bash
docker-compose down -v
```

### Production Configuration

**docker-compose.prod.yml**:
```yaml
version: '3.8'

services:
  aegis-gateway:
    image: aegis-gateway:${VERSION:-latest}
    restart: always
    environment:
      NODE_ENV: production
      LOG_LEVEL: info
    deploy:
      replicas: 3
      resources:
        limits:
          cpus: '1.0'
          memory: 1G
        reservations:
          cpus: '0.5'
          memory: 512M
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8080/health"]
      interval: 30s
      timeout: 10s
      retries: 3

  postgres:
    image: postgres:15
    restart: always
    environment:
      POSTGRES_DB: aegis
      POSTGRES_USER: aegis
      POSTGRES_PASSWORD_FILE: /run/secrets/db_password
    secrets:
      - db_password
    volumes:
      - postgres_data:/var/lib/postgresql/data
    deploy:
      resources:
        limits:
          memory: 2G

secrets:
  db_password:
    file: ./secrets/db_password.txt

volumes:
  postgres_data:
  redis_data:
```

**Deploy**:
```bash
docker-compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

---

## Kubernetes

### Architecture

```
┌─────────────────────────────────────────────────────┐
│                  Ingress Controller                 │
│              (NGINX / Traefik / ALB)                │
└─────────────────┬───────────────────────────────────┘
                  │
         ┌────────┴─────────┐
         │                  │
    ┌────▼─────┐      ┌────▼──────┐
    │ Gateway  │      │ Frontend  │
    │  Pods    │      │   Pods    │
    │  (3x)    │      │   (2x)    │
    └────┬─────┘      └───────────┘
         │
    ┌────▼─────┐
    │  ML API  │
    │   Pods   │
    │   (2x)   │
    └────┬─────┘
         │
    ┌────┴──────────────────┐
    │                       │
┌───▼────┐            ┌────▼─────┐
│ Redis  │            │PostgreSQL│
│Cluster │            │StatefulSet
│ (3x)   │            │   (3x)   │
└────────┘            └──────────┘
```

### Prerequisites

**1. Kubernetes cluster**:
- **Local**: Minikube, Kind, or Docker Desktop
- **Cloud**: EKS (AWS), GKE (Google), AKS (Azure)
- **Self-hosted**: kubeadm, k3s, or RKE2

**2. kubectl configured**:
```bash
kubectl cluster-info
kubectl get nodes
```

**3. Create namespace**:
```bash
kubectl create namespace aegis
kubectl config set-context --current --namespace=aegis
```

### Deployment with Manifests

**1. Create ConfigMap** (`k8s/configmap.yaml`):
```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: aegis-config
data:
  aegis.config.yaml: |
    gateway:
      port: 8080
      routes:
        - path: "/api/users"
          upstream: "http://user-service:3001"
    rateLimiting:
      default:
        limit: 100
        window: "1m"
```

**2. Create Secrets** (`k8s/secrets.yaml`):
```yaml
apiVersion: v1
kind: Secret
metadata:
  name: aegis-secrets
type: Opaque
stringData:
  POSTGRES_PASSWORD: "your-secure-password"
  REDIS_PASSWORD: "your-redis-password"
  OPENAI_API_KEY: "sk-..."
```

**3. Deploy PostgreSQL** (`k8s/postgres.yaml`):
```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: postgres
spec:
  serviceName: postgres
  replicas: 1
  selector:
    matchLabels:
      app: postgres
  template:
    metadata:
      labels:
        app: postgres
    spec:
      containers:
      - name: postgres
        image: postgres:15
        env:
        - name: POSTGRES_DB
          value: aegis
        - name: POSTGRES_USER
          value: aegis
        - name: POSTGRES_PASSWORD
          valueFrom:
            secretKeyRef:
              name: aegis-secrets
              key: POSTGRES_PASSWORD
        ports:
        - containerPort: 5432
        volumeMounts:
        - name: postgres-data
          mountPath: /var/lib/postgresql/data
  volumeClaimTemplates:
  - metadata:
      name: postgres-data
    spec:
      accessModes: ["ReadWriteOnce"]
      resources:
        requests:
          storage: 50Gi
---
apiVersion: v1
kind: Service
metadata:
  name: postgres
spec:
  selector:
    app: postgres
  ports:
  - port: 5432
  clusterIP: None
```

**4. Deploy Redis** (`k8s/redis.yaml`):
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: redis
spec:
  replicas: 1
  selector:
    matchLabels:
      app: redis
  template:
    metadata:
      labels:
        app: redis
    spec:
      containers:
      - name: redis
        image: redis:7-alpine
        ports:
        - containerPort: 6379
---
apiVersion: v1
kind: Service
metadata:
  name: redis
spec:
  selector:
    app: redis
  ports:
  - port: 6379
```

**5. Deploy Gateway** (`k8s/gateway.yaml`):
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: aegis-gateway
spec:
  replicas: 3
  selector:
    matchLabels:
      app: aegis-gateway
  template:
    metadata:
      labels:
        app: aegis-gateway
    spec:
      containers:
      - name: gateway
        image: your-registry/aegis-gateway:v1.0.0
        ports:
        - containerPort: 8080
        env:
        - name: NODE_ENV
          value: production
        - name: POSTGRES_HOST
          value: postgres
        - name: REDIS_HOST
          value: redis
        - name: ML_API_URL
          value: http://aegis-ml:5001
        envFrom:
        - secretRef:
            name: aegis-secrets
        volumeMounts:
        - name: config
          mountPath: /app/config
          readOnly: true
        resources:
          requests:
            memory: "512Mi"
            cpu: "500m"
          limits:
            memory: "1Gi"
            cpu: "1000m"
        livenessProbe:
          httpGet:
            path: /health
            port: 8080
          initialDelaySeconds: 30
          periodSeconds: 10
        readinessProbe:
          httpGet:
            path: /health
            port: 8080
          initialDelaySeconds: 5
          periodSeconds: 5
      volumes:
      - name: config
        configMap:
          name: aegis-config
---
apiVersion: v1
kind: Service
metadata:
  name: aegis-gateway
spec:
  selector:
    app: aegis-gateway
  ports:
  - port: 8080
    targetPort: 8080
  type: ClusterIP
```

**6. Deploy Ingress** (`k8s/ingress.yaml`):
```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: aegis-ingress
  annotations:
    nginx.ingress.kubernetes.io/ssl-redirect: "true"
    cert-manager.io/cluster-issuer: "letsencrypt-prod"
spec:
  ingressClassName: nginx
  tls:
  - hosts:
    - api.yourdomain.com
    secretName: aegis-tls
  rules:
  - host: api.yourdomain.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: aegis-gateway
            port:
              number: 8080
```

**7. Apply manifests**:
```bash
kubectl apply -f k8s/
```

**8. Verify deployment**:
```bash
# Check pods
kubectl get pods

# Check services
kubectl get svc

# Check ingress
kubectl get ingress

# View logs
kubectl logs -f deployment/aegis-gateway
```

### Helm Deployment

**1. Create Helm chart** (`helm/aegis/Chart.yaml`):
```yaml
apiVersion: v2
name: aegis
description: High-performance API Gateway
version: 1.0.0
appVersion: 1.0.0
```

**2. Values file** (`helm/aegis/values.yaml`):
```yaml
replicaCount: 3

image:
  repository: your-registry/aegis-gateway
  tag: v1.0.0
  pullPolicy: IfNotPresent

service:
  type: ClusterIP
  port: 8080

ingress:
  enabled: true
  className: nginx
  hosts:
    - host: api.yourdomain.com
      paths:
        - path: /
          pathType: Prefix
  tls:
    - secretName: aegis-tls
      hosts:
        - api.yourdomain.com

resources:
  requests:
    memory: "512Mi"
    cpu: "500m"
  limits:
    memory: "1Gi"
    cpu: "1000m"

autoscaling:
  enabled: true
  minReplicas: 3
  maxReplicas: 10
  targetCPUUtilizationPercentage: 70

postgres:
  enabled: true
  storageSize: 50Gi

redis:
  enabled: true
```

**3. Install chart**:
```bash
helm install aegis ./helm/aegis --namespace aegis --create-namespace
```

**4. Upgrade**:
```bash
helm upgrade aegis ./helm/aegis
```

**5. Uninstall**:
```bash
helm uninstall aegis
```

### Auto-Scaling

**Horizontal Pod Autoscaler** (`k8s/hpa.yaml`):
```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: aegis-gateway-hpa
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: aegis-gateway
  minReplicas: 3
  maxReplicas: 10
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 70
  - type: Resource
    resource:
      name: memory
      target:
        type: Utilization
        averageUtilization: 80
```

---

## Cloud Platforms

### AWS (EKS + RDS + ElastiCache)

**Architecture**:
```
Internet → ALB → EKS Cluster
                  ├── Gateway Pods
                  ├── Frontend Pods
                  └── ML API Pods
                       ├── RDS PostgreSQL (managed)
                       └── ElastiCache Redis (managed)
```

**1. Provision infrastructure** (`terraform/aws/main.tf`):
```hcl
# EKS Cluster
module "eks" {
  source  = "terraform-aws-modules/eks/aws"
  version = "~> 19.0"

  cluster_name    = "aegis-cluster"
  cluster_version = "1.28"

  vpc_id     = module.vpc.vpc_id
  subnet_ids = module.vpc.private_subnets

  eks_managed_node_groups = {
    main = {
      min_size     = 3
      max_size     = 10
      desired_size = 3

      instance_types = ["t3.medium"]
    }
  }
}

# RDS PostgreSQL
resource "aws_db_instance" "postgres" {
  identifier = "aegis-db"
  engine     = "postgres"
  engine_version = "15.3"
  instance_class = "db.t3.medium"
  allocated_storage = 100

  db_name  = "aegis"
  username = "aegis"
  password = var.db_password

  vpc_security_group_ids = [aws_security_group.rds.id]
  db_subnet_group_name   = aws_db_subnet_group.main.name

  backup_retention_period = 7
  skip_final_snapshot     = false
}

# ElastiCache Redis
resource "aws_elasticache_cluster" "redis" {
  cluster_id      = "aegis-redis"
  engine          = "redis"
  engine_version  = "7.0"
  node_type       = "cache.t3.micro"
  num_cache_nodes = 1

  subnet_group_name    = aws_elasticache_subnet_group.main.name
  security_group_ids   = [aws_security_group.redis.id]
}
```

**2. Deploy**:
```bash
cd terraform/aws
terraform init
terraform plan
terraform apply
```

**3. Configure kubectl**:
```bash
aws eks update-kubeconfig --region us-east-1 --name aegis-cluster
```

**4. Deploy app** (use Kubernetes manifests above, update DB/Redis endpoints)

---

### Google Cloud (GKE + Cloud SQL + Memorystore)

**1. Provision** (`terraform/gcp/main.tf`):
```hcl
# GKE Cluster
resource "google_container_cluster" "primary" {
  name     = "aegis-cluster"
  location = "us-central1"

  node_pool {
    name       = "main-pool"
    node_count = 3

    node_config {
      machine_type = "e2-medium"
    }
  }
}

# Cloud SQL PostgreSQL
resource "google_sql_database_instance" "postgres" {
  name             = "aegis-db"
  database_version = "POSTGRES_15"
  region           = "us-central1"

  settings {
    tier = "db-f1-micro"
  }
}

# Memorystore Redis
resource "google_redis_instance" "redis" {
  name           = "aegis-redis"
  memory_size_gb = 1
  region         = "us-central1"
}
```

---

### Azure (AKS + Azure Database + Azure Cache)

**1. Provision** (`terraform/azure/main.tf`):
```hcl
# AKS Cluster
resource "azurerm_kubernetes_cluster" "main" {
  name                = "aegis-cluster"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  dns_prefix          = "aegis"

  default_node_pool {
    name       = "default"
    node_count = 3
    vm_size    = "Standard_D2_v2"
  }
}

# Azure Database for PostgreSQL
resource "azurerm_postgresql_server" "postgres" {
  name                = "aegis-db"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name

  sku_name = "B_Gen5_1"
  version  = "11"
}

# Azure Cache for Redis
resource "azurerm_redis_cache" "redis" {
  name                = "aegis-redis"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  capacity            = 0
  family              = "C"
  sku_name            = "Basic"
}
```

---

## Production Checklist

### Security

- [ ] Enable TLS/HTTPS (Let's Encrypt or ACM)
- [ ] Use secrets manager (AWS Secrets Manager, HashiCorp Vault)
- [ ] Rotate credentials regularly
- [ ] Enable network policies (restrict pod-to-pod traffic)
- [ ] Use RBAC (role-based access control)
- [ ] Scan images for vulnerabilities (Trivy, Snyk)
- [ ] Enable audit logging
- [ ] Configure firewall rules (security groups, NSGs)

### Performance

- [ ] Enable connection pooling (PgBouncer for PostgreSQL)
- [ ] Configure Redis clustering for high availability
- [ ] Use CDN for static assets (CloudFront, CloudFlare)
- [ ] Enable gzip compression
- [ ] Set resource limits and requests
- [ ] Configure HPA (horizontal pod autoscaling)
- [ ] Use read replicas for PostgreSQL

### Reliability

- [ ] Set up multi-zone/region deployment
- [ ] Configure health checks (liveness, readiness)
- [ ] Enable automatic restarts
- [ ] Configure backups (database, volumes)
- [ ] Test disaster recovery procedures
- [ ] Set up monitoring and alerting
- [ ] Configure PodDisruptionBudget

### Monitoring

- [ ] Install Prometheus + Grafana
- [ ] Set up logging aggregation (ELK, Loki)
- [ ] Configure distributed tracing (Jaeger, Tempo)
- [ ] Enable metrics export
- [ ] Set up uptime monitoring (UptimeRobot, Pingdom)
- [ ] Configure on-call rotation (PagerDuty, Opsgenie)

---

## Monitoring & Operations

### Prometheus + Grafana

**1. Install Prometheus**:
```bash
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm install prometheus prometheus-community/prometheus
```

**2. Install Grafana**:
```bash
helm repo add grafana https://grafana.github.io/helm-charts
helm install grafana grafana/grafana
```

**3. Import Aegis dashboard** (JSON in `grafana/dashboards/aegis.json`)

### Logging with Loki

**1. Install Loki stack**:
```bash
helm repo add grafana https://grafana.github.io/helm-charts
helm install loki grafana/loki-stack
```

**2. Query logs**:
```logql
{app="aegis-gateway"} |= "error"
```

### Backup & Restore

**PostgreSQL backup**:
```bash
# Backup
kubectl exec -it postgres-0 -- pg_dump -U aegis aegis > backup.sql

# Restore
kubectl exec -i postgres-0 -- psql -U aegis aegis < backup.sql
```

**Automated backups** (CronJob):
```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: postgres-backup
spec:
  schedule: "0 2 * * *"  # Daily at 2 AM
  jobTemplate:
    spec:
      template:
        spec:
          containers:
          - name: backup
            image: postgres:15
            command:
            - /bin/sh
            - -c
            - pg_dump -U aegis -h postgres aegis | gzip > /backups/backup-$(date +%Y%m%d).sql.gz
            volumeMounts:
            - name: backups
              mountPath: /backups
          volumes:
          - name: backups
            persistentVolumeClaim:
              claimName: backup-pvc
```

---

## Troubleshooting

### Pod not starting

```bash
# Check pod status
kubectl get pods

# Describe pod (shows events)
kubectl describe pod aegis-gateway-xxxxx

# Check logs
kubectl logs aegis-gateway-xxxxx
```

### Database connection failed

```bash
# Test connection from pod
kubectl exec -it aegis-gateway-xxxxx -- nc -zv postgres 5432

# Check secrets
kubectl get secret aegis-secrets -o yaml
```

### High memory usage

```bash
# Check resource usage
kubectl top pods

# Adjust limits in deployment
resources:
  limits:
    memory: "2Gi"  # Increase limit
```

---

## References

- [Kubernetes Documentation](https://kubernetes.io/docs/)
- [Docker Compose Reference](https://docs.docker.com/compose/)
- [Helm Charts](https://helm.sh/docs/)
- [Terraform AWS Provider](https://registry.terraform.io/providers/hashicorp/aws/latest/docs)

For more details, see:
- [ARCHITECTURE.md](./ARCHITECTURE.md) - System architecture
- [README.md](../README.md) - Quick start guide
