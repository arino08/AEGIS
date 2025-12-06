/**
 * AEGIS - SQL Generator
 *
 * Generates safe SQL queries from natural language using OpenAI.
 * Implements strict validation and parameterization.
 */

import logger from '../utils/logger.js';
import type { SQLQuery } from './types.js';

// =============================================================================
// Configuration
// =============================================================================

export interface SQLGeneratorConfig {
  /**
   * OpenAI API key
   */
  apiKey: string;

  /**
   * OpenAI model to use
   */
  model: string;

  /**
   * Maximum tokens for response
   */
  maxTokens: number;

  /**
   * Temperature for generation
   */
  temperature: number;

  /**
   * Request timeout in milliseconds
   */
  timeout: number;
}

export const DEFAULT_SQL_GENERATOR_CONFIG: SQLGeneratorConfig = {
  apiKey: process.env.OPENAI_API_KEY || '',
  model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
  maxTokens: 1000,
  temperature: 0.1,
  timeout: 30000,
};

// =============================================================================
// Schema Definition
// =============================================================================

/**
 * Allowed tables for queries
 */
export const ALLOWED_TABLES = [
  'request_metrics',
  'aggregated_metrics',
  'rate_limit_metrics',
  'alerts',
  'alert_history',
] as const;

/**
 * Allowed columns per table
 */
export const ALLOWED_COLUMNS: Record<string, string[]> = {
  request_metrics: [
    'id',
    'timestamp',
    'request_id',
    'path',
    'method',
    'status_code',
    'duration_ms',
    'user_id',
    'ip_address',
    'user_agent',
    'backend',
    'bytes_in',
    'bytes_out',
    'error',
    'rate_limited',
    'cached',
    'tier',
  ],
  aggregated_metrics: [
    'id',
    'bucket',
    'endpoint',
    'method',
    'request_count',
    'success_count',
    'error_count',
    'total_latency_ms',
    'avg_latency_ms',
    'min_latency_ms',
    'max_latency_ms',
    'p50_latency_ms',
    'p95_latency_ms',
    'p99_latency_ms',
    'status_2xx',
    'status_3xx',
    'status_4xx',
    'status_5xx',
    'created_at',
  ],
  rate_limit_metrics: [
    'id',
    'timestamp',
    'key',
    'endpoint',
    'limit',
    'remaining',
    'allowed',
    'user_id',
    'ip_address',
    'tier',
    'algorithm',
  ],
  alerts: [
    'id',
    'rule_id',
    'rule_name',
    'severity',
    'status',
    'message',
    'metric_value',
    'threshold',
    'triggered_at',
    'acknowledged_at',
    'resolved_at',
    'created_at',
  ],
  alert_history: [
    'id',
    'alert_id',
    'previous_status',
    'new_status',
    'changed_by',
    'notes',
    'created_at',
  ],
};

/**
 * Query schema for validation
 */
export interface QuerySchema {
  tables: typeof ALLOWED_TABLES;
  columns: typeof ALLOWED_COLUMNS;
}

// =============================================================================
// SQL Generator Class
// =============================================================================

export class SQLGenerator {
  private config: SQLGeneratorConfig;

  constructor(config: Partial<SQLGeneratorConfig> = {}) {
    this.config = { ...DEFAULT_SQL_GENERATOR_CONFIG, ...config };
  }

  /**
   * Generate SQL from natural language question
   */
  async generate(
    question: string,
    context?: {
      timeRange?: { start?: string; end?: string };
      limit?: number;
    }
  ): Promise<SQLQuery> {
    if (!this.config.apiKey) {
      throw new Error('OpenAI API key is not configured');
    }

    const systemPrompt = this.buildSystemPrompt();
    const userPrompt = this.buildUserPrompt(question, context);

    try {
      const response = await this.callOpenAI(systemPrompt, userPrompt);
      const parsed = this.parseResponse(response);

      // Validate the generated SQL
      this.validateSQL(parsed.sql);

      return parsed;
    } catch (error) {
      logger.error('SQL generation failed', {
        question,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Build system prompt with schema information
   */
  private buildSystemPrompt(): string {
    const schemaInfo = Object.entries(ALLOWED_COLUMNS)
      .map(([table, columns]) => `Table: ${table}\nColumns: ${columns.join(', ')}`)
      .join('\n\n');

    return `You are an expert SQL generator for a metrics and analytics database.
Your task is to convert natural language questions into safe, read-only PostgreSQL queries.

IMPORTANT RULES:
1. Only generate SELECT queries - no INSERT, UPDATE, DELETE, DROP, or other modifications
2. Only use tables and columns from the schema provided below
3. Always include proper WHERE clauses for time-based queries
4. Use parameterized queries with $1, $2, etc. for user-provided values
5. Limit results appropriately (default 100 unless specified)
6. Use proper aggregations (COUNT, AVG, SUM, MAX, MIN) where appropriate
7. Include ORDER BY for meaningful results
8. Never use semicolons at the end of queries
9. Always alias calculated columns meaningfully

DATABASE SCHEMA:
${schemaInfo}

COMMON PATTERNS:
- For "last hour": WHERE timestamp >= NOW() - INTERVAL '1 hour'
- For error rate: (COUNT(*) FILTER (WHERE status_code >= 400) * 100.0 / COUNT(*))
- For latency percentiles: Use p50_latency_ms, p95_latency_ms, p99_latency_ms from metrics_aggregated
- For endpoint analysis: GROUP BY endpoint, method

RESPONSE FORMAT:
Respond ONLY with valid JSON in this exact format:
{
  "sql": "SELECT ... FROM ... WHERE ...",
  "params": [],
  "intent": "metrics_summary|error_analysis|latency_analysis|endpoint_analysis|rate_limit_analysis|traffic_pattern|anomaly_detection|time_series|comparison|aggregation|unknown",
  "tables": ["table1", "table2"],
  "confidence": 0.95,
  "explanation": "Brief explanation of what this query does"
}`;
  }

  /**
   * Build user prompt with question and context
   */
  private buildUserPrompt(
    question: string,
    context?: {
      timeRange?: { start?: string; end?: string };
      limit?: number;
    }
  ): string {
    let prompt = `Question: ${question}`;

    if (context?.timeRange) {
      if (context.timeRange.start) {
        prompt += `\nTime range start: ${context.timeRange.start}`;
      }
      if (context.timeRange.end) {
        prompt += `\nTime range end: ${context.timeRange.end}`;
      }
    }

    if (context?.limit) {
      prompt += `\nLimit results to: ${context.limit}`;
    }

    return prompt;
  }

  /**
   * Call OpenAI API
   */
  private async callOpenAI(systemPrompt: string, userPrompt: string): Promise<string> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.timeout);

    try {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          model: this.config.model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          max_tokens: this.config.maxTokens,
          temperature: this.config.temperature,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({})) as Record<string, unknown>;
        const errorObj = errorData.error as Record<string, unknown> | undefined;
        throw new Error(
          (errorObj?.message as string) || `OpenAI API error: ${response.status}`
        );
      }

      const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
      return data.choices?.[0]?.message?.content || '';
    } catch (error) {
      clearTimeout(timeoutId);

      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error('OpenAI request timed out');
      }

      throw error;
    }
  }

  /**
   * Parse OpenAI response into SQLQuery
   */
  private parseResponse(response: string): SQLQuery {
    try {
      // Extract JSON from response (handle markdown code blocks)
      let jsonStr = response;
      const jsonMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (jsonMatch?.[1]) {
        jsonStr = jsonMatch[1];
      }

      const parsed = JSON.parse(jsonStr.trim());

      return {
        sql: parsed.sql || '',
        params: parsed.params || [],
        intent: parsed.intent || 'unknown',
        tables: parsed.tables || [],
        confidence: parsed.confidence || 0.5,
        explanation: parsed.explanation || '',
      };
    } catch (error) {
      logger.error('Failed to parse OpenAI response', {
        response,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new Error('Failed to parse generated SQL');
    }
  }

  /**
   * Validate generated SQL for safety
   */
  private validateSQL(sql: string): void {
    const sqlUpper = sql.toUpperCase();

    // Check for forbidden operations
    const forbidden = [
      'INSERT',
      'UPDATE',
      'DELETE',
      'DROP',
      'CREATE',
      'ALTER',
      'TRUNCATE',
      'GRANT',
      'REVOKE',
      'EXECUTE',
      'EXEC',
      ';',
      '--',
      '/*',
    ];

    for (const keyword of forbidden) {
      if (sqlUpper.includes(keyword)) {
        throw new Error(`Forbidden SQL operation detected: ${keyword}`);
      }
    }

    // Check that query starts with SELECT
    if (!sqlUpper.trim().startsWith('SELECT')) {
      throw new Error('Only SELECT queries are allowed');
    }

    // Validate tables used
    const tablePattern = /FROM\s+(\w+)|JOIN\s+(\w+)/gi;
    let match;
    while ((match = tablePattern.exec(sql)) !== null) {
      const tableMatch = match[1] || match[2];
      if (!tableMatch) continue;
      const table = tableMatch.toLowerCase();
      if (!ALLOWED_TABLES.includes(table as typeof ALLOWED_TABLES[number])) {
        throw new Error(`Access to table '${table}' is not allowed`);
      }
    }
  }

  /**
   * Check if OpenAI is configured
   */
  isConfigured(): boolean {
    return Boolean(this.config.apiKey);
  }
}
