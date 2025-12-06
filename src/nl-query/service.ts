/**
 * AEGIS - Natural Language Query Service
 *
 * Main service that orchestrates NL to SQL conversion and execution.
 */

import { v4 as uuidv4 } from 'uuid';
import { getPostgresClient } from '../storage/postgres.js';
import logger from '../utils/logger.js';
import { SQLGenerator, DEFAULT_SQL_GENERATOR_CONFIG, type SQLGeneratorConfig } from './sql-generator.js';
import { QueryValidator, type QueryValidationConfig, DEFAULT_VALIDATION_CONFIG } from './validator.js';
import type {
  NLQueryRequest,
  NLQueryResponse,
  QueryResult,
  QueryMetadata,
  QueryIntent,
  ChatMessage,
  ChatSession,
} from './types.js';

// =============================================================================
// Configuration
// =============================================================================

export interface NLQueryConfig {
  /**
   * SQL generator configuration
   */
  generator: SQLGeneratorConfig;

  /**
   * Query validation configuration
   */
  validation: QueryValidationConfig;

  /**
   * Whether to execute queries (false = dry run)
   */
  executeQueries: boolean;

  /**
   * Maximum conversation history to maintain
   */
  maxHistoryLength: number;

  /**
   * Whether the service is enabled
   */
  enabled: boolean;
}

export const DEFAULT_NL_QUERY_CONFIG: NLQueryConfig = {
  generator: DEFAULT_SQL_GENERATOR_CONFIG,
  validation: DEFAULT_VALIDATION_CONFIG,
  executeQueries: true,
  maxHistoryLength: 10,
  enabled: Boolean(process.env.OPENAI_API_KEY),
};

// =============================================================================
// NL Query Service
// =============================================================================

export class NLQueryService {
  private config: NLQueryConfig;
  private generator: SQLGenerator;
  private validator: QueryValidator;
  private sessions: Map<string, ChatSession> = new Map();

  constructor(config: Partial<NLQueryConfig> = {}) {
    this.config = {
      ...DEFAULT_NL_QUERY_CONFIG,
      ...config,
      generator: { ...DEFAULT_NL_QUERY_CONFIG.generator, ...config.generator },
      validation: { ...DEFAULT_NL_QUERY_CONFIG.validation, ...config.validation },
    };

    this.generator = new SQLGenerator(this.config.generator);
    this.validator = new QueryValidator(this.config.validation);
  }

  /**
   * Process a natural language query
   */
  async query(request: NLQueryRequest): Promise<NLQueryResponse> {
    const startTime = Date.now();
    const timestamp = new Date().toISOString();

    // Check if service is enabled
    if (!this.config.enabled || !this.generator.isConfigured()) {
      return {
        success: false,
        question: request.question,
        answer: 'Natural language query service is not configured. Please set OPENAI_API_KEY.',
        metadata: this.createEmptyMetadata(),
        error: 'Service not configured',
        timestamp,
      };
    }

    try {
      // Generate SQL from natural language
      const sql = await this.generator.generate(request.question, {
        timeRange: request.timeRange,
        limit: request.limit,
      });

      // Validate the generated SQL
      const validation = this.validator.validate(sql.sql, sql.params);

      if (!validation.valid) {
        return {
          success: false,
          question: request.question,
          sql,
          answer: `I couldn't generate a safe query for that question. ${validation.errors.join(' ')}`,
          metadata: this.extractMetadata(sql, validation.warnings),
          error: validation.errors.join('; '),
          timestamp,
        };
      }

      // Execute the query if enabled
      let result: QueryResult | undefined;
      if (this.config.executeQueries && validation.sanitizedSQL) {
        result = await this.executeQuery(validation.sanitizedSQL, sql.params);
      }

      // Generate natural language answer
      const answer = this.generateAnswer(request.question, sql, result);

      // Determine visualization type
      const visualizationType = this.determineVisualization(sql.intent, result);

      return {
        success: true,
        question: request.question,
        sql,
        result,
        answer,
        metadata: this.extractMetadata(sql, validation.warnings),
        visualizationType,
        timestamp,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('NL query failed', {
        question: request.question,
        error: errorMessage,
        duration: Date.now() - startTime,
      });

      return {
        success: false,
        question: request.question,
        answer: `I encountered an error processing your question: ${errorMessage}`,
        metadata: this.createEmptyMetadata(),
        error: errorMessage,
        timestamp,
      };
    }
  }

  /**
   * Execute a SQL query against the database
   */
  private async executeQuery(sql: string, params: unknown[]): Promise<QueryResult> {
    const startTime = Date.now();

    try {
      const db = getPostgresClient();
      const rows = await db.query<Record<string, unknown>>(sql, params);

      const columns = rows.length > 0 && rows[0] ? Object.keys(rows[0]) : [];

      return {
        rows,
        columns,
        totalCount: rows.length,
        executionTimeMs: Date.now() - startTime,
      };
    } catch (error) {
      logger.error('Query execution failed', {
        sql,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Generate a natural language answer from query results
   */
  private generateAnswer(
    _question: string,
    sql: { intent: QueryIntent; explanation: string },
    result?: QueryResult
  ): string {
    if (!result) {
      return sql.explanation;
    }

    const { rows, totalCount, executionTimeMs } = result;

    if (rows.length === 0) {
      return `No data found for your query. ${sql.explanation}`;
    }

    // Generate contextual answer based on intent
    switch (sql.intent) {
      case 'metrics_summary':
        return this.summarizeMetrics(rows);
      case 'error_analysis':
        return this.summarizeErrors(rows);
      case 'latency_analysis':
        return this.summarizeLatency(rows);
      case 'endpoint_analysis':
        return this.summarizeEndpoints(rows);
      case 'aggregation':
        return this.summarizeAggregation(rows);
      default:
        return `Found ${totalCount} result${totalCount !== 1 ? 's' : ''} in ${executionTimeMs}ms. ${sql.explanation}`;
    }
  }

  /**
   * Summarize metrics data
   */
  private summarizeMetrics(rows: Record<string, unknown>[]): string {
    if (rows.length === 1) {
      const row = rows[0];
      if (!row) return `Found ${rows.length} metrics records.`;
      const parts: string[] = [];

      if (row.request_count != null) parts.push(`${row.request_count} total requests`);
      if (row.avg_latency_ms != null) parts.push(`${Number(row.avg_latency_ms).toFixed(1)}ms average latency`);
      if (row.error_rate != null) parts.push(`${Number(row.error_rate).toFixed(2)}% error rate`);

      return parts.length > 0
        ? `Here's a summary: ${parts.join(', ')}.`
        : `Found ${rows.length} metrics records.`;
    }
    return `Found ${rows.length} metrics records across the selected time range.`;
  }

  /**
   * Summarize error data
   */
  private summarizeErrors(rows: Record<string, unknown>[]): string {
    if (rows.length === 0) return 'No errors found in the selected time range.';

    const total = rows.reduce((sum, r) => sum + (Number(r.error_count) || 0), 0);
    return `Found ${total} errors across ${rows.length} ${rows.length === 1 ? 'endpoint' : 'endpoints'}.`;
  }

  /**
   * Summarize latency data
   */
  private summarizeLatency(rows: Record<string, unknown>[]): string {
    if (rows.length === 0) return 'No latency data available.';

    const row = rows[0];
    if (!row) return `Found ${rows.length} latency records.`;
    const parts: string[] = [];

    if (row.p50_latency_ms != null) parts.push(`P50: ${Number(row.p50_latency_ms).toFixed(1)}ms`);
    if (row.p95_latency_ms != null) parts.push(`P95: ${Number(row.p95_latency_ms).toFixed(1)}ms`);
    if (row.p99_latency_ms != null) parts.push(`P99: ${Number(row.p99_latency_ms).toFixed(1)}ms`);

    return parts.length > 0
      ? `Latency percentiles: ${parts.join(', ')}.`
      : `Found ${rows.length} latency records.`;
  }

  /**
   * Summarize endpoint data
   */
  private summarizeEndpoints(rows: Record<string, unknown>[]): string {
    if (rows.length === 0) return 'No endpoint data available.';

    const topEndpoint = rows[0];
    if (!topEndpoint) return 'No endpoint data available.';
    return `Found ${rows.length} endpoints. The top endpoint is ${topEndpoint.endpoint || topEndpoint.method || 'unknown'} with ${topEndpoint.request_count || 'N/A'} requests.`;
  }

  /**
   * Summarize aggregation results
   */
  private summarizeAggregation(rows: Record<string, unknown>[]): string {
    const firstRow = rows[0];
    if (rows.length === 1 && firstRow && Object.keys(firstRow).length <= 3) {
      const values = Object.entries(firstRow)
        .map(([key, value]) => `${key}: ${value}`)
        .join(', ');
      return `Result: ${values}`;
    }
    return `Found ${rows.length} aggregated results.`;
  }

  /**
   * Determine the best visualization type for results
   */
  private determineVisualization(
    intent: QueryIntent,
    result?: QueryResult
  ): 'table' | 'line_chart' | 'bar_chart' | 'pie_chart' | 'number' | 'text' {
    if (!result || result.rows.length === 0) {
      return 'text';
    }

    // Single value result
    if (result.rows.length === 1 && result.columns.length <= 2) {
      return 'number';
    }

    // Time series data
    if (result.columns.includes('bucket') || result.columns.includes('timestamp')) {
      return 'line_chart';
    }

    // Category/distribution data
    switch (intent) {
      case 'endpoint_analysis':
      case 'error_analysis':
        return 'bar_chart';
      case 'time_series':
        return 'line_chart';
      case 'comparison':
        return 'bar_chart';
      default:
        return result.rows.length > 10 ? 'table' : 'bar_chart';
    }
  }

  /**
   * Extract metadata from SQL query
   */
  private extractMetadata(
    sql: { intent: QueryIntent; tables: string[] },
    warnings: string[]
  ): QueryMetadata {
    return {
      intent: sql.intent,
      entities: {
        // Could be enhanced with NER
      },
      suggestions: this.generateSuggestions(sql.intent),
      warnings,
    };
  }

  /**
   * Generate follow-up question suggestions
   */
  private generateSuggestions(intent: QueryIntent): string[] {
    const suggestions: Record<QueryIntent, string[]> = {
      metrics_summary: [
        'Show me the error rate breakdown by endpoint',
        'What was the peak traffic in the last hour?',
        'Compare today\'s metrics to yesterday',
      ],
      error_analysis: [
        'Which endpoints have the highest error rates?',
        'Show error trends over the last 24 hours',
        'What are the most common error codes?',
      ],
      latency_analysis: [
        'Which endpoints are the slowest?',
        'Show P99 latency trends',
        'Compare latency across different backends',
      ],
      endpoint_analysis: [
        'What is the traffic distribution?',
        'Show endpoint error rates',
        'Which endpoints get the most traffic?',
      ],
      rate_limit_analysis: [
        'How many requests were rate limited?',
        'Which clients hit rate limits most?',
        'Show rate limit events over time',
      ],
      traffic_pattern: [
        'When is peak traffic?',
        'Show hourly request distribution',
        'Compare weekday vs weekend traffic',
      ],
      anomaly_detection: [
        'Were there any anomalies today?',
        'Show unusual traffic patterns',
        'What triggered the anomalies?',
      ],
      time_series: [
        'Show a different time range',
        'Aggregate by hour instead of minute',
        'Add a trend line',
      ],
      comparison: [
        'Compare more endpoints',
        'Show the percentage difference',
        'Add historical comparison',
      ],
      aggregation: [
        'Break down by endpoint',
        'Show the distribution',
        'Add time-based grouping',
      ],
      unknown: [
        'What is the current error rate?',
        'Show me traffic for the last hour',
        'Which endpoints are slowest?',
      ],
    };

    return suggestions[intent] || suggestions.unknown;
  }

  /**
   * Create empty metadata for error cases
   */
  private createEmptyMetadata(): QueryMetadata {
    return {
      intent: 'unknown',
      entities: {},
      suggestions: [
        'What is the current error rate?',
        'Show me traffic for the last hour',
        'Which endpoints are slowest?',
      ],
      warnings: [],
    };
  }

  // ===========================================================================
  // Chat Session Management
  // ===========================================================================

  /**
   * Create a new chat session
   */
  createSession(): ChatSession {
    const session: ChatSession = {
      id: uuidv4(),
      messages: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.sessions.set(session.id, session);
    return session;
  }

  /**
   * Get a chat session by ID
   */
  getSession(sessionId: string): ChatSession | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Add a message to a chat session
   */
  addMessage(
    sessionId: string,
    message: Omit<ChatMessage, 'id' | 'timestamp'>
  ): ChatMessage | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;

    const chatMessage: ChatMessage = {
      id: uuidv4(),
      ...message,
      timestamp: new Date().toISOString(),
    };

    session.messages.push(chatMessage);
    session.updatedAt = new Date().toISOString();

    // Trim history if needed
    if (session.messages.length > this.config.maxHistoryLength * 2) {
      session.messages = session.messages.slice(-this.config.maxHistoryLength * 2);
    }

    return chatMessage;
  }

  /**
   * Process a chat message and get a response
   */
  async chat(sessionId: string, question: string): Promise<NLQueryResponse> {
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = this.createSession();
    }

    // Add user message
    this.addMessage(session.id, {
      role: 'user',
      content: question,
    });

    // Process query
    const response = await this.query({ question });

    // Add assistant message
    this.addMessage(session.id, {
      role: 'assistant',
      content: response.answer,
      metadata: {
        sql: response.sql?.sql,
        result: response.result,
        visualizationType: response.visualizationType,
      },
    });

    return response;
  }

  /**
   * Check if the service is configured
   */
  isConfigured(): boolean {
    return this.config.enabled && this.generator.isConfigured();
  }
}

// =============================================================================
// Singleton Instance
// =============================================================================

let nlQueryService: NLQueryService | null = null;

export function getNLQueryService(): NLQueryService {
  if (!nlQueryService) {
    nlQueryService = new NLQueryService();
  }
  return nlQueryService;
}

export function initializeNLQueryService(config?: Partial<NLQueryConfig>): NLQueryService {
  nlQueryService = new NLQueryService(config);
  return nlQueryService;
}
