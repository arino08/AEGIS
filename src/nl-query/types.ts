/**
 * AEGIS - Natural Language Query Types
 *
 * Type definitions for the NL Query interface.
 */

/**
 * Supported query intents
 */
export type QueryIntent =
  | 'metrics_summary'
  | 'error_analysis'
  | 'latency_analysis'
  | 'endpoint_analysis'
  | 'rate_limit_analysis'
  | 'traffic_pattern'
  | 'anomaly_detection'
  | 'time_series'
  | 'comparison'
  | 'aggregation'
  | 'unknown';

/**
 * User's natural language query request
 */
export interface NLQueryRequest {
  /**
   * Natural language question
   */
  question: string;

  /**
   * Optional time range context
   */
  timeRange?: {
    start?: string;
    end?: string;
    preset?: '5m' | '15m' | '1h' | '6h' | '24h' | '7d' | '30d';
  };

  /**
   * Optional context from previous queries
   */
  context?: {
    previousQueries?: string[];
    currentView?: string;
  };

  /**
   * Maximum number of results
   */
  limit?: number;
}

/**
 * Generated SQL query with metadata
 */
export interface SQLQuery {
  /**
   * The generated SQL query
   */
  sql: string;

  /**
   * Parameterized values (for safe execution)
   */
  params: unknown[];

  /**
   * Detected intent of the query
   */
  intent: QueryIntent;

  /**
   * Tables used in the query
   */
  tables: string[];

  /**
   * Confidence score (0-1)
   */
  confidence: number;

  /**
   * Explanation of what the query does
   */
  explanation: string;
}

/**
 * Query result row
 */
export interface QueryResultRow {
  [key: string]: unknown;
}

/**
 * Query execution result
 */
export interface QueryResult {
  /**
   * Result rows
   */
  rows: QueryResultRow[];

  /**
   * Column names
   */
  columns: string[];

  /**
   * Total row count (before limit)
   */
  totalCount: number;

  /**
   * Execution time in milliseconds
   */
  executionTimeMs: number;
}

/**
 * Query metadata
 */
export interface QueryMetadata {
  /**
   * Detected intent
   */
  intent: QueryIntent;

  /**
   * Entities extracted from the query
   */
  entities: {
    endpoints?: string[];
    methods?: string[];
    statusCodes?: number[];
    timeReferences?: string[];
    metrics?: string[];
  };

  /**
   * Suggested follow-up questions
   */
  suggestions: string[];

  /**
   * Warnings or notes
   */
  warnings: string[];
}

/**
 * Complete response to a natural language query
 */
export interface NLQueryResponse {
  /**
   * Whether the query was successful
   */
  success: boolean;

  /**
   * Original question
   */
  question: string;

  /**
   * Generated SQL (if successful)
   */
  sql?: SQLQuery;

  /**
   * Query results (if executed)
   */
  result?: QueryResult;

  /**
   * Natural language answer
   */
  answer: string;

  /**
   * Query metadata
   */
  metadata: QueryMetadata;

  /**
   * Visualization hint
   */
  visualizationType?: 'table' | 'line_chart' | 'bar_chart' | 'pie_chart' | 'number' | 'text';

  /**
   * Error message (if failed)
   */
  error?: string;

  /**
   * Timestamp
   */
  timestamp: string;
}

/**
 * Conversation message
 */
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
  metadata?: {
    sql?: string;
    result?: QueryResult;
    visualizationType?: string;
  };
}

/**
 * Chat session
 */
export interface ChatSession {
  id: string;
  messages: ChatMessage[];
  createdAt: string;
  updatedAt: string;
}
