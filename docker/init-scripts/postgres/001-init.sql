-- =============================================================================
-- AEGIS - PostgreSQL Database Initialization
-- =============================================================================
-- This script is automatically executed when the PostgreSQL container starts
-- for the first time. It creates the necessary tables, indexes, and seed data.

-- -----------------------------------------------------------------------------
-- Extensions
-- -----------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- -----------------------------------------------------------------------------
-- Request Logs Table
-- -----------------------------------------------------------------------------
-- Stores all request logs for analytics and debugging

CREATE TABLE IF NOT EXISTS request_logs (
    id SERIAL PRIMARY KEY,
    timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    method VARCHAR(10) NOT NULL,
    path TEXT NOT NULL,
    status_code INTEGER NOT NULL,
    response_time_ms INTEGER NOT NULL,
    user_id VARCHAR(255),
    ip_address INET,
    user_agent TEXT,
    backend_name VARCHAR(100),
    request_id UUID NOT NULL,
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_request_logs_timestamp ON request_logs (timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_request_logs_path ON request_logs USING gin (path gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_request_logs_status_code ON request_logs (status_code);
CREATE INDEX IF NOT EXISTS idx_request_logs_user_id ON request_logs (user_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_request_logs_ip_address ON request_logs (ip_address);
CREATE INDEX IF NOT EXISTS idx_request_logs_backend_name ON request_logs (backend_name) WHERE backend_name IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_request_logs_request_id ON request_logs (request_id);

-- Composite index for time-range queries with status filtering
CREATE INDEX IF NOT EXISTS idx_request_logs_timestamp_status ON request_logs (timestamp DESC, status_code);

-- -----------------------------------------------------------------------------
-- Rate Limit Rules Table
-- -----------------------------------------------------------------------------
-- Stores rate limiting configurations per endpoint/tier

CREATE TABLE IF NOT EXISTS rate_limit_rules (
    id SERIAL PRIMARY KEY,
    endpoint_pattern VARCHAR(255) NOT NULL,
    requests_per_minute INTEGER NOT NULL DEFAULT 100,
    tier VARCHAR(50) NOT NULL DEFAULT 'default',
    burst_size INTEGER DEFAULT NULL,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    description TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(endpoint_pattern, tier)
);

-- Index for rule lookups
CREATE INDEX IF NOT EXISTS idx_rate_limit_rules_pattern ON rate_limit_rules (endpoint_pattern);
CREATE INDEX IF NOT EXISTS idx_rate_limit_rules_tier ON rate_limit_rules (tier);
CREATE INDEX IF NOT EXISTS idx_rate_limit_rules_enabled ON rate_limit_rules (enabled) WHERE enabled = TRUE;

-- -----------------------------------------------------------------------------
-- API Keys Table
-- -----------------------------------------------------------------------------
-- Stores API keys for authentication and rate limit tier assignment

CREATE TABLE IF NOT EXISTS api_keys (
    id SERIAL PRIMARY KEY,
    key_hash VARCHAR(64) NOT NULL UNIQUE,
    name VARCHAR(100) NOT NULL,
    tier VARCHAR(50) NOT NULL DEFAULT 'default',
    user_id VARCHAR(255),
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    rate_limit_override INTEGER,
    expires_at TIMESTAMPTZ,
    last_used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for API key lookups
CREATE INDEX IF NOT EXISTS idx_api_keys_key_hash ON api_keys (key_hash);
CREATE INDEX IF NOT EXISTS idx_api_keys_user_id ON api_keys (user_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_api_keys_tier ON api_keys (tier);
CREATE INDEX IF NOT EXISTS idx_api_keys_enabled ON api_keys (enabled) WHERE enabled = TRUE;

-- -----------------------------------------------------------------------------
-- Backend Services Table
-- -----------------------------------------------------------------------------
-- Stores backend service configurations (can be used instead of/alongside YAML config)

CREATE TABLE IF NOT EXISTS backend_services (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL UNIQUE,
    url VARCHAR(500) NOT NULL,
    health_check_path VARCHAR(255) DEFAULT '/health',
    health_check_interval_ms INTEGER DEFAULT 30000,
    timeout_ms INTEGER DEFAULT 30000,
    retry_attempts INTEGER DEFAULT 3,
    weight INTEGER DEFAULT 1,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- -----------------------------------------------------------------------------
-- Backend Routes Table
-- -----------------------------------------------------------------------------
-- Stores route patterns for backend services

CREATE TABLE IF NOT EXISTS backend_routes (
    id SERIAL PRIMARY KEY,
    backend_id INTEGER NOT NULL REFERENCES backend_services(id) ON DELETE CASCADE,
    pattern VARCHAR(255) NOT NULL,
    priority INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(pattern)
);

CREATE INDEX IF NOT EXISTS idx_backend_routes_backend_id ON backend_routes (backend_id);
CREATE INDEX IF NOT EXISTS idx_backend_routes_pattern ON backend_routes (pattern);

-- -----------------------------------------------------------------------------
-- Metrics Aggregates Table
-- -----------------------------------------------------------------------------
-- Pre-aggregated metrics for dashboard performance

CREATE TABLE IF NOT EXISTS metrics_aggregates (
    id SERIAL PRIMARY KEY,
    period_start TIMESTAMPTZ NOT NULL,
    period_end TIMESTAMPTZ NOT NULL,
    period_type VARCHAR(20) NOT NULL, -- 'minute', 'hour', 'day'
    backend_name VARCHAR(100),
    total_requests INTEGER NOT NULL DEFAULT 0,
    successful_requests INTEGER NOT NULL DEFAULT 0,
    failed_requests INTEGER NOT NULL DEFAULT 0,
    avg_response_time_ms NUMERIC(10, 2),
    p50_response_time_ms NUMERIC(10, 2),
    p95_response_time_ms NUMERIC(10, 2),
    p99_response_time_ms NUMERIC(10, 2),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(period_start, period_type, backend_name)
);

CREATE INDEX IF NOT EXISTS idx_metrics_aggregates_period ON metrics_aggregates (period_start DESC, period_type);
CREATE INDEX IF NOT EXISTS idx_metrics_aggregates_backend ON metrics_aggregates (backend_name, period_start DESC);

-- -----------------------------------------------------------------------------
-- Functions
-- -----------------------------------------------------------------------------

-- Function to update the updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- -----------------------------------------------------------------------------
-- Triggers
-- -----------------------------------------------------------------------------

-- Auto-update updated_at for rate_limit_rules
DROP TRIGGER IF EXISTS update_rate_limit_rules_updated_at ON rate_limit_rules;
CREATE TRIGGER update_rate_limit_rules_updated_at
    BEFORE UPDATE ON rate_limit_rules
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Auto-update updated_at for api_keys
DROP TRIGGER IF EXISTS update_api_keys_updated_at ON api_keys;
CREATE TRIGGER update_api_keys_updated_at
    BEFORE UPDATE ON api_keys
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Auto-update updated_at for backend_services
DROP TRIGGER IF EXISTS update_backend_services_updated_at ON backend_services;
CREATE TRIGGER update_backend_services_updated_at
    BEFORE UPDATE ON backend_services
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- -----------------------------------------------------------------------------
-- Seed Data - Default Rate Limit Rules
-- -----------------------------------------------------------------------------

INSERT INTO rate_limit_rules (endpoint_pattern, requests_per_minute, tier, description)
VALUES
    ('/*', 100, 'default', 'Default rate limit for all endpoints'),
    ('/api/public/*', 200, 'public', 'Higher limit for public API endpoints'),
    ('/api/admin/*', 50, 'admin', 'Lower limit for admin endpoints'),
    ('/auth/login', 10, 'auth', 'Strict limit for login attempts'),
    ('/auth/register', 5, 'auth', 'Very strict limit for registration'),
    ('/health', 1000, 'internal', 'High limit for health checks'),
    ('/metrics', 1000, 'internal', 'High limit for metrics endpoint')
ON CONFLICT (endpoint_pattern, tier) DO NOTHING;

-- -----------------------------------------------------------------------------
-- Partitioning Setup for Request Logs (optional, for high-volume deployments)
-- -----------------------------------------------------------------------------
-- Note: Uncomment and modify for production use with high request volumes

-- CREATE TABLE request_logs_partitioned (
--     LIKE request_logs INCLUDING ALL
-- ) PARTITION BY RANGE (timestamp);

-- CREATE TABLE request_logs_y2024m01 PARTITION OF request_logs_partitioned
--     FOR VALUES FROM ('2024-01-01') TO ('2024-02-01');

-- -----------------------------------------------------------------------------
-- Cleanup Function for Old Logs
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION cleanup_old_request_logs(retention_days INTEGER DEFAULT 30)
RETURNS INTEGER AS $$
DECLARE
    deleted_count INTEGER;
BEGIN
    DELETE FROM request_logs
    WHERE timestamp < NOW() - (retention_days || ' days')::INTERVAL;

    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;

-- -----------------------------------------------------------------------------
-- View for Recent Request Statistics
-- -----------------------------------------------------------------------------

CREATE OR REPLACE VIEW v_recent_request_stats AS
SELECT
    date_trunc('minute', timestamp) AS time_bucket,
    COUNT(*) AS total_requests,
    COUNT(*) FILTER (WHERE status_code >= 200 AND status_code < 300) AS successful,
    COUNT(*) FILTER (WHERE status_code >= 400 AND status_code < 500) AS client_errors,
    COUNT(*) FILTER (WHERE status_code >= 500) AS server_errors,
    AVG(response_time_ms)::NUMERIC(10, 2) AS avg_response_time,
    PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY response_time_ms)::NUMERIC(10, 2) AS p95_response_time
FROM request_logs
WHERE timestamp > NOW() - INTERVAL '1 hour'
GROUP BY time_bucket
ORDER BY time_bucket DESC;

-- -----------------------------------------------------------------------------
-- Grants (adjust based on your security requirements)
-- -----------------------------------------------------------------------------

-- Grant permissions to aegis_user
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO aegis_user;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO aegis_user;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO aegis_user;

-- Log completion
DO $$
BEGIN
    RAISE NOTICE 'AEGIS database initialization completed successfully';
END $$;
