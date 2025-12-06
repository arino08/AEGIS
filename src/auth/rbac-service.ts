/**
 * AEGIS - Role-Based Access Control (RBAC) Service
 *
 * Manages roles, permissions, and access control decisions
 */

import { minimatch } from 'minimatch';

import logger from '../utils/logger.js';
import type {
  AuthenticatedUser,
  RoleDefinition,
  PermissionRule,
  AccessControlResult,
  AuthConfig,
} from './types.js';

// =============================================================================
// RBAC Service
// =============================================================================

export class RbacService {
  private roles: Map<string, RoleDefinition> = new Map();
  private superAdminRoles: Set<string> = new Set();
  private roleHierarchy: Map<string, Set<string>> = new Map(); // role -> all inherited roles
  private enabled: boolean;
  private defaultRole: string;

  constructor(config: AuthConfig['rbac']) {
    this.enabled = config?.enabled ?? false;
    this.defaultRole = config?.defaultRole ?? 'user';

    if (config?.roles) {
      this.loadRoles(config.roles);
    }

    if (config?.superAdminRoles) {
      config.superAdminRoles.forEach((role) => this.superAdminRoles.add(role));
    }
  }

  /**
   * Load role definitions
   */
  loadRoles(roles: RoleDefinition[]): void {
    // First pass: load all roles
    for (const role of roles) {
      this.roles.set(role.name, role);
    }

    // Second pass: resolve inheritance hierarchy
    for (const role of roles) {
      this.roleHierarchy.set(role.name, this.resolveInheritedRoles(role.name, new Set()));
    }

    logger.info('RBAC roles loaded', {
      roleCount: this.roles.size,
      superAdminRoles: Array.from(this.superAdminRoles),
    });
  }

  /**
   * Resolve all inherited roles (including transitive inheritance)
   */
  private resolveInheritedRoles(roleName: string, visited: Set<string>): Set<string> {
    if (visited.has(roleName)) {
      logger.warn('Circular role inheritance detected', { role: roleName });
      return new Set();
    }

    visited.add(roleName);
    const result = new Set<string>([roleName]);
    const role = this.roles.get(roleName);

    if (role?.inherits) {
      for (const inheritedRoleName of role.inherits) {
        const inheritedRoles = this.resolveInheritedRoles(inheritedRoleName, new Set(visited));
        inheritedRoles.forEach((r) => result.add(r));
      }
    }

    return result;
  }

  /**
   * Check if user has access to a resource
   */
  checkAccess(
    user: AuthenticatedUser | null,
    resource: string,
    action: string
  ): AccessControlResult {
    // If RBAC is disabled, allow all
    if (!this.enabled) {
      return { allowed: true, reason: 'RBAC disabled' };
    }

    // No user = denied (unless anonymous is allowed)
    if (!user) {
      return {
        allowed: false,
        reason: 'No authenticated user',
      };
    }

    // Check if user has super admin role
    const userRoles = user.roles || [this.defaultRole];
    if (this.hasSuperAdminRole(userRoles)) {
      return {
        allowed: true,
        reason: 'Super admin role',
        userRoles,
      };
    }

    // Check user-specific permissions first
    if (user.permissions && Object.keys(user.permissions).length > 0) {
      const result = this.checkUserPermissions(user.permissions, resource, action);
      if (result.allowed) {
        return { ...result, userRoles };
      }
    }

    // Check role-based permissions
    return this.checkRolePermissions(userRoles, resource, action);
  }

  /**
   * Check if user has any super admin role
   */
  private hasSuperAdminRole(userRoles: string[]): boolean {
    return userRoles.some((role) => this.superAdminRoles.has(role));
  }

  /**
   * Check user-specific permissions
   */
  private checkUserPermissions(
    permissions: Record<string, string[]>,
    resource: string,
    action: string
  ): AccessControlResult {
    for (const [pattern, allowedActions] of Object.entries(permissions)) {
      if (this.matchesPattern(resource, pattern)) {
        if (allowedActions.includes('*') || allowedActions.includes(action.toUpperCase())) {
          return {
            allowed: true,
            reason: 'User permission match',
            matchedRule: pattern,
          };
        }
      }
    }

    return { allowed: false };
  }

  /**
   * Check role-based permissions
   */
  private checkRolePermissions(
    userRoles: string[],
    resource: string,
    action: string
  ): AccessControlResult {
    // Get all roles including inherited ones
    const allRoles = new Set<string>();
    for (const roleName of userRoles) {
      const inherited = this.roleHierarchy.get(roleName) || new Set([roleName]);
      inherited.forEach((r) => allRoles.add(r));
    }

    // Check each role's permissions
    for (const roleName of allRoles) {
      const role = this.roles.get(roleName);
      if (!role) continue;

      for (const permission of role.permissions) {
        if (this.matchesPermission(permission, resource, action)) {
          return {
            allowed: true,
            reason: 'Role permission match',
            matchedRule: `${roleName}:${permission.resource}`,
            userRoles: Array.from(allRoles),
          };
        }
      }
    }

    return {
      allowed: false,
      reason: 'No matching permission found',
      userRoles: Array.from(allRoles),
    };
  }

  /**
   * Check if a permission rule matches the resource and action
   */
  private matchesPermission(
    permission: PermissionRule,
    resource: string,
    action: string
  ): boolean {
    // Check resource pattern
    if (!this.matchesPattern(resource, permission.resource)) {
      return false;
    }

    // Check action
    if (!permission.actions.includes('*') && !permission.actions.includes(action.toUpperCase())) {
      return false;
    }

    // Check conditions (if any)
    if (permission.conditions && permission.conditions.length > 0) {
      // Conditions would need request context to evaluate
      // For now, we don't have that context here
      // This would be extended in a real implementation
    }

    return true;
  }

  /**
   * Match a resource against a pattern (supports glob patterns)
   */
  private matchesPattern(resource: string, pattern: string): boolean {
    // Exact match
    if (resource === pattern) {
      return true;
    }

    // Glob pattern match
    return minimatch(resource, pattern, { matchBase: true });
  }

  /**
   * Get all permissions for a user
   */
  getEffectivePermissions(user: AuthenticatedUser): PermissionRule[] {
    const permissions: PermissionRule[] = [];
    const userRoles = user.roles || [this.defaultRole];

    // Add user-specific permissions
    if (user.permissions) {
      for (const [resource, actions] of Object.entries(user.permissions)) {
        permissions.push({ resource, actions });
      }
    }

    // Add role-based permissions
    const allRoles = new Set<string>();
    for (const roleName of userRoles) {
      const inherited = this.roleHierarchy.get(roleName) || new Set([roleName]);
      inherited.forEach((r) => allRoles.add(r));
    }

    for (const roleName of allRoles) {
      const role = this.roles.get(roleName);
      if (role) {
        permissions.push(...role.permissions);
      }
    }

    return permissions;
  }

  /**
   * Check if user has specific role
   */
  hasRole(user: AuthenticatedUser, roleName: string): boolean {
    const userRoles = user.roles || [];

    // Direct role check
    if (userRoles.includes(roleName)) {
      return true;
    }

    // Check inherited roles
    for (const userRole of userRoles) {
      const inherited = this.roleHierarchy.get(userRole);
      if (inherited?.has(roleName)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Add a new role
   */
  addRole(role: RoleDefinition): void {
    this.roles.set(role.name, role);
    this.roleHierarchy.set(role.name, this.resolveInheritedRoles(role.name, new Set()));
    logger.info('Role added', { role: role.name });
  }

  /**
   * Remove a role
   */
  removeRole(roleName: string): boolean {
    const deleted = this.roles.delete(roleName);
    this.roleHierarchy.delete(roleName);

    // Re-resolve hierarchy for roles that might have inherited from this one
    for (const [name, role] of this.roles) {
      if (role.inherits?.includes(roleName)) {
        this.roleHierarchy.set(name, this.resolveInheritedRoles(name, new Set()));
      }
    }

    return deleted;
  }

  /**
   * Get role definition
   */
  getRole(roleName: string): RoleDefinition | undefined {
    return this.roles.get(roleName);
  }

  /**
   * Get all roles
   */
  getAllRoles(): RoleDefinition[] {
    return Array.from(this.roles.values());
  }
}

// =============================================================================
// Factory Function
// =============================================================================

export function createRbacService(config: AuthConfig['rbac']): RbacService {
  return new RbacService(config);
}

// =============================================================================
// Default Role Definitions
// =============================================================================

export const DEFAULT_ROLES: RoleDefinition[] = [
  {
    name: 'anonymous',
    description: 'Unauthenticated users',
    permissions: [
      { resource: '/api/public/*', actions: ['GET'] },
      { resource: '/health', actions: ['GET'] },
      { resource: '/healthz', actions: ['GET'] },
    ],
  },
  {
    name: 'user',
    description: 'Authenticated basic user',
    permissions: [
      { resource: '/api/user/*', actions: ['GET', 'POST', 'PUT', 'PATCH'] },
      { resource: '/api/public/*', actions: ['GET'] },
    ],
    inherits: ['anonymous'],
  },
  {
    name: 'editor',
    description: 'User with edit permissions',
    permissions: [
      { resource: '/api/content/*', actions: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
    ],
    inherits: ['user'],
  },
  {
    name: 'admin',
    description: 'Administrator with full access',
    permissions: [
      { resource: '/api/admin/*', actions: ['*'] },
      { resource: '/api/*', actions: ['*'] },
    ],
    inherits: ['editor'],
  },
  {
    name: 'superadmin',
    description: 'Super administrator - bypasses all checks',
    permissions: [
      { resource: '/*', actions: ['*'] },
    ],
  },
];
