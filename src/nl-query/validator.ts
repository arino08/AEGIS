/**
 * AEGIS - Query Validator
 *
 * Validates and sanitizes SQL queries before execution.
 */

import { ALLOWED_TABLES, ALLOWED_COLUMNS } from './sql-generator.js';

// =============================================================================
// Types
// =============================================================================

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  sanitizedSQL?: string;
}

export interface QueryValidationConfig {
  /**
   * Maximum allowed query length
   */
  maxQueryLength: number;

  /**
   * Maximum allowed result limit
   */
  maxResultLimit: number;

  /**
   * Require time-based filtering
   */
  requireTimeFilter: boolean;

  /**
   * Maximum query complexity (joins, subqueries)
   */
  maxComplexity: number;
}

export const DEFAULT_VALIDATION_CONFIG: QueryValidationConfig = {
  maxQueryLength: 5000,
  maxResultLimit: 10000,
  requireTimeFilter: true,
  maxComplexity: 3,
};

// =============================================================================
// Query Validator Class
// =============================================================================

export class QueryValidator {
  private config: QueryValidationConfig;

  constructor(config: Partial<QueryValidationConfig> = {}) {
    this.config = { ...DEFAULT_VALIDATION_CONFIG, ...config };
  }

  /**
   * Validate a SQL query
   */
  validate(sql: string, params: unknown[] = []): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];
    const sqlUpper = sql.toUpperCase();

    // Check query length
    if (sql.length > this.config.maxQueryLength) {
      errors.push(`Query exceeds maximum length of ${this.config.maxQueryLength} characters`);
    }

    // Check for SELECT only
    if (!sqlUpper.trim().startsWith('SELECT')) {
      errors.push('Only SELECT queries are allowed');
    }

    // Check for forbidden keywords
    const forbidden = [
      'INSERT', 'UPDATE', 'DELETE', 'DROP', 'CREATE', 'ALTER',
      'TRUNCATE', 'GRANT', 'REVOKE', 'EXECUTE', 'EXEC',
    ];
    for (const keyword of forbidden) {
      if (new RegExp(`\\b${keyword}\\b`, 'i').test(sql)) {
        errors.push(`Forbidden operation: ${keyword}`);
      }
    }

    // Check for SQL comments
    if (sql.includes('--') || sql.includes('/*')) {
      errors.push('SQL comments are not allowed');
    }

    // Check for multiple statements
    if (sql.includes(';')) {
      errors.push('Multiple SQL statements are not allowed');
    }

    // Validate tables
    const tables = this.extractTables(sql);
    for (const table of tables) {
      if (!ALLOWED_TABLES.includes(table as typeof ALLOWED_TABLES[number])) {
        errors.push(`Access to table '${table}' is not allowed`);
      }
    }

    // Validate columns (basic check)
    const columns = this.extractColumns(sql);
    for (const { table, column } of columns) {
      if (table && ALLOWED_COLUMNS[table]) {
        if (!ALLOWED_COLUMNS[table].includes(column) && column !== '*') {
          warnings.push(`Column '${column}' may not exist in table '${table}'`);
        }
      }
    }

    // Check for time filter
    if (this.config.requireTimeFilter) {
      const hasTimeFilter = /WHERE\s+.*(?:timestamp|bucket|created_at|triggered_at)/i.test(sql);
      if (!hasTimeFilter && tables.some(t => ['request_metrics', 'aggregated_metrics'].includes(t))) {
        warnings.push('Consider adding a time-based filter for better performance');
      }
    }

    // Check LIMIT clause
    const limitMatch = sql.match(/LIMIT\s+(\d+)/i);
    if (limitMatch?.[1]) {
      const limit = parseInt(limitMatch[1], 10);
      if (limit > this.config.maxResultLimit) {
        errors.push(`LIMIT exceeds maximum of ${this.config.maxResultLimit}`);
      }
    } else {
      warnings.push('No LIMIT clause - consider adding one to limit results');
    }

    // Check complexity
    const complexity = this.calculateComplexity(sql);
    if (complexity > this.config.maxComplexity) {
      warnings.push(`Query complexity (${complexity}) exceeds recommended maximum (${this.config.maxComplexity})`);
    }

    // Check for potential SQL injection in params
    for (let i = 0; i < params.length; i++) {
      const param = params[i];
      if (typeof param === 'string') {
        if (this.containsSQLInjection(param)) {
          errors.push(`Potential SQL injection in parameter $${i + 1}`);
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
      sanitizedSQL: errors.length === 0 ? this.sanitize(sql) : undefined,
    };
  }

  /**
   * Extract table names from SQL
   */
  private extractTables(sql: string): string[] {
    const tables: string[] = [];
    const patterns = [
      /FROM\s+(\w+)/gi,
      /JOIN\s+(\w+)/gi,
    ];

    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(sql)) !== null) {
        if (match[1]) tables.push(match[1].toLowerCase());
      }
    }

    return [...new Set(tables)];
  }

  /**
   * Extract column references from SQL
   */
  private extractColumns(sql: string): { table: string | null; column: string }[] {
    const columns: { table: string | null; column: string }[] = [];

    // Match table.column patterns
    const tableColumnPattern = /(\w+)\.(\w+)/g;
    let match;
    while ((match = tableColumnPattern.exec(sql)) !== null) {
      if (match[1] && match[2]) {
        columns.push({ table: match[1].toLowerCase(), column: match[2].toLowerCase() });
      }
    }

    return columns;
  }

  /**
   * Calculate query complexity
   */
  private calculateComplexity(sql: string): number {
    let complexity = 1;

    // Count JOINs
    const joins = (sql.match(/\bJOIN\b/gi) || []).length;
    complexity += joins;

    // Count subqueries
    const subqueries = (sql.match(/\(\s*SELECT\b/gi) || []).length;
    complexity += subqueries * 2;

    // Count UNION/INTERSECT/EXCEPT
    const setOps = (sql.match(/\b(UNION|INTERSECT|EXCEPT)\b/gi) || []).length;
    complexity += setOps;

    // Count GROUP BY with HAVING
    if (/GROUP BY/i.test(sql) && /HAVING/i.test(sql)) {
      complexity += 1;
    }

    // Count window functions
    const windowFuncs = (sql.match(/\bOVER\s*\(/gi) || []).length;
    complexity += windowFuncs;

    return complexity;
  }

  /**
   * Check for SQL injection patterns
   */
  private containsSQLInjection(value: string): boolean {
    const patterns = [
      /['";].*['";]/,
      /\b(OR|AND)\s+['"]?\d+['"]?\s*=\s*['"]?\d+['"]?/i,
      /\b(UNION|SELECT|INSERT|UPDATE|DELETE|DROP)\b/i,
      /--/,
      /\/\*/,
    ];

    return patterns.some(pattern => pattern.test(value));
  }

  /**
   * Sanitize SQL query
   */
  private sanitize(sql: string): string {
    // Remove extra whitespace
    let sanitized = sql.replace(/\s+/g, ' ').trim();

    // Remove trailing semicolon if present
    sanitized = sanitized.replace(/;+$/, '');

    return sanitized;
  }
}
