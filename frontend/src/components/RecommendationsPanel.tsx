'use client';

import { useState, useEffect, useCallback } from 'react';

// =============================================================================
// Types
// =============================================================================

interface RateLimitRecommendation {
  endpoint: string;
  tier: string;
  current_limit: number | null;
  recommended_limit: number;
  recommended_burst: number;
  confidence: number;
  reasoning: string;
  strategy: string;
  warnings: string[];
}

interface RecommendationsData {
  recommendations: RateLimitRecommendation[];
  summary: {
    total_endpoints: number;
    avg_confidence: number;
  };
}

// =============================================================================
// Icons
// =============================================================================

const Icons = {
  Sparkles: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
      <path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z" />
    </svg>
  ),
  Check: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  ),
  AlertTriangle: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
      <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </svg>
  ),
  RefreshCw: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
      <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
      <path d="M8 16H3v5" />
    </svg>
  ),
  Loader: () => (
    <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="10" strokeOpacity="0.25" />
      <path d="M12 2a10 10 0 0 1 10 10" strokeLinecap="round" />
    </svg>
  ),
  ChevronDown: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
      <path d="m6 9 6 6 6-6" />
    </svg>
  ),
  ChevronUp: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
      <path d="m18 15-6-6-6 6" />
    </svg>
  ),
};

// =============================================================================
// API Helper
// =============================================================================

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8080';

async function fetchRecommendations(tier?: string, strategy?: string): Promise<RecommendationsData | null> {
  try {
    const params = new URLSearchParams();
    if (tier) params.set('tier', tier);
    if (strategy) params.set('strategy', strategy);

    const url = `${API_BASE}/api/ml/recommendations${params.toString() ? `?${params}` : ''}`;
    const res = await fetch(url);
    const json = await res.json();
    return json.success ? json.data : null;
  } catch {
    return null;
  }
}

async function applyRecommendation(rec: RateLimitRecommendation): Promise<{ success: boolean; message?: string }> {
  try {
    const res = await fetch(`${API_BASE}/api/ml/recommendations/apply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        endpoint: rec.endpoint,
        tier: rec.tier,
        recommendedLimit: rec.recommended_limit,
        recommendedBurst: rec.recommended_burst,
      }),
    });
    const json = await res.json();
    return { success: json.success, message: json.data?.message };
  } catch {
    return { success: false, message: 'Failed to apply recommendation' };
  }
}

async function checkMLHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE}/api/ml/health`);
    const json = await res.json();
    return json.success && json.data?.status === 'healthy';
  } catch {
    return false;
  }
}

// =============================================================================
// Component
// =============================================================================

interface RecommendationsPanelProps {
  className?: string;
}

export default function RecommendationsPanel({ className = '' }: RecommendationsPanelProps) {
  const [data, setData] = useState<RecommendationsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mlAvailable, setMlAvailable] = useState<boolean | null>(null);
  const [expandedRec, setExpandedRec] = useState<string | null>(null);
  const [applyingRec, setApplyingRec] = useState<string | null>(null);
  const [appliedRecs, setAppliedRecs] = useState<Set<string>>(new Set());
  const [selectedTier, setSelectedTier] = useState<string>('');
  const [selectedStrategy, setSelectedStrategy] = useState<string>('balanced');

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);

    const isHealthy = await checkMLHealth();
    setMlAvailable(isHealthy);

    if (!isHealthy) {
      setLoading(false);
      setError('ML service is not available');
      return;
    }

    const result = await fetchRecommendations(selectedTier || undefined, selectedStrategy);
    if (result) {
      setData(result);
    } else {
      setError('Failed to load recommendations');
    }
    setLoading(false);
  }, [selectedTier, selectedStrategy]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleApply = async (rec: RateLimitRecommendation) => {
    const key = `${rec.endpoint}-${rec.tier}`;
    setApplyingRec(key);

    const result = await applyRecommendation(rec);

    if (result.success) {
      setAppliedRecs((prev) => new Set(prev).add(key));
    }

    setApplyingRec(null);
  };

  const getConfidenceColor = (confidence: number) => {
    if (confidence >= 0.8) return 'text-emerald-400';
    if (confidence >= 0.6) return 'text-amber-400';
    return 'text-red-400';
  };

  const getConfidenceBg = (confidence: number) => {
    if (confidence >= 0.8) return 'bg-emerald-500/10';
    if (confidence >= 0.6) return 'bg-amber-500/10';
    return 'bg-red-500/10';
  };

  return (
    <div className={`bg-[#0a0f1a] border border-cyan-900/40 rounded-xl overflow-hidden ${className}`}>
      {/* Header */}
      <div className="px-4 py-3 border-b border-cyan-900/30 flex items-center justify-between bg-[#060a12]">
        <div className="flex items-center gap-2">
          <span className="text-cyan-400"><Icons.Sparkles /></span>
          <h3 className="font-semibold text-cyan-100 font-mono tracking-wide">ML_RECOMMENDATIONS</h3>
        </div>
        <button
          onClick={loadData}
          disabled={loading}
          className="p-1.5 rounded-lg hover:bg-cyan-900/30 text-cyan-600 hover:text-cyan-300 transition-colors disabled:opacity-50"
        >
          {loading ? <Icons.Loader /> : <Icons.RefreshCw />}
        </button>
      </div>

      {/* Filters */}
      <div className="px-4 py-2 border-b border-cyan-900/30 flex gap-3 bg-[#080c14]">
        <select
          value={selectedTier}
          onChange={(e) => setSelectedTier(e.target.value)}
          className="text-xs bg-[#0a0f1a] border border-cyan-900/50 rounded px-2 py-1 text-cyan-300 font-mono focus:border-cyan-600 focus:outline-none"
        >
          <option value="">ALL_TIERS</option>
          <option value="anonymous">ANONYMOUS</option>
          <option value="free">FREE</option>
          <option value="basic">BASIC</option>
          <option value="pro">PRO</option>
          <option value="enterprise">ENTERPRISE</option>
        </select>
        <select
          value={selectedStrategy}
          onChange={(e) => setSelectedStrategy(e.target.value)}
          className="text-xs bg-[#0a0f1a] border border-cyan-900/50 rounded px-2 py-1 text-cyan-300 font-mono focus:border-cyan-600 focus:outline-none"
        >
          <option value="conservative">CONSERVATIVE</option>
          <option value="balanced">BALANCED</option>
          <option value="permissive">PERMISSIVE</option>
          <option value="adaptive">ADAPTIVE</option>
        </select>
      </div>

      {/* Content */}
      <div className="p-4 grid-bg">
        {/* ML Not Available */}
        {mlAvailable === false && (
          <div className="text-center py-6">
            <div className="inline-flex p-3 rounded-lg bg-amber-900/20 border border-amber-500/30 mb-3">
              <span className="text-amber-400"><Icons.AlertTriangle /></span>
            </div>
            <p className="text-sm text-amber-300 mb-2 font-mono">[ML_SERVICE_UNAVAILABLE]</p>
            <p className="text-xs text-cyan-700 font-mono">
              Start with: <code className="bg-cyan-900/30 px-2 py-0.5 rounded border border-cyan-800/30">docker compose up ml-service</code>
            </p>
          </div>
        )}

        {/* Loading */}
        {loading && mlAvailable !== false && (
          <div className="flex items-center justify-center py-8">
            <Icons.Loader />
            <span className="ml-2 text-sm text-cyan-600 font-mono">Loading recommendations...</span>
          </div>
        )}

        {/* Error */}
        {error && !loading && mlAvailable !== false && (
          <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3 text-sm text-red-300 font-mono">
            [ERROR] {error}
          </div>
        )}

        {/* No Data */}
        {!loading && !error && data && data.recommendations.length === 0 && (
          <div className="text-center py-6">
            <p className="text-sm text-cyan-600 font-mono">[NO_RECOMMENDATIONS]</p>
            <p className="text-xs text-cyan-800 mt-1 font-mono">Train the ML model with traffic data first</p>
          </div>
        )}

        {/* Recommendations List */}
        {!loading && data && data.recommendations.length > 0 && (
          <div className="space-y-3">
            {/* Summary */}
            <div className="flex items-center justify-between text-xs text-cyan-600 mb-2 font-mono">
              <span>[{data.summary.total_endpoints} endpoints]</span>
              <span>confidence: {(data.summary.avg_confidence * 100).toFixed(0)}%</span>
            </div>

            {/* Recommendation Cards */}
            {data.recommendations.map((rec, idx) => {
              const key = `${rec.endpoint}-${rec.tier}`;
              const isExpanded = expandedRec === key;
              const isApplying = applyingRec === key;
              const isApplied = appliedRecs.has(key);

              return (
                <div
                  key={key}
                  className="bg-[#0a0f1a]/80 border border-cyan-900/30 rounded-lg overflow-hidden animate-fade-in-up hover:border-cyan-700/40 transition-all"
                  style={{ animationDelay: `${idx * 50}ms` }}
                >
                  {/* Main Row */}
                  <div
                    className="flex items-center justify-between p-3 cursor-pointer hover:bg-cyan-900/10"
                    onClick={() => setExpandedRec(isExpanded ? null : key)}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="font-mono text-sm text-cyan-200 truncate">{rec.endpoint}</span>
                        <span className="text-xs px-1.5 py-0.5 rounded bg-cyan-900/30 text-cyan-500 font-mono border border-cyan-800/30">
                          {rec.tier}
                        </span>
                      </div>
                      <div className="flex items-center gap-3 text-xs font-mono">
                        <span className="text-cyan-700">
                          {rec.current_limit ?? '—'} → <span className="text-cyan-400 font-medium">{rec.recommended_limit}</span> req/min
                        </span>
                        <span className={`px-1.5 py-0.5 rounded ${getConfidenceBg(rec.confidence)} ${getConfidenceColor(rec.confidence)}`}>
                          {(rec.confidence * 100).toFixed(0)}%
                        </span>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 ml-2">
                      {!isApplied ? (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleApply(rec);
                          }}
                          disabled={isApplying}
                          className="px-3 py-1.5 text-xs font-medium bg-cyan-600 hover:bg-cyan-500 disabled:bg-gray-800 text-white rounded-lg transition-colors font-mono"
                        >
                          {isApplying ? <Icons.Loader /> : 'APPLY'}
                        </button>
                      ) : (
                        <span className="px-3 py-1.5 text-xs font-medium bg-emerald-500/20 text-emerald-400 rounded-lg flex items-center gap-1 font-mono border border-emerald-500/30">
                          <Icons.Check /> APPLIED
                        </span>
                      )}
                      <span className="text-cyan-600">{isExpanded ? <Icons.ChevronUp /> : <Icons.ChevronDown />}</span>
                    </div>
                  </div>

                  {/* Expanded Details */}
                  {isExpanded && (
                    <div className="border-t border-cyan-900/30 p-3 bg-[#060a12]/50 space-y-2">
                      <div>
                        <p className="text-xs text-cyan-700 mb-1 font-mono">[REASONING]</p>
                        <p className="text-sm text-cyan-300 font-mono">{rec.reasoning}</p>
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <p className="text-xs text-cyan-700 mb-1 font-mono">[BURST]</p>
                          <p className="text-sm text-cyan-200 font-mono">{rec.recommended_burst} requests</p>
                        </div>
                        <div>
                          <p className="text-xs text-cyan-700 mb-1 font-mono">[STRATEGY]</p>
                          <p className="text-sm text-cyan-200 font-mono uppercase">{rec.strategy}</p>
                        </div>
                      </div>
                      {rec.warnings.length > 0 && (
                        <div>
                          <p className="text-xs text-cyan-700 mb-1 font-mono">[WARNINGS]</p>
                          <ul className="text-xs text-amber-400 space-y-1 font-mono">
                            {rec.warnings.map((w, i) => (
                              <li key={i} className="flex items-start gap-1">
                                <Icons.AlertTriangle />
                                {w}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
