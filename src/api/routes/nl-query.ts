/**
 * AEGIS - NL Query API Routes
 *
 * REST API endpoints for natural language analytics queries.
 */

import { Router, Request, Response } from 'express';
import { getNLQueryService } from '../../nl-query/service.js';
import type { NLQueryRequest } from '../../nl-query/types.js';
import logger from '../../utils/logger.js';

// =============================================================================
// Types
// =============================================================================

type TimePreset = '5m' | '15m' | '1h' | '6h' | '24h' | '7d' | '30d';
const VALID_PRESETS: TimePreset[] = ['5m', '15m', '1h', '6h', '24h', '7d', '30d'];

interface QueryBody {
  question: string;
  timeRange?: {
    start?: string;
    end?: string;
    preset?: string;
  };
  limit?: number;
}

interface ChatBody {
  sessionId?: string;
  message: string;
}

// =============================================================================
// Router
// =============================================================================

const router = Router();

// =============================================================================
// Query Endpoint
// =============================================================================

/**
 * POST /api/nl-query
 *
 * Process a natural language query and return results.
 */
router.post('/', async (req: Request<object, object, QueryBody>, res: Response) => {
  try {
    const { question, timeRange, limit } = req.body;

    if (!question || typeof question !== 'string') {
      res.status(400).json({
        success: false,
        error: 'Question is required',
      });
      return;
    }

    const service = getNLQueryService();

    if (!service.isConfigured()) {
      res.status(503).json({
        success: false,
        error: 'Natural language query service is not configured',
        message: 'Please set OPENAI_API_KEY environment variable',
      });
      return;
    }

    // Validate and normalize preset if provided
    let validatedTimeRange: NLQueryRequest['timeRange'];
    if (timeRange) {
      validatedTimeRange = {
        start: timeRange.start,
        end: timeRange.end,
        preset: timeRange.preset && VALID_PRESETS.includes(timeRange.preset as TimePreset)
          ? (timeRange.preset as TimePreset)
          : undefined,
      };
    }

    const request: NLQueryRequest = {
      question: question.trim(),
      timeRange: validatedTimeRange,
      limit,
    };

    const response = await service.query(request);

    res.json({
      success: response.success,
      data: response,
    });
  } catch (error) {
    logger.error('NL query endpoint failed', {
      error: error instanceof Error ? error.message : String(error),
    });

    res.status(500).json({
      success: false,
      error: 'Failed to process query',
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

// =============================================================================
// Chat Endpoints
// =============================================================================

/**
 * POST /api/nl-query/chat
 *
 * Send a message in a chat session.
 */
router.post('/chat', async (req: Request<object, object, ChatBody>, res: Response) => {
  try {
    const { sessionId, message } = req.body;

    if (!message || typeof message !== 'string') {
      res.status(400).json({
        success: false,
        error: 'Message is required',
      });
      return;
    }

    const service = getNLQueryService();

    if (!service.isConfigured()) {
      res.status(503).json({
        success: false,
        error: 'Natural language query service is not configured',
      });
      return;
    }

    const response = await service.chat(sessionId || '', message.trim());

    res.json({
      success: response.success,
      data: response,
      sessionId: sessionId || service.getSession(sessionId || '')?.id,
    });
  } catch (error) {
    logger.error('Chat endpoint failed', {
      error: error instanceof Error ? error.message : String(error),
    });

    res.status(500).json({
      success: false,
      error: 'Failed to process message',
    });
  }
});

/**
 * POST /api/nl-query/chat/session
 *
 * Create a new chat session.
 */
router.post('/chat/session', (_req: Request, res: Response) => {
  try {
    const service = getNLQueryService();
    const session = service.createSession();

    res.json({
      success: true,
      data: {
        sessionId: session.id,
        createdAt: session.createdAt,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to create session',
    });
  }
});

/**
 * GET /api/nl-query/chat/session/:sessionId
 *
 * Get chat session history.
 */
router.get('/chat/session/:sessionId', (req: Request<{ sessionId: string }>, res: Response) => {
  try {
    const { sessionId } = req.params;
    const service = getNLQueryService();
    const session = service.getSession(sessionId);

    if (!session) {
      res.status(404).json({
        success: false,
        error: 'Session not found',
      });
      return;
    }

    res.json({
      success: true,
      data: session,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to get session',
    });
  }
});

// =============================================================================
// Status Endpoint
// =============================================================================

/**
 * GET /api/nl-query/status
 *
 * Check if the NL query service is configured and available.
 */
router.get('/status', (_req: Request, res: Response) => {
  try {
    const service = getNLQueryService();
    const configured = service.isConfigured();

    res.json({
      success: true,
      data: {
        configured,
        status: configured ? 'available' : 'not_configured',
        message: configured
          ? 'Natural language query service is ready'
          : 'OpenAI API key not configured',
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to check status',
    });
  }
});

// =============================================================================
// Suggestions Endpoint
// =============================================================================

/**
 * GET /api/nl-query/suggestions
 *
 * Get example queries to help users get started.
 */
router.get('/suggestions', (_req: Request, res: Response) => {
  res.json({
    success: true,
    data: {
      categories: [
        {
          name: 'Traffic Analysis',
          queries: [
            'What is the current request rate?',
            'Show me traffic for the last hour',
            'Which endpoints get the most traffic?',
          ],
        },
        {
          name: 'Error Analysis',
          queries: [
            'What is the current error rate?',
            'Which endpoints have the highest error rates?',
            'Show me 5xx errors in the last hour',
          ],
        },
        {
          name: 'Latency Analysis',
          queries: [
            'What is the average response time?',
            'Show P95 latency by endpoint',
            'Which endpoints are the slowest?',
          ],
        },
        {
          name: 'Rate Limiting',
          queries: [
            'How many requests were rate limited today?',
            'Which clients hit rate limits most often?',
            'Show rate limit events over time',
          ],
        },
      ],
    },
  });
});

// =============================================================================
// Export
// =============================================================================

export default router;
export { router as nlQueryRouter };
