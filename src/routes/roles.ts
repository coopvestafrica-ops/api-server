import { Router, type IRouter } from "express";
import { requireAuth, requireRole, requirePermission, type AuthenticatedRequest } from "../middleware/auth";
import { supabase } from "../lib/supabase";

const router: IRouter = Router();

const ADMIN_ROLES = ["super_admin", "admin", "operator", "viewer"];

interface ProfileRow {
  id: string;
  name: string | null;
  email: string | null;
  role: string | null;
  is_active: boolean | null;
  updated_at: string | null;
  created_at: string | null;
  custom_permissions?: string[];
}

interface RoleRow {
  id: string;
  role_key: string;
  label: string;
  description: string | null;
  color: string;
  hierarchy: number;
  is_active: boolean;
}

interface PermissionRow {
  id: string;
  perm_key: string;
  label: string;
  description: string | null;
  category: string;
}

function toAdmin(p: ProfileRow) {
  return {
    id: p.id,
    name: p.name || p.email || "Unknown",
    email: p.email || "",
    role: p.role || "viewer",
    status: p.is_active ? "active" : "inactive",
    lastActive: p.updated_at,
    createdAt: p.created_at,
    customPermissions: p.custom_permissions || [],
  };
}

router.use(requireAuth);

// GET /roles — admin staff sourced from profiles with elevated roles
router.get("/roles", requireRole("admin"), async (_req, res): Promise<void> => {
  const { data, error } = await supabase
    .from("profiles")
    .select("id, name, email, role, is_active, updated_at, created_at, custom_permissions")
    .in("role", ADMIN_ROLES)
    .order("created_at", { ascending: true });
  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }
  res.json({ admins: (data ?? []).map((p) => toAdmin(p as ProfileRow)) });
});

// GET /roles/all — get all available roles
router.get("/roles/all", requireRole("admin"), async (_req, res): Promise<void> => {
  const { data, error } = await supabase
    .from("admin_roles")
    .select("*")
    .eq("is_active", true)
    .order("hierarchy", { ascending: false });
  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }
  res.json({ roles: data });
});

// GET /roles/permissions — get all available permissions
router.get("/roles/permissions", requireRole("admin"), async (_req, res): Promise<void> => {
  const { data, error } = await supabase
    .from("admin_permissions")
    .select("*")
    .eq("is_active", true)
    .order("category", { ascending: true });
  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }
  
  // Group by category
  const grouped = (data ?? []).reduce((acc: Record<string, PermissionRow[]>, p: PermissionRow) => {
    if (!acc[p.category]) acc[p.category] = [];
    acc[p.category].push(p);
    return acc;
  }, {});
  
  res.json({ permissions: data, groupedPermissions: grouped });
});

// GET /roles/:id/permissions — get permissions for a specific role
router.get("/roles/:id/permissions", requireRole("admin"), async (req, res): Promise<void> => {
  const { data, error } = await supabase
    .from("role_permissions")
    .select("permission:admin_permissions!permission_id(perm_key)")
    .eq("role_id", req.params.id);
  
  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }
  
  const permissions = (data ?? []).map((r: { permission: { perm_key: string } }) => r.permission?.perm_key).filter(Boolean);
  res.json({ permissions });
});

// POST /roles — promote an existing member (by email) to an admin role
router.post("/roles", requireRole("admin"), async (req, res): Promise<void> => {
  const { email, role, customPermissions } = req.body ?? {};
  if (!email || !role) {
    res.status(400).json({ error: "email and role are required" });
    return;
  }
  const { data: profile } = await supabase.from("profiles").select("id").eq("email", email).maybeSingle();
  if (!profile?.id) {
    res.status(404).json({ error: "No registered user with that email. Ask them to sign up first." });
    return;
  }
  
  // Validate role - accept hardcoded roles or check database
  const VALID_ROLES = ["admin", "operator", "viewer", "super_admin"];
  const isValidRole = VALID_ROLES.includes(role) || (
    await supabase.from("admin_roles").select("role_key").eq("role_key", role).single()
  ).data;
  
  if (!isValidRole) {
    res.status(400).json({ error: "Invalid role specified" });
    return;
  }
  
  const updateData: Record<string, unknown> = { 
    role, 
    is_active: true, 
    updated_at: new Date().toISOString() 
  };
  
  // Only set custom permissions if provided
  if (customPermissions && Array.isArray(customPermissions)) {
    updateData.custom_permissions = customPermissions;
  }
  
  const { data, error } = await supabase
    .from("profiles")
    .update(updateData)
    .eq("id", profile.id)
    .select("id, name, email, role, is_active, updated_at, created_at, custom_permissions")
    .single();
  if (error || !data) {
    res.status(500).json({ error: error?.message || "Failed to assign role" });
    return;
  }
  res.status(201).json({ admin: toAdmin(data as ProfileRow), message: "Admin role assigned" });
});

// PUT /roles/:id — change role/status/permissions
router.put("/roles/:id", requireRole("admin"), async (req, res): Promise<void> => {
  const { role, status, customPermissions } = req.body ?? {};
  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  
  if (role) {
    // Validate role - accept hardcoded roles or check database
    const VALID_ROLES = ["admin", "operator", "viewer", "super_admin"];
    const isValidRole = VALID_ROLES.includes(role) || (
      await supabase.from("admin_roles").select("role_key").eq("role_key", role).single()
    ).data;
    
    if (!isValidRole) {
      res.status(400).json({ error: "Invalid role specified" });
      return;
    }
    update.role = role;
  }
  
  if (status) update.is_active = status === "active";
  
  // Update custom permissions if provided
  if (customPermissions !== undefined && Array.isArray(customPermissions)) {
    update.custom_permissions = customPermissions;
  }
  
  const { data, error } = await supabase
    .from("profiles")
    .update(update)
    .eq("id", req.params.id)
    .select("id, name, email, role, is_active, updated_at, created_at, custom_permissions")
    .single();
  if (error || !data) {
    res.status(404).json({ error: error?.message || "User not found" });
    return;
  }
  res.json({ admin: toAdmin(data as ProfileRow), message: "Role updated successfully" });
});

// PUT /roles/:id/permissions — update custom permissions for a user
router.put("/roles/:id/permissions", requireRole("super_admin"), async (req, res): Promise<void> => {
  const { permissions } = req.body ?? {};
  
  if (!Array.isArray(permissions)) {
    res.status(400).json({ error: "permissions must be an array" });
    return;
  }
  
  // Validate all permissions exist
  const { data: validPerms } = await supabase
    .from("admin_permissions")
    .select("perm_key")
    .in("perm_key", permissions);
  
  const validPermKeys = (validPerms ?? []).map((p: { perm_key: string }) => p.perm_key);
  const invalidPerms = permissions.filter((p: string) => !validPermKeys.includes(p));
  
  if (invalidPerms.length > 0) {
    res.status(400).json({ error: `Invalid permissions: ${invalidPerms.join(", ")}` });
    return;
  }
  
  const { data, error } = await supabase
    .from("profiles")
    .update({ custom_permissions: permissions, updated_at: new Date().toISOString() })
    .eq("id", req.params.id)
    .select("id, name, email, role, is_active, updated_at, created_at, custom_permissions")
    .single();
  
  if (error || !data) {
    res.status(404).json({ error: error?.message || "User not found" });
    return;
  }
  
  res.json({ admin: toAdmin(data as ProfileRow), message: "Permissions updated successfully" });
});

// DELETE /roles/:id — revoke admin access (demote to member)
router.delete("/roles/:id", requireRole("super_admin"), async (req, res): Promise<void> => {
  const { error } = await supabase
    .from("profiles")
    .update({ role: "member", is_active: true, custom_permissions: [], updated_at: new Date().toISOString() })
    .eq("id", req.params.id);
  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }
  res.json({ message: "Admin access revoked" });
});

export default router;
