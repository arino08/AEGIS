# 10. Frontend Dashboard

## Overview

AEGIS includes a real-time monitoring dashboard built with Next.js 15 and React 19. The dashboard provides live metrics visualization, backend health monitoring, and natural language query capabilities.

---

## 📁 Frontend Structure

```
frontend/
├── src/
│   ├── app/                    # Next.js App Router
│   │   ├── layout.tsx          # Root layout
│   │   ├── page.tsx            # Main dashboard page
│   │   ├── globals.css         # Global styles
│   │   └── alerts/
│   │       └── page.tsx        # Alerts page
│   ├── components/             # React components
│   │   ├── NLQueryChat.tsx     # Natural language chat
│   │   └── RecommendationsPanel.tsx
│   ├── lib/                    # Utilities
│   │   ├── api.ts              # API client
│   │   └── utils.ts            # Helper functions
│   └── types/                  # TypeScript types
│       └── index.ts
├── public/                     # Static assets
├── tailwind.config.js          # Tailwind configuration
├── next.config.js              # Next.js configuration
└── package.json
```

---

## 🎨 Main Dashboard

### `frontend/src/app/page.tsx`

The main dashboard page with all monitoring components:

```tsx
'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import NLQueryChat from '../components/NLQueryChat';
import RecommendationsPanel from '../components/RecommendationsPanel';

// API base URL from environment
const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8080';

export default function Dashboard() {
  // State for all dashboard data
  const [overview, setOverview] = useState<DashboardOverview | null>(null);
  const [requestRate, setRequestRate] = useState<TimeSeriesPoint[]>([]);
  const [latencyData, setLatencyData] = useState<LatencyPoint[]>([]);
  const [statusDist, setStatusDist] = useState<StatusDistribution[]>([]);
  const [topEndpoints, setTopEndpoints] = useState<TopEndpoint[]>([]);
  const [backends, setBackends] = useState<BackendsResponse | null>(null);
  const [alerts, setAlerts] = useState<Alert[]>([]);

  // UI state
  const [timeRange, setTimeRange] = useState<TimeRange>('1h');
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('disconnected');
  const [showNLQuery, setShowNLQuery] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);

  // WebSocket ref
  const wsRef = useRef<WebSocket | null>(null);

  // ... component implementation
}
```

### Data Fetching

```tsx
// Fetch all dashboard data
const fetchData = useCallback(async () => {
  try {
    const [
      overviewData,
      requestRateData,
      latencyData,
      statusData,
      endpointsData,
      backendsData,
      alertsData
    ] = await Promise.all([
      fetchApi<DashboardOverview>(`/api/metrics/overview?range=${timeRange}`),
      fetchApi<TimeSeriesPoint[]>(`/api/metrics/request-rate?range=${timeRange}`),
      fetchApi<LatencyPoint[]>(`/api/metrics/latency?range=${timeRange}`),
      fetchApi<StatusDistribution[]>(`/api/metrics/status-distribution?range=${timeRange}`),
      fetchApi<TopEndpoint[]>(`/api/metrics/top-endpoints?range=${timeRange}`),
      fetchApi<BackendsResponse>('/api/health/backends'),
      fetchApi<Alert[]>('/api/alerts?status=active')
    ]);

    if (overviewData) setOverview(overviewData);
    if (requestRateData) setRequestRate(requestRateData);
    if (latencyData) setLatencyData(latencyData);
    if (statusData) setStatusDist(statusData);
    if (endpointsData) setTopEndpoints(endpointsData);
    if (backendsData) setBackends(backendsData);
    if (alertsData) setAlerts(alertsData);
  } catch (error) {
    console.error('Failed to fetch data:', error);
  }
}, [timeRange]);

// Set up polling
useEffect(() => {
  fetchData();

  if (autoRefresh) {
    const interval = setInterval(fetchData, 5000);
    return () => clearInterval(interval);
  }
}, [fetchData, autoRefresh]);
```

### WebSocket Connection

```tsx
// Connect to real-time WebSocket
const connectWebSocket = useCallback(() => {
  const ws = new WebSocket(`ws://localhost:8080/ws/metrics`);

  ws.onopen = () => {
    setConnectionStatus('connected');

    // Subscribe to metrics
    ws.send(JSON.stringify({
      type: 'subscribe',
      data: {
        overview: true,
        requestRate: true,
        alerts: true
      }
    }));
  };

  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);

    switch (message.type) {
      case 'metrics':
        if (message.data.overview) {
          setOverview(message.data.overview);
        }
        if (message.data.requestRate) {
          setRequestRate(message.data.requestRate);
        }
        break;

      case 'alert':
        setAlerts(prev => [message.data, ...prev]);
        break;
    }
  };

  ws.onclose = () => {
    setConnectionStatus('disconnected');
    // Reconnect after delay
    setTimeout(connectWebSocket, 3000);
  };

  ws.onerror = () => {
    setConnectionStatus('error');
  };

  wsRef.current = ws;
}, []);

useEffect(() => {
  connectWebSocket();
  return () => wsRef.current?.close();
}, [connectWebSocket]);
```

---

## 📊 Custom Chart Components

### Sparkline Chart

Small inline charts for stat cards:

```tsx
function SparklineChart({
  data,
  color = '#3b82f6',
  height = 40,
  showArea = true,
}: {
  data: number[];
  color?: string;
  height?: number;
  showArea?: boolean;
}) {
  if (data.length === 0) return null;

  const max = Math.max(...data);
  const min = Math.min(...data);
  const range = max - min || 1;

  // Generate SVG path
  const points = data.map((value, i) => {
    const x = (i / (data.length - 1)) * 100;
    const y = height - ((value - min) / range) * height;
    return `${x},${y}`;
  });

  const linePath = `M ${points.join(' L ')}`;
  const areaPath = `${linePath} L 100,${height} L 0,${height} Z`;

  return (
    <svg
      viewBox={`0 0 100 ${height}`}
      className="w-full"
      preserveAspectRatio="none"
    >
      {showArea && (
        <path
          d={areaPath}
          fill={color}
          fillOpacity="0.1"
        />
      )}
      <path
        d={linePath}
        fill="none"
        stroke={color}
        strokeWidth="2"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
```

### Area Chart

For time-series data with multiple series:

```tsx
function AreaChart({
  data,
  height = 200,
  series,
}: {
  data: { label: string; values: Record<string, number> }[];
  height?: number;
  series: { key: string; color: string; label: string }[];
}) {
  const width = 600;
  const padding = { top: 20, right: 20, bottom: 40, left: 60 };

  // Calculate scales
  const maxValue = Math.max(
    ...data.flatMap(d => series.map(s => d.values[s.key] || 0))
  );

  const xScale = (i: number) =>
    padding.left + (i / (data.length - 1)) * (width - padding.left - padding.right);

  const yScale = (v: number) =>
    height - padding.bottom - (v / maxValue) * (height - padding.top - padding.bottom);

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full">
      {/* Grid lines */}
      {[0, 0.25, 0.5, 0.75, 1].map(ratio => (
        <g key={ratio}>
          <line
            x1={padding.left}
            x2={width - padding.right}
            y1={yScale(maxValue * ratio)}
            y2={yScale(maxValue * ratio)}
            stroke="#374151"
            strokeDasharray="4"
          />
          <text
            x={padding.left - 10}
            y={yScale(maxValue * ratio)}
            textAnchor="end"
            fill="#9ca3af"
            fontSize="12"
          >
            {formatNumber(maxValue * ratio)}
          </text>
        </g>
      ))}

      {/* Series */}
      {series.map(s => {
        const points = data.map((d, i) => ({
          x: xScale(i),
          y: yScale(d.values[s.key] || 0)
        }));

        const linePath = points
          .map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x},${p.y}`)
          .join(' ');

        const areaPath = `${linePath} L ${points[points.length - 1].x},${height - padding.bottom} L ${points[0].x},${height - padding.bottom} Z`;

        return (
          <g key={s.key}>
            <path d={areaPath} fill={s.color} fillOpacity="0.2" />
            <path d={linePath} fill="none" stroke={s.color} strokeWidth="2" />
          </g>
        );
      })}

      {/* X-axis labels */}
      {data.filter((_, i) => i % Math.ceil(data.length / 6) === 0).map((d, i) => (
        <text
          key={i}
          x={xScale(i * Math.ceil(data.length / 6))}
          y={height - 10}
          textAnchor="middle"
          fill="#9ca3af"
          fontSize="11"
        >
          {d.label}
        </text>
      ))}
    </svg>
  );
}
```

---

## 🎴 Stat Cards

Overview statistics with sparklines:

```tsx
function StatCard({
  title,
  value,
  unit,
  trend,
  trendValue,
  sparklineData,
  icon: Icon,
}: StatCardProps) {
  return (
    <div className="bg-gray-800 rounded-xl p-6 border border-gray-700">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-blue-500/20 rounded-lg">
            <Icon />
          </div>
          <span className="text-gray-400 text-sm">{title}</span>
        </div>

        {trend && (
          <div className={`flex items-center gap-1 text-sm ${
            trend === 'up' ? 'text-green-400' : 'text-red-400'
          }`}>
            {trend === 'up' ? <Icons.TrendingUp /> : <Icons.TrendingDown />}
            <span>{trendValue}</span>
          </div>
        )}
      </div>

      <div className="flex items-end justify-between">
        <div>
          <span className="text-3xl font-bold text-white">{value}</span>
          {unit && <span className="text-gray-400 ml-1">{unit}</span>}
        </div>

        {sparklineData && sparklineData.length > 0 && (
          <div className="w-24 h-10">
            <SparklineChart data={sparklineData} />
          </div>
        )}
      </div>
    </div>
  );
}
```

---

## 💬 NL Query Chat

### `frontend/src/components/NLQueryChat.tsx`

```tsx
export default function NLQueryChat({ isOpen, onClose }: NLQueryChatProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [suggestions, setSuggestions] = useState<QuerySuggestion[]>([]);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Fetch suggestions on mount
  useEffect(() => {
    getSuggestions().then(setSuggestions);
  }, []);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSubmit = async (question: string) => {
    if (!question.trim() || isLoading) return;

    // Add user message
    const userMessage: ChatMessage = {
      id: Date.now().toString(),
      role: 'user',
      content: question,
      timestamp: new Date().toISOString()
    };
    setMessages(prev => [...prev, userMessage]);
    setInput('');
    setIsLoading(true);

    try {
      const response = await sendQuery(question);

      const assistantMessage: ChatMessage = {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: response.data?.answer || response.error || 'No response',
        timestamp: new Date().toISOString(),
        metadata: response.data ? {
          sql: response.data.sql?.sql,
          visualizationType: response.data.visualizationType,
          result: response.data.result
        } : undefined
      };

      setMessages(prev => [...prev, assistantMessage]);
    } catch (error) {
      const errorMessage: ChatMessage = {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: 'Sorry, there was an error processing your query.',
        timestamp: new Date().toISOString()
      };
      setMessages(prev => [...prev, errorMessage]);
    } finally {
      setIsLoading(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-y-0 right-0 w-96 bg-gray-900 border-l border-gray-700 flex flex-col z-50">
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b border-gray-700">
        <div className="flex items-center gap-2">
          <Icons.Sparkles />
          <h2 className="font-semibold">Ask AEGIS</h2>
        </div>
        <button onClick={onClose} className="p-1 hover:bg-gray-800 rounded">
          <Icons.X />
        </button>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.length === 0 && (
          <div className="text-center text-gray-400 py-8">
            <Icons.Sparkles className="w-12 h-12 mx-auto mb-4 opacity-50" />
            <p>Ask questions about your API metrics</p>
            <div className="mt-4 space-y-2">
              {suggestions.slice(0, 3).map((group, i) => (
                <div key={i}>
                  {group.queries.slice(0, 2).map((q, j) => (
                    <button
                      key={j}
                      onClick={() => handleSubmit(q)}
                      className="block w-full text-left p-2 text-sm text-blue-400 hover:bg-gray-800 rounded"
                    >
                      "{q}"
                    </button>
                  ))}
                </div>
              ))}
            </div>
          </div>
        )}

        {messages.map(message => (
          <ChatMessageBubble key={message.id} message={message} />
        ))}

        {isLoading && (
          <div className="flex items-center gap-2 text-gray-400">
            <Icons.Loader className="animate-spin" />
            <span>Thinking...</span>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="p-4 border-t border-gray-700">
        <div className="flex gap-2">
          <input
            type="text"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleSubmit(input)}
            placeholder="Ask about your metrics..."
            className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-4 py-2 focus:outline-none focus:border-blue-500"
          />
          <button
            onClick={() => handleSubmit(input)}
            disabled={isLoading || !input.trim()}
            className="p-2 bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50"
          >
            <Icons.Send />
          </button>
        </div>
      </div>
    </div>
  );
}
```

### Chat Message Bubble

```tsx
function ChatMessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === 'user';
  const [showSql, setShowSql] = useState(false);

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div className={`max-w-[85%] rounded-lg p-3 ${
        isUser
          ? 'bg-blue-600 text-white'
          : 'bg-gray-800 border border-gray-700'
      }`}>
        <p className="whitespace-pre-wrap">{message.content}</p>

        {/* Show result table if available */}
        {message.metadata?.result && (
          <div className="mt-3 overflow-x-auto">
            <ResultTable result={message.metadata.result} />
          </div>
        )}

        {/* Toggle SQL view */}
        {message.metadata?.sql && (
          <div className="mt-2">
            <button
              onClick={() => setShowSql(!showSql)}
              className="text-xs text-gray-400 hover:text-gray-300 flex items-center gap-1"
            >
              <Icons.Code />
              {showSql ? 'Hide SQL' : 'Show SQL'}
            </button>
            {showSql && (
              <pre className="mt-2 p-2 bg-gray-900 rounded text-xs text-gray-300 overflow-x-auto">
                {message.metadata.sql}
              </pre>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
```

---

## 🖥️ Backend Health Panel

```tsx
function BackendsPanel({ backends }: { backends: BackendsResponse }) {
  return (
    <div className="bg-gray-800 rounded-xl p-6 border border-gray-700">
      <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
        <Icons.Server />
        Backend Services
      </h3>

      {/* Summary */}
      <div className="flex gap-4 mb-4 text-sm">
        <span className="text-green-400">
          {backends.summary.healthy} Healthy
        </span>
        <span className="text-red-400">
          {backends.summary.unhealthy} Unhealthy
        </span>
        {backends.summary.circuitOpen > 0 && (
          <span className="text-yellow-400">
            {backends.summary.circuitOpen} Circuit Open
          </span>
        )}
      </div>

      {/* Backend list */}
      <div className="space-y-3">
        {backends.backends.map(backend => (
          <div
            key={backend.name}
            className="flex items-center justify-between p-3 bg-gray-700/50 rounded-lg"
          >
            <div className="flex items-center gap-3">
              <div className={`w-3 h-3 rounded-full ${
                backend.isAvailable ? 'bg-green-400' : 'bg-red-400'
              }`} />
              <div>
                <div className="font-medium">{backend.name}</div>
                <div className="text-xs text-gray-400">{backend.url}</div>
              </div>
            </div>

            <div className="text-right text-sm">
              <div className={getStatusColor(backend.health?.status)}>
                {backend.health?.status || 'Unknown'}
              </div>
              {backend.health?.responseTimeMs && (
                <div className="text-gray-400">
                  {backend.health.responseTimeMs.toFixed(0)}ms
                </div>
              )}
            </div>

            {/* Circuit breaker state */}
            <div className={`px-2 py-1 rounded text-xs ${
              backend.state === 'CLOSED' ? 'bg-green-500/20 text-green-400' :
              backend.state === 'OPEN' ? 'bg-red-500/20 text-red-400' :
              'bg-yellow-500/20 text-yellow-400'
            }`}>
              {backend.state}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
```

---

## 🎨 Tailwind Configuration

### `frontend/tailwind.config.js`

```javascript
/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        gray: {
          750: '#2d3748',
          850: '#1a202c',
          950: '#0d1117',
        },
      },
      animation: {
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
      },
    },
  },
  plugins: [],
};
```

---

## 🔧 Environment Configuration

### `frontend/.env.local`

```bash
# API Gateway URL
NEXT_PUBLIC_API_URL=http://localhost:8080

# WebSocket URL (optional, derived from API_URL)
NEXT_PUBLIC_WS_URL=ws://localhost:8080
```

---

## 🚀 Running the Frontend

```bash
# Development
cd frontend
npm install
npm run dev

# Production build
npm run build
npm start
```

Dashboard available at: `http://localhost:3100`

---

## 🚀 Next Steps

Now that you understand the frontend:
1. [Storage Layer](./11-storage.md) - PostgreSQL and Redis clients
2. [Configuration](./12-configuration.md) - Configuration system
