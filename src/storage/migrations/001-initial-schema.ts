/**
 * AEGIS - Initial Database Migration
 * Creates the foundational schema for the gateway
 */

export const migrationName = '001-initial-schema';
export const migrationDate = '2024-01-01';

export const up = `
-- =============================================================================
-- AEGIS Database Schema - Initial Migration
-- =============================================================================

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- =============================================================================
-- Request Logs Table
-- Stores all request/response data for observability
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
  backend_name VARCHAR(100),
  request_id UUID NOT NULL,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_request_logs_timestamp ON request_logs (timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_request_logs_path ON request_logs (path);
CREATE INDEX IF NOT EXISTS idx_request_logs_status_code ON request_logs (status_code);
CREATE INDEX IF NOT EXISTS idx_request_logs_user_id ON request_logs (user_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_request_logs_backend ON request_logs (backend_name) WHERE backend_name IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_request_logs_request_id ON request_logs (request_id);

-- Composite index for time-range queries with filters
CREATE INDEX IF NOT EXISTS idx_request_logs_timestamp_status ON request_logs (timestamp DESC, status_code);
CREATE INDEX IF NOT EXISTS idx_request_logs_timestamp_backend ON request_logs (timestamp DESC, backend_name);

-- =============================================================================
-- Rate Limit Rules Table
-- Configurable rate limiting rules per endpoint/tier
-- =============================================================================
CREATE TABLE IF NOT EXISTS rate_limit_rules (
  id SERIAL PRIMARY KEY,
  endpoint_pattern VARCHAR(255) NOT NULL UNIQUE,
  requests_per_minute INTEGER NOT NULL CHECK (requests_per_minute > 0),
  tier VARCHAR(50) NOT NULL DEFAULT 'default',
  burst_limit INTEGER DEFAULT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for pattern matching queries
CREATE INDEX IF NOT EXISTS idx_rate_limit_rules_pattern ON rate_limit_rules (endpoint_pattern);
CREATE INDEX IF NOT EXISTS idx_rate_limit_rules_tier ON rate_limit_rules (tier);
CREATE INDEX IF NOT EXISTS idx_rate_limit_rules_enabled ON rate_limit_rules (enabled) WHERE enabled = true;

-- =============================================================================
-- API Keys Table (for authenticated rate limiting)
-- =============================================================================
CREATE TABLE IF NOT EXISTS api_keys (
  id SERIAL PRIMARY KEY,
  key_hash VARCHAR(64) NOT NULL UNIQUE, -- SHA-256 hash of the API key
  key_prefix VARCHAR(8) NOT NULL, -- First 8 chars for identification
  name VARCHAR(100) NOT NULL,
  tier VARCHAR(50) NOT NULL DEFAULT 'default',
  rate_limit_override INTEGER, -- Override default tier rate limit
  enabled BOOLEAN NOT NULL DEFAULT true,
  expires_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  usage_count BIGINT NOT NULL DEFAULT 0,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for API key lookups
CREATE INDEX IF NOT EXISTS idx_api_keys_key_hash ON api_keys (key_hash);
CREATE INDEX IF NOT EXISTS idx_api_keys_tier ON api_keys (tier);
CREATE INDEX IF NOT EXISTS idx_api_keys_enabled ON api_keys (enabled) WHERE enabled = true;

-- =============================================================================
-- Backend Services Table
-- Registry of backend services (can be managed via API)
-- =============================================================================
CREATE TABLE IF NOT EXISTS backend_services (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL UNIQUE,
  url VARCHAR(500) NOT NULL,
  health_check_path VARCHAR(255) DEFAULT '/health',
  health_check_interval_ms INTEGER DEFAULT 30000,
  timeout_ms INTEGER DEFAULT 30000,
  retry_attempts INTEGER DEFAULT 3,
  weight INTEGER DEFAULT 1 CHECK (weight > 0 AND weight <= 100),
  enabled BOOLEAN NOT NULL DEFAULT true,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =============================================================================
-- Backend Routes Table
-- Route patterns for each backend
-- =============================================================================
CREATE TABLE IF NOT EXISTS backend_routes (
  id SERIAL PRIMARY KEY,
  backend_id INTEGER NOT NULL REFERENCES backend_services(id) ON DELETE CASCADE,
  route_pattern VARCHAR(255) NOT NULL,
  priority INTEGER DEFAULT 0, -- Higher priority routes match first
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for route matching
CREATE INDEX IF NOT EXISTS idx_backend_routes_backend ON backend_routes (backend_id);
CREATE INDEX IF NOT EXISTS idx_backend_routes_pattern ON backend_routes (route_pattern);
CREATE INDEX IF NOT EXISTS idx_backend_routes_priority ON backend_routes (priority DESC);

-- Unique constraint to prevent duplicate routes
CREATE UNIQUE INDEX IF NOT EXISTS idx_backend_routes_unique ON backend_routes (backend_id, route_pattern);

-- =============================================================================
-- Health Check Log Table
-- Track backend health status over time
-- =============================================================================
CREATE TABLE IF NOT EXISTS health_check_logs (
  id SERIAL PRIMARY KEY,
  backend_name VARCHAR(100) NOT NULL,
  healthy BOOLEAN NOT NULL,
  response_time_ms INTEGER,
  status_code INTEGER,
  error_message TEXT,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for time-based queries
CREATE INDEX IF NOT EXISTS idx_health_check_logs_backend_time ON health_check_logs (backend_name, checked_at DESC);

-- Partition hint: In production, consider partitioning by time
-- CREATE INDEX IF NOT EXISTS idx_health_check_logs_time ON health_check_logs (checked_at DESC);

-- =============================================================================
-- Migrations Table (for tracking applied migrations)
-- =============================================================================
CREATE TABLE IF NOT EXISTS schema_migrations (
  id SERIAL PRIMARY KEY,
  migration_name VARCHAR(255) NOT NULL UNIQUE,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =============================================================================
-- Helper Functions
-- =============================================================================

-- Function to automatically update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ language 'plpgsql';

-- Apply triggers to tables with updated_at
DROP TRIGGER IF EXISTS update_rate_limit_rules_updated_at ON rate_limit_rules;
CREATE TRIGGER update_rate_limit_rules_updated_at
  BEFORE UPDATE ON rate_limit_rules
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_api_keys_updated_at ON api_keys;
CREATE TRIGGER update_api_keys_updated_at
  BEFORE UPDATE ON api_keys
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_backend_services_updated_at ON backend_services;
CREATE TRIGGER update_backend_services_updated_at
  BEFORE UPDATE ON backend_services
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- =============================================================================
-- Initial Data
-- =============================================================================

-- Insert default rate limit rules
INSERT INTO rate_limit_rules (endpoint_pattern, requests_per_minute, tier, description)
VALUES
  ('/**', 100, 'default', 'Default rate limit for all endpoints'),
  ('/api/public/**', 200, 'public', 'Higher limit for public APIs'),
  ('/api/admin/**', 50, 'admin', 'Lower limit for admin endpoints'),
  ('/auth/login', 10, 'auth', 'Strict limit for login endpoint'),
  ('/auth/register', 5, 'auth', 'Strict limit for registration')
ON CONFLICT (endpoint_pattern) DO NOTHING;

-- Record this migration
INSERT INTO schema_migrations (migration_name)
VALUES ('001-initial-schema')
ON CONFLICT (migration_name) DO NOTHING;
`;

export const down = `
-- =============================================================================
-- Rollback Migration 001-initial-schema
-- =============================================================================

-- Drop triggers
DROP TRIGGER IF EXISTS update_rate_limit_rules_updated_at ON rate_limit_rules;
DROP TRIGGER IF EXISTS update_api_keys_updated_at ON api_keys;
DROP TRIGGER IF EXISTS update_backend_services_updated_at ON backend_services;

-- Drop function
DROP FUNCTION IF EXISTS update_updated_at_column();

-- Drop tables in reverse order of creation (respecting foreign keys)
DROP TABLE IF EXISTS health_check_logs;
DROP TABLE IF EXISTS backend_routes;
DROP TABLE IF EXISTS backend_services;
DROP TABLE IF EXISTS api_keys;
DROP TABLE IF EXISTS rate_limit_rules;
DROP TABLE IF EXISTS request_logs;
DROP TABLE IF EXISTS schema_migrations;
`;
