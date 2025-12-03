'use client';

import { useState, useRef, useEffect, useCallback } from 'react';

// =============================================================================
// Types
// =============================================================================

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  metadata?: {
    sql?: string;
    visualizationType?: string;
    result?: {
      rows: Record<string, unknown>[];
      columns: string[];
      totalCount: number;
      executionTimeMs: number;
    };
  };
}

interface QuerySuggestion {
  name: string;
  queries: string[];
}

// =============================================================================
// Icons
// =============================================================================

const Icons = {
  Send: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
      <path d="m22 2-7 20-4-9-9-4Z" />
      <path d="M22 2 11 13" />
    </svg>
  ),
  Bot: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
      <path d="M12 8V4H8" />
      <rect width="16" height="12" x="4" y="8" rx="2" />
      <path d="M2 14h2" />
      <path d="M20 14h2" />
      <path d="M15 13v2" />
      <path d="M9 13v2" />
    </svg>
  ),
  User: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
      <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </svg>
  ),
  Sparkles: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
      <path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z" />
      <path d="M5 3v4" />
      <path d="M19 17v4" />
      <path d="M3 5h4" />
      <path d="M17 19h4" />
    </svg>
  ),
  Code: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
      <polyline points="16 18 22 12 16 6" />
      <polyline points="8 6 2 12 8 18" />
    </svg>
  ),
  X: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  ),
  Loader: () => (
    <svg className="animate-spin w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="10" strokeOpacity="0.25" />
      <path d="M12 2a10 10 0 0 1 10 10" strokeLinecap="round" />
    </svg>
  ),
};

// =============================================================================
// API Helper
// =============================================================================

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8080';

interface QueryResult {
  rows: Record<string, unknown>[];
  columns: string[];
  totalCount: number;
  executionTimeMs: number;
}

async function sendQuery(question: string): Promise<{
  success: boolean;
  data?: {
    answer: string;
    sql?: { sql: string };
    result?: QueryResult;
    visualizationType?: string;
    metadata?: { suggestions?: string[] };
  };
  error?: string;
}> {
  try {
    const res = await fetch(`${API_BASE}/api/nl-query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question }),
    });
    return await res.json();
  } catch (error) {
    return { success: false, error: 'Failed to connect to server' };
  }
}

async function getServiceStatus(): Promise<{ configured: boolean; status: string }> {
  try {
    const res = await fetch(`${API_BASE}/api/nl-query/status`);
    const json = await res.json();
    return json.data || { configured: false, status: 'unknown' };
  } catch {
    return { configured: false, status: 'unavailable' };
  }
}

async function getSuggestions(): Promise<QuerySuggestion[]> {
  try {
    const res = await fetch(`${API_BASE}/api/nl-query/suggestions`);
    const json = await res.json();
    return json.data?.categories || [];
  } catch {
    return [];
  }
}

// =============================================================================
// Chat Component
// =============================================================================

interface NLQueryChatProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function NLQueryChat({ isOpen, onClose }: NLQueryChatProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [suggestions, setSuggestions] = useState<QuerySuggestion[]>([]);
  const [serviceStatus, setServiceStatus] = useState<{ configured: boolean; status: string } | null>(null);
  const [showSql, setShowSql] = useState<string | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Check service status on mount
  useEffect(() => {
    if (isOpen) {
      getServiceStatus().then(setServiceStatus);
      getSuggestions().then(setSuggestions);
    }
  }, [isOpen]);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Focus input when opened
  useEffect(() => {
    if (isOpen) {
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [isOpen]);

  const handleSubmit = useCallback(async (question: string) => {
    if (!question.trim() || isLoading) return;

    const userMessage: ChatMessage = {
      id: Date.now().toString(),
      role: 'user',
      content: question.trim(),
      timestamp: new Date().toISOString(),
    };

    setMessages((prev) => [...prev, userMessage]);
    setInput('');
    setIsLoading(true);

    try {
      const response = await sendQuery(question);

      const assistantMessage: ChatMessage = {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: response.success
          ? response.data?.answer || 'Query completed successfully.'
          : response.error || 'An error occurred.',
        timestamp: new Date().toISOString(),
        metadata: response.success ? {
          sql: response.data?.sql?.sql,
          result: response.data?.result,
          visualizationType: response.data?.visualizationType,
        } : undefined,
      };

      setMessages((prev) => [...prev, assistantMessage]);
    } catch {
      setMessages((prev) => [...prev, {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: 'Sorry, I encountered an error processing your request.',
        timestamp: new Date().toISOString(),
      }]);
    } finally {
      setIsLoading(false);
    }
  }, [isLoading]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(input);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-2xl h-[600px] bg-[#0a0f1a] border border-cyan-900/50 rounded-xl shadow-2xl flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-cyan-900/30 bg-[#060a12]">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-cyan-500/10 border border-cyan-500/30">
              <span className="text-cyan-400"><Icons.Sparkles /></span>
            </div>
            <div>
              <h2 className="font-semibold text-cyan-100 font-mono tracking-wide">ANALYTICS_ASSISTANT</h2>
              <p className="text-xs text-cyan-700 font-mono">&gt; Query metrics in natural language</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-lg hover:bg-cyan-900/30 text-cyan-600 hover:text-cyan-300 transition-colors border border-transparent hover:border-cyan-800"
          >
            <Icons.X />
          </button>
        </div>

        {/* Messages Area */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* Service Status Warning */}
          {serviceStatus && !serviceStatus.configured && (
            <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-3 text-sm text-amber-300 font-mono">
              <strong>[WARN]</strong> OpenAI API key not configured. NL queries unavailable.
            </div>
          )}

          {/* Empty State */}
          {messages.length === 0 && (
            <div className="space-y-4">
              <div className="text-center py-6">
                <div className="inline-flex p-3 rounded-lg bg-cyan-500/10 border border-cyan-500/30 mb-3">
                  <span className="text-cyan-400"><Icons.Bot /></span>
                </div>
                <h3 className="text-lg font-medium text-cyan-100 font-mono mb-1">READY_FOR_QUERY</h3>
                <p className="text-sm text-cyan-700 font-mono">&gt; Ask me anything about your API metrics</p>
              </div>

              {/* Suggestions */}
              {suggestions.length > 0 && (
                <div className="space-y-3">
                  {suggestions.map((category) => (
                    <div key={category.name}>
                      <p className="text-xs text-cyan-700 mb-2 font-mono">[{category.name.toUpperCase()}]</p>
                      <div className="flex flex-wrap gap-2">
                        {category.queries.map((query) => (
                          <button
                            key={query}
                            onClick={() => handleSubmit(query)}
                            className="px-3 py-1.5 text-sm bg-cyan-900/20 hover:bg-cyan-900/40 text-cyan-300 rounded-lg transition-colors border border-cyan-800/30 hover:border-cyan-600/50 font-mono"
                          >
                            {query}
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Messages */}
          {messages.map((message) => (
            <div
              key={message.id}
              className={`flex gap-3 ${message.role === 'user' ? 'justify-end' : ''}`}
            >
              {message.role === 'assistant' && (
                <div className="flex-shrink-0 w-8 h-8 rounded-lg bg-cyan-500/20 border border-cyan-500/30 flex items-center justify-center">
                  <span className="text-cyan-400"><Icons.Bot /></span>
                </div>
              )}
              <div
                className={`max-w-[80%] rounded-lg px-4 py-2 ${
                  message.role === 'user'
                    ? 'bg-purple-600/80 text-white border border-purple-500/30'
                    : 'bg-cyan-900/20 text-cyan-100 border border-cyan-800/30'
                }`}
              >
                <p className="text-sm whitespace-pre-wrap font-mono">{message.content}</p>

                {/* SQL Preview */}
                {message.metadata?.sql && (
                  <div className="mt-2 pt-2 border-t border-cyan-800/30">
                    <button
                      onClick={() => setShowSql(showSql === message.id ? null : message.id)}
                      className="flex items-center gap-1 text-xs text-cyan-600 hover:text-cyan-300 font-mono"
                    >
                      <Icons.Code />
                      {showSql === message.id ? '[HIDE_SQL]' : '[VIEW_SQL]'}
                    </button>
                    {showSql === message.id && (
                      <pre className="mt-2 p-2 bg-[#060a12] rounded border border-cyan-900/30 text-xs text-cyan-400 overflow-x-auto font-mono">
                        {message.metadata.sql}
                      </pre>
                    )}
                  </div>
                )}

                {/* Result Table Preview */}
                {message.metadata?.result && message.metadata.result.rows.length > 0 && (
                  <div className="mt-2 pt-2 border-t border-cyan-800/30">
                    <p className="text-xs text-cyan-600 mb-2 font-mono">
                      [{message.metadata.result.totalCount} rows] [{message.metadata.result.executionTimeMs}ms]
                    </p>
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs font-mono">
                        <thead>
                          <tr className="text-cyan-500 border-b border-cyan-800/30">
                            {message.metadata.result.columns.slice(0, 4).map((col) => (
                              <th key={col} className="text-left px-2 py-1 font-medium">{col}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {message.metadata.result.rows.slice(0, 5).map((row, i) => (
                            <tr key={i} className="border-t border-cyan-900/20 hover:bg-cyan-900/10">
                              {message.metadata!.result!.columns.slice(0, 4).map((col) => (
                                <td key={col} className="px-2 py-1 text-cyan-300">
                                  {String(row[col] ?? '-')}
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>
              {message.role === 'user' && (
                <div className="flex-shrink-0 w-8 h-8 rounded-lg bg-purple-600/80 border border-purple-500/30 flex items-center justify-center">
                  <span className="text-white"><Icons.User /></span>
                </div>
              )}
            </div>
          ))}

          {/* Loading */}
          {isLoading && (
            <div className="flex gap-3">
              <div className="flex-shrink-0 w-8 h-8 rounded-lg bg-cyan-500/20 border border-cyan-500/30 flex items-center justify-center">
                <span className="text-cyan-400"><Icons.Bot /></span>
              </div>
              <div className="bg-cyan-900/20 border border-cyan-800/30 rounded-lg px-4 py-2">
                <span className="text-cyan-400"><Icons.Loader /></span>
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* Input Area */}
        <div className="border-t border-cyan-900/30 p-4 bg-[#060a12]">
          <div className="flex gap-2">
            <input
              ref={inputRef}
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="> Enter query..."
              disabled={isLoading || (serviceStatus !== null && !serviceStatus.configured)}
              className="flex-1 bg-[#0a0f1a] border border-cyan-900/50 rounded-lg px-4 py-2 text-cyan-100 placeholder-cyan-800 focus:outline-none focus:border-cyan-600 disabled:opacity-50 font-mono transition-colors"
            />
            <button
              onClick={() => handleSubmit(input)}
              disabled={isLoading || !input.trim() || (serviceStatus !== null && !serviceStatus.configured)}
              className="px-4 py-2 bg-cyan-600 hover:bg-cyan-500 disabled:bg-gray-800 disabled:cursor-not-allowed text-white rounded-lg transition-colors"
            >
              {isLoading ? <Icons.Loader /> : <Icons.Send />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
