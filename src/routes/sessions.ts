import { Router, type IRouter } from "express";
import { supabase } from "../lib/supabase";
import { requireAuth, requireRole } from "../middleware/auth";

const router: IRouter = Router();
router.use(requireAuth);

// Get all active sessions (admin view)
router.get("/sessions", requireRole("admin", "super_admin"), async (req, res): Promise<void> => {
  const { data: sessions, error } = await supabase
    .from("admin_sessions")
    .select("*")
    .eq("is_active", true)
    .order("last_activity", { ascending: false });

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  res.json({ data: sessions || [] });
});

// Get current user's sessions
router.get("/sessions/me", async (req, res): Promise<void> => {
  const userId = (req as any).user?.id;
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const { data: sessions, error } = await supabase
    .from("admin_sessions")
    .select("*")
    .eq("user_id", userId)
    .eq("is_active", true)
    .order("last_activity", { ascending: false });

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  res.json({ data: sessions || [] });
});

// Force logout a specific session
router.delete("/sessions/:sessionId", requireRole("admin", "super_admin"), async (req, res): Promise<void> => {
  const { sessionId } = req.params;
  
  const { error } = await supabase
    .from("admin_sessions")
    .update({ is_active: false, terminated_at: new Date().toISOString() })
    .eq("id", sessionId);

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  res.json({ success: true });
});

// Force logout all sessions for a user
router.delete("/sessions/user/:userId", requireRole("super_admin"), async (req, res): Promise<void> => {
  const { userId } = req.params;
  const currentUserId = (req as any).user?.id;
  
  // Don't allow force-logout of yourself
  if (userId === currentUserId) {
    res.status(400).json({ error: "Cannot force logout your own session" });
    return;
  }

  const { error } = await supabase
    .from("admin_sessions")
    .update({ is_active: false, terminated_at: new Date().toISOString() })
    .eq("user_id", userId)
    .eq("is_active", true);

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  res.json({ success: true, message: "All sessions terminated" });
});

// Terminate all other sessions for current user
router.delete("/sessions/terminate-others", async (req, res): Promise<void> => {
  const userId = (req as any).user?.id;
  const currentSessionId = req.headers["x-session-id"] as string;

  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const { error } = await supabase
    .from("admin_sessions")
    .update({ is_active: false, terminated_at: new Date().toISOString() })
    .eq("user_id", userId)
    .eq("is_active", true)
    .neq("id", currentSessionId || "");

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  res.json({ success: true });
});

// Get session statistics
router.get("/sessions/stats", requireRole("admin", "super_admin"), async (req, res): Promise<void> => {
  const { count: activeSessions } = await supabase
    .from("admin_sessions")
    .select("*", { count: "exact", head: true })
    .eq("is_active", true);

  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { count: recentSessions } = await supabase
    .from("admin_sessions")
    .select("*", { count: "exact", head: true })
    .eq("is_active", true)
    .gte("last_activity", oneHourAgo);

  // Sessions by role
  const { data: sessionsByRole } = await supabase
    .from("admin_sessions")
    .select("role")
    .eq("is_active", true);

  const roleCounts: Record<string, number> = {};
  sessionsByRole?.forEach(s => {
    roleCounts[s.role || "unknown"] = (roleCounts[s.role || "unknown"] || 0) + 1;
  });

  res.json({
    totalActive: activeSessions ?? 0,
    activeLastHour: recentSessions ?? 0,
    byRole: roleCounts,
  });
});

// Update session activity (called on each API request)
router.post("/sessions/:sessionId/heartbeat", async (req, res): Promise<void> => {
  const { sessionId } = req.params;

  await supabase
    .from("admin_sessions")
    .update({ last_activity: new Date().toISOString() })
    .eq("id", sessionId);

  res.json({ success: true });
});

export default router;