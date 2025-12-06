# =============================================================================
# AEGIS - Makefile
# =============================================================================
# Convenient commands for development, testing, and deployment

.PHONY: help install dev build start test lint format clean docker-up docker-down db-migrate ml-up ml-train ml-health

# Default target
help:
	@echo "AEGIS - Intelligent API Gateway"
	@echo ""
	@echo "Usage:"
	@echo "  make install      Install dependencies"
	@echo "  make dev          Start development server"
	@echo "  make build        Build for production"
	@echo "  make start        Start production server"
	@echo "  make test         Run tests"
	@echo "  make lint         Run linter"
	@echo "  make format       Format code"
	@echo "  make clean        Clean build artifacts"
	@echo ""
	@echo "Docker:"
	@echo "  make docker-up    Start Docker services"
	@echo "  make docker-down  Stop Docker services"
	@echo "  make docker-logs  View Docker logs"
	@echo "  make docker-all   Start all services including dev tools"
	@echo ""
	@echo "Database:"
	@echo "  make db-migrate   Run database migrations"
	@echo "  make db-status    Check migration status"
	@echo ""
	@echo "ML Service:"
	@echo "  make ml-up        Start ML service"
	@echo "  make ml-down      Stop ML service"
	@echo "  make ml-logs      View ML service logs"
	@echo "  make ml-health    Check ML service health"
	@echo "  make ml-train     Train ML models"
	@echo "  make ml-synthetic Generate synthetic training data"
	@echo "  make ml-shell     Open shell in ML container"
	@echo ""
	@echo "Testing:"
	@echo "  make echo-server  Start echo server for testing"
	@echo "  make test-api     Start mock API service"
	@echo "  make test-auth    Start mock auth service"

# =============================================================================
# Development
# =============================================================================

install:
	npm install

dev:
	npm run dev

build:
	npm run build

start:
	npm start

# =============================================================================
# Code Quality
# =============================================================================

test:
	npm test

test-watch:
	npm run test:watch

test-coverage:
	npm run test:coverage

lint:
	npm run lint

lint-fix:
	npm run lint:fix

format:
	npm run format

typecheck:
	npm run typecheck

# =============================================================================
# Docker
# =============================================================================

docker-up:
	docker compose -f docker/docker-compose.yml up -d

docker-down:
	docker compose -f docker/docker-compose.yml down

docker-logs:
	docker compose -f docker/docker-compose.yml logs -f

docker-all:
	docker compose -f docker/docker-compose.yml --profile dev-tools --profile mock-backends --profile ml up -d

docker-ps:
	docker compose -f docker/docker-compose.yml ps

docker-clean:
	docker compose -f docker/docker-compose.yml down -v --remove-orphans

# =============================================================================
# Database
# =============================================================================

db-migrate:
	npm run db:migrate

db-status:
	npm run db:migrate:status

db-create:
	@read -p "Enter migration name: " name; \
	npm run db:migrate:create -- $$name

# =============================================================================
# ML Service
# =============================================================================

ml-up:
	docker compose -f docker/docker-compose.yml --profile ml up -d

ml-down:
	docker compose -f docker/docker-compose.yml --profile ml down

ml-logs:
	docker compose -f docker/docker-compose.yml logs -f ml-service

ml-build:
	docker compose -f docker/docker-compose.yml build ml-service

ml-health:
	@curl -s http://localhost:5000/health | python3 -m json.tool 2>/dev/null || echo "ML service not available"

ml-train:
	@echo "Training ML models on historical data..."
	@curl -s -X POST http://localhost:5000/train \
		-H "Content-Type: application/json" \
		-d '{"days": 7, "models": ["anomaly", "optimizer"]}' | python3 -m json.tool

ml-train-synthetic:
	@echo "Generating synthetic data and training..."
	@curl -s -X POST http://localhost:5000/generate/synthetic \
		-H "Content-Type: application/json" \
		-d '{"duration_hours": 168, "base_rps": 50, "anomaly_rate": 0.05}' | python3 -m json.tool
	@curl -s -X POST http://localhost:5000/train/synthetic | python3 -m json.tool

ml-synthetic:
	@echo "Generating synthetic training data..."
	@curl -s -X POST http://localhost:5000/generate/synthetic \
		-H "Content-Type: application/json" \
		-d '{"duration_hours": 168, "base_rps": 50, "include_anomalies": true, "anomaly_rate": 0.05}' | python3 -m json.tool

ml-model-info:
	@curl -s http://localhost:5000/model/info | python3 -m json.tool 2>/dev/null || echo "ML service not available"

ml-shell:
	docker compose -f docker/docker-compose.yml exec ml-service /bin/sh

ml-detect:
	@echo "Testing anomaly detection..."
	@curl -s -X POST http://localhost:5000/detect \
		-H "Content-Type: application/json" \
		-d '{"requests_per_second": 100, "avg_latency_ms": 50, "p95_latency_ms": 100, "p99_latency_ms": 150, "error_rate": 0.01}' | python3 -m json.tool

ml-detect-anomaly:
	@echo "Testing with anomalous data..."
	@curl -s -X POST http://localhost:5000/detect \
		-H "Content-Type: application/json" \
		-d '{"requests_per_second": 500, "avg_latency_ms": 500, "p95_latency_ms": 1000, "p99_latency_ms": 2000, "error_rate": 0.25}' | python3 -m json.tool

ml-optimize:
	@echo "Getting rate limit recommendation..."
	@curl -s -X POST http://localhost:5000/optimize \
		-H "Content-Type: application/json" \
		-d '{"endpoint": "/api/users", "tier": "default", "strategy": "balanced"}' | python3 -m json.tool

# Local ML development (without Docker)
ml-dev-install:
	cd aegis-ml && python -m venv venv && . venv/bin/activate && pip install -r requirements.txt

ml-dev-run:
	cd aegis-ml && . venv/bin/activate && python -m api.flask_server

ml-dev-export:
	cd aegis-ml && . venv/bin/activate && python scripts/export_training_data.py --days 7 --stats

ml-dev-generate:
	cd aegis-ml && . venv/bin/activate && python scripts/generate_synthetic_data.py --days 7 --output data/synthetic_data.csv

# =============================================================================
# Testing Utilities
# =============================================================================

echo-server:
	npm run test:echo

test-api:
	npm run test:echo:api

test-auth:
	npm run test:echo:auth

test-users:
	npm run test:echo:users

test-server:
	npx ts-node scripts/test-server.ts

# =============================================================================
# Stress Testing & Demos
# =============================================================================

stress-quick:
	@chmod +x scripts/stress-test.sh
	./scripts/stress-test.sh --quick

stress-standard:
	@chmod +x scripts/stress-test.sh
	./scripts/stress-test.sh --standard

stress-heavy:
	@chmod +x scripts/stress-test.sh
	./scripts/stress-test.sh --heavy

stress-all:
	@chmod +x scripts/stress-test.sh
	./scripts/stress-test.sh --all

demo:
	@chmod +x scripts/stress-test.sh
	./scripts/stress-test.sh --demo

demo-load:
	@echo "Generating demo traffic for 2 minutes..."
	@for i in $$(seq 1 2400); do \
		curl -s -o /dev/null http://localhost:8080/health & \
		curl -s -o /dev/null http://localhost:8080/api/test & \
		sleep 0.05; \
	done
	@echo "Demo load complete"

benchmark:
	@echo "Running benchmark..."
	@if command -v wrk &> /dev/null; then \
		wrk -t4 -c100 -d30s http://localhost:8080/health; \
	elif command -v ab &> /dev/null; then \
		ab -n 10000 -c 100 -k http://localhost:8080/health; \
	else \
		echo "Install wrk or ab for benchmarking"; \
	fi

# =============================================================================
# Cleanup
# =============================================================================

clean:
	rm -rf dist
	rm -rf coverage
	rm -rf node_modules/.cache

clean-ml:
	rm -rf aegis-ml/data/models/*
	rm -rf aegis-ml/data/*.csv
	rm -rf aegis-ml/__pycache__
	rm -rf aegis-ml/**/__pycache__
	rm -rf aegis-ml/venv

clean-all: clean clean-ml
	rm -rf node_modules
	rm -rf docker/data

# =============================================================================
# Setup (first-time installation)
# =============================================================================

setup: install docker-up
	@echo "Waiting for services to start..."
	@sleep 5
	$(MAKE) db-migrate
	@echo ""
	@echo "✅ AEGIS setup complete!"
	@echo "Run 'make dev' to start the development server"

setup-ml: docker-up ml-up
	@echo "Waiting for ML service to start..."
	@sleep 10
	$(MAKE) ml-train-synthetic
	@echo ""
	@echo "✅ AEGIS ML setup complete!"
	@echo "Run 'make ml-health' to check service status"

setup-full: setup ml-up
	@echo "Waiting for ML service to start..."
	@sleep 10
	$(MAKE) ml-train-synthetic
	@echo ""
	@echo "✅ Full AEGIS setup complete!"
	@echo "- Gateway: Run 'make dev' to start"
	@echo "- ML Service: http://localhost:5000"
	@echo "- PostgreSQL: localhost:5432"
	@echo "- Redis: localhost:6379"
