/**
 * AEGIS - Gateway Tests
 * Basic unit tests for the gateway functionality
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';

import { Router } from '../src/gateway/router.js';
import { matchesPattern, findBestMatch, generateRequestId, parseDuration } from '../src/utils/helpers.js';

// =============================================================================
// Router Tests
// =============================================================================

describe('Router', () => {
  let router: Router;

  beforeAll(() => {
    router = new Router();
  });

  afterAll(() => {
    router.clear();
  });

  describe('registerBackends', () => {
    it('should register backends with routes', () => {
      router.registerBackends([
        {
          name: 'api-service',
          url: 'http://localhost:3000',
          routes: ['/api/*', '/api/**'],
        },
        {
          name: 'auth-service',
          url: 'http://localhost:3001',
          routes: ['/auth/*'],
        },
      ]);

      expect(router.hasRoutes()).toBe(true);
      expect(router.getAllBackends()).toHaveLength(2);
    });

    it('should get backend by name', () => {
      const backend = router.getBackend('api-service');
      expect(backend).toBeDefined();
      expect(backend?.url).toBe('http://localhost:3000');
    });

    it('should return undefined for non-existent backend', () => {
      const backend = router.getBackend('non-existent');
      expect(backend).toBeUndefined();
    });
  });

  describe('match', () => {
    beforeAll(() => {
      router.registerBackends([
        {
          name: 'api-service',
          url: 'http://localhost:3000',
          routes: ['/api/*', '/api/**'],
        },
        {
          name: 'auth-service',
          url: 'http://localhost:3001',
          routes: ['/auth/*', '/auth/**'],
        },
        {
          name: 'specific-service',
          url: 'http://localhost:3002',
          routes: ['/api/specific/endpoint'],
        },
      ]);
    });

    it('should match exact paths', () => {
      const match = router.match('/api/specific/endpoint');
      expect(match).not.toBeNull();
      expect(match?.backend.name).toBe('specific-service');
    });

    it('should match wildcard paths', () => {
      const match = router.match('/api/users');
      expect(match).not.toBeNull();
      expect(match?.backend.name).toBe('api-service');
    });

    it('should match double wildcard paths', () => {
      const match = router.match('/api/users/123/profile');
      expect(match).not.toBeNull();
      expect(match?.backend.name).toBe('api-service');
    });

    it('should match auth service routes', () => {
      const match = router.match('/auth/login');
      expect(match).not.toBeNull();
      expect(match?.backend.name).toBe('auth-service');
    });

    it('should return null for unmatched paths', () => {
      const match = router.match('/unknown/path');
      expect(match).toBeNull();
    });

    it('should handle paths with query strings', () => {
      const match = router.match('/api/users?page=1&limit=10');
      expect(match).not.toBeNull();
      expect(match?.backend.name).toBe('api-service');
    });

    it('should handle paths with trailing slashes', () => {
      const match = router.match('/api/users/');
      expect(match).not.toBeNull();
    });
  });

  describe('clear', () => {
    it('should remove all routes', () => {
      router.clear();
      expect(router.hasRoutes()).toBe(false);
      expect(router.getAllBackends()).toHaveLength(0);
    });
  });
});

// =============================================================================
// Pattern Matching Helper Tests
// =============================================================================

describe('Pattern Matching Helpers', () => {
  describe('matchesPattern', () => {
    it('should match exact paths', () => {
      expect(matchesPattern('/api/users', '/api/users')).toBe(true);
      expect(matchesPattern('/api/users', '/api/posts')).toBe(false);
    });

    it('should match single wildcard', () => {
      expect(matchesPattern('/api/users', '/api/*')).toBe(true);
      expect(matchesPattern('/api/users/123', '/api/*')).toBe(false);
    });

    it('should match double wildcard', () => {
      expect(matchesPattern('/api/users', '/api/**')).toBe(true);
      expect(matchesPattern('/api/users/123', '/api/**')).toBe(true);
      expect(matchesPattern('/api/users/123/profile', '/api/**')).toBe(true);
    });

    it('should not match unrelated paths', () => {
      expect(matchesPattern('/auth/login', '/api/*')).toBe(false);
      expect(matchesPattern('/auth/login', '/api/**')).toBe(false);
    });
  });

  describe('findBestMatch', () => {
    it('should find the most specific match', () => {
      const patterns = ['/api/**', '/api/*', '/api/users'];
      expect(findBestMatch('/api/users', patterns)).toBe('/api/users');
    });

    it('should prefer single wildcard over double', () => {
      const patterns = ['/api/**', '/api/*'];
      expect(findBestMatch('/api/users', patterns)).toBe('/api/*');
    });

    it('should return null for no matches', () => {
      const patterns = ['/api/*', '/api/**'];
      expect(findBestMatch('/auth/login', patterns)).toBeNull();
    });
  });
});

// =============================================================================
// Utility Function Tests
// =============================================================================

describe('Utility Functions', () => {
  describe('generateRequestId', () => {
    it('should generate a valid UUID', () => {
      const id = generateRequestId();
      expect(id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      );
    });

    it('should generate unique IDs', () => {
      const id1 = generateRequestId();
      const id2 = generateRequestId();
      expect(id1).not.toBe(id2);
    });
  });

  describe('parseDuration', () => {
    it('should parse milliseconds', () => {
      expect(parseDuration('100ms')).toBe(100);
      expect(parseDuration('500ms')).toBe(500);
    });

    it('should parse seconds', () => {
      expect(parseDuration('1s')).toBe(1000);
      expect(parseDuration('5s')).toBe(5000);
    });

    it('should parse minutes', () => {
      expect(parseDuration('1m')).toBe(60000);
      expect(parseDuration('5m')).toBe(300000);
    });

    it('should parse hours', () => {
      expect(parseDuration('1h')).toBe(3600000);
      expect(parseDuration('2h')).toBe(7200000);
    });

    it('should parse days', () => {
      expect(parseDuration('1d')).toBe(86400000);
    });

    it('should throw for invalid format', () => {
      expect(() => parseDuration('invalid')).toThrow();
      expect(() => parseDuration('100')).toThrow();
    });
  });
});

// =============================================================================
// Integration Tests (require running services)
// =============================================================================

describe('Gateway Integration', () => {
  // These tests would require a running gateway and backend services
  // They are skipped by default and can be enabled for integration testing

  describe.skip('HTTP Proxy', () => {
    it('should forward GET requests to backend', async () => {
      // TODO: Implement when integration test infrastructure is ready
    });

    it('should forward POST requests with body', async () => {
      // TODO: Implement when integration test infrastructure is ready
    });

    it('should handle backend errors gracefully', async () => {
      // TODO: Implement when integration test infrastructure is ready
    });

    it('should timeout slow backend requests', async () => {
      // TODO: Implement when integration test infrastructure is ready
    });
  });
});
