/**
 * AEGIS - Database Migration Runner
 * Handles running database migrations for PostgreSQL
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import pgPromise from 'pg-promise';

// Get directory name in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// =============================================================================
// Configuration
// =============================================================================

interface MigrationConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

function getConfig(): MigrationConfig {
  return {
    host: process.env['POSTGRES_HOST'] ?? 'localhost',
    port: parseInt(process.env['POSTGRES_PORT'] ?? '5432', 10),
    database: process.env['POSTGRES_DB'] ?? 'aegis',
    user: process.env['POSTGRES_USER'] ?? 'aegis_user',
    password: process.env['POSTGRES_PASSWORD'] ?? 'dev_password',
  };
}

// =============================================================================
// Migration Runner
// =============================================================================

interface Migration {
  id: number;
  name: string;
  applied_at: Date;
}

async function runMigrations(): Promise<void> {
  const config = getConfig();
  const pgp = pgPromise();
  const db = pgp(config);

  console.log('🚀 Starting AEGIS database migrations...');
  console.log(`   Host: ${config.host}:${config.port}`);
  console.log(`   Database: ${config.database}`);

  try {
    // Test connection
    await db.connect();
    console.log('✅ Database connection established');

    // Create migrations table if it doesn't exist
    await db.none(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL UNIQUE,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    console.log('✅ Migrations table ready');

    // Get list of applied migrations
    const appliedMigrations = await db.any<Migration>(
      'SELECT name FROM schema_migrations ORDER BY id'
    );
    const appliedNames = new Set(appliedMigrations.map((m) => m.name));
    console.log(`   Found ${appliedNames.size} applied migration(s)`);

    // Get list of migration files
    const migrationsDir = path.join(__dirname, 'sql');

    // Check if migrations directory exists
    if (!fs.existsSync(migrationsDir)) {
      console.log('📁 Creating migrations directory...');
      fs.mkdirSync(migrationsDir, { recursive: true });

      // Create initial migration file
      const initialMigration = `-- AEGIS Initial Schema Migration
-- Created: ${new Date().toISOString()}

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
`;

      fs.writeFileSync(path.join(migrationsDir, '001_initial_schema.sql'), initialMigration);
      console.log('✅ Created initial migration file');
    }

    // Get all SQL files in migrations directory
    const migrationFiles = fs
      .readdirSync(migrationsDir)
      .filter((file) => file.endsWith('.sql'))
      .sort();

    console.log(`   Found ${migrationFiles.length} migration file(s)`);

    // Run pending migrations
    let migrationsRun = 0;

    for (const file of migrationFiles) {
      if (appliedNames.has(file)) {
        console.log(`   ⏭️  Skipping ${file} (already applied)`);
        continue;
      }

      console.log(`   🔄 Running migration: ${file}`);

      const filePath = path.join(migrationsDir, file);
      const sql = fs.readFileSync(filePath, 'utf-8');

      // Run migration in a transaction
      await db.tx(async (t) => {
        // Execute the migration SQL
        await t.none(sql);

        // Record the migration
        await t.none('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      });

      console.log(`   ✅ Applied ${file}`);
      migrationsRun++;
    }

    if (migrationsRun === 0) {
      console.log('\n✨ Database is up to date!');
    } else {
      console.log(`\n✨ Successfully applied ${migrationsRun} migration(s)`);
    }
  } catch (error) {
    console.error('\n❌ Migration failed:', error instanceof Error ? error.message : error);
    process.exit(1);
  } finally {
    pgp.end();
  }
}

// =============================================================================
// CLI Commands
// =============================================================================

async function showStatus(): Promise<void> {
  const config = getConfig();
  const pgp = pgPromise();
  const db = pgp(config);

  try {
    const migrations = await db.any<Migration>(
      'SELECT name, applied_at FROM schema_migrations ORDER BY id'
    );

    console.log('\n📋 Migration Status\n');
    console.log('Applied migrations:');

    if (migrations.length === 0) {
      console.log('  (none)');
    } else {
      for (const m of migrations) {
        console.log(`  ✅ ${m.name} (${m.applied_at.toISOString()})`);
      }
    }

    console.log('');
  } catch (error) {
    if ((error as { code?: string }).code === '42P01') {
      console.log('\n📋 Migration Status\n');
      console.log('  No migrations have been run yet.');
      console.log('  Run `npm run db:migrate` to initialize the database.\n');
    } else {
      console.error('Error:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  } finally {
    pgp.end();
  }
}

async function createMigration(name: string): Promise<void> {
  const migrationsDir = path.join(__dirname, 'sql');

  if (!fs.existsSync(migrationsDir)) {
    fs.mkdirSync(migrationsDir, { recursive: true });
  }

  // Get next migration number
  const existingFiles = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  let nextNumber = 1;
  if (existingFiles.length > 0) {
    const lastFile = existingFiles[existingFiles.length - 1];
    const match = lastFile?.match(/^(\d+)_/);
    if (match?.[1]) {
      nextNumber = parseInt(match[1], 10) + 1;
    }
  }

  const sanitizedName = name.toLowerCase().replace(/[^a-z0-9]+/g, '_');
  const fileName = `${String(nextNumber).padStart(3, '0')}_${sanitizedName}.sql`;
  const filePath = path.join(migrationsDir, fileName);

  const template = `-- Migration: ${name}
-- Created: ${new Date().toISOString()}

-- Write your migration SQL here

`;

  fs.writeFileSync(filePath, template);
  console.log(`✅ Created migration: ${fileName}`);
}

// =============================================================================
// Main Entry Point
// =============================================================================

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0] ?? 'run';

  switch (command) {
    case 'run':
      await runMigrations();
      break;

    case 'status':
      await showStatus();
      break;

    case 'create':
      const name = args[1];
      if (!name) {
        console.error('Usage: npm run db:migrate create <migration_name>');
        process.exit(1);
      }
      await createMigration(name);
      break;

    default:
      console.log('AEGIS Database Migration Tool\n');
      console.log('Usage:');
      console.log('  npm run db:migrate          Run pending migrations');
      console.log('  npm run db:migrate status   Show migration status');
      console.log('  npm run db:migrate create <name>  Create new migration');
      break;
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
