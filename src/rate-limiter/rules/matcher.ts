/**
 * AEGIS - Rate Limit Rule Matcher
 * Matches incoming requests against rate limit rules
 * Supports per-user, per-IP, per-endpoint, and tiered rate limiting
 */

import logger from '../../utils/logger.js';
import type {
  RateLimitRule,
  RateLimitContext,
  MatchedRule,
  RuleMatchType,
  RateLimitTier,
  KeyStrategy,
  KeyGenerator,
} from '../types.js';

// =============================================================================
// Constants
// =============================================================================

const MATCH_TYPE_WEIGHTS: Record<RuleMatchType, number> = {
  exact: 100,
  prefix: 50,
  glob: 30,
  regex: 20,
};

// =============================================================================
// Glob Pattern Matching
// =============================================================================

/**
 * Convert glob pattern to regex
 * Supports:
 * - * matches any single path segment
 * - ** matches any path (including nested)
 * - ? matches single character
 */
function globToRegex(pattern: string): RegExp {
  let regex = pattern
    // Escape special regex characters (except * and ?)
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    // ** matches any path including slashes
    .replace(/\*\*/g, '{{DOUBLE_STAR}}')
    // * matches any characters except /
    .replace(/\*/g, '[^/]*')
    // Restore ** as .*
    .replace(/{{DOUBLE_STAR}}/g, '.*')
    // ? matches single character
    .replace(/\?/g, '.');

  return new RegExp(`^${regex}$`);
}

/**
 * Match a path against a glob pattern
 */
export function matchGlob(pattern: string, path: string): boolean {
  const regex = globToRegex(pattern);
  return regex.test(path);
}

// =============================================================================
// IP Matching
// =============================================================================

/**
 * Parse CIDR notation to network and mask
 */
function parseCIDR(cidr: string): { network: number[]; maskBits: number } | null {
  const parts = cidr.split('/');
  const ip = parts[0];
  if (!ip) {
    return null;
  }
  const maskBits = parts[1] ? parseInt(parts[1], 10) : 32;

  const ipParts = ip.split('.').map((p) => parseInt(p, 10));
  if (ipParts.length !== 4 || ipParts.some((p) => isNaN(p) || p < 0 || p > 255)) {
    return null;
  }

  if (isNaN(maskBits) || maskBits < 0 || maskBits > 32) {
    return null;
  }

  return { network: ipParts, maskBits };
}

/**
 * Check if an IP matches a CIDR range or exact IP
 */
export function matchIP(pattern: string, ip: string): boolean {
  // Handle exact match
  if (!pattern.includes('/')) {
    return pattern === ip;
  }

  const parsed = parseCIDR(pattern);
  if (!parsed) {
    return false;
  }

  const ipParts = ip.split('.').map((p) => parseInt(p, 10));
  if (ipParts.length !== 4 || ipParts.some((p) => isNaN(p) || p < 0 || p > 255)) {
    return false;
  }

  const { network, maskBits } = parsed;

  // Convert to 32-bit integers
  const ipInt =
    ((ipParts[0] ?? 0) << 24) |
    ((ipParts[1] ?? 0) << 16) |
    ((ipParts[2] ?? 0) << 8) |
    (ipParts[3] ?? 0);
  const networkInt =
    ((network[0] ?? 0) << 24) |
    ((network[1] ?? 0) << 16) |
    ((network[2] ?? 0) << 8) |
    (network[3] ?? 0);

  // Create mask
  const mask = maskBits === 0 ? 0 : ~((1 << (32 - maskBits)) - 1);

  return (ipInt & mask) === (networkInt & mask);
}

// =============================================================================
// Rule Matcher Class
// =============================================================================

export class RuleMatcher {
  private rules: RateLimitRule[] = [];
  private sortedRules: RateLimitRule[] = [];
  private compiledPatterns: Map<string, RegExp> = new Map();

  constructor(rules: RateLimitRule[] = []) {
    this.setRules(rules);
  }

  /**
   * Set the rules to match against
   */
  public setRules(rules: RateLimitRule[]): void {
    this.rules = rules;
    this.sortedRules = this.sortRulesByPriority(rules.filter((r) => r.enabled));
    this.compilePatterns();
  }

  /**
   * Add a single rule
   */
  public addRule(rule: RateLimitRule): void {
    this.rules.push(rule);
    if (rule.enabled) {
      this.sortedRules = this.sortRulesByPriority([...this.sortedRules, rule]);
    }
    this.compilePattern(rule);
  }

  /**
   * Remove a rule by ID
   */
  public removeRule(ruleId: string): boolean {
    const index = this.rules.findIndex((r) => r.id === ruleId);
    if (index === -1) {
      return false;
    }

    this.rules.splice(index, 1);
    this.sortedRules = this.sortRulesByPriority(this.rules.filter((r) => r.enabled));
    this.compiledPatterns.delete(ruleId);
    return true;
  }

  /**
   * Get all rules
   */
  public getRules(): RateLimitRule[] {
    return [...this.rules];
  }

  /**
   * Sort rules by priority (higher priority first)
   */
  private sortRulesByPriority(rules: RateLimitRule[]): RateLimitRule[] {
    return [...rules].sort((a, b) => b.priority - a.priority);
  }

  /**
   * Pre-compile regex patterns for performance
   */
  private compilePatterns(): void {
    this.compiledPatterns.clear();
    for (const rule of this.rules) {
      this.compilePattern(rule);
    }
  }

  /**
   * Compile pattern for a single rule
   */
  private compilePattern(rule: RateLimitRule): void {
    if (!rule.match.endpoint) {
      return;
    }

    const matchType = rule.match.endpointMatchType ?? 'glob';
    let pattern: RegExp;

    switch (matchType) {
      case 'exact':
        pattern = new RegExp(`^${rule.match.endpoint.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
        break;
      case 'prefix':
        pattern = new RegExp(`^${rule.match.endpoint.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
        break;
      case 'glob':
        pattern = globToRegex(rule.match.endpoint);
        break;
      case 'regex':
        try {
          pattern = new RegExp(rule.match.endpoint);
        } catch {
          logger.warn('Invalid regex pattern in rule', {
            ruleId: rule.id,
            pattern: rule.match.endpoint,
          });
          pattern = /^$/; // Never matches
        }
        break;
    }

    this.compiledPatterns.set(rule.id, pattern);
  }

  /**
   * Match a request context against all rules
   * Returns all matching rules sorted by match score
   */
  public match(context: RateLimitContext): MatchedRule[] {
    const matches: MatchedRule[] = [];

    for (const rule of this.sortedRules) {
      const matchResult = this.matchRule(rule, context);
      if (matchResult !== null) {
        matches.push(matchResult);
      }
    }

    // Sort by match score (descending) then by priority
    return matches.sort((a, b) => {
      if (b.matchScore !== a.matchScore) {
        return b.matchScore - a.matchScore;
      }
      return b.rule.priority - a.rule.priority;
    });
  }

  /**
   * Get the best matching rule for a context
   */
  public getBestMatch(context: RateLimitContext): MatchedRule | null {
    const matches = this.match(context);
    return matches.length > 0 ? (matches[0] ?? null) : null;
  }

  /**
   * Match a single rule against a context
   */
  private matchRule(rule: RateLimitRule, context: RateLimitContext): MatchedRule | null {
    const matchedConditions: string[] = [];
    let score = 0;

    // Check endpoint pattern
    if (rule.match.endpoint) {
      const pattern = this.compiledPatterns.get(rule.id);
      if (!pattern || !pattern.test(context.path)) {
        return null; // Endpoint doesn't match - rule doesn't apply
      }
      matchedConditions.push(`endpoint:${rule.match.endpoint}`);
      score += MATCH_TYPE_WEIGHTS[rule.match.endpointMatchType ?? 'glob'];

      // Bonus for more specific paths
      const pathDepth = context.path.split('/').filter(Boolean).length;
      score += pathDepth * 2;
    }

    // Check HTTP methods
    if (rule.match.methods && rule.match.methods.length > 0) {
      if (!rule.match.methods.includes(context.method.toUpperCase())) {
        return null; // Method doesn't match
      }
      matchedConditions.push(`method:${context.method}`);
      score += 10;
    }

    // Check user tiers
    if (rule.match.tiers && rule.match.tiers.length > 0) {
      if (!rule.match.tiers.includes(context.tier)) {
        return null; // Tier doesn't match
      }
      matchedConditions.push(`tier:${context.tier}`);
      score += 20;
    }

    // Check specific user IDs
    if (rule.match.userIds && rule.match.userIds.length > 0) {
      if (!context.userId || !rule.match.userIds.includes(context.userId)) {
        return null; // User ID doesn't match
      }
      matchedConditions.push(`userId:${context.userId}`);
      score += 50; // High score for specific user match
    }

    // Check IP addresses/ranges
    if (rule.match.ips && rule.match.ips.length > 0) {
      const ipMatch = rule.match.ips.some((ipPattern) => matchIP(ipPattern, context.ip));
      if (!ipMatch) {
        return null; // IP doesn't match
      }
      matchedConditions.push(`ip:${context.ip}`);
      score += 30;
    }

    // Check API keys
    if (rule.match.apiKeys && rule.match.apiKeys.length > 0) {
      if (!context.apiKey || !rule.match.apiKeys.some((k) => matchGlob(k, context.apiKey!))) {
        return null; // API key doesn't match
      }
      matchedConditions.push(`apiKey:${context.apiKey}`);
      score += 40;
    }

    // Check custom headers
    if (rule.match.headers && Object.keys(rule.match.headers).length > 0) {
      for (const [header, expectedValue] of Object.entries(rule.match.headers)) {
        const actualValue = context.headers[header.toLowerCase()];
        const valueStr = Array.isArray(actualValue) ? actualValue[0] : actualValue;
        if (valueStr !== expectedValue) {
          return null; // Header doesn't match
        }
        matchedConditions.push(`header:${header}`);
        score += 5;
      }
    }

    // If no conditions were specified, this is a catch-all rule
    if (matchedConditions.length === 0) {
      matchedConditions.push('catch-all');
      score = 1; // Lowest score for catch-all
    }

    return {
      rule,
      matchScore: score,
      matchedConditions,
    };
  }
}

// =============================================================================
// Key Generator
// =============================================================================

/**
 * Default key generators for different strategies
 */
export const KEY_GENERATORS: Record<KeyStrategy, KeyGenerator> = {
  ip: (ctx) => `ip:${ctx.ip}`,

  user: (ctx) => (ctx.userId ? `user:${ctx.userId}` : `ip:${ctx.ip}`),

  'api-key': (ctx) => (ctx.apiKey ? `apikey:${ctx.apiKey}` : `ip:${ctx.ip}`),

  'ip-endpoint': (ctx) => `ip:${ctx.ip}:${ctx.method}:${ctx.path}`,

  'user-endpoint': (ctx) =>
    ctx.userId
      ? `user:${ctx.userId}:${ctx.method}:${ctx.path}`
      : `ip:${ctx.ip}:${ctx.method}:${ctx.path}`,

  composite: (ctx) => {
    const parts: string[] = [];
    if (ctx.userId) {
      parts.push(`u:${ctx.userId}`);
    } else {
      parts.push(`ip:${ctx.ip}`);
    }
    if (ctx.apiKey) {
      parts.push(`k:${ctx.apiKey.slice(0, 8)}`);
    }
    parts.push(`t:${ctx.tier}`);
    return parts.join(':');
  },
};

/**
 * Create a key generator from strategy
 */
export function createKeyGenerator(strategy: KeyStrategy): KeyGenerator {
  return KEY_GENERATORS[strategy];
}

/**
 * Generate rate limit key from context and rule
 */
export function generateRateLimitKey(
  context: RateLimitContext,
  rule?: RateLimitRule,
  strategy: KeyStrategy = 'composite'
): string {
  const generator = KEY_GENERATORS[strategy];
  const baseKey = generator(context);

  if (rule) {
    // Include rule ID for rule-specific rate limiting
    return `${rule.id}:${baseKey}`;
  }

  return baseKey;
}

// =============================================================================
// Tier Detection
// =============================================================================

/**
 * Determine the rate limit tier for a context
 * This is typically based on authentication/API key lookup
 */
export function determineTier(
  context: Partial<RateLimitContext>,
  tierMapping?: Map<string, RateLimitTier>
): RateLimitTier {
  // Check user ID mapping
  if (context.userId && tierMapping) {
    const tier = tierMapping.get(`user:${context.userId}`);
    if (tier) {
      return tier;
    }
  }

  // Check API key mapping
  if (context.apiKey && tierMapping) {
    const tier = tierMapping.get(`apikey:${context.apiKey}`);
    if (tier) {
      return tier;
    }
  }

  // Default tier based on authentication status
  if (context.userId) {
    return 'free'; // Authenticated user defaults to free tier
  }

  return 'anonymous'; // Unauthenticated defaults to anonymous
}

// =============================================================================
// Factory Functions
// =============================================================================

export function createRuleMatcher(rules?: RateLimitRule[]): RuleMatcher {
  return new RuleMatcher(rules);
}

export default RuleMatcher;
