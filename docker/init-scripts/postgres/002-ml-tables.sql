-- =============================================================================
-- AEGIS - ML Service Database Tables
-- =============================================================================
-- This script creates tables and views for ML training data export and
-- anomaly detection integration.

-- -----------------------------------------------------------------------------
-- Metrics Snapshots Table (for ML training)
-- -----------------------------------------------------------------------------
-- Stores pre-aggregated metrics snapshots for ML model training

CREATE TABLE IF NOT EXISTS metrics_snapshots (
    id SERIAL PRIMARY KEY,
    snapshot_time TIMESTAMPTZ NOT NULL,
    bucket_interval_seconds INTEGER NOT NULL DEFAULT 60,

    -- Traffic metrics
    total_requests INTEGER NOT NULL DEFAULT 0,
    requests_per_second NUMERIC(12, 4) NOT NULL DEFAULT 0,

    -- Latency metrics (in milliseconds)
    avg_latency_ms NUMERIC(10, 2),
    p50_latency_ms NUMERIC(10, 2),
    p75_latency_ms NUMERIC(10, 2),
    p90_latency_ms NUMERIC(10, 2),
    p95_latency_ms NUMERIC(10, 2),
    p99_latency_ms NUMERIC(10, 2),
    min_latency_ms NUMERIC(10, 2),
    max_latency_ms NUMERIC(10, 2),
    stddev_latency_ms NUMERIC(10, 2),

    -- Status code distribution
    status_2xx INTEGER NOT NULL DEFAULT 0,
    status_3xx INTEGER NOT NULL DEFAULT 0,
    status_4xx INTEGER NOT NULL DEFAULT 0,
    status_5xx INTEGER NOT NULL DEFAULT 0,

    -- Error metrics
    error_count INTEGER NOT NULL DEFAULT 0,
    error_rate NUMERIC(5, 4) NOT NULL DEFAULT 0,

    -- Unique counts
    unique_ips INTEGER DEFAULT 0,
    unique_users INTEGER DEFAULT 0,
    unique_endpoints INTEGER DEFAULT 0,

    -- ML annotations (filled by ML service)
    is_anomaly BOOLEAN DEFAULT FALSE,
    anomaly_type VARCHAR(50),
    anomaly_score NUMERIC(8, 6),
    anomaly_confidence NUMERIC(5, 4),

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE(snapshot_time, bucket_interval_seconds)
);

-- Indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_metrics_snapshots_time ON metrics_snapshots (snapshot_time DESC);
CREATE INDEX IF NOT EXISTS idx_metrics_snapshots_anomaly ON metrics_snapshots (is_anomaly) WHERE is_anomaly = TRUE;
CREATE INDEX IF NOT EXISTS idx_metrics_snapshots_interval ON metrics_snapshots (bucket_interval_seconds, snapshot_time DESC);

-- -----------------------------------------------------------------------------
-- Anomaly Events Table
-- -----------------------------------------------------------------------------
-- Stores detected anomaly events for alerting and analysis

CREATE TABLE IF NOT EXISTS anomaly_events (
    id SERIAL PRIMARY KEY,
    detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Anomaly classification
    anomaly_type VARCHAR(50) NOT NULL,
    severity VARCHAR(20) NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
    confidence NUMERIC(5, 4) NOT NULL,

    -- Anomaly scores
    raw_score NUMERIC(10, 6),
    normalized_score NUMERIC(5, 4),

    -- Explanation
    explanation TEXT,

    -- Metrics at time of detection
    metrics JSONB NOT NULL,

    -- Feature values used for detection
    features JSONB,

    -- Status tracking
    status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'acknowledged', 'resolved', 'false_positive')),
    acknowledged_at TIMESTAMPTZ,
    acknowledged_by VARCHAR(255),
    resolved_at TIMESTAMPTZ,
    resolution_notes TEXT,

    -- Related snapshot
    snapshot_id INTEGER REFERENCES metrics_snapshots(id),

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_anomaly_events_detected ON anomaly_events (detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_anomaly_events_type ON anomaly_events (anomaly_type, detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_anomaly_events_severity ON anomaly_events (severity, detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_anomaly_events_status ON anomaly_events (status) WHERE status = 'active';

-- -----------------------------------------------------------------------------
-- Rate Limit Recommendations Table
-- -----------------------------------------------------------------------------
-- Stores ML-generated rate limit recommendations

CREATE TABLE IF NOT EXISTS rate_limit_recommendations (
    id SERIAL PRIMARY KEY,
    generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Target
    endpoint_pattern VARCHAR(255) NOT NULL,
    tier VARCHAR(50) NOT NULL DEFAULT 'default',

    -- Current limits
    current_limit INTEGER,
    current_burst INTEGER,

    -- Recommended limits
    recommended_limit INTEGER NOT NULL,
    recommended_burst INTEGER NOT NULL,

    -- Optimization details
    strategy VARCHAR(20) NOT NULL,
    confidence NUMERIC(5, 4) NOT NULL,
    reasoning TEXT,

    -- Warnings
    warnings TEXT[],

    -- Endpoint profile at time of recommendation
    endpoint_profile JSONB,

    -- Application status
    status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applied', 'rejected', 'expired')),
    applied_at TIMESTAMPTZ,
    applied_by VARCHAR(255),
    rejection_reason TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '7 days')
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_rate_limit_rec_endpoint ON rate_limit_recommendations (endpoint_pattern, tier);
CREATE INDEX IF NOT EXISTS idx_rate_limit_rec_status ON rate_limit_recommendations (status) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_rate_limit_rec_generated ON rate_limit_recommendations (generated_at DESC);

-- -----------------------------------------------------------------------------
-- ML Model Metadata Table
-- -----------------------------------------------------------------------------
-- Stores metadata about trained ML models

CREATE TABLE IF NOT EXISTS ml_models (
    id SERIAL PRIMARY KEY,
    model_name VARCHAR(100) NOT NULL,
    model_type VARCHAR(50) NOT NULL,
    version VARCHAR(50) NOT NULL,

    -- Training info
    trained_at TIMESTAMPTZ NOT NULL,
    training_samples INTEGER NOT NULL,
    training_duration_seconds NUMERIC(10, 2),

    -- Model parameters
    parameters JSONB NOT NULL,

    -- Performance metrics
    metrics JSONB,

    -- Feature information
    feature_names TEXT[] NOT NULL,
    feature_baselines JSONB,

    -- Storage
    model_path VARCHAR(500),
    model_size_bytes BIGINT,

    -- Status
    is_active BOOLEAN NOT NULL DEFAULT FALSE,
    deactivated_at TIMESTAMPTZ,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE(model_name, version)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_ml_models_name ON ml_models (model_name, is_active);
CREATE INDEX IF NOT EXISTS idx_ml_models_active ON ml_models (is_active) WHERE is_active = TRUE;

-- -----------------------------------------------------------------------------
-- Functions for ML Data Export
-- -----------------------------------------------------------------------------

-- Function to get aggregated training data
CREATE OR REPLACE FUNCTION get_ml_training_data(
    p_start_time TIMESTAMPTZ,
    p_end_time TIMESTAMPTZ,
    p_bucket_minutes INTEGER DEFAULT 1
)
RETURNS TABLE (
    time_bucket TIMESTAMPTZ,
    total_requests BIGINT,
    requests_per_second NUMERIC,
    avg_latency_ms NUMERIC,
    p50_latency_ms NUMERIC,
    p95_latency_ms NUMERIC,
    p99_latency_ms NUMERIC,
    error_rate NUMERIC,
    status_2xx BIGINT,
    status_4xx BIGINT,
    status_5xx BIGINT,
    unique_ips BIGINT
)
LANGUAGE SQL STABLE
AS $$
    SELECT
        date_trunc('minute', timestamp) -
            (EXTRACT(minute FROM timestamp)::integer % p_bucket_minutes) * interval '1 minute' as time_bucket,
        COUNT(*)::BIGINT as total_requests,
        (COUNT(*)::NUMERIC / (p_bucket_minutes * 60))::NUMERIC(12, 4) as requests_per_second,
        AVG(response_time_ms)::NUMERIC(10, 2) as avg_latency_ms,
        PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY response_time_ms)::NUMERIC(10, 2) as p50_latency_ms,
        PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY response_time_ms)::NUMERIC(10, 2) as p95_latency_ms,
        PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY response_time_ms)::NUMERIC(10, 2) as p99_latency_ms,
        (COUNT(*) FILTER (WHERE status_code >= 400)::NUMERIC / NULLIF(COUNT(*), 0))::NUMERIC(5, 4) as error_rate,
        COUNT(*) FILTER (WHERE status_code >= 200 AND status_code < 300)::BIGINT as status_2xx,
        COUNT(*) FILTER (WHERE status_code >= 400 AND status_code < 500)::BIGINT as status_4xx,
        COUNT(*) FILTER (WHERE status_code >= 500)::BIGINT as status_5xx,
        COUNT(DISTINCT ip_address)::BIGINT as unique_ips
    FROM request_logs
    WHERE timestamp >= p_start_time AND timestamp < p_end_time
    GROUP BY time_bucket
    ORDER BY time_bucket;
$$;

-- Function to get endpoint-level training data
CREATE OR REPLACE FUNCTION get_endpoint_training_data(
    p_start_time TIMESTAMPTZ,
    p_end_time TIMESTAMPTZ
)
RETURNS TABLE (
    endpoint VARCHAR,
    method VARCHAR,
    total_requests BIGINT,
    avg_rpm NUMERIC,
    peak_rpm NUMERIC,
    p95_rpm NUMERIC,
    avg_latency_ms NUMERIC,
    p95_latency_ms NUMERIC,
    error_rate NUMERIC,
    unique_users BIGINT,
    unique_ips BIGINT
)
LANGUAGE SQL STABLE
AS $$
    WITH minute_stats AS (
        SELECT
            path as endpoint,
            method,
            date_trunc('minute', timestamp) as minute,
            COUNT(*) as requests
        FROM request_logs
        WHERE timestamp >= p_start_time AND timestamp < p_end_time
        GROUP BY path, method, minute
    ),
    rpm_agg AS (
        SELECT
            endpoint,
            method,
            AVG(requests)::NUMERIC(10, 2) as avg_rpm,
            MAX(requests)::NUMERIC(10, 2) as peak_rpm,
            PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY requests)::NUMERIC(10, 2) as p95_rpm
        FROM minute_stats
        GROUP BY endpoint, method
    )
    SELECT
        r.path::VARCHAR as endpoint,
        r.method::VARCHAR as method,
        COUNT(*)::BIGINT as total_requests,
        COALESCE(rpm.avg_rpm, 0) as avg_rpm,
        COALESCE(rpm.peak_rpm, 0) as peak_rpm,
        COALESCE(rpm.p95_rpm, 0) as p95_rpm,
        AVG(r.response_time_ms)::NUMERIC(10, 2) as avg_latency_ms,
        PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY r.response_time_ms)::NUMERIC(10, 2) as p95_latency_ms,
        (COUNT(*) FILTER (WHERE r.status_code >= 400)::NUMERIC / NULLIF(COUNT(*), 0))::NUMERIC(5, 4) as error_rate,
        COUNT(DISTINCT r.user_id) FILTER (WHERE r.user_id IS NOT NULL)::BIGINT as unique_users,
        COUNT(DISTINCT r.ip_address)::BIGINT as unique_ips
    FROM request_logs r
    LEFT JOIN rpm_agg rpm ON r.path = rpm.endpoint AND r.method = rpm.method
    WHERE r.timestamp >= p_start_time AND r.timestamp < p_end_time
    GROUP BY r.path, r.method, rpm.avg_rpm, rpm.peak_rpm, rpm.p95_rpm
    ORDER BY total_requests DESC;
$$;

-- -----------------------------------------------------------------------------
-- Views for ML Analysis
-- -----------------------------------------------------------------------------

-- View for recent anomaly summary
CREATE OR REPLACE VIEW v_recent_anomalies AS
SELECT
    ae.id,
    ae.detected_at,
    ae.anomaly_type,
    ae.severity,
    ae.confidence,
    ae.normalized_score,
    ae.explanation,
    ae.status,
    ae.metrics->>'requests_per_second' as rps,
    ae.metrics->>'avg_latency_ms' as avg_latency,
    ae.metrics->>'error_rate' as error_rate
FROM anomaly_events ae
WHERE ae.detected_at > NOW() - INTERVAL '24 hours'
ORDER BY ae.detected_at DESC;

-- View for pending rate limit recommendations
CREATE OR REPLACE VIEW v_pending_recommendations AS
SELECT
    rlr.id,
    rlr.endpoint_pattern,
    rlr.tier,
    rlr.current_limit,
    rlr.recommended_limit,
    rlr.recommended_burst,
    rlr.confidence,
    rlr.strategy,
    rlr.reasoning,
    rlr.generated_at,
    rlr.expires_at
FROM rate_limit_recommendations rlr
WHERE rlr.status = 'pending'
  AND rlr.expires_at > NOW()
ORDER BY rlr.confidence DESC;

-- View for active ML models
CREATE OR REPLACE VIEW v_active_models AS
SELECT
    mm.id,
    mm.model_name,
    mm.model_type,
    mm.version,
    mm.trained_at,
    mm.training_samples,
    mm.parameters,
    mm.metrics
FROM ml_models mm
WHERE mm.is_active = TRUE;

-- View for ML training data export (last 7 days, 1-minute buckets)
CREATE OR REPLACE VIEW v_ml_training_data AS
SELECT * FROM get_ml_training_data(NOW() - INTERVAL '7 days', NOW(), 1);

-- -----------------------------------------------------------------------------
-- Procedure to create metrics snapshot
-- -----------------------------------------------------------------------------

CREATE OR REPLACE PROCEDURE create_metrics_snapshot(
    p_bucket_seconds INTEGER DEFAULT 60
)
LANGUAGE plpgsql
AS $$
DECLARE
    v_end_time TIMESTAMPTZ := date_trunc('minute', NOW());
    v_start_time TIMESTAMPTZ := v_end_time - (p_bucket_seconds || ' seconds')::INTERVAL;
BEGIN
    INSERT INTO metrics_snapshots (
        snapshot_time,
        bucket_interval_seconds,
        total_requests,
        requests_per_second,
        avg_latency_ms,
        p50_latency_ms,
        p75_latency_ms,
        p90_latency_ms,
        p95_latency_ms,
        p99_latency_ms,
        min_latency_ms,
        max_latency_ms,
        stddev_latency_ms,
        status_2xx,
        status_3xx,
        status_4xx,
        status_5xx,
        error_count,
        error_rate,
        unique_ips,
        unique_users,
        unique_endpoints
    )
    SELECT
        v_start_time,
        p_bucket_seconds,
        COUNT(*)::INTEGER,
        (COUNT(*)::NUMERIC / p_bucket_seconds)::NUMERIC(12, 4),
        AVG(response_time_ms)::NUMERIC(10, 2),
        PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY response_time_ms)::NUMERIC(10, 2),
        PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY response_time_ms)::NUMERIC(10, 2),
        PERCENTILE_CONT(0.90) WITHIN GROUP (ORDER BY response_time_ms)::NUMERIC(10, 2),
        PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY response_time_ms)::NUMERIC(10, 2),
        PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY response_time_ms)::NUMERIC(10, 2),
        MIN(response_time_ms)::NUMERIC(10, 2),
        MAX(response_time_ms)::NUMERIC(10, 2),
        STDDEV(response_time_ms)::NUMERIC(10, 2),
        COUNT(*) FILTER (WHERE status_code >= 200 AND status_code < 300)::INTEGER,
        COUNT(*) FILTER (WHERE status_code >= 300 AND status_code < 400)::INTEGER,
        COUNT(*) FILTER (WHERE status_code >= 400 AND status_code < 500)::INTEGER,
        COUNT(*) FILTER (WHERE status_code >= 500)::INTEGER,
        COUNT(*) FILTER (WHERE status_code >= 400)::INTEGER,
        (COUNT(*) FILTER (WHERE status_code >= 400)::NUMERIC / NULLIF(COUNT(*), 0))::NUMERIC(5, 4),
        COUNT(DISTINCT ip_address)::INTEGER,
        COUNT(DISTINCT user_id) FILTER (WHERE user_id IS NOT NULL)::INTEGER,
        COUNT(DISTINCT path)::INTEGER
    FROM request_logs
    WHERE timestamp >= v_start_time AND timestamp < v_end_time
    ON CONFLICT (snapshot_time, bucket_interval_seconds) DO UPDATE SET
        total_requests = EXCLUDED.total_requests,
        requests_per_second = EXCLUDED.requests_per_second,
        avg_latency_ms = EXCLUDED.avg_latency_ms,
        p50_latency_ms = EXCLUDED.p50_latency_ms,
        p75_latency_ms = EXCLUDED.p75_latency_ms,
        p90_latency_ms = EXCLUDED.p90_latency_ms,
        p95_latency_ms = EXCLUDED.p95_latency_ms,
        p99_latency_ms = EXCLUDED.p99_latency_ms,
        min_latency_ms = EXCLUDED.min_latency_ms,
        max_latency_ms = EXCLUDED.max_latency_ms,
        stddev_latency_ms = EXCLUDED.stddev_latency_ms,
        status_2xx = EXCLUDED.status_2xx,
        status_3xx = EXCLUDED.status_3xx,
        status_4xx = EXCLUDED.status_4xx,
        status_5xx = EXCLUDED.status_5xx,
        error_count = EXCLUDED.error_count,
        error_rate = EXCLUDED.error_rate,
        unique_ips = EXCLUDED.unique_ips,
        unique_users = EXCLUDED.unique_users,
        unique_endpoints = EXCLUDED.unique_endpoints;
END;
$$;

-- -----------------------------------------------------------------------------
-- Cleanup function for old ML data
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION cleanup_old_ml_data(
    p_snapshots_retention_days INTEGER DEFAULT 90,
    p_anomalies_retention_days INTEGER DEFAULT 365,
    p_recommendations_retention_days INTEGER DEFAULT 30
)
RETURNS TABLE (
    snapshots_deleted INTEGER,
    anomalies_deleted INTEGER,
    recommendations_deleted INTEGER
)
LANGUAGE plpgsql
AS $$
DECLARE
    v_snapshots_deleted INTEGER;
    v_anomalies_deleted INTEGER;
    v_recommendations_deleted INTEGER;
BEGIN
    -- Delete old snapshots
    DELETE FROM metrics_snapshots
    WHERE snapshot_time < NOW() - (p_snapshots_retention_days || ' days')::INTERVAL;
    GET DIAGNOSTICS v_snapshots_deleted = ROW_COUNT;

    -- Delete old anomaly events
    DELETE FROM anomaly_events
    WHERE detected_at < NOW() - (p_anomalies_retention_days || ' days')::INTERVAL;
    GET DIAGNOSTICS v_anomalies_deleted = ROW_COUNT;

    -- Delete old/expired recommendations
    DELETE FROM rate_limit_recommendations
    WHERE created_at < NOW() - (p_recommendations_retention_days || ' days')::INTERVAL
       OR (status = 'expired' AND expires_at < NOW() - INTERVAL '7 days');
    GET DIAGNOSTICS v_recommendations_deleted = ROW_COUNT;

    RETURN QUERY SELECT v_snapshots_deleted, v_anomalies_deleted, v_recommendations_deleted;
END;
$$;

-- -----------------------------------------------------------------------------
-- Grants
-- -----------------------------------------------------------------------------

GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO aegis_user;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO aegis_user;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO aegis_user;
GRANT EXECUTE ON ALL PROCEDURES IN SCHEMA public TO aegis_user;

-- Log completion
DO $$
BEGIN
    RAISE NOTICE 'AEGIS ML database tables initialized successfully';
END $$;
