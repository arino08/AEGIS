# 07. Authentication & Authorization

## Overview

AEGIS supports multiple authentication methods and role-based access control (RBAC). This allows you to secure your APIs without modifying backend services.

---

## 📁 Auth Module Structure

```
src/auth/
├── index.ts          # Module exports
├── auth-service.ts   # Main authentication service
├── middleware.ts     # Express auth middleware
├── rbac-service.ts   # Role-Based Access Control
├── transform.ts      # Header transformation
└── types.ts          # Type definitions
```

---

## 🔐 Authentication Methods

AEGIS supports three authentication methods:

| Method | Best For | Implementation |
|--------|----------|----------------|
| **API Keys** | Server-to-server, simple auth | SHA256 hashed keys |
| **JWT** | Modern web apps, mobile | Standard JWT verification |
| **OAuth 2.0** | Enterprise, SSO integration | JWKS or token introspection |

---

## 🔑 API Key Authentication

### How It Works

1. Client sends API key in header (e.g., `X-API-Key: ak_live_xxx`)
2. Gateway hashes the key with SHA256
3. Looks up hash in database/cache
4. Returns user info if valid

### Implementation

```typescript
// src/auth/auth-service.ts

export class AuthService {
  private apiKeyCache: Map<string, ApiKeyRecord> = new Map();

  async authenticateApiKey(apiKey: string, req: Request): Promise<AuthenticatedUser | null> {
    // Extract key (remove prefix if present)
    const key = this.extractApiKey(apiKey);
    if (!key) return null;

    // Hash the key
    const keyHash = this.hashApiKey(key);

    // Check cache first
    let record = this.apiKeyCache.get(keyHash);

    if (!record) {
      // Look up in database
      record = await this.lookupApiKey(keyHash);

      if (!record) {
        this.emitAuthEvent({
          type: 'api_key_auth_failed',
          reason: 'invalid_key',
          ip: this.getClientIp(req)
        });
        return null;
      }

      // Cache for future requests
      this.apiKeyCache.set(keyHash, record);
    }

    // Check if key is active
    if (!record.active) {
      this.emitAuthEvent({
        type: 'api_key_auth_failed',
        reason: 'key_inactive',
        keyId: record.id
      });
      return null;
    }

    // Check expiration
    if (record.expiresAt && new Date() > record.expiresAt) {
      this.emitAuthEvent({
        type: 'api_key_auth_failed',
        reason: 'key_expired',
        keyId: record.id
      });
      return null;
    }

    // Update last used timestamp
    void this.updateApiKeyLastUsed(keyHash);

    // Return authenticated user
    return {
      id: record.userId,
      email: record.userEmail,
      roles: record.roles,
      tier: record.tier,
      metadata: record.metadata,
      authMethod: 'api-key',
      keyId: record.id
    };
  }

  private hashApiKey(apiKey: string): string {
    return createHash('sha256').update(apiKey).digest('hex');
  }
}
```

### Configuration

```yaml
auth:
  enabled: true
  defaultAuthType: api-key

  apiKey:
    enabled: true
    headerName: X-API-Key     # or "Authorization"
    prefix: ''                 # e.g., "Bearer " or "ApiKey "
    hashAlgorithm: sha256
```

---

## 🎫 JWT Authentication

### How It Works

1. Client sends JWT in Authorization header
2. Gateway verifies signature using secret/public key
3. Validates claims (expiration, issuer, audience)
4. Extracts user info from token payload

### Implementation

```typescript
async authenticateJwt(token: string, req: Request): Promise<AuthenticatedUser | null> {
  const jwtConfig = this.config.jwt;
  if (!jwtConfig?.enabled) return null;

  try {
    let payload: JwtPayload;

    if (jwtConfig.secret) {
      // HS256 - Symmetric key
      const secretKey = new TextEncoder().encode(jwtConfig.secret);
      const { payload: p } = await jose.jwtVerify(token, secretKey, {
        issuer: jwtConfig.issuer,
        audience: jwtConfig.audience,
        clockTolerance: jwtConfig.clockTolerance
      });
      payload = p as JwtPayload;
    } else if (jwtConfig.publicKey) {
      // RS256/ES256 - Asymmetric key
      const publicKey = await jose.importSPKI(jwtConfig.publicKey, jwtConfig.algorithm);
      const { payload: p } = await jose.jwtVerify(token, publicKey, {
        issuer: jwtConfig.issuer,
        audience: jwtConfig.audience
      });
      payload = p as JwtPayload;
    } else {
      logger.warn('JWT configured but no secret or public key provided');
      return null;
    }

    // Return authenticated user from JWT claims
    return {
      id: payload.sub!,
      email: payload.email,
      roles: payload.roles || [],
      tier: payload.tier || 'free',
      authMethod: 'jwt',
      tokenId: payload.jti
    };

  } catch (error) {
    if (error instanceof jose.errors.JWTExpired) {
      this.emitAuthEvent({ type: 'jwt_expired', token: token.substring(0, 20) });
    } else if (error instanceof jose.errors.JWTClaimValidationFailed) {
      this.emitAuthEvent({ type: 'jwt_claim_failed', error: error.message });
    } else {
      this.emitAuthEvent({ type: 'jwt_verification_failed', error: String(error) });
    }
    return null;
  }
}
```

### Configuration

```yaml
auth:
  jwt:
    enabled: true

    # For HS256 (symmetric)
    secret: 'your-super-secret-key-at-least-32-characters'

    # For RS256/ES256 (asymmetric)
    # publicKey: |
    #   -----BEGIN PUBLIC KEY-----
    #   ...
    #   -----END PUBLIC KEY-----

    algorithm: HS256
    issuer: 'aegis'
    audience: 'aegis-api'
    clockTolerance: 30  # seconds
```

---

## 🌐 OAuth 2.0 Authentication

### How It Works

Two methods supported:

1. **JWKS Validation**: Validate token using provider's public keys
2. **Token Introspection**: Ask provider if token is valid

### JWKS Validation

```typescript
async validateWithJwks(
  token: string,
  oauthConfig: OAuthConfig,
  req: Request
): Promise<AuthenticatedUser | null> {
  try {
    // Fetch JWKS from provider
    const jwksUrl = oauthConfig.jwksUri;
    const jwks = jose.createRemoteJWKSet(new URL(jwksUrl));

    // Verify token
    const { payload } = await jose.jwtVerify(token, jwks, {
      issuer: oauthConfig.issuer,
      audience: oauthConfig.audience
    });

    return {
      id: payload.sub!,
      email: payload.email as string,
      roles: (payload.roles || payload['https://aegis/roles'] || []) as string[],
      authMethod: 'oauth',
      provider: oauthConfig.provider
    };

  } catch (error) {
    logger.warn('OAuth JWKS validation failed', { error: String(error) });
    return null;
  }
}
```

### Token Introspection

```typescript
async introspectToken(
  token: string,
  oauthConfig: OAuthConfig,
  req: Request
): Promise<AuthenticatedUser | null> {
  try {
    const response = await fetch(oauthConfig.introspectionEndpoint!, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${Buffer.from(
          `${oauthConfig.clientId}:${oauthConfig.clientSecret}`
        ).toString('base64')}`
      },
      body: new URLSearchParams({ token })
    });

    const data = await response.json();

    if (!data.active) {
      return null;
    }

    return {
      id: data.sub,
      email: data.email,
      roles: data.roles || [],
      scope: data.scope,
      authMethod: 'oauth',
      provider: oauthConfig.provider
    };

  } catch (error) {
    logger.error('Token introspection failed', { error });
    return null;
  }
}
```

### Configuration

```yaml
auth:
  oauth:
    provider: auth0  # auth0, okta, google, azure, custom
    issuer: 'https://your-tenant.auth0.com/'
    audience: 'your-api-identifier'
    jwksUri: 'https://your-tenant.auth0.com/.well-known/jwks.json'

    # For token introspection
    # clientId: 'your-client-id'
    # clientSecret: 'your-client-secret'
    # introspectionEndpoint: 'https://your-tenant.auth0.com/oauth/token/introspect'
```

---

## 🛡️ Auth Middleware

### `src/auth/middleware.ts`

```typescript
export function createAuthMiddleware(
  authService: AuthService,
  rbacService?: RbacService
): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    // Check if path allows anonymous access
    if (authService.isAnonymousPath(req.path)) {
      (req as AuthenticatedRequest).user = authService.createAnonymousUser(req);
      return next();
    }

    // Try to authenticate
    const user = await authService.authenticate(req);

    if (!user) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Authentication required'
      });
    }

    // Attach user to request
    (req as AuthenticatedRequest).user = user;

    // Check RBAC if enabled
    if (rbacService) {
      const allowed = rbacService.isAllowed(user, req.path, req.method);

      if (!allowed) {
        return res.status(403).json({
          error: 'Forbidden',
          message: 'You do not have permission to access this resource'
        });
      }
    }

    next();
  };
}
```

### Authentication Flow

```typescript
async authenticate(req: Request): Promise<AuthenticatedUser | null> {
  // 1. Try API Key (if configured)
  if (this.config.apiKey?.enabled) {
    const apiKeyHeader = req.get(this.config.apiKey.headerName);
    if (apiKeyHeader) {
      const user = await this.authenticateApiKey(apiKeyHeader, req);
      if (user) return user;
    }
  }

  // 2. Try JWT (Authorization: Bearer token)
  const authHeader = req.get('Authorization');
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.substring(7);

    // Try JWT
    if (this.config.jwt?.enabled) {
      const user = await this.authenticateJwt(token, req);
      if (user) return user;
    }

    // Try OAuth
    if (this.config.oauth) {
      const user = await this.authenticateOAuth(token, req);
      if (user) return user;
    }
  }

  // 3. If anonymous allowed, return anonymous user
  if (this.config.allowAnonymous) {
    return this.createAnonymousUser(req);
  }

  return null;
}
```

---

## 👥 Role-Based Access Control (RBAC)

### `src/auth/rbac-service.ts`

RBAC allows you to define:
- **Roles**: Named groups of permissions (admin, editor, viewer)
- **Permissions**: What actions are allowed on which resources
- **Role Inheritance**: Roles can inherit from other roles

### Role Definition

```yaml
auth:
  rbac:
    enabled: true
    defaultRole: user
    superAdminRoles:
      - super-admin

    roles:
      - name: admin
        description: 'Administrator with full access'
        permissions:
          - resource: '/**'
            actions: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']
        inherits: []

      - name: editor
        description: 'Can read and modify content'
        permissions:
          - resource: '/api/**'
            actions: ['GET', 'POST', 'PUT', 'PATCH']
          - resource: '/users/profile'
            actions: ['GET', 'PUT']
        inherits:
          - viewer

      - name: viewer
        description: 'Read-only access'
        permissions:
          - resource: '/api/**'
            actions: ['GET']
          - resource: '/users/profile'
            actions: ['GET']

      - name: user
        description: 'Basic user access'
        permissions:
          - resource: '/api/public/**'
            actions: ['GET', 'POST']
          - resource: '/users/profile'
            actions: ['GET', 'PUT']
```

### Permission Checking

```typescript
export class RbacService {
  private roles: Map<string, RoleConfig> = new Map();
  private compiledPermissions: Map<string, CompiledPermission[]> = new Map();

  isAllowed(user: AuthenticatedUser, path: string, method: string): boolean {
    // Super admin check
    if (this.isSuperAdmin(user)) {
      return true;
    }

    // Check each of user's roles
    for (const roleName of user.roles) {
      const permissions = this.getPermissionsForRole(roleName);

      for (const permission of permissions) {
        if (permission.matches(path) && permission.allowsAction(method)) {
          return true;
        }
      }
    }

    return false;
  }

  private getPermissionsForRole(roleName: string): CompiledPermission[] {
    const cached = this.compiledPermissions.get(roleName);
    if (cached) return cached;

    const role = this.roles.get(roleName);
    if (!role) return [];

    const permissions: CompiledPermission[] = [];

    // Add own permissions
    for (const p of role.permissions) {
      permissions.push(new CompiledPermission(p));
    }

    // Add inherited permissions
    for (const inheritedRole of role.inherits) {
      const inheritedPerms = this.getPermissionsForRole(inheritedRole);
      permissions.push(...inheritedPerms);
    }

    this.compiledPermissions.set(roleName, permissions);
    return permissions;
  }
}
```

### Permission Pattern Matching

```typescript
class CompiledPermission {
  private resourcePattern: RegExp;
  private allowedActions: Set<string>;

  constructor(permission: Permission) {
    // Convert glob pattern to regex
    this.resourcePattern = this.compilePattern(permission.resource);
    this.allowedActions = new Set(permission.actions.map(a => a.toUpperCase()));
  }

  matches(path: string): boolean {
    return this.resourcePattern.test(path);
  }

  allowsAction(method: string): boolean {
    return this.allowedActions.has(method.toUpperCase()) ||
           this.allowedActions.has('*');
  }

  private compilePattern(pattern: string): RegExp {
    const regexStr = pattern
      .replace(/\*\*/g, '<<<DOUBLE>>>')
      .replace(/\*/g, '[^/]+')
      .replace(/<<<DOUBLE>>>/g, '.*');

    return new RegExp(`^${regexStr}$`);
  }
}
```

---

## 🔄 Header Transformation

### `src/auth/transform.ts`

After authentication, AEGIS can inject user info into requests:

```typescript
export function transformRequest(
  req: AuthenticatedRequest,
  config: TransformConfig
): void {
  const user = req.user;
  if (!user) return;

  // Inject user info headers
  if (config.injectUserInfo) {
    req.headers['x-user-id'] = user.id;
    if (user.email) {
      req.headers['x-user-email'] = user.email;
    }
    if (user.roles.length > 0) {
      req.headers['x-user-roles'] = user.roles.join(',');
    }
    if (user.tier) {
      req.headers['x-user-tier'] = user.tier;
    }
  }

  // Inject request ID
  if (config.injectRequestId) {
    req.headers['x-request-id'] = req.requestId || generateRequestId();
  }

  // Inject forwarded headers
  if (config.injectForwardedHeaders) {
    req.headers['x-forwarded-for'] = getClientIp(req);
    req.headers['x-forwarded-proto'] = req.protocol;
    req.headers['x-forwarded-host'] = req.get('host');
  }

  // Add custom headers
  for (const [key, value] of Object.entries(config.headers.add)) {
    req.headers[key.toLowerCase()] = value;
  }

  // Remove specified headers
  for (const header of config.headers.remove) {
    delete req.headers[header.toLowerCase()];
  }
}
```

### Response Transformation

Strip sensitive headers from responses:

```typescript
export function transformResponse(
  res: Response,
  config: TransformConfig
): void {
  // Remove sensitive headers
  for (const header of config.sensitiveHeaders) {
    res.removeHeader(header);
  }

  // Add response headers
  for (const [key, value] of Object.entries(config.headers.add)) {
    res.setHeader(key, value);
  }
}
```

### Configuration

```yaml
transform:
  request:
    headers:
      add:
        X-Gateway-Version: '1.0'
      remove:
        - X-Debug-Token
    injectUserInfo: true
    injectRequestId: true
    injectForwardedHeaders: true

  response:
    headers:
      add:
        X-Gateway: aegis
    sensitiveHeaders:
      - X-Internal-Token
      - X-Database-Server
      - Server
      - X-Powered-By
```

---

## 🔒 Anonymous Access

Some paths can skip authentication:

```yaml
auth:
  allowAnonymous: true
  anonymousPaths:
    - /health
    - /healthz
    - /ready
    - /_aegis/*
    - /api/public/*
```

Anonymous users get a minimal user object:

```typescript
createAnonymousUser(req: Request): AuthenticatedUser {
  return {
    id: 'anonymous',
    roles: [],
    tier: 'anonymous',
    authMethod: 'anonymous',
    metadata: {
      ip: this.getClientIp(req),
      userAgent: req.get('user-agent')
    }
  };
}
```

---

## 📊 Auth Events

Auth operations emit events for monitoring:

```typescript
interface AuthEvent {
  type:
    | 'api_key_auth_success'
    | 'api_key_auth_failed'
    | 'jwt_auth_success'
    | 'jwt_expired'
    | 'jwt_claim_failed'
    | 'oauth_auth_success'
    | 'rbac_denied';
  userId?: string;
  ip?: string;
  reason?: string;
  path?: string;
  method?: string;
  timestamp: Date;
}
```

---

## 🚀 Next Steps

Now that you understand authentication:
1. [Natural Language Query](./08-nl-query.md) - Query metrics with natural language
2. [ML Service](./09-ml-service.md) - AI-powered anomaly detection
