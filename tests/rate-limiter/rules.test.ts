/**
 * AEGIS - Rate Limiter Rules Tests
 * Comprehensive tests for rule matcher and bypass checker
 */

import { describe, it, expect, beforeEach } from '@jest/globals';

import {
  RuleMatcher,
  createRuleMatcher,
  matchGlob,
  matchIP,
  KEY_GENERATORS,
  createKeyGenerator,
  generateRateLimitKey,
  determineTier,
} from '../../src/rate-limiter/rules/matcher.js';

import { BypassChecker, createBypassChecker } from '../../src/rate-limiter/rules/bypass.js';

import type {
  RateLimitRule,
  RateLimitContext,
  RateLimitTier,
} from '../../src/rate-limiter/types.js';

// =============================================================================
// Test Data
// =============================================================================

const createTestRule = (overrides: Partial<RateLimitRule> = {}): RateLimitRule => ({
  id: 'test-rule',
  name: 'Test Rule',
  priority: 10,
  enabled: true,
  match: {
    endpoint: '/api/*',
    endpointMatchType: 'glob',
  },
  rateLimit: {
    algorithm: 'token-bucket',
    requests: 100,
    windowSeconds: 60,
  },
  ...overrides,
});

const createTestContext = (overrides: Partial<RateLimitContext> = {}): RateLimitContext => ({
  ip: '192.168.1.100',
  userId: 'user123',
  apiKey: 'key_abc123',
  tier: 'free',
  path: '/api/users',
  method: 'GET',
  headers: {},
  requestId: 'req-123',
  ...overrides,
});

// =============================================================================
// Glob Matching Tests
// =============================================================================

describe('matchGlob', () => {
  describe('single asterisk (*) patterns', () => {
    it('should match single path segment', () => {
      expect(matchGlob('/api/*', '/api/users')).toBe(true);
      expect(matchGlob('/api/*', '/api/orders')).toBe(true);
    });

    it('should not match nested paths', () => {
      expect(matchGlob('/api/*', '/api/users/123')).toBe(false);
      expect(matchGlob('/api/*', '/api/users/orders/456')).toBe(false);
    });

    it('should match at any position', () => {
      expect(matchGlob('/*/users', '/api/users')).toBe(true);
      expect(matchGlob('/*/users', '/v1/users')).toBe(true);
    });

    it('should handle multiple single asterisks', () => {
      expect(matchGlob('/*/*', '/api/users')).toBe(true);
      expect(matchGlob('/*/*/*', '/api/users/123')).toBe(true);
    });
  });

  describe('double asterisk (**) patterns', () => {
    it('should match any depth of paths', () => {
      expect(matchGlob('/api/**', '/api/users')).toBe(true);
      expect(matchGlob('/api/**', '/api/users/123')).toBe(true);
      expect(matchGlob('/api/**', '/api/users/123/orders')).toBe(true);
    });

    it('should match empty remainder', () => {
      expect(matchGlob('/api/**', '/api/')).toBe(true);
    });

    it('should work at end of pattern', () => {
      expect(matchGlob('/users/**', '/users/123/profile/settings')).toBe(true);
    });
  });

  describe('question mark (?) patterns', () => {
    it('should match single character', () => {
      expect(matchGlob('/api/v?', '/api/v1')).toBe(true);
      expect(matchGlob('/api/v?', '/api/v2')).toBe(true);
    });

    it('should not match multiple characters', () => {
      expect(matchGlob('/api/v?', '/api/v10')).toBe(false);
    });

    it('should handle multiple question marks', () => {
      expect(matchGlob('/api/v??', '/api/v10')).toBe(true);
      expect(matchGlob('/api/v??', '/api/v1')).toBe(false);
    });
  });

  describe('exact patterns', () => {
    it('should match exact path', () => {
      expect(matchGlob('/api/users', '/api/users')).toBe(true);
    });

    it('should not match different paths', () => {
      expect(matchGlob('/api/users', '/api/orders')).toBe(false);
    });

    it('should not match partial paths', () => {
      expect(matchGlob('/api/users', '/api/users/123')).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('should handle root path', () => {
      expect(matchGlob('/', '/')).toBe(true);
      expect(matchGlob('/*', '/anything')).toBe(true);
    });

    it('should escape special regex characters', () => {
      expect(matchGlob('/api/test.json', '/api/test.json')).toBe(true);
      expect(matchGlob('/api/test.json', '/api/testXjson')).toBe(false);
    });
  });
});

// =============================================================================
// IP Matching Tests
// =============================================================================

describe('matchIP', () => {
  describe('exact IP matching', () => {
    it('should match exact IP addresses', () => {
      expect(matchIP('192.168.1.1', '192.168.1.1')).toBe(true);
      expect(matchIP('10.0.0.1', '10.0.0.1')).toBe(true);
    });

    it('should not match different IPs', () => {
      expect(matchIP('192.168.1.1', '192.168.1.2')).toBe(false);
      expect(matchIP('10.0.0.1', '10.0.0.2')).toBe(false);
    });
  });

  describe('CIDR range matching', () => {
    it('should match IPs within /24 range', () => {
      expect(matchIP('192.168.1.0/24', '192.168.1.1')).toBe(true);
      expect(matchIP('192.168.1.0/24', '192.168.1.100')).toBe(true);
      expect(matchIP('192.168.1.0/24', '192.168.1.255')).toBe(true);
    });

    it('should not match IPs outside /24 range', () => {
      expect(matchIP('192.168.1.0/24', '192.168.2.1')).toBe(false);
      expect(matchIP('192.168.1.0/24', '10.0.0.1')).toBe(false);
    });

    it('should match IPs within /16 range', () => {
      expect(matchIP('192.168.0.0/16', '192.168.0.1')).toBe(true);
      expect(matchIP('192.168.0.0/16', '192.168.255.255')).toBe(true);
    });

    it('should not match IPs outside /16 range', () => {
      expect(matchIP('192.168.0.0/16', '192.169.0.1')).toBe(false);
    });

    it('should match IPs within /8 range', () => {
      expect(matchIP('10.0.0.0/8', '10.0.0.1')).toBe(true);
      expect(matchIP('10.0.0.0/8', '10.255.255.255')).toBe(true);
    });

    it('should handle /32 (single IP)', () => {
      expect(matchIP('192.168.1.1/32', '192.168.1.1')).toBe(true);
      expect(matchIP('192.168.1.1/32', '192.168.1.2')).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('should handle invalid IP formats', () => {
      expect(matchIP('192.168.1.1', 'invalid')).toBe(false);
      expect(matchIP('invalid', '192.168.1.1')).toBe(false);
    });

    it('should handle invalid CIDR notation', () => {
      expect(matchIP('192.168.1.1/33', '192.168.1.1')).toBe(false);
      expect(matchIP('192.168.1.1/-1', '192.168.1.1')).toBe(false);
    });

    it('should handle loopback addresses', () => {
      expect(matchIP('127.0.0.0/8', '127.0.0.1')).toBe(true);
      expect(matchIP('127.0.0.1', '127.0.0.1')).toBe(true);
    });
  });
});

// =============================================================================
// Rule Matcher Tests
// =============================================================================

describe('RuleMatcher', () => {
  let matcher: RuleMatcher;

  beforeEach(() => {
    matcher = new RuleMatcher();
  });

  describe('constructor', () => {
    it('should initialize with empty rules', () => {
      expect(matcher.getRules()).toEqual([]);
    });

    it('should initialize with provided rules', () => {
      const rules = [createTestRule({ id: 'rule1' }), createTestRule({ id: 'rule2' })];
      const matcherWithRules = new RuleMatcher(rules);
      expect(matcherWithRules.getRules()).toHaveLength(2);
    });
  });

  describe('setRules', () => {
    it('should replace existing rules', () => {
      matcher.addRule(createTestRule({ id: 'old-rule' }));
      matcher.setRules([createTestRule({ id: 'new-rule' })]);

      expect(matcher.getRules()).toHaveLength(1);
      expect(matcher.getRules()[0]!.id).toBe('new-rule');
    });

    it('should filter out disabled rules for matching', () => {
      matcher.setRules([
        createTestRule({ id: 'enabled', enabled: true }),
        createTestRule({ id: 'disabled', enabled: false }),
      ]);

      const context = createTestContext({ path: '/api/test' });
      const matches = matcher.match(context);

      expect(matches).toHaveLength(1);
      expect(matches[0]!.rule.id).toBe('enabled');
    });
  });

  describe('addRule', () => {
    it('should add a rule to the collection', () => {
      matcher.addRule(createTestRule({ id: 'new-rule' }));
      expect(matcher.getRules()).toHaveLength(1);
    });

    it('should maintain priority sorting', () => {
      matcher.addRule(createTestRule({ id: 'low', priority: 1 }));
      matcher.addRule(createTestRule({ id: 'high', priority: 100 }));
      matcher.addRule(createTestRule({ id: 'mid', priority: 50 }));

      const context = createTestContext({ path: '/api/test' });
      const matches = matcher.match(context);

      expect(matches[0]!.rule.priority).toBeGreaterThanOrEqual(matches[1]!.rule.priority);
    });
  });

  describe('removeRule', () => {
    it('should remove rule by ID', () => {
      matcher.addRule(createTestRule({ id: 'to-remove' }));
      expect(matcher.removeRule('to-remove')).toBe(true);
      expect(matcher.getRules()).toHaveLength(0);
    });

    it('should return false for non-existent rule', () => {
      expect(matcher.removeRule('nonexistent')).toBe(false);
    });
  });

  describe('match', () => {
    it('should match endpoint patterns', () => {
      matcher.addRule(
        createTestRule({
          id: 'api-rule',
          match: { endpoint: '/api/*' },
        })
      );

      const context = createTestContext({ path: '/api/users' });
      const matches = matcher.match(context);

      expect(matches).toHaveLength(1);
      expect(matches[0]!.rule.id).toBe('api-rule');
    });

    it('should match HTTP methods', () => {
      matcher.addRule(
        createTestRule({
          id: 'post-only',
          match: {
            endpoint: '/api/*',
            methods: ['POST'],
          },
        })
      );

      const getContext = createTestContext({ path: '/api/users', method: 'GET' });
      const postContext = createTestContext({ path: '/api/users', method: 'POST' });

      expect(matcher.match(getContext)).toHaveLength(0);
      expect(matcher.match(postContext)).toHaveLength(1);
    });

    it('should match user tiers', () => {
      matcher.addRule(
        createTestRule({
          id: 'pro-only',
          match: {
            endpoint: '/api/*',
            tiers: ['pro', 'enterprise'],
          },
        })
      );

      const freeContext = createTestContext({ tier: 'free' });
      const proContext = createTestContext({ tier: 'pro' });

      expect(matcher.match(freeContext)).toHaveLength(0);
      expect(matcher.match(proContext)).toHaveLength(1);
    });

    it('should match specific user IDs', () => {
      matcher.addRule(
        createTestRule({
          id: 'specific-user',
          match: {
            endpoint: '/api/*',
            userIds: ['user123', 'user456'],
          },
        })
      );

      const matchingContext = createTestContext({ userId: 'user123' });
      const nonMatchingContext = createTestContext({ userId: 'user789' });

      expect(matcher.match(matchingContext)).toHaveLength(1);
      expect(matcher.match(nonMatchingContext)).toHaveLength(0);
    });

    it('should match IP addresses', () => {
      matcher.addRule(
        createTestRule({
          id: 'ip-rule',
          match: {
            endpoint: '/api/*',
            ips: ['192.168.1.0/24'],
          },
        })
      );

      const matchingContext = createTestContext({ ip: '192.168.1.100' });
      const nonMatchingContext = createTestContext({ ip: '10.0.0.1' });

      expect(matcher.match(matchingContext)).toHaveLength(1);
      expect(matcher.match(nonMatchingContext)).toHaveLength(0);
    });

    it('should match API keys with glob patterns', () => {
      matcher.addRule(
        createTestRule({
          id: 'api-key-rule',
          match: {
            endpoint: '/api/*',
            apiKeys: ['key_*'],
          },
        })
      );

      const matchingContext = createTestContext({ apiKey: 'key_abc123' });
      const nonMatchingContext = createTestContext({ apiKey: 'other_key' });

      expect(matcher.match(matchingContext)).toHaveLength(1);
      expect(matcher.match(nonMatchingContext)).toHaveLength(0);
    });

    it('should match custom headers', () => {
      matcher.addRule(
        createTestRule({
          id: 'header-rule',
          match: {
            endpoint: '/api/*',
            headers: { 'x-custom-header': 'expected-value' },
          },
        })
      );

      const matchingContext = createTestContext({
        headers: { 'x-custom-header': 'expected-value' },
      });
      const nonMatchingContext = createTestContext({
        headers: { 'x-custom-header': 'different-value' },
      });

      expect(matcher.match(matchingContext)).toHaveLength(1);
      expect(matcher.match(nonMatchingContext)).toHaveLength(0);
    });

    it('should handle catch-all rules', () => {
      matcher.addRule(
        createTestRule({
          id: 'catch-all',
          match: {}, // No conditions
        })
      );

      const anyContext = createTestContext({ path: '/anything' });
      const matches = matcher.match(anyContext);

      expect(matches).toHaveLength(1);
      expect(matches[0]!.matchedConditions).toContain('catch-all');
    });

    it('should return multiple matching rules sorted by score', () => {
      matcher.addRule(
        createTestRule({
          id: 'general',
          priority: 1,
          match: { endpoint: '/api/**' },
        })
      );
      matcher.addRule(
        createTestRule({
          id: 'specific',
          priority: 10,
          match: {
            endpoint: '/api/users/*',
            methods: ['GET'],
          },
        })
      );

      const context = createTestContext({ path: '/api/users/123', method: 'GET' });
      const matches = matcher.match(context);

      expect(matches.length).toBeGreaterThanOrEqual(1);
      // More specific rule should have higher score
      expect(matches[0]!.rule.id).toBe('specific');
    });
  });

  describe('getBestMatch', () => {
    it('should return the best matching rule', () => {
      matcher.addRule(createTestRule({ id: 'rule1', priority: 1 }));
      matcher.addRule(createTestRule({ id: 'rule2', priority: 100 }));

      const context = createTestContext({ path: '/api/test' });
      const best = matcher.getBestMatch(context);

      expect(best).not.toBeNull();
      expect(best!.rule.id).toBe('rule2');
    });

    it('should return null when no rules match', () => {
      matcher.addRule(
        createTestRule({
          match: { endpoint: '/other/*' },
        })
      );

      const context = createTestContext({ path: '/api/test' });
      const best = matcher.getBestMatch(context);

      expect(best).toBeNull();
    });
  });

  describe('match type scoring', () => {
    it('should score exact matches higher than glob', () => {
      matcher.addRule(
        createTestRule({
          id: 'exact',
          match: {
            endpoint: '/api/users',
            endpointMatchType: 'exact',
          },
        })
      );
      matcher.addRule(
        createTestRule({
          id: 'glob',
          match: {
            endpoint: '/api/*',
            endpointMatchType: 'glob',
          },
        })
      );

      const context = createTestContext({ path: '/api/users' });
      const matches = matcher.match(context);

      expect(matches[0]!.rule.id).toBe('exact');
    });

    it('should score prefix matches', () => {
      matcher.addRule(
        createTestRule({
          id: 'prefix',
          match: {
            endpoint: '/api/',
            endpointMatchType: 'prefix',
          },
        })
      );

      const context = createTestContext({ path: '/api/users/123' });
      const matches = matcher.match(context);

      expect(matches).toHaveLength(1);
    });
  });
});

// =============================================================================
// Key Generator Tests
// =============================================================================

describe('KEY_GENERATORS', () => {
  const context = createTestContext();

  describe('ip strategy', () => {
    it('should generate key based on IP', () => {
      const generator = KEY_GENERATORS['ip'];
      expect(generator(context)).toBe('ip:192.168.1.100');
    });
  });

  describe('user strategy', () => {
    it('should use user ID when available', () => {
      const generator = KEY_GENERATORS['user'];
      expect(generator(context)).toBe('user:user123');
    });

    it('should fall back to IP when no user ID', () => {
      const generator = KEY_GENERATORS['user'];
      const noUserContext = { ...context, userId: undefined };
      expect(generator(noUserContext)).toBe('ip:192.168.1.100');
    });
  });

  describe('api-key strategy', () => {
    it('should use API key when available', () => {
      const generator = KEY_GENERATORS['api-key'];
      expect(generator(context)).toBe('apikey:key_abc123');
    });

    it('should fall back to IP when no API key', () => {
      const generator = KEY_GENERATORS['api-key'];
      const noKeyContext = { ...context, apiKey: undefined };
      expect(generator(noKeyContext)).toBe('ip:192.168.1.100');
    });
  });

  describe('ip-endpoint strategy', () => {
    it('should combine IP, method, and path', () => {
      const generator = KEY_GENERATORS['ip-endpoint'];
      expect(generator(context)).toBe('ip:192.168.1.100:GET:/api/users');
    });
  });

  describe('user-endpoint strategy', () => {
    it('should combine user ID, method, and path', () => {
      const generator = KEY_GENERATORS['user-endpoint'];
      expect(generator(context)).toBe('user:user123:GET:/api/users');
    });

    it('should fall back to IP when no user ID', () => {
      const generator = KEY_GENERATORS['user-endpoint'];
      const noUserContext = { ...context, userId: undefined };
      expect(generator(noUserContext)).toBe('ip:192.168.1.100:GET:/api/users');
    });
  });

  describe('composite strategy', () => {
    it('should include user ID and tier', () => {
      const generator = KEY_GENERATORS['composite'];
      const key = generator(context);
      expect(key).toContain('u:user123');
      expect(key).toContain('t:free');
    });

    it('should include truncated API key', () => {
      const generator = KEY_GENERATORS['composite'];
      const key = generator(context);
      expect(key).toContain('k:key_abc1');
    });

    it('should use IP when no user ID', () => {
      const generator = KEY_GENERATORS['composite'];
      const noUserContext = { ...context, userId: undefined };
      const key = generator(noUserContext);
      expect(key).toContain('ip:192.168.1.100');
    });
  });
});

describe('createKeyGenerator', () => {
  it('should return the correct generator for strategy', () => {
    const generator = createKeyGenerator('ip');
    expect(generator).toBe(KEY_GENERATORS['ip']);
  });
});

describe('generateRateLimitKey', () => {
  it('should generate key without rule', () => {
    const context = createTestContext();
    const key = generateRateLimitKey(context, undefined, 'ip');
    expect(key).toBe('ip:192.168.1.100');
  });

  it('should include rule ID when provided', () => {
    const context = createTestContext();
    const rule = createTestRule({ id: 'my-rule' });
    const key = generateRateLimitKey(context, rule, 'ip');
    expect(key).toBe('my-rule:ip:192.168.1.100');
  });

  it('should use default composite strategy', () => {
    const context = createTestContext();
    const key = generateRateLimitKey(context);
    expect(key).toContain('u:user123');
    expect(key).toContain('t:free');
  });
});

// =============================================================================
// Tier Detection Tests
// =============================================================================

describe('determineTier', () => {
  it('should return anonymous for unauthenticated users', () => {
    const tier = determineTier({});
    expect(tier).toBe('anonymous');
  });

  it('should return free for authenticated users without mapping', () => {
    const tier = determineTier({ userId: 'user123' });
    expect(tier).toBe('free');
  });

  it('should use tier mapping for user ID', () => {
    const tierMapping = new Map<string, RateLimitTier>([['user:vip-user', 'enterprise']]);
    const tier = determineTier({ userId: 'vip-user' }, tierMapping);
    expect(tier).toBe('enterprise');
  });

  it('should use tier mapping for API key', () => {
    const tierMapping = new Map<string, RateLimitTier>([['apikey:premium-key', 'pro']]);
    const tier = determineTier({ apiKey: 'premium-key' }, tierMapping);
    expect(tier).toBe('pro');
  });

  it('should prioritize user ID mapping over API key', () => {
    const tierMapping = new Map<string, RateLimitTier>([
      ['user:vip-user', 'enterprise'],
      ['apikey:premium-key', 'pro'],
    ]);
    const tier = determineTier({ userId: 'vip-user', apiKey: 'premium-key' }, tierMapping);
    expect(tier).toBe('enterprise');
  });
});

// =============================================================================
// Bypass Checker Tests
// =============================================================================

describe('BypassChecker', () => {
  let checker: BypassChecker;

  beforeEach(() => {
    // Create a fresh checker with empty config for each test
    checker = new BypassChecker({
      ips: [],
      userIds: [],
      apiKeys: [],
      paths: [],
      internal: true,
    });
  });

  describe('constructor', () => {
    it('should initialize with default config', () => {
      const config = checker.getConfig();
      expect(config.ips).toEqual([]);
      expect(config.userIds).toEqual([]);
      expect(config.apiKeys).toEqual([]);
      expect(config.paths).toEqual([]);
      expect(config.internal).toBe(true);
    });

    it('should initialize with provided config', () => {
      const customChecker = new BypassChecker({
        ips: ['10.0.0.1'],
        internal: false,
      });
      const config = customChecker.getConfig();
      expect(config.ips).toContain('10.0.0.1');
      expect(config.internal).toBe(false);
    });
  });

  describe('shouldBypass', () => {
    it('should bypass for whitelisted IPs', () => {
      checker.addIP('192.168.1.100');
      const context = createTestContext({ ip: '192.168.1.100' });
      const result = checker.shouldBypass(context);

      expect(result.bypass).toBe(true);
      expect(result.reason).toBe('ip_whitelist');
    });

    it('should bypass for internal IPs when enabled', () => {
      const context = createTestContext({ ip: '127.0.0.1' });
      const result = checker.shouldBypass(context);

      expect(result.bypass).toBe(true);
      expect(result.reason).toBe('internal_ip');
    });

    it('should not bypass for internal IPs when disabled', () => {
      checker.setInternalBypass(false);
      const context = createTestContext({ ip: '127.0.0.1' });
      const result = checker.shouldBypass(context);

      expect(result.bypass).toBe(false);
    });

    it('should bypass for whitelisted user IDs', () => {
      checker.addUser('admin-user');
      // Use an external IP to avoid internal IP bypass
      const context = createTestContext({ userId: 'admin-user', ip: '8.8.8.8' });
      const result = checker.shouldBypass(context);

      expect(result.bypass).toBe(true);
      expect(result.reason).toBe('user_whitelist');
    });

    it('should bypass for whitelisted API keys', () => {
      checker.addAPIKey('master-key');
      // Use an external IP to avoid internal IP bypass
      const context = createTestContext({ apiKey: 'master-key', ip: '8.8.8.8' });
      const result = checker.shouldBypass(context);

      expect(result.bypass).toBe(true);
      expect(result.reason).toBe('apikey_whitelist');
    });

    it('should bypass for whitelisted paths', () => {
      checker.addPath('/health');
      // Use an external IP to avoid internal IP bypass
      const context = createTestContext({ path: '/health', ip: '8.8.8.8' });
      const result = checker.shouldBypass(context);

      expect(result.bypass).toBe(true);
      expect(result.reason).toBe('path_whitelist');
    });

    it('should support glob patterns in path whitelist', () => {
      checker.addPath('/internal/**');
      // Use an external IP to avoid internal IP bypass
      const context = createTestContext({ path: '/internal/admin/users', ip: '8.8.8.8' });
      const result = checker.shouldBypass(context);

      expect(result.bypass).toBe(true);
    });

    it('should not bypass when no conditions match', () => {
      const context = createTestContext({
        ip: '8.8.8.8', // External IP
        userId: 'regular-user',
        apiKey: 'regular-key',
        path: '/api/data',
      });
      const result = checker.shouldBypass(context);

      expect(result.bypass).toBe(false);
      expect(result.reason).toBe('none');
    });
  });

  describe('isIPWhitelisted', () => {
    it('should match exact IPs', () => {
      checker.addIP('10.0.0.1');
      expect(checker.isIPWhitelisted('10.0.0.1')).toBe(true);
      expect(checker.isIPWhitelisted('10.0.0.2')).toBe(false);
    });

    it('should match CIDR ranges', () => {
      checker.addIP('10.0.0.0/24');
      expect(checker.isIPWhitelisted('10.0.0.1')).toBe(true);
      expect(checker.isIPWhitelisted('10.0.0.255')).toBe(true);
      expect(checker.isIPWhitelisted('10.0.1.1')).toBe(false);
    });
  });

  describe('isInternalIP', () => {
    it('should recognize loopback addresses', () => {
      expect(checker.isInternalIP('127.0.0.1')).toBe(true);
      expect(checker.isInternalIP('127.0.0.255')).toBe(true);
    });

    it('should recognize private class A', () => {
      expect(checker.isInternalIP('10.0.0.1')).toBe(true);
      expect(checker.isInternalIP('10.255.255.255')).toBe(true);
    });

    it('should recognize private class B', () => {
      expect(checker.isInternalIP('172.16.0.1')).toBe(true);
      expect(checker.isInternalIP('172.31.255.255')).toBe(true);
    });

    it('should recognize private class C', () => {
      expect(checker.isInternalIP('192.168.0.1')).toBe(true);
      expect(checker.isInternalIP('192.168.255.255')).toBe(true);
    });

    it('should not recognize public IPs as internal', () => {
      expect(checker.isInternalIP('8.8.8.8')).toBe(false);
      expect(checker.isInternalIP('1.1.1.1')).toBe(false);
    });

    it('should handle IPv4-mapped IPv6 addresses', () => {
      expect(checker.isInternalIP('::ffff:127.0.0.1')).toBe(true);
      expect(checker.isInternalIP('::ffff:192.168.1.1')).toBe(true);
    });
  });

  describe('isUserWhitelisted', () => {
    it('should check exact user ID match', () => {
      checker.addUser('admin');
      expect(checker.isUserWhitelisted('admin')).toBe(true);
      expect(checker.isUserWhitelisted('user')).toBe(false);
    });
  });

  describe('isAPIKeyWhitelisted', () => {
    it('should match exact API keys', () => {
      checker.addAPIKey('secret-key');
      expect(checker.isAPIKeyWhitelisted('secret-key')).toBe(true);
      expect(checker.isAPIKeyWhitelisted('other-key')).toBe(false);
    });

    it('should support glob patterns', () => {
      checker.addAPIKey('admin_*');
      expect(checker.isAPIKeyWhitelisted('admin_123')).toBe(true);
      expect(checker.isAPIKeyWhitelisted('user_123')).toBe(false);
    });
  });

  describe('isPathWhitelisted', () => {
    it('should match exact paths', () => {
      checker.addPath('/health');
      expect(checker.isPathWhitelisted('/health')).toBe(true);
      expect(checker.isPathWhitelisted('/ready')).toBe(false);
    });

    it('should support glob patterns with single asterisk', () => {
      checker.addPath('/internal/*');
      expect(checker.isPathWhitelisted('/internal/status')).toBe(true);
      // Single asterisk should not match nested paths
      expect(checker.isPathWhitelisted('/internal/deep/path')).toBe(false);
    });

    it('should support glob patterns with double asterisk', () => {
      checker.addPath('/admin/**');
      expect(checker.isPathWhitelisted('/admin/users/123')).toBe(true);
    });
  });

  describe('management methods', () => {
    it('should add and remove IPs', () => {
      // Use a fresh checker to avoid state from other tests
      const freshChecker = new BypassChecker({
        ips: [],
        userIds: [],
        apiKeys: [],
        paths: [],
        internal: false,
      });
      freshChecker.addIP('10.0.0.1');
      expect(freshChecker.isIPWhitelisted('10.0.0.1')).toBe(true);

      freshChecker.removeIP('10.0.0.1');
      expect(freshChecker.isIPWhitelisted('10.0.0.1')).toBe(false);
    });

    it('should add and remove users', () => {
      checker.addUser('admin');
      expect(checker.isUserWhitelisted('admin')).toBe(true);

      checker.removeUser('admin');
      expect(checker.isUserWhitelisted('admin')).toBe(false);
    });

    it('should add and remove API keys', () => {
      checker.addAPIKey('key');
      expect(checker.isAPIKeyWhitelisted('key')).toBe(true);

      checker.removeAPIKey('key');
      expect(checker.isAPIKeyWhitelisted('key')).toBe(false);
    });

    it('should add and remove paths', () => {
      checker.addPath('/test');
      expect(checker.isPathWhitelisted('/test')).toBe(true);

      checker.removePath('/test');
      expect(checker.isPathWhitelisted('/test')).toBe(false);
    });

    it('should not add duplicates', () => {
      checker.addIP('10.0.0.1');
      checker.addIP('10.0.0.1');
      const config = checker.getConfig();
      expect(config.ips.filter((ip) => ip === '10.0.0.1')).toHaveLength(1);
    });

    it('should clear all entries', () => {
      // Use a fresh checker
      const freshChecker = new BypassChecker({
        ips: [],
        userIds: [],
        apiKeys: [],
        paths: [],
        internal: false,
      });
      freshChecker.addIP('10.0.0.1');
      freshChecker.addUser('admin');
      freshChecker.addAPIKey('key');
      freshChecker.addPath('/test');

      freshChecker.clearAll();

      const config = freshChecker.getConfig();
      expect(config.ips).toEqual([]);
      expect(config.userIds).toEqual([]);
      expect(config.apiKeys).toEqual([]);
      expect(config.paths).toEqual([]);
    });
  });

  describe('setConfig', () => {
    it('should update configuration', () => {
      checker.setConfig({
        ips: ['1.1.1.1'],
        internal: false,
      });

      const config = checker.getConfig();
      expect(config.ips).toContain('1.1.1.1');
      expect(config.internal).toBe(false);
    });
  });
});

describe('createBypassChecker factory', () => {
  it('should create checker with default config', () => {
    const checker = createBypassChecker();
    expect(checker).toBeInstanceOf(BypassChecker);
  });

  it('should create checker with custom config', () => {
    const checker = createBypassChecker({
      ips: ['10.0.0.0/8'],
    });
    expect(checker.isIPWhitelisted('10.0.0.1')).toBe(true);
  });
});

describe('createRuleMatcher factory', () => {
  it('should create matcher with no rules', () => {
    const matcher = createRuleMatcher();
    expect(matcher).toBeInstanceOf(RuleMatcher);
    expect(matcher.getRules()).toEqual([]);
  });

  it('should create matcher with rules', () => {
    const rules = [createTestRule()];
    const matcher = createRuleMatcher(rules);
    expect(matcher.getRules()).toHaveLength(1);
  });
});
