/**
 * AEGIS - Rate Limit Bypass Checker
 * Checks if requests should bypass rate limiting based on whitelist configuration
 */

import logger from '../../utils/logger.js';
import type { RateLimitContext, BypassConfig } from '../types.js';
import { matchIP, matchGlob } from './matcher.js';

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_BYPASS_CONFIG: BypassConfig = {
  ips: [],
  userIds: [],
  apiKeys: [],
  paths: [],
  internal: true,
};

// Internal IP ranges (private networks)
const INTERNAL_IP_RANGES = [
  '127.0.0.0/8',      // Loopback
  '10.0.0.0/8',       // Private Class A
  '172.16.0.0/12',    // Private Class B
  '192.168.0.0/16',   // Private Class C
  '::1/128',          // IPv6 loopback
  'fc00::/7',         // IPv6 private
];

// =============================================================================
// Bypass Checker Class
// =============================================================================

export class BypassChecker {
  private config: BypassConfig;
  private compiledPathPatterns: RegExp[] = [];

  constructor(config: Partial<BypassConfig> = {}) {
    this.config = { ...DEFAULT_BYPASS_CONFIG, ...config };
    this.compilePathPatterns();
  }

  /**
   * Update bypass configuration
   */
  public setConfig(config: Partial<BypassConfig>): void {
    this.config = { ...this.config, ...config };
    this.compilePathPatterns();
  }

  /**
   * Get current configuration
   */
  public getConfig(): BypassConfig {
    return { ...this.config };
  }

  /**
   * Pre-compile path patterns for performance
   */
  private compilePathPatterns(): void {
    this.compiledPathPatterns = this.config.paths.map((pattern) => {
      // Convert glob pattern to regex
      let regex = pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*/g, '{{DOUBLE_STAR}}')
        .replace(/\*/g, '[^/]*')
        .replace(/{{DOUBLE_STAR}}/g, '.*')
        .replace(/\?/g, '.');
      return new RegExp(`^${regex}$`);
    });
  }

  /**
   * Check if a request should bypass rate limiting
   */
  public shouldBypass(context: RateLimitContext): BypassResult {
    // Check IP whitelist
    if (this.isIPWhitelisted(context.ip)) {
      return {
        bypass: true,
        reason: 'ip_whitelist',
        detail: `IP ${context.ip} is whitelisted`,
      };
    }

    // Check internal IPs (if enabled)
    if (this.config.internal && this.isInternalIP(context.ip)) {
      return {
        bypass: true,
        reason: 'internal_ip',
        detail: `IP ${context.ip} is an internal address`,
      };
    }

    // Check user ID whitelist
    if (context.userId && this.isUserWhitelisted(context.userId)) {
      return {
        bypass: true,
        reason: 'user_whitelist',
        detail: `User ${context.userId} is whitelisted`,
      };
    }

    // Check API key whitelist
    if (context.apiKey && this.isAPIKeyWhitelisted(context.apiKey)) {
      return {
        bypass: true,
        reason: 'apikey_whitelist',
        detail: `API key is whitelisted`,
      };
    }

    // Check path whitelist
    if (this.isPathWhitelisted(context.path)) {
      return {
        bypass: true,
        reason: 'path_whitelist',
        detail: `Path ${context.path} is whitelisted`,
      };
    }

    return {
      bypass: false,
      reason: 'none',
    };
  }

  /**
   * Check if an IP is in the whitelist
   */
  public isIPWhitelisted(ip: string): boolean {
    return this.config.ips.some((pattern) => matchIP(pattern, ip));
  }

  /**
   * Check if an IP is internal (private network)
   */
  public isInternalIP(ip: string): boolean {
    // Handle IPv4-mapped IPv6 addresses
    const normalizedIP = this.normalizeIP(ip);

    return INTERNAL_IP_RANGES.some((range) => {
      try {
        return matchIP(range, normalizedIP);
      } catch {
        return false;
      }
    });
  }

  /**
   * Normalize IP address (handle IPv4-mapped IPv6)
   */
  private normalizeIP(ip: string): string {
    // Handle ::ffff:x.x.x.x format
    if (ip.startsWith('::ffff:')) {
      return ip.substring(7);
    }
    return ip;
  }

  /**
   * Check if a user ID is in the whitelist
   */
  public isUserWhitelisted(userId: string): boolean {
    return this.config.userIds.includes(userId);
  }

  /**
   * Check if an API key is in the whitelist
   */
  public isAPIKeyWhitelisted(apiKey: string): boolean {
    return this.config.apiKeys.some((pattern) => {
      // Support both exact match and glob patterns
      if (pattern.includes('*') || pattern.includes('?')) {
        return matchGlob(pattern, apiKey);
      }
      return pattern === apiKey;
    });
  }

  /**
   * Check if a path is in the whitelist
   */
  public isPathWhitelisted(path: string): boolean {
    return this.compiledPathPatterns.some((pattern) => pattern.test(path));
  }

  /**
   * Add an IP to the whitelist
   */
  public addIP(ip: string): void {
    if (!this.config.ips.includes(ip)) {
      this.config.ips.push(ip);
      logger.debug('Added IP to bypass whitelist', { ip });
    }
  }

  /**
   * Remove an IP from the whitelist
   */
  public removeIP(ip: string): boolean {
    const index = this.config.ips.indexOf(ip);
    if (index !== -1) {
      this.config.ips.splice(index, 1);
      logger.debug('Removed IP from bypass whitelist', { ip });
      return true;
    }
    return false;
  }

  /**
   * Add a user ID to the whitelist
   */
  public addUser(userId: string): void {
    if (!this.config.userIds.includes(userId)) {
      this.config.userIds.push(userId);
      logger.debug('Added user to bypass whitelist', { userId });
    }
  }

  /**
   * Remove a user ID from the whitelist
   */
  public removeUser(userId: string): boolean {
    const index = this.config.userIds.indexOf(userId);
    if (index !== -1) {
      this.config.userIds.splice(index, 1);
      logger.debug('Removed user from bypass whitelist', { userId });
      return true;
    }
    return false;
  }

  /**
   * Add an API key to the whitelist
   */
  public addAPIKey(apiKey: string): void {
    if (!this.config.apiKeys.includes(apiKey)) {
      this.config.apiKeys.push(apiKey);
      logger.debug('Added API key to bypass whitelist');
    }
  }

  /**
   * Remove an API key from the whitelist
   */
  public removeAPIKey(apiKey: string): boolean {
    const index = this.config.apiKeys.indexOf(apiKey);
    if (index !== -1) {
      this.config.apiKeys.splice(index, 1);
      logger.debug('Removed API key from bypass whitelist');
      return true;
    }
    return false;
  }

  /**
   * Add a path to the whitelist
   */
  public addPath(path: string): void {
    if (!this.config.paths.includes(path)) {
      this.config.paths.push(path);
      this.compilePathPatterns();
      logger.debug('Added path to bypass whitelist', { path });
    }
  }

  /**
   * Remove a path from the whitelist
   */
  public removePath(path: string): boolean {
    const index = this.config.paths.indexOf(path);
    if (index !== -1) {
      this.config.paths.splice(index, 1);
      this.compilePathPatterns();
      logger.debug('Removed path from bypass whitelist', { path });
      return true;
    }
    return false;
  }

  /**
   * Enable or disable internal IP bypass
   */
  public setInternalBypass(enabled: boolean): void {
    this.config.internal = enabled;
    logger.debug('Updated internal IP bypass setting', { enabled });
  }

  /**
   * Clear all whitelist entries
   */
  public clearAll(): void {
    this.config = { ...DEFAULT_BYPASS_CONFIG };
    this.compiledPathPatterns = [];
    logger.debug('Cleared all bypass whitelist entries');
  }
}

// =============================================================================
// Types
// =============================================================================

export interface BypassResult {
  /** Whether rate limiting should be bypassed */
  bypass: boolean;
  /** Reason for bypass (or 'none' if not bypassed) */
  reason: BypassReason;
  /** Additional detail about the bypass */
  detail?: string;
}

export type BypassReason =
  | 'none'
  | 'ip_whitelist'
  | 'internal_ip'
  | 'user_whitelist'
  | 'apikey_whitelist'
  | 'path_whitelist';

// =============================================================================
// Factory Function
// =============================================================================

export function createBypassChecker(config?: Partial<BypassConfig>): BypassChecker {
  return new BypassChecker(config);
}

export default BypassChecker;
