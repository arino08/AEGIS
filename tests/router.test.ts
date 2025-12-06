/**
 * AEGIS - Router Tests
 * Unit tests for the route matching functionality
 */

import { Router, createRouter } from '../src/gateway/router.js';
import type { BackendConfig } from '../src/utils/types.js';

describe('Router', () => {
  let router: Router;

  beforeEach(() => {
    router = createRouter();
  });

  afterEach(() => {
    router.clear();
  });

  describe('registerBackends', () => {
    it('should register backends and their routes', () => {
      const backends: BackendConfig[] = [
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
      ];

      router.registerBackends(backends);

      expect(router.hasRoutes()).toBe(true);
      expect(router.getAllBackends()).toHaveLength(2);
    });

    it('should clear existing routes when registering new backends', () => {
      const backends1: BackendConfig[] = [
        {
          name: 'service-1',
          url: 'http://localhost:3000',
          routes: ['/v1/*'],
        },
      ];

      const backends2: BackendConfig[] = [
        {
          name: 'service-2',
          url: 'http://localhost:3001',
          routes: ['/v2/*'],
        },
      ];

      router.registerBackends(backends1);
      router.registerBackends(backends2);

      expect(router.getAllBackends()).toHaveLength(1);
      expect(router.getBackend('service-1')).toBeUndefined();
      expect(router.getBackend('service-2')).toBeDefined();
    });
  });

  describe('match', () => {
    beforeEach(() => {
      const backends: BackendConfig[] = [
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
          name: 'users-service',
          url: 'http://localhost:3002',
          routes: ['/users/:id', '/users'],
        },
      ];

      router.registerBackends(backends);
    });

    it('should match exact paths', () => {
      const match = router.match('/users');
      expect(match).not.toBeNull();
      expect(match?.backend.name).toBe('users-service');
    });

    it('should match single wildcard patterns', () => {
      const match = router.match('/api/resource');
      expect(match).not.toBeNull();
      expect(match?.backend.name).toBe('api-service');
    });

    it('should match double wildcard patterns', () => {
      const match = router.match('/api/v1/resources/123/details');
      expect(match).not.toBeNull();
      expect(match?.backend.name).toBe('api-service');
    });

    it('should match named parameters', () => {
      const match = router.match('/users/123');
      expect(match).not.toBeNull();
      expect(match?.backend.name).toBe('users-service');
    });

    it('should return null for unmatched paths', () => {
      const match = router.match('/unknown/path');
      expect(match).toBeNull();
    });

    it('should match paths with query strings (stripping the query)', () => {
      const match = router.match('/api/resource?foo=bar');
      expect(match).not.toBeNull();
      expect(match?.backend.name).toBe('api-service');
    });

    it('should handle paths with trailing slashes', () => {
      const match = router.match('/auth/login/');
      expect(match).not.toBeNull();
      expect(match?.backend.name).toBe('auth-service');
    });

    it('should normalize paths with multiple slashes', () => {
      const match = router.match('//api//resource');
      expect(match).not.toBeNull();
      expect(match?.backend.name).toBe('api-service');
    });
  });

  describe('matchAll', () => {
    it('should return all matching routes', () => {
      const backends: BackendConfig[] = [
        {
          name: 'catch-all',
          url: 'http://localhost:3000',
          routes: ['/**'],
        },
        {
          name: 'api-service',
          url: 'http://localhost:3001',
          routes: ['/api/**'],
        },
      ];

      router.registerBackends(backends);

      const matches = router.matchAll('/api/users');
      expect(matches.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('getRoutes', () => {
    it('should return all registered routes with their backends', () => {
      const backends: BackendConfig[] = [
        {
          name: 'api-service',
          url: 'http://localhost:3000',
          routes: ['/api/*'],
        },
      ];

      router.registerBackends(backends);

      const routes = router.getRoutes();
      expect(routes).toHaveLength(1);
      expect(routes[0]).toMatchObject({
        pattern: '/api/*',
        backend: 'api-service',
      });
    });
  });

  describe('extractParams', () => {
    it('should extract named parameters from a path', () => {
      const backends: BackendConfig[] = [
        {
          name: 'users-service',
          url: 'http://localhost:3000',
          routes: ['/users/:userId/posts/:postId'],
        },
      ];

      router.registerBackends(backends);

      const params = router.extractParams(
        '/users/123/posts/456',
        '/users/:userId/posts/:postId'
      );

      expect(params).toEqual({
        userId: '123',
        postId: '456',
      });
    });

    it('should return empty object when no params in pattern', () => {
      const params = router.extractParams('/api/users', '/api/users');
      expect(params).toEqual({});
    });
  });

  describe('clear', () => {
    it('should remove all routes and backends', () => {
      const backends: BackendConfig[] = [
        {
          name: 'api-service',
          url: 'http://localhost:3000',
          routes: ['/api/*'],
        },
      ];

      router.registerBackends(backends);
      expect(router.hasRoutes()).toBe(true);

      router.clear();
      expect(router.hasRoutes()).toBe(false);
      expect(router.getAllBackends()).toHaveLength(0);
    });
  });

  describe('specificity', () => {
    it('should match more specific routes first', () => {
      const backends: BackendConfig[] = [
        {
          name: 'general-api',
          url: 'http://localhost:3000',
          routes: ['/api/**'],
        },
        {
          name: 'specific-api',
          url: 'http://localhost:3001',
          routes: ['/api/v1/users'],
        },
      ];

      router.registerBackends(backends);

      const match = router.match('/api/v1/users');
      expect(match).not.toBeNull();
      expect(match?.backend.name).toBe('specific-api');
    });

    it('should prefer exact matches over wildcards', () => {
      const backends: BackendConfig[] = [
        {
          name: 'wildcard',
          url: 'http://localhost:3000',
          routes: ['/api/*'],
        },
        {
          name: 'exact',
          url: 'http://localhost:3001',
          routes: ['/api/health'],
        },
      ];

      router.registerBackends(backends);

      const match = router.match('/api/health');
      expect(match).not.toBeNull();
      expect(match?.backend.name).toBe('exact');
    });
  });
});
