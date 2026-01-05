# 08. Natural Language Query

## Overview

AEGIS allows you to query your API metrics using natural language. Ask questions like "What's the error rate?" or "Show me the slowest endpoints" and get visual results without writing SQL.

---

## 📁 NL Query Module Structure

```
src/nl-query/
├── index.ts          # Module exports
├── service.ts        # Main NLQueryService class
├── sql-generator.ts  # NL to SQL conversion using OpenAI
├── validator.ts      # SQL validation and sanitization
└── types.ts          # Type definitions
```

---

## 🧠 How It Works

```
User Question                          Visual Answer
     │                                      ▲
     ▼                                      │
┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│   OpenAI    │ →  │    SQL      │ →  │   Execute   │
│   GPT-4     │    │  Validator  │    │   Query     │
└─────────────┘    └─────────────┘    └─────────────┘
      │                  │                  │
      │                  │                  │
  Generate           Validate            Run against
  SQL query       and sanitize          PostgreSQL
```

---

## 🎯 NL Query Service

### `src/nl-query/service.ts`

```typescript
export class NLQueryService {
  private config: NLQueryConfig;
  private generator: SQLGenerator;
  private validator: QueryValidator;
  private sessions: Map<string, ChatSession> = new Map();

  constructor(config: Partial<NLQueryConfig> = {}) {
    this.config = {
      ...DEFAULT_NL_QUERY_CONFIG,
      ...config
    };

    this.generator = new SQLGenerator(this.config.generator);
    this.validator = new QueryValidator(this.config.validation);
  }
}
```

### Processing a Query

```typescript
async query(request: NLQueryRequest): Promise<NLQueryResponse> {
  const { question, context } = request;
  const startTime = Date.now();

  try {
    // 1. Generate SQL from natural language
    const sqlResult = await this.generator.generate(question, context);

    if (!sqlResult.success) {
      return {
        success: false,
        error: sqlResult.error || 'Failed to generate SQL',
        metadata: this.createEmptyMetadata()
      };
    }

    // 2. Validate the generated SQL
    const validation = this.validator.validate(sqlResult.sql!);

    if (!validation.valid) {
      return {
        success: false,
        error: `Invalid SQL: ${validation.errors.join(', ')}`,
        metadata: this.createEmptyMetadata()
      };
    }

    // 3. Execute the query (if enabled)
    let result: QueryResult | undefined;
    if (this.config.executeQueries) {
      result = await this.executeQuery(sqlResult.sql!, sqlResult.params || []);
    }

    // 4. Generate natural language answer
    const answer = this.generateAnswer(question, sqlResult, result);

    // 5. Determine best visualization
    const visualizationType = this.determineVisualization(sqlResult.intent, result);

    return {
      success: true,
      answer,
      sql: {
        sql: sqlResult.sql!,
        params: sqlResult.params
      },
      result,
      visualizationType,
      metadata: this.extractMetadata(sqlResult, validation.warnings),
      suggestions: this.generateSuggestions(sqlResult.intent)
    };

  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      metadata: this.createEmptyMetadata()
    };
  }
}
```

---

## 🤖 SQL Generator

### `src/nl-query/sql-generator.ts`

Uses OpenAI GPT-4 to convert natural language to SQL:

```typescript
export class SQLGenerator {
  private openai: OpenAI;
  private config: SQLGeneratorConfig;

  constructor(config: SQLGeneratorConfig) {
    this.config = config;
    this.openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY
    });
  }

  async generate(question: string, context?: QueryContext): Promise<SQLGenerationResult> {
    const systemPrompt = this.buildSystemPrompt();
    const userPrompt = this.buildUserPrompt(question, context);

    try {
      const response = await this.openai.chat.completions.create({
        model: this.config.model || 'gpt-4-turbo-preview',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.1,  // Low temperature for consistent SQL
        max_tokens: 1000,
        response_format: { type: 'json_object' }
      });

      const content = response.choices[0]?.message?.content;
      if (!content) {
        return { success: false, error: 'No response from AI' };
      }

      const parsed = JSON.parse(content);
      return {
        success: true,
        sql: parsed.sql,
        params: parsed.params || [],
        intent: parsed.intent,
        explanation: parsed.explanation,
        tables: parsed.tables || []
      };

    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }
}
```

### System Prompt

```typescript
private buildSystemPrompt(): string {
  return `You are a SQL query generator for an API gateway metrics system.
You convert natural language questions into PostgreSQL queries.

DATABASE SCHEMA:
----------------
Table: request_metrics
- timestamp (TIMESTAMPTZ): When the request occurred
- method (VARCHAR): HTTP method (GET, POST, etc.)
- path (VARCHAR): Request path/endpoint
- status_code (INTEGER): HTTP response status
- duration_ms (REAL): Response time in milliseconds
- backend (VARCHAR): Backend service name
- client_ip (VARCHAR): Client IP address
- error_message (TEXT): Error details if failed

Table: rate_limit_metrics
- timestamp (TIMESTAMPTZ): When rate limit was checked
- key (VARCHAR): Rate limit key
- allowed (BOOLEAN): Whether request was allowed
- remaining (INTEGER): Remaining quota
- limit_value (INTEGER): Total limit

Table: backend_metrics
- timestamp (TIMESTAMPTZ): Health check time
- backend_name (VARCHAR): Backend service name
- status (VARCHAR): 'healthy' or 'unhealthy'
- response_time_ms (REAL): Health check response time

RULES:
------
1. Always use parameterized queries ($1, $2, etc.)
2. Default time range to 1 hour if not specified
3. Use PostgreSQL syntax (e.g., PERCENTILE_CONT for percentiles)
4. Return only SELECT queries (no INSERT, UPDATE, DELETE)
5. Limit results to prevent huge responses (default LIMIT 100)

RESPONSE FORMAT:
----------------
Return a JSON object with:
{
  "sql": "SELECT ...",
  "params": ["param1", "param2"],
  "intent": "error_rate|latency|endpoints|traffic|rate_limits|backends",
  "explanation": "What this query does",
  "tables": ["request_metrics"]
}`;
}
```

### User Prompt

```typescript
private buildUserPrompt(question: string, context?: QueryContext): string {
  let prompt = `Question: ${question}\n\n`;

  if (context) {
    if (context.timeRange) {
      prompt += `Time range: ${context.timeRange}\n`;
    }
    if (context.backend) {
      prompt += `Backend: ${context.backend}\n`;
    }
    if (context.endpoint) {
      prompt += `Endpoint: ${context.endpoint}\n`;
    }
  }

  prompt += '\nGenerate the SQL query as JSON.';
  return prompt;
}
```

---

## 🔒 Query Validator

### `src/nl-query/validator.ts`

Validates generated SQL to prevent injection and ensure safety:

```typescript
export class QueryValidator {
  private config: QueryValidationConfig;
  private dangerousPatterns: RegExp[];

  constructor(config: QueryValidationConfig) {
    this.config = config;
    this.dangerousPatterns = [
      /\bDROP\b/i,
      /\bDELETE\b/i,
      /\bINSERT\b/i,
      /\bUPDATE\b/i,
      /\bTRUNCATE\b/i,
      /\bALTER\b/i,
      /\bCREATE\b/i,
      /\bGRANT\b/i,
      /\bREVOKE\b/i,
      /\bEXECUTE\b/i,
      /;\s*\w/,  // Multiple statements
    ];
  }

  validate(sql: string): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Check for dangerous patterns
    for (const pattern of this.dangerousPatterns) {
      if (pattern.test(sql)) {
        errors.push(`Dangerous SQL pattern detected: ${pattern.source}`);
      }
    }

    // Must be a SELECT query
    if (!sql.trim().toUpperCase().startsWith('SELECT')) {
      errors.push('Only SELECT queries are allowed');
    }

    // Check allowed tables
    const tables = this.extractTables(sql);
    const allowedTables = ['request_metrics', 'rate_limit_metrics', 'backend_metrics'];

    for (const table of tables) {
      if (!allowedTables.includes(table)) {
        errors.push(`Table not allowed: ${table}`);
      }
    }

    // Warn if no LIMIT clause
    if (!/\bLIMIT\b/i.test(sql)) {
      warnings.push('Query has no LIMIT clause, results may be large');
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
      sanitizedSql: this.sanitize(sql)
    };
  }

  private extractTables(sql: string): string[] {
    const tables: string[] = [];
    const fromMatch = sql.match(/\bFROM\s+(\w+)/gi);
    const joinMatch = sql.match(/\bJOIN\s+(\w+)/gi);

    if (fromMatch) {
      tables.push(...fromMatch.map(m => m.replace(/FROM\s+/i, '')));
    }
    if (joinMatch) {
      tables.push(...joinMatch.map(m => m.replace(/JOIN\s+/i, '')));
    }

    return tables;
  }

  private sanitize(sql: string): string {
    // Remove comments
    let sanitized = sql.replace(/--.*$/gm, '');
    sanitized = sanitized.replace(/\/\*[\s\S]*?\*\//g, '');

    // Normalize whitespace
    sanitized = sanitized.replace(/\s+/g, ' ').trim();

    return sanitized;
  }
}
```

---

## 📊 Query Execution

```typescript
async executeQuery(sql: string, params: unknown[]): Promise<QueryResult> {
  const db = getPostgresClient();
  const startTime = Date.now();

  try {
    const rows = await db.query<Record<string, unknown>>(sql, params);
    const executionTimeMs = Date.now() - startTime;

    return {
      rows,
      columns: rows.length > 0 ? Object.keys(rows[0]) : [],
      totalCount: rows.length,
      executionTimeMs
    };

  } catch (error) {
    throw new Error(`Query execution failed: ${error}`);
  }
}
```

---

## 💬 Answer Generation

Convert query results to human-readable answers:

```typescript
generateAnswer(
  question: string,
  sql: SQLGenerationResult,
  result?: QueryResult
): string {
  if (!result || result.rows.length === 0) {
    return 'No data found for your query.';
  }

  // Generate answer based on query intent
  switch (sql.intent) {
    case 'error_rate':
      return this.summarizeMetrics(result.rows);

    case 'latency':
      return this.summarizeLatency(result.rows);

    case 'endpoints':
      return this.summarizeEndpoints(result.rows);

    case 'traffic':
      return this.summarizeTraffic(result.rows);

    case 'aggregation':
      return this.summarizeAggregation(result.rows);

    default:
      return `Found ${result.rows.length} results.`;
  }
}

private summarizeLatency(rows: Record<string, unknown>[]): string {
  if (rows.length === 1) {
    const row = rows[0];
    const p50 = row.p50 || row.avg_latency;
    const p95 = row.p95;
    const p99 = row.p99;

    let summary = `Average latency is ${Number(p50).toFixed(1)}ms`;
    if (p95) summary += `, P95 is ${Number(p95).toFixed(1)}ms`;
    if (p99) summary += `, P99 is ${Number(p99).toFixed(1)}ms`;

    return summary + '.';
  }

  return `Found ${rows.length} latency data points.`;
}
```

---

## 📈 Visualization Type Selection

```typescript
determineVisualization(
  intent: QueryIntent,
  result?: QueryResult
): VisualizationType {
  if (!result || result.rows.length === 0) {
    return 'text';
  }

  // Single value result
  if (result.rows.length === 1 && result.columns.length === 1) {
    return 'number';
  }

  // Time series data
  if (this.hasTimeColumn(result.columns)) {
    return 'line_chart';
  }

  // Intent-based selection
  switch (intent) {
    case 'error_rate':
    case 'latency':
      return result.rows.length > 5 ? 'line_chart' : 'bar_chart';

    case 'endpoints':
      return 'bar_chart';

    case 'traffic':
      return 'line_chart';

    default:
      return 'table';
  }
}

private hasTimeColumn(columns: string[]): boolean {
  const timeColumns = ['timestamp', 'bucket', 'time', 'date'];
  return columns.some(c => timeColumns.includes(c.toLowerCase()));
}
```

---

## 💡 Follow-Up Suggestions

```typescript
generateSuggestions(intent: QueryIntent): string[] {
  const suggestions: Record<QueryIntent, string[]> = {
    error_rate: [
      'What endpoints have the highest error rate?',
      'Show me error trends over the last hour',
      'What are the most common error status codes?'
    ],
    latency: [
      'Which endpoints are the slowest?',
      'How has latency changed over time?',
      'What is the P99 latency by backend?'
    ],
    endpoints: [
      'Which endpoint has the most traffic?',
      'Show me endpoint performance comparison',
      'What are the busiest endpoints today?'
    ],
    traffic: [
      'What was the peak traffic time?',
      'How many requests per second currently?',
      'Compare traffic between backends'
    ],
    rate_limits: [
      'How many requests were rate limited?',
      'Which IPs hit rate limits most?',
      'Show rate limit trends'
    ],
    backends: [
      'Are all backends healthy?',
      'Which backend has the most failures?',
      'Show backend response times'
    ]
  };

  return suggestions[intent] || [
    'What is the current error rate?',
    'Show me the slowest endpoints',
    'How many requests per second?'
  ];
}
```

---

## 💬 Chat Sessions

Support for conversational queries with context:

```typescript
createSession(): ChatSession {
  const session: ChatSession = {
    id: uuidv4(),
    messages: [],
    context: {},
    createdAt: new Date(),
    lastActivityAt: new Date()
  };

  this.sessions.set(session.id, session);
  return session;
}

async chat(sessionId: string, question: string): Promise<NLQueryResponse> {
  const session = this.sessions.get(sessionId);
  if (!session) {
    throw new Error('Session not found');
  }

  // Add user message
  this.addMessage(sessionId, {
    role: 'user',
    content: question
  });

  // Build context from previous messages
  const context = this.buildContextFromHistory(session);

  // Process query with context
  const response = await this.query({
    question,
    context,
    sessionId
  });

  // Add assistant response
  this.addMessage(sessionId, {
    role: 'assistant',
    content: response.answer || response.error || 'No response',
    metadata: {
      sql: response.sql?.sql,
      visualizationType: response.visualizationType,
      result: response.result
    }
  });

  return response;
}
```

---

## 🔌 API Endpoint

### `src/api/routes/nl-query.ts`

```typescript
const router = Router();

// Process a query
router.post('/query', async (req, res) => {
  const { question, context } = req.body;

  if (!question) {
    return res.status(400).json({
      success: false,
      error: 'Question is required'
    });
  }

  const response = await nlQueryService.query({ question, context });
  res.json(response);
});

// Create chat session
router.post('/session', (req, res) => {
  const session = nlQueryService.createSession();
  res.json({
    success: true,
    data: {
      sessionId: session.id
    }
  });
});

// Chat in session
router.post('/chat/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  const { question } = req.body;

  const response = await nlQueryService.chat(sessionId, question);
  res.json(response);
});

// Get suggestions
router.get('/suggestions', (req, res) => {
  res.json({
    success: true,
    data: [
      { name: 'Error Analysis', queries: [
        'What is the current error rate?',
        'Which endpoints have the most errors?'
      ]},
      { name: 'Performance', queries: [
        'What is the average latency?',
        'Show me the slowest endpoints'
      ]},
      { name: 'Traffic', queries: [
        'How many requests per second?',
        'What are the busiest endpoints?'
      ]}
    ]
  });
});

// Check service status
router.get('/status', (req, res) => {
  res.json({
    success: true,
    data: {
      configured: nlQueryService.isConfigured(),
      status: nlQueryService.isConfigured() ? 'ready' : 'unconfigured'
    }
  });
});
```

---

## 🎨 Example Queries

| Question | Generated SQL |
|----------|---------------|
| "What's the error rate?" | `SELECT COUNT(*) FILTER (WHERE status_code >= 400)::float / COUNT(*) * 100 as error_rate FROM request_metrics WHERE timestamp > NOW() - INTERVAL '1 hour'` |
| "Show slowest endpoints" | `SELECT path, AVG(duration_ms) as avg_latency FROM request_metrics WHERE timestamp > NOW() - INTERVAL '1 hour' GROUP BY path ORDER BY avg_latency DESC LIMIT 10` |
| "How many 429s today?" | `SELECT COUNT(*) as rate_limited_count FROM request_metrics WHERE status_code = 429 AND timestamp > CURRENT_DATE` |

---

## 🚀 Next Steps

Now that you understand NL queries:
1. [ML Service](./09-ml-service.md) - Anomaly detection and optimization
2. [Frontend Dashboard](./10-frontend.md) - See NL queries in action
