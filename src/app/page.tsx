'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import NLQueryChat from '../components/NLQueryChat';
import RecommendationsPanel from '../components/RecommendationsPanel';

// =============================================================================
// Types
// =============================================================================

interface DashboardOverview {
  timestamp: string;
  requestsPerSecond: number;
  avgLatency: number;
  p95Latency: number;
  p99Latency: number;
  errorRate: number;
  activeConnections: number;
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  rateLimitedRequests: number;
  cachedResponses: number;
  uptime: number;
  healthyBackends: number;
  totalBackends: number;
}

interface TimeSeriesPoint {
  timestamp: string;
  value: number;
}

interface LatencyPoint {
  bucket: string;
  p50: number;
  p95: number;
  p99: number;
  avg: number;
}

interface StatusDistribution {
  bucket: string;
  status2xx: number;
  status3xx: number;
  status4xx: number;
  status5xx: number;
}

interface TopEndpoint {
  endpoint: string;
  method: string;
  requestCount: number;
  avgLatency: number;
  errorRate: number;
}

interface Alert {
  id: string;
  ruleName: string;
  severity: 'info' | 'warning' | 'critical';
  status: 'active' | 'acknowledged' | 'resolved';
  message: string;
  triggeredAt: string;
}

// Health Check Types
type HealthStatus = 'healthy' | 'unhealthy' | 'degraded' | 'unknown';
type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

interface BackendStatus {
  name: string;
  url: string;
  health: {
    status: HealthStatus;
    lastCheck: string | null;
    lastError: string | null;
    responseTimeMs: number | null;
    consecutiveFailures: number;
  } | null;
  circuitBreaker: {
    state: CircuitState;
    stats: {
      consecutiveFailures: number;
      openCount: number;
      lastStateChange: number;
    };
  };
  isAvailable: boolean;
}

interface BackendsResponse {
  summary: {
    total: number;
    available: number;
    healthy: number;
    unhealthy: number;
    circuitOpen: number;
  };
  backends: BackendStatus[];
}

type TimeRange = '5m' | '15m' | '1h' | '6h' | '24h';
type ConnectionStatus = 'connected' | 'connecting' | 'disconnected';

// =============================================================================
// API Helper
// =============================================================================

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8080';

async function fetchApi<T>(endpoint: string): Promise<T | null> {
  try {
    const res = await fetch(`${API_BASE}${endpoint}`);
    if (!res.ok) return null;
    const json = await res.json();
    return json.data || json;
  } catch {
    return null;
  }
}

// =============================================================================
// Icons (inline SVG)
// =============================================================================

const Icons = {
  Activity: () => (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="w-5 h-5"
    >
      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
    </svg>
  ),
  Clock: () => (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="w-5 h-5"
    >
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  ),
  AlertTriangle: () => (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="w-5 h-5"
    >
      <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </svg>
  ),
  Users: () => (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="w-5 h-5"
    >
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  ),
  Server: () => (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="w-5 h-5"
    >
      <rect width="20" height="8" x="2" y="2" rx="2" ry="2" />
      <rect width="20" height="8" x="2" y="14" rx="2" ry="2" />
      <line x1="6" x2="6.01" y1="6" y2="6" />
      <line x1="6" x2="6.01" y1="18" y2="18" />
    </svg>
  ),
  Bell: () => (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="w-5 h-5"
    >
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </svg>
  ),
  RefreshCw: () => (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="w-4 h-4"
    >
      <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
      <path d="M8 16H3v5" />
    </svg>
  ),
  TrendingUp: () => (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="w-4 h-4"
    >
      <polyline points="22 7 13.5 15.5 8.5 10.5 2 17" />
      <polyline points="16 7 22 7 22 13" />
    </svg>
  ),
  TrendingDown: () => (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="w-4 h-4"
    >
      <polyline points="22 17 13.5 8.5 8.5 13.5 2 7" />
      <polyline points="16 17 22 17 22 11" />
    </svg>
  ),
  Shield: () => (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="w-6 h-6"
    >
      <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
    </svg>
  ),
  Zap: () => (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="w-5 h-5"
    >
      <path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z" />
    </svg>
  ),
  Check: () => (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="w-4 h-4"
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
  ),
  X: () => (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="w-4 h-4"
    >
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  ),
};

// =============================================================================
// Custom Chart Components
// =============================================================================

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
  if (!data || data.length < 2) {
    return (
      <div className="h-10 flex items-center justify-center text-gray-600 text-sm">No data</div>
    );
  }

  const width = 200;
  const padding = 2;
  const max = Math.max(...data) || 1;
  const min = Math.min(...data);
  const range = max - min || 1;

  const points = data.map((value, i) => {
    const x = padding + (i / (data.length - 1)) * (width - padding * 2);
    const y = height - padding - ((value - min) / range) * (height - padding * 2);
    return `${x},${y}`;
  });

  const linePath = `M ${points.join(' L ')}`;
  const areaPath = `${linePath} L ${width - padding},${height - padding} L ${padding},${height - padding} Z`;

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full" style={{ height }}>
      {showArea && <path d={areaPath} fill={`${color}20`} />}
      <path
        d={linePath}
        fill="none"
        stroke={color}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle
        cx={points[points.length - 1].split(',')[0]}
        cy={points[points.length - 1].split(',')[1]}
        r="3"
        fill={color}
      />
    </svg>
  );
}

function AreaChart({
  data,
  height = 200,
  series,
}: {
  data: { label: string; values: Record<string, number> }[];
  height?: number;
  series: { key: string; color: string; label: string }[];
}) {
  if (!data || data.length < 2) {
    return (
      <div className="flex items-center justify-center text-gray-500" style={{ height }}>
        No data available
      </div>
    );
  }

  const width = 600;
  const padding = { top: 20, right: 20, bottom: 30, left: 50 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;

  // Find max value across all series
  let maxValue = 0;
  data.forEach((point) => {
    series.forEach((s) => {
      maxValue = Math.max(maxValue, point.values[s.key] || 0);
    });
  });
  maxValue = maxValue || 1;

  // Generate paths for each series
  const paths = series.map((s) => {
    const points = data.map((point, i) => {
      const x = padding.left + (i / (data.length - 1)) * chartWidth;
      const y = padding.top + chartHeight - ((point.values[s.key] || 0) / maxValue) * chartHeight;
      return { x, y };
    });

    const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x},${p.y}`).join(' ');
    const areaPath = `${linePath} L ${points[points.length - 1].x},${padding.top + chartHeight} L ${points[0].x},${padding.top + chartHeight} Z`;

    return { key: s.key, color: s.color, linePath, areaPath };
  });

  // Y-axis labels
  const yLabels = [0, maxValue * 0.5, maxValue].map((v, i) => ({
    value: v,
    y: padding.top + chartHeight - (v / maxValue) * chartHeight,
  }));

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full"
        preserveAspectRatio="xMidYMid meet"
      >
        {/* Grid lines */}
        {yLabels.map((label, i) => (
          <g key={i}>
            <line
              x1={padding.left}
              y1={label.y}
              x2={width - padding.right}
              y2={label.y}
              stroke="#1e3a5f"
              strokeDasharray="4 4"
              opacity="0.5"
            />
            <text
              x={padding.left - 8}
              y={label.y + 4}
              textAnchor="end"
              className="fill-cyan-700 text-xs font-mono"
            >
              {label.value.toFixed(0)}
            </text>
          </g>
        ))}

        {/* Areas and lines */}
        {paths.map((path, idx) => (
          <g key={path.key}>
            <path
              d={path.areaPath}
              fill={`${path.color}12`}
              className="transition-opacity duration-500"
              style={{ animationDelay: `${idx * 100}ms` }}
            />
            <path
              d={path.linePath}
              fill="none"
              stroke={path.color}
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </g>
        ))}

        {/* X-axis labels */}
        {data
          .filter((_, i) => i % Math.ceil(data.length / 5) === 0)
          .map((point, i, arr) => {
            const x = padding.left + (data.indexOf(point) / (data.length - 1)) * chartWidth;
            return (
              <text
                key={i}
                x={x}
                y={height - 8}
                textAnchor="middle"
                className="fill-gray-600 text-xs font-mono"
              >
                {point.label}
              </text>
            );
          })}
      </svg>

      {/* Legend */}
      <div className="flex gap-4 justify-center mt-2">
        {series.map((s) => (
          <div key={s.key} className="flex items-center gap-1.5">
            <div className="w-3 h-3 rounded" style={{ backgroundColor: s.color }} />
            <span className="text-xs text-gray-500 font-mono">{s.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function BarChart({
  data,
  height = 200,
}: {
  data: { label: string; value: number; color: string }[];
  height?: number;
}) {
  if (!data || data.length === 0) {
    return (
      <div className="flex items-center justify-center text-cyan-700 font-mono" style={{ height }}>
        <span className="opacity-50">[NO DATA]</span>
      </div>
    );
  }

  const max = Math.max(...data.map((d) => d.value)) || 1;

  return (
    <div className="flex items-end gap-2 justify-around" style={{ height }}>
      {data.map((item, i) => (
        <div key={i} className="flex flex-col items-center gap-1 flex-1 group">
          <div className="w-full flex flex-col items-center">
            <span className="text-xs text-cyan-400 mb-1 font-mono opacity-0 group-hover:opacity-100 transition-opacity">
              {item.value}
            </span>
            <div
              className="w-full max-w-[40px] rounded-t transition-all duration-300 hover:opacity-80"
              style={{
                height: `${(item.value / max) * (height - 40)}px`,
                backgroundColor: item.color,
                minHeight: item.value > 0 ? '4px' : '0',
              }}
            />
          </div>
          <span className="text-xs text-cyan-600 truncate max-w-full font-mono">{item.label}</span>
        </div>
      ))}
    </div>
  );
}

function DonutChart({
  data,
  size = 120,
}: {
  data: { label: string; value: number; color: string }[];
  size?: number;
}) {
  const total = data.reduce((sum, d) => sum + d.value, 0) || 1;
  const strokeWidth = 20;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;

  let currentOffset = 0;

  return (
    <div className="flex items-center gap-4">
      <svg width={size} height={size} className="transform -rotate-90">
        {/* Background ring */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="#0a1628"
          strokeWidth={strokeWidth}
        />
        {/* Data segments */}
        {data.map((item, i) => {
          const percentage = item.value / total;
          const strokeDasharray = `${circumference * percentage} ${circumference}`;
          const strokeDashoffset = -currentOffset;
          currentOffset += circumference * percentage;

          return (
            <circle
              key={i}
              cx={size / 2}
              cy={size / 2}
              r={radius}
              fill="none"
              stroke={item.color}
              strokeWidth={strokeWidth}
              strokeDasharray={strokeDasharray}
              strokeDashoffset={strokeDashoffset}
              strokeLinecap="round"
              className="transition-all duration-500"
              style={{
                animationDelay: `${i * 150}ms`
              }}
            />
          );
        })}
      </svg>
      <div className="flex flex-col gap-1.5">
        {data.map((item, i) => (
          <div key={i} className="flex items-center gap-2">
            <div
              className="w-3 h-3 rounded"
              style={{ backgroundColor: item.color }}
            />
            <span className="text-sm text-cyan-600 font-mono">{item.label}</span>
            <span className="text-sm font-medium text-cyan-300 ml-auto font-mono">{item.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// =============================================================================
// UI Components
// =============================================================================

function StatCard({
  label,
  value,
  unit,
  icon: Icon,
  trend,
  trendValue,
  color = 'blue',
  sparklineData,
}: {
  label: string;
  value: string | number;
  unit?: string;
  icon: React.FC;
  trend?: 'up' | 'down' | 'neutral';
  trendValue?: string;
  color?: 'blue' | 'green' | 'yellow' | 'red' | 'purple';
  sparklineData?: number[];
}) {
  const colors = {
    blue: { bg: 'bg-cyan-500/10', text: 'text-cyan-400', border: 'border-cyan-500/30', glow: 'shadow-cyan-500/10' },
    green: { bg: 'bg-emerald-500/10', text: 'text-emerald-400', border: 'border-emerald-500/30', glow: 'shadow-emerald-500/10' },
    yellow: { bg: 'bg-amber-500/10', text: 'text-amber-400', border: 'border-amber-500/30', glow: 'shadow-amber-500/10' },
    red: { bg: 'bg-red-500/10', text: 'text-red-400', border: 'border-red-500/30', glow: 'shadow-red-500/10' },
    purple: { bg: 'bg-purple-500/10', text: 'text-purple-400', border: 'border-purple-500/30', glow: 'shadow-purple-500/10' },
  };

  const c = colors[color];

  return (
    <div className={`card-glow p-4 border ${c.border} hover-lift transition-all animate-fade-in-up`}>
      <div className="flex items-start justify-between mb-3">
        <div className={`p-2 rounded-lg ${c.bg} ${c.glow} shadow-lg`}>
          <span className={c.text}>
            <Icon />
          </span>
        </div>
        {trend && trendValue && (
          <div
            className={`flex items-center gap-1 text-xs font-mono ${trend === 'up' ? 'text-emerald-400' : trend === 'down' ? 'text-red-400' : 'text-gray-400'}`}
          >
            {trend === 'up' ? (
              <Icons.TrendingUp />
            ) : trend === 'down' ? (
              <Icons.TrendingDown />
            ) : null}
            {trendValue}
          </div>
        )}
      </div>
      <div className="space-y-1">
        <p className="text-sm text-gray-500 font-mono">{label}</p>
        <p className="text-2xl font-bold tabular-nums font-mono animate-count">
          {value}
          {unit && <span className="text-sm font-normal text-gray-600 ml-1">{unit}</span>}
        </p>
      </div>
      {sparklineData && sparklineData.length > 0 && (
        <div className="mt-3 -mx-1">
          <SparklineChart
            data={sparklineData}
            color={c.text.replace('text-', '#').replace('-400', '')}
            height={32}
          />
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: 'healthy' | 'degraded' | 'down' | 'unknown' }) {
  const styles = {
    healthy: 'bg-emerald-500/20 text-emerald-400',
    degraded: 'bg-amber-500/20 text-amber-400',
    down: 'bg-red-500/20 text-red-400',
    unknown: 'bg-gray-500/20 text-gray-400',
  };

  return (
    <span className={`badge ${styles[status]}`}>
      <span
        className={`w-1.5 h-1.5 rounded-full mr-1.5 ${status === 'healthy' ? 'bg-emerald-400' : status === 'degraded' ? 'bg-amber-400' : status === 'down' ? 'bg-red-400' : 'bg-gray-400'}`}
      />
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </span>
  );
}

function ConnectionIndicator({ status }: { status: ConnectionStatus }) {
  const config = {
    connected: { color: 'bg-emerald-500', label: 'Connected', pulse: false },
    connecting: { color: 'bg-amber-500', label: 'Connecting', pulse: true },
    disconnected: { color: 'bg-red-500', label: 'Disconnected', pulse: false },
  };

  const c = config[status];

  return (
    <div className="flex items-center gap-2">
      <div className="relative">
        <div className={`w-2 h-2 rounded-full ${c.color}`} />
        {c.pulse && (
          <div className={`absolute inset-0 w-2 h-2 rounded-full ${c.color} animate-ping`} />
        )}
      </div>
      <span className="text-sm text-gray-400">{c.label}</span>
    </div>
  );
}

// =============================================================================
// Main Dashboard Component
// =============================================================================

export default function Dashboard() {
  const [overview, setOverview] = useState<DashboardOverview | null>(null);
  const [latencyData, setLatencyData] = useState<LatencyPoint[]>([]);
  const [statusData, setStatusData] = useState<StatusDistribution[]>([]);
  const [topEndpoints, setTopEndpoints] = useState<TopEndpoint[]>([]);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [backendsData, setBackendsData] = useState<BackendsResponse | null>(null);
  const [timeRange, setTimeRange] = useState<TimeRange>('1h');
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('disconnected');
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [loading, setLoading] = useState(true);
  const [isChatOpen, setIsChatOpen] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout>();

  // Fetch data
  const fetchData = useCallback(async () => {
    const [overviewRes, latencyRes, statusRes, endpointsRes, alertsRes, backendsRes] = await Promise.all([
      fetchApi<DashboardOverview>(`/api/metrics/overview?range=${timeRange}`),
      fetchApi<LatencyPoint[]>(`/api/metrics/latency?range=${timeRange}`),
      fetchApi<StatusDistribution[]>(`/api/metrics/status?range=${timeRange}`),
      fetchApi<TopEndpoint[]>(`/api/metrics/endpoints/top?range=${timeRange}&limit=5`),
      fetchApi<Alert[]>('/api/alerts/active'),
      fetchApi<BackendsResponse>('/api/health/backends'),
    ]);

    if (overviewRes) setOverview(overviewRes);
    if (latencyRes) setLatencyData(latencyRes);
    if (statusRes) setStatusData(statusRes);
    if (endpointsRes) setTopEndpoints(endpointsRes);
    if (alertsRes) setAlerts(alertsRes);
    if (backendsRes) setBackendsData(backendsRes);

    setLastUpdated(new Date());
    setLoading(false);
  }, [timeRange]);

  // WebSocket connection
  const connectWebSocket = useCallback(() => {
    const wsUrl = process.env.NEXT_PUBLIC_WS_URL || 'ws://localhost:8080/ws/metrics';

    setConnectionStatus('connecting');

    try {
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        setConnectionStatus('connected');
        ws.send(JSON.stringify({ type: 'subscribe', data: { type: 'overview' } }));
      };

      ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          if (message.type === 'metrics' && message.data?.type === 'overview') {
            setOverview(message.data.data);
            setLastUpdated(new Date());
          }
        } catch {
          // Ignore parse errors
        }
      };

      ws.onclose = () => {
        setConnectionStatus('disconnected');
        reconnectTimeoutRef.current = setTimeout(connectWebSocket, 5000);
      };

      ws.onerror = () => {
        setConnectionStatus('disconnected');
      };
    } catch {
      setConnectionStatus('disconnected');
    }
  }, []);

  useEffect(() => {
    fetchData();
    connectWebSocket();

    const interval = setInterval(fetchData, 30000);

    return () => {
      clearInterval(interval);
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, [fetchData, connectWebSocket]);

  // Format helpers
  const formatNumber = (n: number | string | null | undefined, decimals = 0) => {
    const num = typeof n === 'string' ? parseFloat(n) : n;
    if (num == null || isNaN(num)) return '0';
    if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
    if (num >= 1000) return `${(num / 1000).toFixed(1)}K`;
    return num.toFixed(decimals);
  };

  const formatLatency = (ms: number | string | null | undefined) => {
    const num = typeof ms === 'string' ? parseFloat(ms) : ms;
    if (num == null || isNaN(num)) return '0ms';
    if (num >= 1000) return `${(num / 1000).toFixed(2)}s`;
    return `${Math.round(num)}ms`;
  };

  const formatTime = (date: Date) => {
    return date.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  };

  // Prepare chart data
  const latencyChartData = latencyData.map((point) => ({
    label: new Date(point.bucket).toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
    }),
    values: { p50: point.p50, p95: point.p95, p99: point.p99 },
  }));

  const statusChartData =
    statusData.length > 0
      ? [
          {
            label: '2xx',
            value: statusData.reduce((sum, d) => sum + d.status2xx, 0),
            color: '#10b981',
          },
          {
            label: '3xx',
            value: statusData.reduce((sum, d) => sum + d.status3xx, 0),
            color: '#3b82f6',
          },
          {
            label: '4xx',
            value: statusData.reduce((sum, d) => sum + d.status4xx, 0),
            color: '#f59e0b',
          },
          {
            label: '5xx',
            value: statusData.reduce((sum, d) => sum + d.status5xx, 0),
            color: '#ef4444',
          },
        ]
      : [];

  return (
    <div className="min-h-screen bg-[#0a0f1a] grid-bg">
      {/* Header */}
      <header className="sticky top-0 z-50 bg-[#0a0f1a]/95 backdrop-blur border-b border-cyan-900/30">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-16">
            {/* Logo */}
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-cyan-500/20 border border-cyan-500/30">
                <svg viewBox="0 0 24 24" fill="none" className="w-6 h-6">
                  <circle cx="12" cy="12" r="10" stroke="#22d3ee" strokeWidth="1.5" />
                  <circle cx="12" cy="12" r="6" stroke="#22d3ee" strokeWidth="1.5" />
                  <circle cx="12" cy="12" r="2" fill="#22d3ee" />
                  <line x1="12" y1="2" x2="12" y2="6" stroke="#22d3ee" strokeWidth="1.5" />
                  <line x1="12" y1="18" x2="12" y2="22" stroke="#22d3ee" strokeWidth="1.5" />
                  <line x1="2" y1="12" x2="6" y2="12" stroke="#22d3ee" strokeWidth="1.5" />
                  <line x1="18" y1="12" x2="22" y2="12" stroke="#22d3ee" strokeWidth="1.5" />
                </svg>
              </div>
              <div>
                <h1 className="text-xl font-bold text-white font-mono tracking-wider">AEGIS</h1>
                <p className="text-xs text-cyan-600 font-mono">API Gateway</p>
              </div>
            </div>

            {/* Controls */}
            <div className="flex items-center gap-4">
              {/* Alerts Button */}
              <a
                href="/alerts"
                className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-400 hover:text-amber-300 hover:bg-amber-500/20 transition-all relative"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
                  <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
                  <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
                </svg>
                <span className="text-sm font-medium font-mono">Alerts</span>
                {overview && overview.rateLimitedRequests > 0 && (
                  <span className="absolute -top-1 -right-1 w-2 h-2 bg-amber-500 rounded-full animate-pulse" />
                )}
              </a>

              {/* AI Assistant Button */}
              <button
                onClick={() => setIsChatOpen(true)}
                className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-purple-500/10 border border-purple-500/30 text-purple-400 hover:text-purple-300 hover:bg-purple-500/20 transition-all"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
                  <path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z" />
                </svg>
                <span className="text-sm font-medium font-mono">Ask AI</span>
              </button>

              {/* Time Range */}
              <select
                value={timeRange}
                onChange={(e) => setTimeRange(e.target.value as TimeRange)}
                className="bg-gray-900/80 border border-cyan-800/50 rounded-lg px-3 py-1.5 text-sm text-cyan-300 focus:border-cyan-500 outline-none font-mono cursor-pointer hover:border-cyan-600 transition-colors"
              >
                <option value="5m">Last 5 minutes</option>
                <option value="15m">Last 15 minutes</option>
                <option value="1h">Last 1 hour</option>
                <option value="6h">Last 6 hours</option>
                <option value="24h">Last 24 hours</option>
              </select>

              {/* Refresh */}
              <button
                onClick={fetchData}
                className="p-2 rounded-lg bg-gray-800/50 hover:bg-gray-700 text-cyan-400 hover:text-cyan-300 transition-all border border-gray-700/50 hover:border-cyan-700/50"
              >
                <Icons.RefreshCw />
              </button>

              {/* Connection Status */}
              <ConnectionIndicator status={connectionStatus} />

              {/* Last Updated */}
              {lastUpdated && (
                <span className="text-xs text-gray-500 font-mono">Updated {formatTime(lastUpdated)}</span>
              )}
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
        {loading ? (
          <div className="space-y-6">
            {/* Stats Skeleton */}
            <div className="mb-6">
              <div className="flex items-center justify-between mb-3">
                <div className="skeleton h-4 w-32" />
                <div className="skeleton h-6 w-16 rounded-md" />
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                {[1, 2, 3, 4].map((i) => (
                  <div key={i} className="card p-4">
                    <div className="flex items-start justify-between mb-3">
                      <div className="skeleton h-10 w-10 rounded-lg" />
                      <div className="skeleton h-4 w-12" />
                    </div>
                    <div className="skeleton h-4 w-24 mb-2" />
                    <div className="skeleton h-8 w-32" />
                  </div>
                ))}
              </div>
            </div>

            {/* Charts Skeleton */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
              <div className="card-glow p-6">
                <div className="flex items-center gap-2 mb-4">
                  <div className="skeleton h-5 w-5 rounded" />
                  <div className="skeleton h-5 w-36" />
                </div>
                <div className="skeleton h-4 w-40 mb-4" />
                <div className="skeleton h-[200px] w-full rounded-lg" />
              </div>
              <div className="card-glow p-6">
                <div className="flex items-center gap-2 mb-4">
                  <div className="skeleton h-5 w-5 rounded" />
                  <div className="skeleton h-5 w-28" />
                </div>
                <div className="skeleton h-4 w-40 mb-4" />
                <div className="flex items-center gap-8">
                  <div className="skeleton h-[120px] w-[120px] rounded-full" />
                  <div className="space-y-3 flex-1">
                    {[1, 2, 3, 4].map((i) => (
                      <div key={i} className="flex items-center gap-2">
                        <div className="skeleton h-3 w-3 rounded" />
                        <div className="skeleton h-3 w-16" />
                        <div className="skeleton h-3 w-8 ml-auto" />
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            {/* Tables Skeleton */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              <div className="lg:col-span-2 card-glow p-6">
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center gap-2">
                    <div className="skeleton h-5 w-5 rounded" />
                    <div className="skeleton h-5 w-32" />
                  </div>
                  <div className="skeleton h-6 w-16 rounded-md" />
                </div>
                <div className="space-y-3">
                  {[1, 2, 3, 4, 5].map((i) => (
                    <div key={i} className="flex items-center gap-4 py-2">
                      <div className="skeleton h-5 w-12 rounded" />
                      <div className="skeleton h-4 w-40 flex-1" />
                      <div className="skeleton h-4 w-12" />
                      <div className="skeleton h-4 w-12" />
                      <div className="skeleton h-4 w-12" />
                    </div>
                  ))}
                </div>
              </div>
              <div className="card-glow p-6">
                <div className="flex items-center gap-2 mb-4">
                  <div className="skeleton h-5 w-5 rounded" />
                  <div className="skeleton h-5 w-28" />
                </div>
                <div className="space-y-4">
                  {[1, 2, 3, 4, 5].map((i) => (
                    <div key={i} className="flex items-center justify-between py-2">
                      <div className="skeleton h-4 w-28" />
                      <div className="skeleton h-4 w-16" />
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        ) : (
          <>
            {/* Alerts Banner */}
            {alerts.length > 0 && (
              <div className="mb-6 p-4 bg-red-500/10 border border-red-500/20 rounded-xl">
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-lg bg-red-500/20">
                    <span className="text-red-400">
                      <Icons.AlertTriangle />
                    </span>
                  </div>
                  <div className="flex-1">
                    <p className="font-medium text-red-400">
                      {alerts.length} Active Alert{alerts.length > 1 ? 's' : ''}
                    </p>
                    <p className="text-sm text-red-300/70">{alerts[0]?.message}</p>
                  </div>
                  <button className="btn btn-sm bg-red-500/20 text-red-400 hover:bg-red-500/30">
                    View All
                  </button>
                </div>
              </div>
            )}

            {/* Stats Grid */}
            <div className="mb-6">
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-sm font-mono text-gray-500 uppercase tracking-wider flex items-center gap-2">
                  <span className="text-cyan-500">▸</span> System Overview
                </h2>
                <div className="time-badge">
                  {timeRange === '5m' ? '5 min' : timeRange === '15m' ? '15 min' : timeRange === '1h' ? '1 hour' : timeRange === '6h' ? '6 hours' : '24 hours'}
                </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                <StatCard
                  label="Requests / sec"
                  value={formatNumber(overview?.requestsPerSecond || 0, 1)}
                  icon={Icons.Activity}
                  color="blue"
                  trend="up"
                  trendValue="+12%"
                />
                <StatCard
                  label="Avg Latency"
                  value={formatLatency(overview?.avgLatency || 0)}
                  icon={Icons.Clock}
                  color="green"
                  trend="down"
                  trendValue="-5%"
                />
                <StatCard
                  label="Error Rate"
                  value={`${(overview?.errorRate || 0).toFixed(2)}%`}
                  icon={Icons.AlertTriangle}
                  color={overview?.errorRate && overview.errorRate > 5 ? 'red' : 'yellow'}
                  trend="neutral"
                />
                <StatCard
                  label="Active Connections"
                  value={formatNumber(overview?.activeConnections || 0)}
                  icon={Icons.Users}
                  color="purple"
                />
              </div>
            </div>

            {/* Charts Row */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
              {/* Latency Chart */}
              <div className="card-glow p-5 hover-lift transition-all">
                <h3 className="text-lg font-semibold mb-1 flex items-center gap-2 font-mono">
                  <span className="text-green-400">
                    <Icons.Clock />
                  </span>
                  Response Latency
                </h3>
                <p className="text-xs text-gray-500 mb-4 font-mono">
                  <span className="text-cyan-600">⏱</span> Showing data for {timeRange === '5m' ? 'last 5 minutes' : timeRange === '15m' ? 'last 15 minutes' : timeRange === '1h' ? 'last hour' : timeRange === '6h' ? 'last 6 hours' : 'last 24 hours'}
                </p>
                <AreaChart
                  data={latencyChartData}
                  height={220}
                  series={[
                    { key: 'p50', color: '#10b981', label: 'P50' },
                    { key: 'p95', color: '#f59e0b', label: 'P95' },
                    { key: 'p99', color: '#ef4444', label: 'P99' },
                  ]}
                />
              </div>

              {/* Status Distribution */}
              <div className="card-glow p-5 hover-lift transition-all">
                <h3 className="text-lg font-semibold mb-1 flex items-center gap-2 font-mono">
                  <span className="text-blue-400">
                    <Icons.Server />
                  </span>
                  Status Codes
                </h3>
                <p className="text-xs text-gray-500 mb-4 font-mono">
                  <span className="text-cyan-600">⏱</span> Showing data for {timeRange === '5m' ? 'last 5 minutes' : timeRange === '15m' ? 'last 15 minutes' : timeRange === '1h' ? 'last hour' : timeRange === '6h' ? 'last 6 hours' : 'last 24 hours'}
                </p>
                <div className="flex items-center justify-center h-[220px]">
                  {statusChartData.length > 0 ? (
                    <DonutChart data={statusChartData} size={160} />
                  ) : (
                    <span className="text-gray-500 font-mono">No data available</span>
                  )}
                </div>
              </div>
            </div>

            {/* Bottom Row */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              {/* Top Endpoints */}
              <div className="lg:col-span-2 card-glow p-5 hover-lift transition-all">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-lg font-semibold flex items-center gap-2 font-mono">
                    <span className="text-purple-400">
                      <Icons.Zap />
                    </span>
                    Top Endpoints
                  </h3>
                  <div className="time-badge">
                    {timeRange === '5m' ? '5 min' : timeRange === '15m' ? '15 min' : timeRange === '1h' ? '1 hour' : timeRange === '6h' ? '6 hours' : '24 hours'}
                  </div>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead>
                      <tr className="text-left text-sm text-cyan-600 border-b border-cyan-900/30 font-mono">
                        <th className="pb-3 font-medium">Endpoint</th>
                        <th className="pb-3 font-medium text-right">Requests</th>
                        <th className="pb-3 font-medium text-right">Latency</th>
                        <th className="pb-3 font-medium text-right">Error Rate</th>
                      </tr>
                    </thead>
                    <tbody>
                      {topEndpoints.length > 0 ? (
                        topEndpoints.map((endpoint, i) => (
                          <tr key={i} className="table-row animate-fade-in-up" style={{ animationDelay: `${i * 50}ms` }}>
                            <td className="py-3">
                              <div className="flex items-center gap-2">
                                <span
                                  className={`px-1.5 py-0.5 rounded text-xs font-mono font-medium ${
                                    endpoint.method === 'GET'
                                      ? 'bg-cyan-500/20 text-cyan-400 border border-cyan-500/30'
                                      : endpoint.method === 'POST'
                                        ? 'bg-green-500/20 text-green-400 border border-green-500/30'
                                        : endpoint.method === 'PUT'
                                          ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30'
                                          : endpoint.method === 'DELETE'
                                            ? 'bg-red-500/20 text-red-400 border border-red-500/30'
                                            : 'bg-gray-500/20 text-gray-400 border border-gray-500/30'
                                  }`}
                                >
                                  {endpoint.method}
                                </span>
                                <span className="font-mono text-sm text-gray-300 truncate max-w-[200px]">
                                  {endpoint.endpoint}
                                </span>
                              </div>
                            </td>
                            <td className="py-3 text-right font-mono text-sm text-cyan-300">
                              {formatNumber(endpoint.requestCount)}
                            </td>
                            <td className="py-3 text-right font-mono text-sm text-gray-300">
                              {formatLatency(endpoint.avgLatency)}
                            </td>
                            <td className="py-3 text-right">
                              <span
                                className={`font-mono text-sm ${endpoint.errorRate > 5 ? 'text-red-400' : endpoint.errorRate > 1 ? 'text-amber-400' : 'text-emerald-400'}`}
                              >
                                {endpoint.errorRate.toFixed(1)}%
                              </span>
                            </td>
                          </tr>
                        ))
                      ) : (
                        <tr>
                          <td colSpan={4} className="py-8 text-center text-gray-500 font-mono">
                            No endpoint data available
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* System Health */}
              <div className="card-glow p-5 hover-lift transition-all">
                <h3 className="text-lg font-semibold mb-4 flex items-center gap-2 font-mono">
                  <span className="text-emerald-400">
                    <Icons.Server />
                  </span>
                  System Health
                </h3>
                <div className="space-y-3">
                  <div className="flex items-center justify-between p-3 bg-gray-800/30 rounded-lg border border-gray-700/50 hover:border-cyan-800/50 transition-colors">
                    <span className="text-gray-400 font-mono text-sm">Gateway Status</span>
                    <StatusBadge
                      status={overview != null && overview.errorRate < 5 ? 'healthy' : 'degraded'}
                    />
                  </div>
                  <div className="flex items-center justify-between p-3 bg-gray-800/30 rounded-lg border border-gray-700/50 hover:border-cyan-800/50 transition-colors">
                    <span className="text-gray-400 font-mono text-sm">Backends</span>
                    <span className="text-sm font-mono">
                      <span className="text-emerald-400">{overview?.healthyBackends || 0}</span>
                      <span className="text-gray-600"> / </span>
                      <span className="text-gray-400">{overview?.totalBackends || 0}</span>
                    </span>
                  </div>
                  <div className="flex items-center justify-between p-3 bg-gray-800/30 rounded-lg border border-gray-700/50 hover:border-cyan-800/50 transition-colors">
                    <span className="text-gray-400 font-mono text-sm">Uptime</span>
                    <span className="text-sm text-cyan-300 font-mono">
                      {overview?.uptime ? `${(overview.uptime / 3600).toFixed(1)}h` : '—'}
                    </span>
                  </div>
                  <div className="flex items-center justify-between p-3 bg-gray-800/30 rounded-lg border border-gray-700/50 hover:border-cyan-800/50 transition-colors">
                    <span className="text-gray-400 font-mono text-sm">Cache Hit Rate</span>
                    <span className="text-sm text-cyan-300 font-mono">
                      {overview?.totalRequests && overview?.cachedResponses
                        ? `${((overview.cachedResponses / overview.totalRequests) * 100).toFixed(1)}%`
                        : '—'}
                    </span>
                  </div>
                  <div className="flex items-center justify-between p-3 bg-gray-800/30 rounded-lg border border-gray-700/50 hover:border-cyan-800/50 transition-colors">
                    <span className="text-gray-400 font-mono text-sm">Rate Limited</span>
                    <span className="text-sm text-amber-400 font-mono">
                      {formatNumber(overview?.rateLimitedRequests || 0)}
                    </span>
                  </div>
                </div>

                {/* Backend Services with Circuit Breakers */}
                {backendsData && backendsData.length > 0 && (
                  <div className="mt-4 pt-4 border-t border-gray-700/50">
                    <h4 className="text-sm font-semibold text-gray-400 mb-3 font-mono flex items-center gap-2">
                      <span className="text-cyan-400">⚡</span>
                      Backend Services & Circuit Breakers
                    </h4>
                    <div className="space-y-2">
                      {backendsData.map((backend) => (
                        <div
                          key={backend.name}
                          className="p-3 bg-gray-800/40 rounded-lg border border-gray-700/50 hover:border-cyan-800/50 transition-colors"
                        >
                          <div className="flex items-center justify-between mb-2">
                            <span className="font-mono text-sm text-gray-300">{backend.name}</span>
                            <StatusBadge
                              status={
                                backend.status === 'healthy'
                                  ? 'healthy'
                                  : backend.status === 'unhealthy'
                                    ? 'critical'
                                    : 'degraded'
                              }
                            />
                          </div>
                          <div className="flex items-center justify-between text-xs">
                            <div className="flex items-center gap-2">
                              <span className="text-gray-500">Circuit:</span>
                              <span
                                className={`font-mono px-2 py-0.5 rounded ${
                                  backend.circuitBreaker?.state === 'CLOSED'
                                    ? 'bg-emerald-900/30 text-emerald-400 border border-emerald-700/50'
                                    : backend.circuitBreaker?.state === 'OPEN'
                                      ? 'bg-red-900/30 text-red-400 border border-red-700/50'
                                      : 'bg-amber-900/30 text-amber-400 border border-amber-700/50'
                                }`}
                              >
                                {backend.circuitBreaker?.state || 'CLOSED'}
                              </span>
                            </div>
                            {backend.responseTime !== undefined && (
                              <span className="text-gray-500 font-mono">
                                {backend.responseTime}ms
                              </span>
                            )}
                          </div>
                          {backend.circuitBreaker?.state === 'OPEN' &&
                            backend.circuitBreaker.nextAttempt && (
                              <div className="mt-2 text-xs text-gray-500 font-mono">
                                Recovery in:{' '}
                                {Math.max(
                                  0,
                                  Math.ceil(
                                    (new Date(backend.circuitBreaker.nextAttempt).getTime() -
                                      Date.now()) /
                                      1000
                                  )
                                )}
                                s
                              </div>
                            )}
                          {backend.lastError && (
                            <div className="mt-2 text-xs text-red-400/70 font-mono truncate">
                              {backend.lastError}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* AI Recommendations Row */}
            <div className="mt-6">
              <RecommendationsPanel />
            </div>
          </>
        )}
      </main>

      {/* NL Query Chat Modal */}
      <NLQueryChat isOpen={isChatOpen} onClose={() => setIsChatOpen(false)} />

      {/* Footer */}
      <footer className="border-t border-gray-800 mt-8">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
          <div className="flex items-center justify-between text-sm text-gray-500">
            <span>AEGIS API Gateway Dashboard</span>
            <span>v1.0.0</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
