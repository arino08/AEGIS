/**
 * AEGIS - Route Matcher
 * Handles matching incoming requests to backend services based on configured routes
 */

import type { BackendConfig, RouteMatch } from '../utils/types.js';

// =============================================================================
// Route Pattern Types
// =============================================================================

interface CompiledRoute {
  pattern: string;
  regex: RegExp;
  specificity: number;
  backend: BackendConfig;
}

// =============================================================================
// Router Class
// =============================================================================

export class Router {
  private routes: CompiledRoute[] = [];
  private backends = new Map<string, BackendConfig>();

  constructor() {
    this.routes = [];
    this.backends = new Map();
  }

  /**
   * Register backends and compile their routes
   */
  public registerBackends(backends: BackendConfig[]): void {
    this.routes = [];
    this.backends.clear();

    for (const backend of backends) {
      this.backends.set(backend.name, backend);

      for (const pattern of backend.routes) {
        const compiled = this.compileRoute(pattern, backend);
        this.routes.push(compiled);
      }
    }

    // Sort routes by specificity (most specific first)
    this.routes.sort((a, b) => b.specificity - a.specificity);
  }

  /**
   * Compile a route pattern into a regex and calculate specificity
   */
  private compileRoute(pattern: string, backend: BackendConfig): CompiledRoute {
    // Calculate specificity:
    // - More segments = higher specificity
    // - Literal segments > wildcard segments
    // - Single wildcard (*) > double wildcard (**)
    const segments = pattern.split('/').filter((s) => s.length > 0);
    let specificity = segments.length * 100;

    for (const segment of segments) {
      if (segment === '**') {
        specificity -= 50;
      } else if (segment === '*' || segment.includes('*')) {
        specificity -= 10;
      } else if (segment.startsWith(':')) {
        specificity -= 5;
      } else {
        specificity += 10; // Literal segment bonus
      }
    }

    // Build regex pattern
    const regexPattern = this.patternToRegex(pattern);

    return {
      pattern,
      regex: new RegExp(regexPattern),
      specificity,
      backend,
    };
  }

  /**
   * Convert a route pattern to a regex string
   * Supports:
   *   - Exact matches: /api/users
   *   - Single wildcards: /api/* (matches one segment)
   *   - Double wildcards: /api/** (matches any number of segments)
   *   - Named parameters: /api/:id (matches one segment, captured)
   */
  private patternToRegex(pattern: string): string {
    // Escape special regex characters (except * and :)
    let regex = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      // Replace ** with placeholder
      .replace(/\*\*/g, '<<<DOUBLE_STAR>>>')
      // Replace * with single segment match
      .replace(/\*/g, '[^/]+')
      // Replace named parameters :param with capture group
      .replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, '(?<$1>[^/]+)')
      // Replace ** placeholder with multi-segment match
      .replace(/<<<DOUBLE_STAR>>>/g, '.*');

    // Ensure pattern matches from start
    if (!regex.startsWith('^')) {
      regex = '^' + regex;
    }

    // Add optional trailing slash and end anchor
    if (!regex.endsWith('$')) {
      // Allow optional trailing slash
      regex = regex.replace(/\/$/, '');
      regex += '/?$';
    }

    return regex;
  }

  /**
   * Match a request path to a backend
   */
  public match(path: string): RouteMatch | null {
    // Normalize path
    const normalizedPath = this.normalizePath(path);

    for (const route of this.routes) {
      if (route.regex.test(normalizedPath)) {
        return {
          backend: route.backend,
          matchedPattern: route.pattern,
        };
      }
    }

    return null;
  }

  /**
   * Match a request path and return all matching routes (for debugging)
   */
  public matchAll(path: string): RouteMatch[] {
    const normalizedPath = this.normalizePath(path);
    const matches: RouteMatch[] = [];

    for (const route of this.routes) {
      if (route.regex.test(normalizedPath)) {
        matches.push({
          backend: route.backend,
          matchedPattern: route.pattern,
        });
      }
    }

    return matches;
  }

  /**
   * Normalize a path for consistent matching
   */
  private normalizePath(path: string): string {
    // Remove query string
    const queryIndex = path.indexOf('?');
    let normalized = queryIndex !== -1 ? path.substring(0, queryIndex) : path;

    // Remove fragment
    const fragmentIndex = normalized.indexOf('#');
    if (fragmentIndex !== -1) {
      normalized = normalized.substring(0, fragmentIndex);
    }

    // Ensure leading slash
    if (!normalized.startsWith('/')) {
      normalized = '/' + normalized;
    }

    // Remove trailing slash (except for root)
    if (normalized.length > 1 && normalized.endsWith('/')) {
      normalized = normalized.slice(0, -1);
    }

    // Collapse multiple slashes
    normalized = normalized.replace(/\/+/g, '/');

    return normalized;
  }

  /**
   * Get a backend by name
   */
  public getBackend(name: string): BackendConfig | undefined {
    return this.backends.get(name);
  }

  /**
   * Get all registered backends
   */
  public getAllBackends(): BackendConfig[] {
    return Array.from(this.backends.values());
  }

  /**
   * Get all registered routes (for debugging)
   */
  public getRoutes(): { pattern: string; backend: string; specificity: number }[] {
    return this.routes.map((r) => ({
      pattern: r.pattern,
      backend: r.backend.name,
      specificity: r.specificity,
    }));
  }

  /**
   * Check if any routes are registered
   */
  public hasRoutes(): boolean {
    return this.routes.length > 0;
  }

  /**
   * Clear all routes
   */
  public clear(): void {
    this.routes = [];
    this.backends.clear();
  }

  /**
   * Extract path parameters from a matched route
   */
  public extractParams(path: string, pattern: string): Record<string, string> {
    const normalizedPath = this.normalizePath(path);
    const regex = new RegExp(this.patternToRegex(pattern));
    const match = regex.exec(normalizedPath);

    if (match?.groups) {
      return { ...match.groups };
    }

    return {};
  }
}

// =============================================================================
// Singleton Instance
// =============================================================================

let routerInstance: Router | null = null;

export function getRouter(): Router {
  if (routerInstance === null) {
    routerInstance = new Router();
  }
  return routerInstance;
}

export function createRouter(): Router {
  return new Router();
}

export default Router;
