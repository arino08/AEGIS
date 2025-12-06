-- AEGIS Initial Schema Migration
-- Created: 2025-12-02T18:12:38.522Z

-- =============================================================================
-- Request Logs Table
-- Stores all request metrics for analytics and debugging
-- =============================================================================
CREATE TABLE IF NOT EXISTS request_logs (
  id SERIAL PRIMARY KEY,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  method VARCHAR(10) NOT NULL,
  path TEXT NOT NULL,
  status_code INTEGER NOT NULL,
  response_time_ms INTEGER NOT NULL,
  user_id VARCHAR(255),
  ip_address INET NOT NULL,
  user_agent TEXT,
  backend_name VARCHAR(255),
  request_id UUID NOT NULL,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_request_logs_timestamp ON request_logs(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_request_logs_path ON request_logs(path);
CREATE INDEX IF NOT EXISTS idx_request_logs_status_code ON request_logs(status_code);
CREATE INDEX IF NOT EXISTS idx_request_logs_user_id ON request_logs(user_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_request_logs_backend_name ON request_logs(backend_name) WHERE backend_name IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_request_logs_request_id ON request_logs(request_id);

-- Composite index for time-based queries with status
CREATE INDEX IF NOT EXISTS idx_request_logs_timestamp_status ON request_logs(timestamp DESC, status_code);

-- =============================================================================
-- Rate Limit Rules Table
-- Stores rate limiting configurations per endpoint/tier
-- =============================================================================
CREATE TABLE IF NOT EXISTS rate_limit_rules (
  id SERIAL PRIMARY KEY,
  endpoint_pattern VARCHAR(255) NOT NULL UNIQUE,
  requests_per_minute INTEGER NOT NULL DEFAULT 100,
  tier VARCHAR(50) NOT NULL DEFAULT 'default',
  burst_limit INTEGER,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for looking up rules by pattern
CREATE INDEX IF NOT EXISTS idx_rate_limit_rules_pattern ON rate_limit_rules(endpoint_pattern);
CREATE INDEX IF NOT EXISTS idx_rate_limit_rules_tier ON rate_limit_rules(tier);

-- =============================================================================
-- API Keys Table (for future use)
-- Stores API keys for client authentication
-- =============================================================================
CREATE TABLE IF NOT EXISTS api_keys (
  id SERIAL PRIMARY KEY,
  key_hash VARCHAR(64) NOT NULL UNIQUE,
  name VARCHAR(255) NOT NULL,
  tier VARCHAR(50) NOT NULL DEFAULT 'default',
  rate_limit_override INTEGER,
  enabled BOOLEAN NOT NULL DEFAULT true,
  last_used_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);
CREATE INDEX IF NOT EXISTS idx_api_keys_tier ON api_keys(tier);

-- =============================================================================
-- Backend Health Table
-- Tracks health status of backend services
-- =============================================================================
CREATE TABLE IF NOT EXISTS backend_health (
  id SERIAL PRIMARY KEY,
  backend_name VARCHAR(255) NOT NULL,
  healthy BOOLEAN NOT NULL DEFAULT true,
  last_check_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  consecutive_successes INTEGER NOT NULL DEFAULT 0,
  last_response_time_ms INTEGER,
  last_error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(backend_name)
);

CREATE INDEX IF NOT EXISTS idx_backend_health_name ON backend_health(backend_name);
CREATE INDEX IF NOT EXISTS idx_backend_health_healthy ON backend_health(healthy);

-- =============================================================================
-- Insert default rate limit rules
-- =============================================================================
INSERT INTO rate_limit_rules (endpoint_pattern, requests_per_minute, tier) VALUES
  ('/**', 100, 'default'),
  ('/api/public/**', 200, 'public'),
  ('/api/admin/**', 50, 'admin'),
  ('/auth/login', 10, 'auth'),
  ('/auth/register', 5, 'auth')
ON CONFLICT (endpoint_pattern) DO NOTHING;

-- =============================================================================
-- Function to update updated_at timestamp
-- =============================================================================
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ language 'plpgsql';

-- Apply trigger to tables with updated_at
DROP TRIGGER IF EXISTS update_rate_limit_rules_updated_at ON rate_limit_rules;
CREATE TRIGGER update_rate_limit_rules_updated_at
  BEFORE UPDATE ON rate_limit_rules
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_api_keys_updated_at ON api_keys;
CREATE TRIGGER update_api_keys_updated_at
  BEFORE UPDATE ON api_keys
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_backend_health_updated_at ON backend_health;
CREATE TRIGGER update_backend_health_updated_at
  BEFORE UPDATE ON backend_health
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
