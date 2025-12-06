/**
 * AEGIS - PostgreSQL Database Client
 * Handles database connections, queries, and connection pooling
 */

import pgPromise, { type IDatabase, type IMain, type ITask } from 'pg-promise';

import logger from '../utils/logger.js';
import type { PostgresConfig, RequestLog } from '../utils/types.js';
import { DatabaseError } from '../utils/types.js';

// =============================================================================
// Types
// =============================================================================

export interface DatabaseClient {
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;
  queryOne<T>(sql: string, params?: unknown[]): Promise<T | null>;
  execute(sql: string, params?: unknown[]): Promise<number>;
  transaction<T>(callback: (t: ITask<object>) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  isConnected(): boolean;
}

export interface ConnectionStats {
  total: number;
  idle: number;
  waiting: number;
}

/**
 * Database schema type for rate limit rules
 * This is the legacy structure used in the database
 */
export interface DbRateLimitRule {
  id: number;
  endpointPattern: string;
  requestsPerMinute: number;
  tier: string;
}

// =============================================================================
// PostgreSQL Client Class
// =============================================================================

export class PostgresClient implements DatabaseClient {
  private pgp: IMain;
  private db: IDatabase<object>;
  private config: PostgresConfig;
  private connected = false;

  constructor(config: PostgresConfig) {
    this.config = config;

    // Initialize pg-promise
    this.pgp = pgPromise({
      // Connection pool settings
      capSQL: true,

      // Query events for logging
      query(e) {
        logger.debug('PostgreSQL query', {
          query: e.query.substring(0, 200),
        });
      },

      error(err, e) {
        logger.error('PostgreSQL error', {
          error: err.message,
          query: e.query?.substring(0, 200),
        });
      },

      // Connection events
      connect(e) {
        logger.debug('PostgreSQL connection established', {
          useCount: e.useCount,
        });
      },

      disconnect(_e) {
        logger.debug('PostgreSQL connection closed');
      },
    });

    // Build connection string
    const connectionConfig = {
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.user,
      password: config.password,
      ssl: config.ssl ? { rejectUnauthorized: false } : false,
      max: config.poolMax,
      min: config.poolMin,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    };

    this.db = this.pgp(connectionConfig);
  }

  /**
   * Test database connection
   */
  public async connect(): Promise<void> {
    try {
      const connection = await this.db.connect();
      void connection.done(); // Release connection back to pool
      this.connected = true;
      logger.info('PostgreSQL connection pool initialized', {
        host: this.config.host,
        port: this.config.port,
        database: this.config.database,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('Failed to connect to PostgreSQL', {
        host: this.config.host,
        port: this.config.port,
        error: message,
      });
      throw new DatabaseError(`Failed to connect to PostgreSQL: ${message}`);
    }
  }

  /**
   * Execute a query and return all results
   */
  public async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
    try {
      return await this.db.any<T>(sql, params);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new DatabaseError(`Query failed: ${message}`);
    }
  }

  /**
   * Execute a query and return a single result or null
   */
  public async queryOne<T>(sql: string, params?: unknown[]): Promise<T | null> {
    try {
      return await this.db.oneOrNone<T>(sql, params);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new DatabaseError(`Query failed: ${message}`);
    }
  }

  /**
   * Execute a query that doesn't return data (INSERT, UPDATE, DELETE)
   * Returns the number of affected rows
   */
  public async execute(sql: string, params?: unknown[]): Promise<number> {
    try {
      const result = await this.db.result(sql, params);
      return result.rowCount;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new DatabaseError(`Execute failed: ${message}`);
    }
  }

  /**
   * Execute multiple queries in a transaction
   */
  public async transaction<T>(callback: (t: ITask<object>) => Promise<T>): Promise<T> {
    try {
      return await this.db.tx(callback);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new DatabaseError(`Transaction failed: ${message}`);
    }
  }

  /**
   * Check if connected to database
   */
  public isConnected(): boolean {
    return this.connected;
  }

  /**
   * Close all connections
   */
  public async close(): Promise<void> {
    this.pgp.end();
    this.connected = false;
    logger.info('PostgreSQL connection pool closed');
  }

  /**
   * Get the raw pg-promise database instance (for advanced usage)
   */
  public getDb(): IDatabase<object> {
    return this.db;
  }

  // ===========================================================================
  // Request Logs Repository Methods
  // ===========================================================================

  /**
   * Insert a request log entry
   */
  public async insertRequestLog(log: Omit<RequestLog, 'id'>): Promise<number> {
    const sql = `
      INSERT INTO request_logs (
        timestamp, method, path, status_code, response_time_ms,
        user_id, ip_address, user_agent, backend_name, request_id, error_message
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11
      )
      RETURNING id
    `;

    const result = await this.queryOne<{ id: number }>(sql, [
      log.timestamp,
      log.method,
      log.path,
      log.statusCode,
      log.responseTimeMs,
      log.userId ?? null,
      log.ipAddress,
      log.userAgent ?? null,
      log.backendName ?? null,
      log.requestId,
      log.errorMessage ?? null,
    ]);

    return result?.id ?? 0;
  }

  /**
   * Bulk insert request logs (for batch operations)
   */
  public async insertRequestLogsBatch(logs: Omit<RequestLog, 'id'>[]): Promise<number> {
    if (logs.length === 0) {
      return 0;
    }

    const cs = new this.pgp.helpers.ColumnSet(
      [
        'timestamp',
        'method',
        'path',
        'status_code',
        'response_time_ms',
        'user_id',
        'ip_address',
        'user_agent',
        'backend_name',
        'request_id',
        'error_message',
      ],
      { table: 'request_logs' }
    );

    const values = logs.map((log) => ({
      timestamp: log.timestamp,
      method: log.method,
      path: log.path,
      status_code: log.statusCode,
      response_time_ms: log.responseTimeMs,
      user_id: log.userId ?? null,
      ip_address: log.ipAddress,
      user_agent: log.userAgent ?? null,
      backend_name: log.backendName ?? null,
      request_id: log.requestId,
      error_message: log.errorMessage ?? null,
    }));

    const query = this.pgp.helpers.insert(values, cs);
    return await this.execute(query);
  }

  /**
   * Get recent request logs
   */
  public async getRecentRequestLogs(limit = 100, offset = 0): Promise<RequestLog[]> {
    const sql = `
      SELECT
        id, timestamp, method, path, status_code as "statusCode",
        response_time_ms as "responseTimeMs", user_id as "userId",
        ip_address as "ipAddress", user_agent as "userAgent",
        backend_name as "backendName", request_id as "requestId",
        error_message as "errorMessage"
      FROM request_logs
      ORDER BY timestamp DESC
      LIMIT $1 OFFSET $2
    `;

    return await this.query<RequestLog>(sql, [limit, offset]);
  }

  /**
   * Get request logs by path pattern
   */
  public async getRequestLogsByPath(pathPattern: string, limit = 100): Promise<RequestLog[]> {
    const sql = `
      SELECT
        id, timestamp, method, path, status_code as "statusCode",
        response_time_ms as "responseTimeMs", user_id as "userId",
        ip_address as "ipAddress", user_agent as "userAgent",
        backend_name as "backendName", request_id as "requestId",
        error_message as "errorMessage"
      FROM request_logs
      WHERE path LIKE $1
      ORDER BY timestamp DESC
      LIMIT $2
    `;

    return await this.query<RequestLog>(sql, [`%${pathPattern}%`, limit]);
  }

  // ===========================================================================
  // Rate Limit Rules Repository Methods
  // ===========================================================================

  /**
   * Get all rate limit rules from database
   */
  public async getRateLimitRules(): Promise<DbRateLimitRule[]> {
    const sql = `
      SELECT
        id, endpoint_pattern as "endpointPattern",
        requests_per_minute as "requestsPerMinute", tier
      FROM rate_limit_rules
      ORDER BY LENGTH(endpoint_pattern) DESC
    `;

    return await this.query<DbRateLimitRule>(sql);
  }

  /**
   * Get rate limit rule by endpoint pattern
   */
  public async getRateLimitRuleByPattern(pattern: string): Promise<DbRateLimitRule | null> {
    const sql = `
      SELECT
        id, endpoint_pattern as "endpointPattern",
        requests_per_minute as "requestsPerMinute", tier
      FROM rate_limit_rules
      WHERE endpoint_pattern = $1
    `;

    return await this.queryOne<DbRateLimitRule>(sql, [pattern]);
  }

  /**
   * Insert a new rate limit rule
   */
  public async insertRateLimitRule(rule: Omit<DbRateLimitRule, 'id'>): Promise<number> {
    const sql = `
      INSERT INTO rate_limit_rules (endpoint_pattern, requests_per_minute, tier)
      VALUES ($1, $2, $3)
      RETURNING id
    `;

    const result = await this.queryOne<{ id: number }>(sql, [
      rule.endpointPattern,
      rule.requestsPerMinute,
      rule.tier,
    ]);

    return result?.id ?? 0;
  }

  /**
   * Update a rate limit rule
   */
  public async updateRateLimitRule(
    id: number,
    updates: Partial<Omit<DbRateLimitRule, 'id'>>
  ): Promise<boolean> {
    const setClauses: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (updates.endpointPattern !== undefined) {
      setClauses.push(`endpoint_pattern = $${paramIndex++}`);
      values.push(updates.endpointPattern);
    }

    if (updates.requestsPerMinute !== undefined) {
      setClauses.push(`requests_per_minute = $${paramIndex++}`);
      values.push(updates.requestsPerMinute);
    }

    if (updates.tier !== undefined) {
      setClauses.push(`tier = $${paramIndex++}`);
      values.push(updates.tier);
    }

    if (setClauses.length === 0) {
      return false;
    }

    values.push(id);
    const sql = `
      UPDATE rate_limit_rules
      SET ${setClauses.join(', ')}
      WHERE id = $${paramIndex}
    `;

    const rowCount = await this.execute(sql, values);
    return rowCount > 0;
  }

  /**
   * Delete a rate limit rule
   */
  public async deleteRateLimitRule(id: number): Promise<boolean> {
    const sql = 'DELETE FROM rate_limit_rules WHERE id = $1';
    const rowCount = await this.execute(sql, [id]);
    return rowCount > 0;
  }

  // ===========================================================================
  // Aggregation Methods for Metrics
  // ===========================================================================

  /**
   * Get request count by status code for a time range
   */
  public async getRequestCountByStatus(
    startTime: Date,
    endTime: Date
  ): Promise<{ statusCode: number; count: number }[]> {
    const sql = `
      SELECT status_code as "statusCode", COUNT(*)::int as count
      FROM request_logs
      WHERE timestamp >= $1 AND timestamp <= $2
      GROUP BY status_code
      ORDER BY status_code
    `;

    return await this.query<{ statusCode: number; count: number }>(sql, [startTime, endTime]);
  }

  /**
   * Get average response time by backend
   */
  public async getAverageResponseTimeByBackend(
    startTime: Date,
    endTime: Date
  ): Promise<{ backendName: string; avgResponseTime: number }[]> {
    const sql = `
      SELECT
        backend_name as "backendName",
        AVG(response_time_ms)::numeric(10,2) as "avgResponseTime"
      FROM request_logs
      WHERE timestamp >= $1 AND timestamp <= $2 AND backend_name IS NOT NULL
      GROUP BY backend_name
      ORDER BY "avgResponseTime" DESC
    `;

    return await this.query<{ backendName: string; avgResponseTime: number }>(sql, [
      startTime,
      endTime,
    ]);
  }

  /**
   * Get request count by time bucket (for graphing)
   */
  public async getRequestCountByTimeBucket(
    startTime: Date,
    endTime: Date,
    bucketMinutes = 5
  ): Promise<{ bucket: Date; count: number }[]> {
    const sql = `
      SELECT
        date_trunc('minute', timestamp) -
          (EXTRACT(minute FROM timestamp)::integer % $3) * interval '1 minute' as bucket,
        COUNT(*)::int as count
      FROM request_logs
      WHERE timestamp >= $1 AND timestamp <= $2
      GROUP BY bucket
      ORDER BY bucket
    `;

    return await this.query<{ bucket: Date; count: number }>(sql, [
      startTime,
      endTime,
      bucketMinutes,
    ]);
  }
}

// =============================================================================
// Singleton Instance
// =============================================================================

let postgresInstance: PostgresClient | null = null;

export function getPostgresClient(config?: PostgresConfig): PostgresClient {
  if (postgresInstance === null) {
    if (config === undefined) {
      throw new Error('PostgreSQL configuration required for first initialization');
    }
    postgresInstance = new PostgresClient(config);
  }
  return postgresInstance;
}

export async function initializePostgres(config: PostgresConfig): Promise<PostgresClient> {
  const client = getPostgresClient(config);
  await client.connect();
  return client;
}

export async function closePostgres(): Promise<void> {
  if (postgresInstance !== null) {
    await postgresInstance.close();
    postgresInstance = null;
  }
}

export default PostgresClient;
