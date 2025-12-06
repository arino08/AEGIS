/**
 * AEGIS - Authentication Service
 *
 * Multi-auth support: API Keys, JWT, OAuth 2.0
 */

import { createHash } from 'crypto';
import type { Request } from 'express';
import * as jose from 'jose';

import logger from '../utils/logger.js';
import type {
  AuthConfig,
  AuthenticatedUser,
  ApiKeyRecord,
  JwtPayload,
  AuthEvent,
} from './types.js';

// =============================================================================
// Authentication Service
// =============================================================================

export class AuthService {
  private config: AuthConfig;
  private apiKeyCache: Map<string, ApiKeyRecord> = new Map();
  private jwksCache: Map<string, unknown> = new Map();

  constructor(config: AuthConfig) {
    this.config = config;
  }

  /**
   * Authenticate a request using configured auth methods
   */
  async authenticate(req: Request): Promise<AuthenticatedUser | null> {
    // Check if path is in anonymous paths
    if (this.isAnonymousPath(req.path)) {
      return this.createAnonymousUser(req);
    }

    const authHeader = req.headers.authorization;
    const apiKeyHeader = req.headers[this.config.apiKey?.headerName?.toLowerCase() || 'x-api-key'];

    // Try API Key authentication
    if (this.config.apiKey?.enabled && apiKeyHeader) {
      const apiKey = this.extractApiKey(apiKeyHeader as string);
      if (apiKey) {
        const user = await this.authenticateApiKey(apiKey, req);
        if (user) {
          req.authType = 'api-key';
          req.apiKey = apiKey;
          return user;
        }
      }
    }

    // Try JWT authentication
    if (this.config.jwt?.enabled && authHeader?.startsWith('Bearer ')) {
      const token = authHeader.substring(7);
      const user = await this.authenticateJwt(token, req);
      if (user) {
        req.authType = 'jwt';
        req.token = token;
        return user;
      }
    }

    // Try OAuth authentication
    if (this.config.oauth && authHeader?.startsWith('Bearer ')) {
      const token = authHeader.substring(7);
      const user = await this.authenticateOAuth(token, req);
      if (user) {
        req.authType = 'oauth';
        req.token = token;
        return user;
      }
    }

    // Allow anonymous if configured
    if (this.config.allowAnonymous) {
      return this.createAnonymousUser(req);
    }

    return null;
  }

  /**
   * Check if path allows anonymous access
   */
  private isAnonymousPath(path: string): boolean {
    return this.config.anonymousPaths?.some((pattern) => {
      if (pattern.endsWith('*')) {
        return path.startsWith(pattern.slice(0, -1));
      }
      return path === pattern;
    }) ?? false;
  }

  /**
   * Create anonymous user
   */
  private createAnonymousUser(_req: Request): AuthenticatedUser {
    return {
      id: 'anonymous',
      roles: ['anonymous'],
      permissions: {},
      tier: 'anonymous',
      authType: 'none',
    };
  }

  /**
   * Extract API key from header value
   */
  private extractApiKey(headerValue: string): string | null {
    const prefix = this.config.apiKey?.prefix || '';
    if (prefix && headerValue.startsWith(prefix)) {
      return headerValue.substring(prefix.length).trim();
    }
    return headerValue.trim();
  }

  /**
   * Authenticate using API key
   */
  async authenticateApiKey(apiKey: string, req: Request): Promise<AuthenticatedUser | null> {
    try {
      // Check cache first
      const keyHash = this.hashApiKey(apiKey);
      let record = this.apiKeyCache.get(keyHash);

      if (!record) {
        // Look up in database (implement your own storage)
        const lookedUp = await this.lookupApiKey(keyHash);
        if (lookedUp) {
          record = lookedUp;
          this.apiKeyCache.set(keyHash, record);
        }
      }

      if (!record) {
        this.emitAuthEvent({
          type: 'auth_failure',
          authType: 'api-key',
          ip: this.getClientIp(req),
          path: req.path,
          method: req.method,
          timestamp: new Date(),
          reason: 'Invalid API key',
        });
        return null;
      }

      // Check if key is enabled
      if (!record.enabled) {
        this.emitAuthEvent({
          type: 'auth_failure',
          authType: 'api-key',
          userId: record.userId,
          ip: this.getClientIp(req),
          path: req.path,
          method: req.method,
          timestamp: new Date(),
          reason: 'API key disabled',
        });
        return null;
      }

      // Check expiration
      if (record.expiresAt && record.expiresAt < new Date()) {
        this.emitAuthEvent({
          type: 'token_expired',
          authType: 'api-key',
          userId: record.userId,
          ip: this.getClientIp(req),
          path: req.path,
          method: req.method,
          timestamp: new Date(),
          reason: 'API key expired',
        });
        return null;
      }

      // Update last used timestamp (async, don't await)
      this.updateApiKeyLastUsed(keyHash).catch(() => {});

      this.emitAuthEvent({
        type: 'auth_success',
        authType: 'api-key',
        userId: record.userId,
        ip: this.getClientIp(req),
        path: req.path,
        method: req.method,
        timestamp: new Date(),
      });

      return {
        id: record.userId,
        roles: record.roles,
        permissions: record.permissions,
        tier: record.tier,
        authType: 'api-key',
        metadata: record.metadata,
      };
    } catch (error) {
      logger.error('API key authentication error', {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Authenticate using JWT
   */
  async authenticateJwt(token: string, req: Request): Promise<AuthenticatedUser | null> {
    try {
      const jwtConfig = this.config.jwt!;
      const secret = jwtConfig.secret || jwtConfig.publicKey;

      if (!secret) {
        logger.error('JWT secret or public key not configured');
        return null;
      }

      // Create secret key for verification
      const secretKey = new TextEncoder().encode(secret);

      // Verify the token using jose
      const { payload } = await jose.jwtVerify(token, secretKey, {
        issuer: jwtConfig.issuer,
        audience: jwtConfig.audience,
        clockTolerance: jwtConfig.clockTolerance || 0,
      });

      const decoded = payload as unknown as JwtPayload;

      this.emitAuthEvent({
        type: 'auth_success',
        authType: 'jwt',
        userId: decoded.sub,
        ip: this.getClientIp(req),
        path: req.path,
        method: req.method,
        timestamp: new Date(),
      });

      return {
        id: decoded.sub,
        email: decoded.email,
        roles: decoded.roles || [this.config.rbac?.defaultRole || 'user'],
        permissions: decoded.permissions || {},
        tier: decoded.tier || 'free',
        authType: 'jwt',
        tokenExp: new Date(decoded.exp * 1000),
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const isExpired = errorMessage.includes('expired');

      this.emitAuthEvent({
        type: isExpired ? 'token_expired' : 'auth_failure',
        authType: 'jwt',
        ip: this.getClientIp(req),
        path: req.path,
        method: req.method,
        timestamp: new Date(),
        reason: errorMessage,
      });

      logger.debug('JWT authentication failed', { error: errorMessage });
      return null;
    }
  }

  /**
   * Authenticate using OAuth 2.0 (token introspection or JWKS)
   */
  async authenticateOAuth(token: string, req: Request): Promise<AuthenticatedUser | null> {
    try {
      const oauthConfig = this.config.oauth!;

      // For providers like Auth0/Okta, validate using JWKS
      if (oauthConfig.jwksUri) {
        return this.validateWithJwks(token, oauthConfig, req);
      }

      // For custom providers, use token introspection endpoint
      if (oauthConfig.tokenEndpoint) {
        return this.introspectToken(token, oauthConfig, req);
      }

      logger.error('OAuth not properly configured - need jwksUri or tokenEndpoint');
      return null;
    } catch (error) {
      logger.error('OAuth authentication error', {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Validate token using JWKS (JSON Web Key Set)
   */
  private async validateWithJwks(
    token: string,
    oauthConfig: AuthConfig['oauth'],
    req: Request
  ): Promise<AuthenticatedUser | null> {
    try {
      // Create a remote JWKS fetcher with caching
      const jwksUri = oauthConfig!.jwksUri!;
      let jwks = this.jwksCache.get(jwksUri) as ReturnType<typeof jose.createRemoteJWKSet> | undefined;

      if (!jwks) {
        jwks = jose.createRemoteJWKSet(new URL(jwksUri));
        this.jwksCache.set(jwksUri, jwks);
      }

      // Verify the token using jose with JWKS
      const { payload } = await jose.jwtVerify(token, jwks, {
        issuer: oauthConfig!.issuer,
        audience: oauthConfig!.audience,
      });

      const decoded = payload as unknown as JwtPayload;

      this.emitAuthEvent({
        type: 'auth_success',
        authType: 'oauth',
        userId: decoded.sub,
        ip: this.getClientIp(req),
        path: req.path,
        method: req.method,
        timestamp: new Date(),
        metadata: { provider: oauthConfig!.provider },
      });

      return {
        id: decoded.sub,
        email: decoded.email,
        roles: decoded.roles || [this.config.rbac?.defaultRole || 'user'],
        permissions: decoded.permissions || {},
        tier: decoded.tier || 'free',
        authType: 'oauth',
        tokenExp: decoded.exp ? new Date(decoded.exp * 1000) : undefined,
      };
    } catch (error) {
      logger.debug('JWKS validation failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Introspect token with OAuth provider
   */
  private async introspectToken(
    token: string,
    oauthConfig: AuthConfig['oauth'],
    req: Request
  ): Promise<AuthenticatedUser | null> {
    try {
      const response = await fetch(oauthConfig!.tokenEndpoint!, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Basic ${Buffer.from(
            `${oauthConfig!.clientId}:${oauthConfig!.clientSecret}`
          ).toString('base64')}`,
        },
        body: new URLSearchParams({
          token,
          token_type_hint: 'access_token',
        }),
      });

      const data = await response.json() as { active: boolean; sub?: string; email?: string; exp?: number };

      if (!data.active) {
        this.emitAuthEvent({
          type: 'token_expired',
          authType: 'oauth',
          ip: this.getClientIp(req),
          path: req.path,
          method: req.method,
          timestamp: new Date(),
          reason: 'Token not active',
        });
        return null;
      }

      this.emitAuthEvent({
        type: 'auth_success',
        authType: 'oauth',
        userId: data.sub,
        ip: this.getClientIp(req),
        path: req.path,
        method: req.method,
        timestamp: new Date(),
        metadata: { provider: oauthConfig!.provider },
      });

      return {
        id: data.sub || 'unknown',
        email: data.email,
        roles: [this.config.rbac?.defaultRole || 'user'],
        permissions: {},
        tier: 'free',
        authType: 'oauth',
        tokenExp: data.exp ? new Date(data.exp * 1000) : undefined,
      };
    } catch (error) {
      logger.error('Token introspection failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Hash API key for secure storage/lookup
   */
  hashApiKey(apiKey: string): string {
    const algorithm = this.config.apiKey?.hashAlgorithm || 'sha256';
    if (algorithm === 'bcrypt') {
      // For bcrypt, we'd need to compare differently
      // This is a simplified version using SHA256
      return createHash('sha256').update(apiKey).digest('hex');
    }
    return createHash(algorithm).update(apiKey).digest('hex');
  }

  /**
   * Look up API key in storage (override in subclass or inject storage)
   */
  async lookupApiKey(keyHash: string): Promise<ApiKeyRecord | null> {
    // Default implementation - override with your storage
    // This could query PostgreSQL, Redis, etc.
    logger.debug('API key lookup - implement storage', { keyHash: keyHash.substring(0, 8) });
    return null;
  }

  /**
   * Update API key last used timestamp
   */
  async updateApiKeyLastUsed(keyHash: string): Promise<void> {
    // Default implementation - override with your storage
    logger.debug('Update API key last used', { keyHash: keyHash.substring(0, 8) });
  }

  /**
   * Get client IP address
   */
  private getClientIp(req: Request): string {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string') {
      const first = forwarded.split(',')[0];
      return first?.trim() || 'unknown';
    }
    return req.socket?.remoteAddress || 'unknown';
  }

  /**
   * Emit authentication event
   */
  private emitAuthEvent(event: AuthEvent): void {
    logger.info('Auth event', { ...event });
    // Could also emit to event bus, metrics collector, etc.
  }

  /**
   * Clear caches
   */
  clearCaches(): void {
    this.apiKeyCache.clear();
    this.jwksCache.clear();
  }

  /**
   * Invalidate specific API key from cache
   */
  invalidateApiKey(keyHash: string): void {
    this.apiKeyCache.delete(keyHash);
  }
}

// =============================================================================
// Factory Function
// =============================================================================

export function createAuthService(config: AuthConfig): AuthService {
  return new AuthService(config);
}
