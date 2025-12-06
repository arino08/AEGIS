-- =============================================================================
-- Migration 003: Create Metrics Tables
-- =============================================================================
-- Creates time-series tables for storing metrics data with TimescaleDB-compatible
-- schema. These tables are optimized for efficient time-range queries and aggregations.
--
-- Note: If using TimescaleDB, run `CREATE EXTENSION IF NOT EXISTS timescaledb;`
-- and convert tables to hypertables for better performance:
--   SELECT create_hypertable('request_metrics', 'timestamp');
--   SELECT create_hypertable('rate_limit_metrics', 'timestamp');
--   SELECT create_hypertable('backend_metrics', 'timestamp');
-- =============================================================================

-- Request metrics table (main time-series data)
CREATE TABLE IF NOT EXISTS request_metrics (
    id BIGSERIAL,
    timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    request_id VARCHAR(64) NOT NULL,
    path TEXT NOT NULL,
    method VARCHAR(10) NOT NULL,
    status_code INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL,
    user_id VARCHAR(128),
    ip_address VARCHAR(45) NOT NULL,
    user_agent TEXT,
    backend VARCHAR(64),
    bytes_in INTEGER,
    bytes_out INTEGER,
    error TEXT,
    rate_limited BOOLEAN DEFAULT FALSE,
    cached BOOLEAN DEFAULT FALSE,
    tier VARCHAR(32),

    PRIMARY KEY (id, timestamp)
);

-- Create index for time-based queries (essential for time-series data)
CREATE INDEX IF NOT EXISTS idx_request_metrics_timestamp
    ON request_metrics (timestamp DESC);

-- Create index for endpoint analysis
CREATE INDEX IF NOT EXISTS idx_request_metrics_path_method
    ON request_metrics (path, method, timestamp DESC);

-- Create index for user analysis
CREATE INDEX IF NOT EXISTS idx_request_metrics_user_id
    ON request_metrics (user_id, timestamp DESC)
    WHERE user_id IS NOT NULL;

-- Create index for backend analysis
CREATE INDEX IF NOT EXISTS idx_request_metrics_backend
    ON request_metrics (backend, timestamp DESC)
    WHERE backend IS NOT NULL;

-- Create index for error analysis
CREATE INDEX IF NOT EXISTS idx_request_metrics_status
    ON request_metrics (status_code, timestamp DESC);

-- Create index for rate limit analysis
CREATE INDEX IF NOT EXISTS idx_request_metrics_rate_limited
    ON request_metrics (rate_limited, timestamp DESC)
    WHERE rate_limited = TRUE;

-- =============================================================================
-- Rate limit metrics table
-- =============================================================================
CREATE TABLE IF NOT EXISTS rate_limit_metrics (
    id BIGSERIAL,
    timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    rate_limit_key VARCHAR(256) NOT NULL,
    endpoint TEXT NOT NULL,
    allowed BOOLEAN NOT NULL,
    remaining INTEGER NOT NULL,
    limit_value INTEGER NOT NULL,
    user_id VARCHAR(128),
    ip_address VARCHAR(45) NOT NULL,
    tier VARCHAR(32),
    algorithm VARCHAR(32) NOT NULL,

    PRIMARY KEY (id, timestamp)
);

-- Create indexes for rate limit analysis
CREATE INDEX IF NOT EXISTS idx_rate_limit_metrics_timestamp
    ON rate_limit_metrics (timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_rate_limit_metrics_key
    ON rate_limit_metrics (rate_limit_key, timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_rate_limit_metrics_allowed
    ON rate_limit_metrics (allowed, timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_rate_limit_metrics_user
    ON rate_limit_metrics (user_id, timestamp DESC)
    WHERE user_id IS NOT NULL;

-- =============================================================================
-- Backend health metrics table
-- =============================================================================
CREATE TABLE IF NOT EXISTS backend_metrics (
    id BIGSERIAL,
    timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    backend VARCHAR(64) NOT NULL,
    healthy BOOLEAN NOT NULL,
    response_time_ms INTEGER,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    consecutive_successes INTEGER NOT NULL DEFAULT 0,

    PRIMARY KEY (id, timestamp)
);

-- Create indexes for backend health analysis
CREATE INDEX IF NOT EXISTS idx_backend_metrics_timestamp
    ON backend_metrics (timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_backend_metrics_backend
    ON backend_metrics (backend, timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_backend_metrics_healthy
    ON backend_metrics (backend, healthy, timestamp DESC);

-- =============================================================================
-- Aggregated metrics table (pre-computed aggregations)
-- =============================================================================
CREATE TABLE IF NOT EXISTS aggregated_metrics (
    id BIGSERIAL,
    bucket TIMESTAMPTZ NOT NULL,
    bucket_size VARCHAR(10) NOT NULL, -- '1m', '5m', '15m', '1h', '1d'
    metric_name VARCHAR(64) NOT NULL,

    -- Dimensions (nullable for global aggregations)
    endpoint TEXT,
    method VARCHAR(10),
    backend VARCHAR(64),
    status_class VARCHAR(3), -- '2xx', '3xx', '4xx', '5xx'

    -- Aggregated values
    count BIGINT NOT NULL DEFAULT 0,
    sum_value DOUBLE PRECISION,
    avg_value DOUBLE PRECISION,
    min_value DOUBLE PRECISION,
    max_value DOUBLE PRECISION,
    p50_value DOUBLE PRECISION,
    p75_value DOUBLE PRECISION,
    p90_value DOUBLE PRECISION,
    p95_value DOUBLE PRECISION,
    p99_value DOUBLE PRECISION,

    PRIMARY KEY (id, bucket)
);

-- Create indexes for aggregated metrics queries
CREATE INDEX IF NOT EXISTS idx_aggregated_metrics_bucket
    ON aggregated_metrics (bucket DESC, bucket_size);

CREATE INDEX IF NOT EXISTS idx_aggregated_metrics_name_bucket
    ON aggregated_metrics (metric_name, bucket DESC, bucket_size);

CREATE INDEX IF NOT EXISTS idx_aggregated_metrics_endpoint
    ON aggregated_metrics (endpoint, bucket DESC)
    WHERE endpoint IS NOT NULL;

-- Create unique constraint for upsert operations
CREATE UNIQUE INDEX IF NOT EXISTS idx_aggregated_metrics_unique
    ON aggregated_metrics (
        bucket,
        bucket_size,
        metric_name,
        COALESCE(endpoint, ''),
        COALESCE(method, ''),
        COALESCE(backend, ''),
        COALESCE(status_class, '')
    );

-- =============================================================================
-- Alert rules table
-- =============================================================================
CREATE TABLE IF NOT EXISTS alert_rules (
    id VARCHAR(64) PRIMARY KEY,
    name VARCHAR(128) NOT NULL,
    description TEXT,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    severity VARCHAR(16) NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),

    -- Condition
    metric VARCHAR(64) NOT NULL,
    operator VARCHAR(4) NOT NULL CHECK (operator IN ('>', '>=', '<', '<=', '==', '!=')),
    threshold DOUBLE PRECISION NOT NULL,
    window_seconds INTEGER NOT NULL,
    endpoint TEXT,
    backend VARCHAR(64),

    -- Actions (JSON array)
    actions JSONB NOT NULL DEFAULT '[]',

    -- Cooldown
    cooldown_seconds INTEGER,

    -- Timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_triggered_at TIMESTAMPTZ
);

-- Create indexes for alert rules
CREATE INDEX IF NOT EXISTS idx_alert_rules_enabled
    ON alert_rules (enabled)
    WHERE enabled = TRUE;

CREATE INDEX IF NOT EXISTS idx_alert_rules_metric
    ON alert_rules (metric);

-- =============================================================================
-- Alerts table (triggered alert instances)
-- =============================================================================
CREATE TABLE IF NOT EXISTS alerts (
    id VARCHAR(64) PRIMARY KEY,
    rule_id VARCHAR(64) NOT NULL REFERENCES alert_rules(id) ON DELETE CASCADE,
    rule_name VARCHAR(128) NOT NULL,
    severity VARCHAR(16) NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
    status VARCHAR(16) NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'acknowledged', 'resolved', 'muted')),

    -- Alert details
    message TEXT NOT NULL,
    value DOUBLE PRECISION NOT NULL,
    threshold DOUBLE PRECISION NOT NULL,

    -- Timestamps
    triggered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    acknowledged_at TIMESTAMPTZ,
    acknowledged_by VARCHAR(128),
    resolved_at TIMESTAMPTZ,
    muted_until TIMESTAMPTZ,

    -- Additional context
    metadata JSONB
);

-- Create indexes for alerts
CREATE INDEX IF NOT EXISTS idx_alerts_rule_id
    ON alerts (rule_id);

CREATE INDEX IF NOT EXISTS idx_alerts_status
    ON alerts (status);

CREATE INDEX IF NOT EXISTS idx_alerts_severity
    ON alerts (severity, status);

CREATE INDEX IF NOT EXISTS idx_alerts_triggered_at
    ON alerts (triggered_at DESC);

CREATE INDEX IF NOT EXISTS idx_alerts_active
    ON alerts (status, triggered_at DESC)
    WHERE status = 'active';

-- =============================================================================
-- Alert history table
-- =============================================================================
CREATE TABLE IF NOT EXISTS alert_history (
    id VARCHAR(64) PRIMARY KEY,
    alert_id VARCHAR(64) NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
    action VARCHAR(32) NOT NULL
        CHECK (action IN ('triggered', 'acknowledged', 'resolved', 'muted', 'unmuted')),
    timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    user_id VARCHAR(128),
    note TEXT
);

-- Create indexes for alert history
CREATE INDEX IF NOT EXISTS idx_alert_history_alert_id
    ON alert_history (alert_id, timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_alert_history_timestamp
    ON alert_history (timestamp DESC);

-- =============================================================================
-- Dashboard snapshots table (for caching expensive queries)
-- =============================================================================
CREATE TABLE IF NOT EXISTS dashboard_snapshots (
    id VARCHAR(64) PRIMARY KEY,
    snapshot_type VARCHAR(32) NOT NULL, -- 'overview', 'endpoints', 'users', etc.
    time_range VARCHAR(16) NOT NULL, -- '1h', '24h', '7d', '30d'
    data JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL
);

-- Create indexes for dashboard snapshots
CREATE INDEX IF NOT EXISTS idx_dashboard_snapshots_type_range
    ON dashboard_snapshots (snapshot_type, time_range);

CREATE INDEX IF NOT EXISTS idx_dashboard_snapshots_expires
    ON dashboard_snapshots (expires_at);

-- =============================================================================
-- Utility Functions
-- =============================================================================

-- Function to clean up old metrics based on retention policy
CREATE OR REPLACE FUNCTION cleanup_old_metrics(retention_days INTEGER)
RETURNS TABLE(
    request_metrics_deleted BIGINT,
    rate_limit_metrics_deleted BIGINT,
    backend_metrics_deleted BIGINT,
    aggregated_metrics_deleted BIGINT
) AS $$
DECLARE
    cutoff_time TIMESTAMPTZ;
BEGIN
    cutoff_time := NOW() - (retention_days || ' days')::INTERVAL;

    WITH deleted_requests AS (
        DELETE FROM request_metrics
        WHERE timestamp < cutoff_time
        RETURNING 1
    )
    SELECT COUNT(*) INTO request_metrics_deleted FROM deleted_requests;

    WITH deleted_rate_limits AS (
        DELETE FROM rate_limit_metrics
        WHERE timestamp < cutoff_time
        RETURNING 1
    )
    SELECT COUNT(*) INTO rate_limit_metrics_deleted FROM deleted_rate_limits;

    WITH deleted_backends AS (
        DELETE FROM backend_metrics
        WHERE timestamp < cutoff_time
        RETURNING 1
    )
    SELECT COUNT(*) INTO backend_metrics_deleted FROM deleted_backends;

    -- Keep aggregated metrics longer (10x retention)
    WITH deleted_aggregated AS (
        DELETE FROM aggregated_metrics
        WHERE bucket < NOW() - (retention_days * 10 || ' days')::INTERVAL
        RETURNING 1
    )
    SELECT COUNT(*) INTO aggregated_metrics_deleted FROM deleted_aggregated;

    RETURN NEXT;
END;
$$ LANGUAGE plpgsql;

-- Function to clean up expired dashboard snapshots
CREATE OR REPLACE FUNCTION cleanup_expired_snapshots()
RETURNS INTEGER AS $$
DECLARE
    deleted_count INTEGER;
BEGIN
    WITH deleted AS (
        DELETE FROM dashboard_snapshots
        WHERE expires_at < NOW()
        RETURNING 1
    )
    SELECT COUNT(*) INTO deleted_count FROM deleted;

    RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;

-- Function to get requests per second for a time window
CREATE OR REPLACE FUNCTION get_requests_per_second(window_seconds INTEGER DEFAULT 60)
RETURNS DOUBLE PRECISION AS $$
DECLARE
    request_count BIGINT;
BEGIN
    SELECT COUNT(*) INTO request_count
    FROM request_metrics
    WHERE timestamp > NOW() - (window_seconds || ' seconds')::INTERVAL;

    RETURN request_count::DOUBLE PRECISION / window_seconds;
END;
$$ LANGUAGE plpgsql;

-- Function to get latency percentile
CREATE OR REPLACE FUNCTION get_latency_percentile(
    percentile DOUBLE PRECISION,
    window_seconds INTEGER DEFAULT 3600
)
RETURNS DOUBLE PRECISION AS $$
DECLARE
    result DOUBLE PRECISION;
BEGIN
    SELECT PERCENTILE_CONT(percentile) WITHIN GROUP (ORDER BY duration_ms) INTO result
    FROM request_metrics
    WHERE timestamp > NOW() - (window_seconds || ' seconds')::INTERVAL;

    RETURN COALESCE(result, 0);
END;
$$ LANGUAGE plpgsql;

-- Function to get error rate
CREATE OR REPLACE FUNCTION get_error_rate(window_seconds INTEGER DEFAULT 3600)
RETURNS DOUBLE PRECISION AS $$
DECLARE
    total_requests BIGINT;
    error_requests BIGINT;
BEGIN
    SELECT
        COUNT(*),
        COUNT(*) FILTER (WHERE status_code >= 500)
    INTO total_requests, error_requests
    FROM request_metrics
    WHERE timestamp > NOW() - (window_seconds || ' seconds')::INTERVAL;

    IF total_requests = 0 THEN
        RETURN 0;
    END IF;

    RETURN (error_requests::DOUBLE PRECISION / total_requests) * 100;
END;
$$ LANGUAGE plpgsql;

-- =============================================================================
-- Comments
-- =============================================================================
COMMENT ON TABLE request_metrics IS 'Time-series table storing individual request metrics';
COMMENT ON TABLE rate_limit_metrics IS 'Time-series table storing rate limit check results';
COMMENT ON TABLE backend_metrics IS 'Time-series table storing backend health check results';
COMMENT ON TABLE aggregated_metrics IS 'Pre-computed metric aggregations for faster dashboard queries';
COMMENT ON TABLE alert_rules IS 'Alert rule definitions for monitoring thresholds';
COMMENT ON TABLE alerts IS 'Triggered alert instances';
COMMENT ON TABLE alert_history IS 'History of alert status changes';
COMMENT ON TABLE dashboard_snapshots IS 'Cached dashboard query results';

COMMENT ON FUNCTION cleanup_old_metrics IS 'Removes metrics older than the specified retention period';
COMMENT ON FUNCTION cleanup_expired_snapshots IS 'Removes expired dashboard snapshot caches';
COMMENT ON FUNCTION get_requests_per_second IS 'Returns the average requests per second for a time window';
COMMENT ON FUNCTION get_latency_percentile IS 'Returns a specific latency percentile for a time window';
COMMENT ON FUNCTION get_error_rate IS 'Returns the error rate (5xx responses) as a percentage';
