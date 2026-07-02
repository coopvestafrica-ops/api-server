import type { Request, Response, NextFunction } from "express";
import { supabase } from "../lib/supabase";

// Extend Express Request to carry the authenticated user and their role
export interface AuthenticatedRequest extends Request {
  user: { 
    id: string; 
    email?: string; 
    role?: string; 
    profileId?: string;
    permissions?: string[];
  };
}

// ── Fix #4: requireAuth – verify JWT and attach user + role + permissions ──────
export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing or invalid Authorization header" });
    return;
  }

  const token = authHeader.slice(7);
  const { data, error } = await supabase.auth.getUser(token);

  if (error || !data.user) {
    res.status(401).json({ error: "Invalid or expired token" });
    return;
  }

  // Get user email for profile lookup
  const userEmail = data.user.email;

  // Fetch user role and permissions from profiles table
  let userRole = "member";
  let profileId = "";
  let permissions: string[] = [];

  if (userEmail) {
    const { data: profile } = await supabase
      .from("profiles")
      .select("id, role, custom_permissions")
      .eq("email", userEmail)
      .single();

    if (profile) {
      userRole = profile.role || "member";
      profileId = profile.id;
      
      // Super admin always has all permissions
      if (userRole === "super_admin") {
        // Get all permissions
        const { data: allPerms } = await supabase
          .from("admin_permissions")
          .select("perm_key");
        permissions = (allPerms ?? []).map((p: { perm_key: string }) => p.perm_key);
      } else {
        // Get role-based permissions
        const { data: rolePerms } = await supabase
          .from("role_permissions")
          .select(`
            permission:admin_permissions!permission_id(perm_key)
          `)
          .eq("role:admin_roles!role_id(role_key)", userRole);
        
        const rolePermsList = (rolePerms ?? []).map(
          (rp: { permission: { perm_key: string } }) => rp.permission?.perm_key
        ).filter(Boolean);
        
        // Merge role permissions with custom permissions
        const customPerms = profile.custom_permissions || [];
        permissions = [...new Set([...rolePermsList, ...customPerms])];
      }
    }
  }

  (req as AuthenticatedRequest).user = {
    id: data.user.id,
    email: userEmail,
    role: userRole,
    profileId,
    permissions,
  };

  next();
}

// ── Role Hierarchy ────────────────────────────────────────────────────────────
const ROLE_HIERARCHY: Record<string, number> = {
  super_admin: 100,
  admin: 80,
  operator: 60,
  viewer: 40,
  member: 0,
};

/**
 * Middleware factory that enforces a minimum role level.
 *
 * Usage:
 *   router.post("/loans/:id/approve", requireAuth, requireRole("operator"), handler)
 *
 * Roles (ascending privilege): member → viewer → operator → admin → super_admin
 */
export function requireRole(...allowedRoles: string[]) {
  return function roleGuard(
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    const user = (req as AuthenticatedRequest).user;

    if (!user) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }

    // Super admin always has access
    if (user.role === "super_admin") {
      next();
      return;
    }

    const userLevel = ROLE_HIERARCHY[user.role ?? "member"] ?? 0;
    const hasPermission = allowedRoles.some(
      (r) => userLevel >= (ROLE_HIERARCHY[r] ?? 0),
    );

    if (!hasPermission) {
      res.status(403).json({
        error: `Insufficient permissions. Required: one of [${allowedRoles.join(", ")}]. Your role: ${user.role}`,
      });
      return;
    }

    next();
  };
}

/**
 * Middleware factory that enforces specific permissions.
 *
 * Usage:
 *   router.delete("/users/:id", requireAuth, requirePermission("users.suspend"), handler)
 */
export function requirePermission(...requiredPermissions: string[]) {
  return function permissionGuard(
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    const user = (req as AuthenticatedRequest).user;

    if (!user) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }

    // Super admin always has all permissions
    if (user.role === "super_admin") {
      next();
      return;
    }

    const userPermissions = user.permissions ?? [];
    const hasAllPermissions = requiredPermissions.every(
      (p) => userPermissions.includes(p),
    );

    if (!hasAllPermissions) {
      res.status(403).json({
        error: `Insufficient permissions. Required: [${requiredPermissions.join(", ")}]. Your permissions: [${userPermissions.join(", ")}]`,
      });
      return;
    }

    next();
  };
}
