'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';

// =============================================================================
// Types
// =============================================================================

interface Alert {
  id: string;
  ruleId: string;
  ruleName: string;
  severity: 'info' | 'warning' | 'critical';
  status: 'active' | 'acknowledged' | 'resolved' | 'muted';
  message: string;
  value: number;
  threshold: number;
  triggeredAt: string;
  acknowledgedAt?: string;
  acknowledgedBy?: string;
  resolvedAt?: string;
  mutedUntil?: string;
}

interface AlertRule {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  severity: 'info' | 'warning' | 'critical';
  condition: {
    metric: string;
    operator: string;
    threshold: number;
    window: string;
  };
  actions: { type: string; config: Record<string, unknown> }[];
  cooldown?: string;
  createdAt: string;
  updatedAt: string;
}

interface AlertHistoryEntry {
  id: string;
  alertId: string;
  action: string;
  timestamp: string;
  userId?: string;
  note?: string;
}

interface AlertStats {
  rulesCount: number;
  enabledRulesCount: number;
  activeAlertsCount: number;
  alertsByStatus: Record<string, number>;
  alertsBySeverity: Record<string, number>;
}

type TabType = 'alerts' | 'rules' | 'history';

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

async function postApi<T>(endpoint: string, body?: unknown): Promise<T | null> {
  try {
    const res = await fetch(`${API_BASE}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) return null;
    const json = await res.json();
    return json.data || json;
  } catch {
    return null;
  }
}

async function deleteApi(endpoint: string): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE}${endpoint}`, { method: 'DELETE' });
    return res.ok;
  } catch {
    return false;
  }
}

// =============================================================================
// Icons
// =============================================================================

const Icons = {
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
  Clock: () => (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="w-4 h-4"
    >
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  ),
  Plus: () => (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="w-5 h-5"
    >
      <path d="M5 12h14" />
      <path d="M12 5v14" />
    </svg>
  ),
  Trash: () => (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="w-4 h-4"
    >
      <path d="M3 6h18" />
      <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
      <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
    </svg>
  ),
  ArrowLeft: () => (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="w-5 h-5"
    >
      <path d="m12 19-7-7 7-7" />
      <path d="M19 12H5" />
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
  CheckCircle: () => (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="w-12 h-12"
    >
      <circle cx="12" cy="12" r="10" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  ),
};

// =============================================================================
// Utility Functions
// =============================================================================

function formatDate(dateString: string): string {
  return new Date(dateString).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatRelativeTime(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSecs = Math.floor(diffMs / 1000);
  const diffMins = Math.floor(diffSecs / 60);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffDays > 0) return `${diffDays}d ago`;
  if (diffHours > 0) return `${diffHours}h ago`;
  if (diffMins > 0) return `${diffMins}m ago`;
  return 'just now';
}

function getSeverityStyles(severity: string): { bg: string; text: string; border: string } {
  switch (severity) {
    case 'critical':
      return { bg: 'bg-red-500/20', text: 'text-red-400', border: 'border-red-500/30' };
    case 'warning':
      return { bg: 'bg-amber-500/20', text: 'text-amber-400', border: 'border-amber-500/30' };
    default:
      return { bg: 'bg-blue-500/20', text: 'text-blue-400', border: 'border-blue-500/30' };
  }
}

function getStatusStyles(status: string): { bg: string; text: string } {
  switch (status) {
    case 'active':
      return { bg: 'bg-red-500/20', text: 'text-red-400' };
    case 'acknowledged':
      return { bg: 'bg-amber-500/20', text: 'text-amber-400' };
    case 'muted':
      return { bg: 'bg-gray-500/20', text: 'text-gray-400' };
    case 'resolved':
      return { bg: 'bg-emerald-500/20', text: 'text-emerald-400' };
    default:
      return { bg: 'bg-gray-500/20', text: 'text-gray-400' };
  }
}

// =============================================================================
// Components
// =============================================================================

function StatCard({
  label,
  value,
  color,
}: {
  label: string;
  value: number | string;
  color: string;
}) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 hover-lift transition-all animate-fade-in-up">
      <p className="text-sm text-gray-400 mb-1 font-mono">{label}</p>
      <p className={`text-2xl font-bold ${color} font-mono animate-count`}>{value}</p>
    </div>
  );
}

function AlertCard({
  alert,
  onAcknowledge,
  onResolve,
  onMute,
}: {
  alert: Alert;
  onAcknowledge: (id: string) => void;
  onResolve: (id: string) => void;
  onMute: (id: string, duration: string) => void;
}) {
  const [showActions, setShowActions] = useState(false);
  const severity = getSeverityStyles(alert.severity);
  const status = getStatusStyles(alert.status);

  return (
    <div className={`bg-[#0d1525] border-l-4 ${severity.border} rounded-lg p-4 mb-3 hover:bg-[#111d2e] transition-all group animate-fade-in-up hover-lift`}>
      <div className="flex items-start justify-between">
        <div className="flex-1">
          <div className="flex items-center gap-2 mb-2">
            <span
              className={`px-2 py-0.5 rounded text-xs font-mono font-medium ${severity.bg} ${severity.text}`}
            >
              [{alert.severity.toUpperCase()}]
            </span>
            <span className={`px-2 py-0.5 rounded text-xs font-mono font-medium ${status.bg} ${status.text}`}>
              {alert.status.toUpperCase()}
            </span>
            <span className="text-xs text-cyan-700 flex items-center gap-1 font-mono">
              <Icons.Clock />
              {formatRelativeTime(alert.triggeredAt)}
            </span>
          </div>
          <h3 className="font-semibold text-cyan-100 mb-1 font-mono">{alert.ruleName}</h3>
          <p className="text-sm text-gray-500">{alert.message}</p>
          <div className="flex gap-4 mt-2 text-xs text-cyan-800 font-mono">
            <span>
              value: <span className="text-cyan-400">{alert.value.toFixed(2)}</span>
            </span>
            <span>
              threshold: <span className="text-cyan-400">{alert.threshold}</span>
            </span>
            {alert.acknowledgedBy && (
              <span>
                ack_by: <span className="text-cyan-400">{alert.acknowledgedBy}</span>
              </span>
            )}
          </div>
        </div>

        <div className="relative">
          <button
            onClick={() => setShowActions(!showActions)}
            className="px-3 py-1.5 text-sm bg-cyan-900/30 hover:bg-cyan-800/40 rounded-lg text-cyan-400 transition-colors border border-cyan-800/50 font-mono"
          >
            [actions]
          </button>

          {showActions && (
            <div className="absolute right-0 mt-2 w-40 bg-[#0d1525] border border-cyan-800/50 rounded-lg shadow-xl z-10 overflow-hidden">
              {alert.status === 'active' && (
                <button
                  onClick={() => {
                    onAcknowledge(alert.id);
                    setShowActions(false);
                  }}
                  className="w-full px-4 py-2 text-left text-sm text-cyan-400 hover:bg-cyan-900/30 transition-colors font-mono"
                >
                  acknowledge
                </button>
              )}
              {(alert.status === 'active' || alert.status === 'acknowledged') && (
                <button
                  onClick={() => {
                    onResolve(alert.id);
                    setShowActions(false);
                  }}
                  className="w-full px-4 py-2 text-left text-sm text-emerald-400 hover:bg-cyan-900/30 transition-colors font-mono"
                >
                  resolve
                </button>
              )}
              {alert.status !== 'muted' && alert.status !== 'resolved' && (
                <>
                  <button
                    onClick={() => {
                      onMute(alert.id, '1h');
                      setShowActions(false);
                    }}
                    className="w-full px-4 py-2 text-left text-sm text-amber-400 hover:bg-cyan-900/30 transition-colors font-mono"
                  >
                    mute 1h
                  </button>
                  <button
                    onClick={() => {
                      onMute(alert.id, '24h');
                      setShowActions(false);
                    }}
                    className="w-full px-4 py-2 text-left text-sm text-amber-400 hover:bg-cyan-900/30 transition-colors font-mono"
                  >
                    mute 24h
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function RuleCard({
  rule,
  onToggle,
  onDelete,
}: {
  rule: AlertRule;
  onToggle: (id: string, enabled: boolean) => void;
  onDelete: (id: string) => void;
}) {
  const severity = getSeverityStyles(rule.severity);

  return (
    <div className="bg-[#0d1525] border border-cyan-900/30 rounded-lg p-4 mb-3 hover:border-cyan-800/50 transition-all">
      <div className="flex items-start justify-between">
        <div className="flex-1">
          <div className="flex items-center gap-2 mb-2">
            <span
              className={`px-2 py-0.5 rounded text-xs font-mono font-medium ${severity.bg} ${severity.text}`}
            >
              [{rule.severity.toUpperCase()}]
            </span>
            <span
              className={`px-2 py-0.5 rounded text-xs font-mono font-medium ${
                rule.enabled ? 'bg-emerald-500/20 text-emerald-400' : 'bg-gray-500/20 text-gray-500'
              }`}
            >
              {rule.enabled ? '● ENABLED' : '○ DISABLED'}
            </span>
          </div>
          <h3 className="font-semibold text-cyan-100 mb-1 font-mono">{rule.name}</h3>
          {rule.description && <p className="text-sm text-gray-500 mb-2">{rule.description}</p>}
          <div className="text-xs text-cyan-800 space-x-4 font-mono">
            <span className="text-cyan-500">
              {rule.condition.metric} {rule.condition.operator} {rule.condition.threshold}
            </span>
            <span>window: <span className="text-cyan-400">{rule.condition.window}</span></span>
            {rule.cooldown && <span>cooldown: <span className="text-cyan-400">{rule.cooldown}</span></span>}
            <span>actions: <span className="text-cyan-400">[{rule.actions.map((a) => a.type).join(', ')}]</span></span>
          </div>
        </div>

        <div className="flex gap-2">
          <button
            onClick={() => onToggle(rule.id, !rule.enabled)}
            className={`px-3 py-1.5 text-sm rounded-lg transition-colors font-mono ${
              rule.enabled
                ? 'bg-cyan-900/30 hover:bg-cyan-800/40 text-cyan-400 border border-cyan-800/50'
                : 'bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-400 border border-emerald-800/50'
            }`}
          >
            {rule.enabled ? 'disable' : 'enable'}
          </button>
          <button
            onClick={() => onDelete(rule.id)}
            className="px-3 py-1.5 text-sm bg-red-500/20 hover:bg-red-500/30 text-red-400 rounded-lg transition-colors border border-red-800/50"
          >
            <Icons.Trash />
          </button>
        </div>
      </div>
    </div>
  );
}

function HistoryEntry({ entry }: { entry: AlertHistoryEntry }) {
  return (
    <div className="flex items-center justify-between py-3 border-b border-cyan-900/20 last:border-0">
      <div>
        <span className="font-medium text-cyan-300 font-mono">{entry.action}</span>
        {entry.userId && <span className="text-sm text-cyan-700 ml-2 font-mono">by {entry.userId}</span>}
        {entry.note && <p className="text-sm text-gray-500 mt-1">{entry.note}</p>}
      </div>
      <span className="text-sm text-cyan-800 font-mono">{formatDate(entry.timestamp)}</span>
    </div>
  );
}

function CreateRuleModal({
  isOpen,
  onClose,
  onCreate,
}: {
  isOpen: boolean;
  onClose: () => void;
  onCreate: (rule: Partial<AlertRule>) => void;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [severity, setSeverity] = useState<'info' | 'warning' | 'critical'>('warning');
  const [metric, setMetric] = useState('latency_p95');
  const [operator, setOperator] = useState('>');
  const [threshold, setThreshold] = useState(1000);
  const [window, setWindow] = useState('5m');
  const [cooldown, setCooldown] = useState('5m');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onCreate({
      name,
      description,
      enabled: true,
      severity,
      condition: { metric, operator, threshold, window },
      actions: [{ type: 'log', config: {} }],
      cooldown,
    });
    onClose();
    // Reset form
    setName('');
    setDescription('');
    setSeverity('warning');
    setMetric('latency_p95');
    setOperator('>');
    setThreshold(1000);
    setWindow('5m');
    setCooldown('5m');
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-50">
      <div className="bg-[#0a0f1a] border border-cyan-800/50 rounded-xl w-full max-w-lg mx-4 shadow-2xl" style={{ boxShadow: '0 0 50px rgba(34, 211, 238, 0.1)' }}>
        <div className="p-6">
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-xl font-semibold text-cyan-100 font-mono tracking-wide">[CREATE_RULE]</h2>
            <button onClick={onClose} className="text-cyan-700 hover:text-cyan-400 transition-colors">
              <Icons.X />
            </button>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm text-cyan-600 mb-1 font-mono">name:</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                className="w-full px-3 py-2 bg-[#0d1525] border border-cyan-900/50 rounded-lg text-cyan-100 focus:border-cyan-500 outline-none font-mono placeholder:text-cyan-900"
                placeholder="e.g., High P95 Latency"
              />
            </div>

            <div>
              <label className="block text-sm text-cyan-600 mb-1 font-mono">description:</label>
              <input
                type="text"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                className="w-full px-3 py-2 bg-[#0d1525] border border-cyan-900/50 rounded-lg text-cyan-100 focus:border-cyan-500 outline-none font-mono placeholder:text-cyan-900"
                placeholder="Optional description"
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm text-cyan-600 mb-1 font-mono">severity:</label>
                <select
                  value={severity}
                  onChange={(e) => setSeverity(e.target.value as 'info' | 'warning' | 'critical')}
                  className="w-full px-3 py-2 bg-[#0d1525] border border-cyan-900/50 rounded-lg text-cyan-100 focus:border-cyan-500 outline-none font-mono cursor-pointer"
                >
                  <option value="info">info</option>
                  <option value="warning">warning</option>
                  <option value="critical">critical</option>
                </select>
              </div>
              <div>
                <label className="block text-sm text-cyan-600 mb-1 font-mono">metric:</label>
                <select
                  value={metric}
                  onChange={(e) => setMetric(e.target.value)}
                  className="w-full px-3 py-2 bg-[#0d1525] border border-cyan-900/50 rounded-lg text-cyan-100 focus:border-cyan-500 outline-none font-mono cursor-pointer"
                >
                  <option value="latency_p95">latency_p95</option>
                  <option value="latency_p99">latency_p99</option>
                  <option value="latency_avg">latency_avg</option>
                  <option value="error_rate">error_rate</option>
                  <option value="request_rate">request_rate</option>
                </select>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-4">
              <div>
                <label className="block text-sm text-cyan-600 mb-1 font-mono">operator:</label>
                <select
                  value={operator}
                  onChange={(e) => setOperator(e.target.value)}
                  className="w-full px-3 py-2 bg-[#0d1525] border border-cyan-900/50 rounded-lg text-cyan-100 focus:border-cyan-500 outline-none font-mono cursor-pointer"
                >
                  <option value=">">&gt;</option>
                  <option value=">=">&gt;=</option>
                  <option value="<">&lt;</option>
                  <option value="<=">&lt;=</option>
                  <option value="==">==</option>
                </select>
              </div>
              <div>
                <label className="block text-sm text-cyan-600 mb-1 font-mono">threshold:</label>
                <input
                  type="number"
                  value={threshold}
                  onChange={(e) => setThreshold(Number(e.target.value))}
                  required
                  className="w-full px-3 py-2 bg-[#0d1525] border border-cyan-900/50 rounded-lg text-cyan-100 focus:border-cyan-500 outline-none font-mono"
                />
              </div>
              <div>
                <label className="block text-sm text-cyan-600 mb-1 font-mono">window:</label>
                <select
                  value={window}
                  onChange={(e) => setWindow(e.target.value)}
                  className="w-full px-3 py-2 bg-[#0d1525] border border-cyan-900/50 rounded-lg text-cyan-100 focus:border-cyan-500 outline-none font-mono cursor-pointer"
                >
                  <option value="1m">1m</option>
                  <option value="5m">5m</option>
                  <option value="15m">15m</option>
                  <option value="30m">30m</option>
                  <option value="1h">1h</option>
                </select>
              </div>
            </div>

            <div>
              <label className="block text-sm text-cyan-600 mb-1 font-mono">cooldown:</label>
              <select
                value={cooldown}
                onChange={(e) => setCooldown(e.target.value)}
                className="w-full px-3 py-2 bg-[#0d1525] border border-cyan-900/50 rounded-lg text-cyan-100 focus:border-cyan-500 outline-none font-mono cursor-pointer"
              >
                <option value="1m">1m</option>
                <option value="5m">5m</option>
                <option value="15m">15m</option>
                <option value="30m">30m</option>
                <option value="1h">1h</option>
              </select>
            </div>

            <div className="flex justify-end gap-3 mt-6">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 bg-cyan-900/30 hover:bg-cyan-800/40 text-cyan-400 rounded-lg transition-colors border border-cyan-800/50 font-mono"
              >
                [cancel]
              </button>
              <button
                type="submit"
                className="px-4 py-2 bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 text-white rounded-lg transition-all font-mono hover-lift"
              >
                [create]
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}

// =============================================================================
// Main Page Component
// =============================================================================

export default function AlertsPage() {
  const [activeTab, setActiveTab] = useState<TabType>('alerts');
  const [stats, setStats] = useState<AlertStats | null>(null);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [rules, setRules] = useState<AlertRule[]>([]);
  const [history, setHistory] = useState<AlertHistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const [statsRes, alertsRes, rulesRes, historyRes] = await Promise.all([
        fetchApi<AlertStats>('/api/alerts/stats'),
        fetchApi<Alert[]>('/api/alerts/active'),
        fetchApi<AlertRule[]>('/api/alerts/rules'),
        fetchApi<AlertHistoryEntry[]>('/api/alerts/history?limit=50'),
      ]);

      if (statsRes) setStats(statsRes);
      if (alertsRes) setAlerts(alertsRes);
      if (rulesRes) setRules(rulesRes);
      if (historyRes) setHistory(historyRes);
    } catch {
      setError('Failed to fetch alerts data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 30000);
    return () => clearInterval(interval);
  }, [fetchData]);

  const handleAcknowledge = async (alertId: string) => {
    await postApi(`/api/alerts/${alertId}/acknowledge`, { userId: 'dashboard-user' });
    fetchData();
  };

  const handleResolve = async (alertId: string) => {
    await postApi(`/api/alerts/${alertId}/resolve`, { userId: 'dashboard-user' });
    fetchData();
  };

  const handleMute = async (alertId: string, duration: string) => {
    await postApi(`/api/alerts/${alertId}/mute`, { duration, userId: 'dashboard-user' });
    fetchData();
  };

  const handleToggleRule = async (ruleId: string, enabled: boolean) => {
    const endpoint = enabled ? 'enable' : 'disable';
    await postApi(`/api/alerts/rules/${ruleId}/${endpoint}`);
    fetchData();
  };

  const handleDeleteRule = async (ruleId: string) => {
    if (!confirm('Are you sure you want to delete this rule?')) return;
    await deleteApi(`/api/alerts/rules/${ruleId}`);
    fetchData();
  };

  const handleCreateRule = async (rule: Partial<AlertRule>) => {
    await postApi('/api/alerts/rules', rule);
    fetchData();
  };

  return (
    <div className="min-h-screen bg-[#0a0f1a] grid-bg">
      {/* Header */}
      <header className="sticky top-0 z-50 bg-[#0a0f1a]/95 backdrop-blur border-b border-cyan-900/30">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-16">
            <div className="flex items-center gap-4">
              <Link
                href="/"
                className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-cyan-800/50 text-cyan-400 hover:text-cyan-300 hover:border-cyan-600 transition-colors font-mono text-sm"
              >
                <Icons.ArrowLeft />
                <span>Dashboard</span>
              </Link>
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-amber-500/20 border border-amber-500/30">
                  <svg viewBox="0 0 24 24" fill="none" className="w-6 h-6">
                    <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" stroke="#f59e0b" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                    <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" stroke="#f59e0b" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                    <circle cx="18" cy="5" r="3" fill="#ef4444" className="animate-pulse" />
                  </svg>
                </div>
                <div>
                  <h1 className="text-xl font-bold text-white font-mono tracking-wider">ALERTS</h1>
                  <p className="text-xs text-cyan-600 font-mono">Monitoring & Rules</p>
                </div>
              </div>
            </div>

            <div className="flex items-center gap-3">
              <button
                onClick={fetchData}
                className="p-2 rounded-lg bg-gray-800/50 hover:bg-gray-700 text-cyan-400 hover:text-cyan-300 transition-colors border border-gray-700/50"
              >
                <Icons.RefreshCw />
              </button>
              <button
                onClick={() => setShowCreateModal(true)}
                className="flex items-center gap-2 px-4 py-2 bg-cyan-600 hover:bg-cyan-500 text-white rounded-lg transition-colors font-mono text-sm"
              >
                <Icons.Plus />
                Create Rule
              </button>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
        {/* Error Banner */}
        {error && (
          <div className="mb-6 p-4 bg-red-500/10 border border-red-500/20 rounded-xl flex items-center justify-between">
            <span className="text-red-400">{error}</span>
            <button onClick={() => setError(null)} className="text-red-400 hover:text-red-300">
              <Icons.X />
            </button>
          </div>
        )}

        {/* Stats */}
        {loading ? (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="card-glow p-4">
                <div className="skeleton h-4 w-24 mb-2" />
                <div className="skeleton h-8 w-16" />
              </div>
            ))}
          </div>
        ) : stats && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
            <div className="card-glow p-4 animate-fade-in-up" style={{ animationDelay: '0ms' }}>
              <p className="text-sm text-cyan-600 mb-1 font-mono">Active Alerts</p>
              <p className="text-2xl font-bold text-red-400 font-mono">{stats.activeAlertsCount}</p>
            </div>
            <div className="card-glow p-4 animate-fade-in-up" style={{ animationDelay: '50ms' }}>
              <p className="text-sm text-cyan-600 mb-1 font-mono">Critical</p>
              <p className="text-2xl font-bold text-red-400 font-mono">{stats.alertsBySeverity?.critical || 0}</p>
            </div>
            <div className="card-glow p-4 animate-fade-in-up" style={{ animationDelay: '100ms' }}>
              <p className="text-sm text-cyan-600 mb-1 font-mono">Warning</p>
              <p className="text-2xl font-bold text-amber-400 font-mono">{stats.alertsBySeverity?.warning || 0}</p>
            </div>
            <div className="card-glow p-4 animate-fade-in-up" style={{ animationDelay: '150ms' }}>
              <p className="text-sm text-cyan-600 mb-1 font-mono">Enabled Rules</p>
              <p className="text-2xl font-bold text-cyan-300 font-mono">{stats.enabledRulesCount}/{stats.rulesCount}</p>
            </div>
          </div>
        )}

        {/* Tabs */}
        <div className="border-b border-cyan-900/30 mb-6">
          <nav className="flex gap-6">
            {(['alerts', 'rules', 'history'] as TabType[]).map((tab) => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={`pb-3 text-sm font-mono font-medium border-b-2 transition-all uppercase tracking-wider ${
                  activeTab === tab
                    ? 'border-cyan-400 text-cyan-400'
                    : 'border-transparent text-gray-500 hover:text-cyan-500'
                }`}
              >
                [{tab}]
                {tab === 'alerts' && alerts.length > 0 && (
                  <span className="ml-2 px-2 py-0.5 bg-red-500/20 text-red-400 rounded-full text-xs font-mono">
                    {alerts.length}
                  </span>
                )}
              </button>
            ))}
          </nav>
        </div>

        {/* Content */}
        <div className="card-glow p-6">
          {loading ? (
            <div className="space-y-4">
              {[1, 2, 3, 4].map((i) => (
                <div key={i} className="bg-[#0d1525] border-l-4 border-cyan-900/30 rounded-lg p-4">
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-2">
                        <div className="skeleton h-5 w-16 rounded" />
                        <div className="skeleton h-5 w-20 rounded" />
                        <div className="skeleton h-4 w-24" />
                      </div>
                      <div className="skeleton h-5 w-48 mb-2" />
                      <div className="skeleton h-4 w-64 mb-2" />
                      <div className="flex gap-4 mt-2">
                        <div className="skeleton h-3 w-20" />
                        <div className="skeleton h-3 w-24" />
                      </div>
                    </div>
                    <div className="skeleton h-8 w-20 rounded-lg" />
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <>
              {/* Alerts Tab */}
              {activeTab === 'alerts' &&
                (alerts.length > 0 ? (
                  <div>
                    {alerts.map((alert) => (
                      <AlertCard
                        key={alert.id}
                        alert={alert}
                        onAcknowledge={handleAcknowledge}
                        onResolve={handleResolve}
                        onMute={handleMute}
                      />
                    ))}
                  </div>
                ) : (
                  <div className="py-16 text-center">
                    <div className="text-emerald-400 mb-4 flex justify-center animate-pulse">
                      <Icons.CheckCircle />
                    </div>
                    <h3 className="text-lg font-medium text-cyan-100 mb-1 font-mono">[ALL_CLEAR]</h3>
                    <p className="text-cyan-700 font-mono">No active alerts at the moment.</p>
                  </div>
                ))}

              {/* Rules Tab */}
              {activeTab === 'rules' &&
                (rules.length > 0 ? (
                  <div>
                    {rules.map((rule) => (
                      <RuleCard
                        key={rule.id}
                        rule={rule}
                        onToggle={handleToggleRule}
                        onDelete={handleDeleteRule}
                      />
                    ))}
                  </div>
                ) : (
                  <div className="py-16 text-center">
                    <div className="text-cyan-700 mb-4 flex justify-center">
                      <Icons.Bell />
                    </div>
                    <h3 className="text-lg font-medium text-cyan-100 mb-1 font-mono">[NO_RULES]</h3>
                    <p className="text-cyan-700 mb-4 font-mono">Create an alert rule to start monitoring.</p>
                    <button
                      onClick={() => setShowCreateModal(true)}
                      className="px-4 py-2 bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 text-white rounded-lg transition-all font-mono hover-lift"
                    >
                      [create_first_rule]
                    </button>
                  </div>
                ))}

              {/* History Tab */}
              {activeTab === 'history' &&
                (history.length > 0 ? (
                  <div>
                    {history.map((entry) => (
                      <HistoryEntry key={entry.id} entry={entry} />
                    ))}
                  </div>
                ) : (
                  <div className="py-16 text-center">
                    <div className="text-cyan-700 mb-4 flex justify-center">
                      <Icons.Clock />
                    </div>
                    <h3 className="text-lg font-medium text-cyan-100 mb-1 font-mono">[NO_HISTORY]</h3>
                    <p className="text-cyan-700 font-mono">Alert history will appear here.</p>
                  </div>
                ))}
            </>
          )}
        </div>
      </main>

      {/* Create Rule Modal */}
      <CreateRuleModal
        isOpen={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        onCreate={handleCreateRule}
      />
    </div>
  );
}
