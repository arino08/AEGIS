/**
 * AEGIS - Natural Language Query Module
 *
 * Provides OpenAI-powered natural language interface for analytics queries.
 * Converts natural language questions to SQL and executes them safely.
 */

export { NLQueryService, NLQueryConfig, DEFAULT_NL_QUERY_CONFIG } from './service.js';
export { SQLGenerator, SQLGeneratorConfig, QuerySchema, ALLOWED_TABLES, ALLOWED_COLUMNS } from './sql-generator.js';
export { QueryValidator, ValidationResult, QueryValidationConfig } from './validator.js';
export type {
  NLQueryRequest,
  NLQueryResponse,
  QueryResult,
  QueryIntent,
  SQLQuery,
  QueryMetadata,
} from './types.js';
