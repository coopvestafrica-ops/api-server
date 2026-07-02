import { Router, type IRouter } from "express";
import { supabase } from "../lib/supabase";
import { requireAuth, requireRole } from "../middleware/auth";

const router: IRouter = Router();

// Public endpoint to log login attempts (no auth required)
router.post("/login-history/log", async (req, res): Promise<void> => {
  const { email, success, failure_reason, ip_address, user_agent, device_type, browser, os } = req.body;

  if (!email) {
    res.status(400).json({ error: "Email is required" });
    return;
  }

  try {
    // Try to find the profile by email
    const { data: profile } = await supabase
      .from("profiles")
      .select("id, user_id")
      .eq("email", email)
      .maybeSingle();

    const insertData: any = {
      email,
      success: success || false,
      failure_reason: failure_reason || null,
      ip_address: ip_address || null,
      user_agent: user_agent || null,
      device_type: device_type || null,
      browser: browser || null,
      os: os || null,
      created_at: new Date().toISOString(),
    };

    if (profile) {
      insertData.profile_id = profile.id;
      insertData.user_id = profile.user_id;
    }

    const { error } = await supabase.from("login_history").insert(insertData);

    if (error) {
      console.error("Error logging login attempt:", error);
      // Don't return error to client - logging failure shouldn't break login
    }

    res.json({ success: true });
  } catch (err) {
    console.error("Error logging login attempt:", err);
    res.json({ success: true }); // Still return success
  }
});

// Get login history for a specific member
router.get("/members/:memberId/login-history", requireRole("admin", "super_admin"), async (req, res): Promise<void> => {
  const { memberId } = req.params;
  const { page = 1, limit = 20 } = req.query;
  const offset = (Number(page) - 1) * Number(limit);

  // First get the profile by user_id or id
  const { data: profile } = await supabase
    .from("profiles")
    .select("id")
    .or(`id.eq.${memberId},user_id.eq.${memberId}`)
    .single();

  if (!profile) {
    res.status(404).json({ error: "Member not found" });
    return;
  }

  const { data: history, count, error } = await supabase
    .from("login_history")
    .select("*", { count: "exact" })
    .eq("profile_id", profile.id)
    .order("created_at", { ascending: false })
    .range(offset, offset + Number(limit) - 1);

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  res.json({ data: history || [], total: count || 0, page: Number(page), limit: Number(limit) });
});

// Get all login history (admin view)
router.get("/login-history", requireRole("admin", "super_admin"), async (req, res): Promise<void> => {
  const { page = 1, limit = 50, search, startDate, endDate, status } = req.query;
  const offset = (Number(page) - 1) * Number(limit);

  let query = supabase
    .from("login_history")
    .select("*, profiles!inner(name, email, user_id)", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(offset, offset + Number(limit) - 1);

  if (startDate) query = query.gte("created_at", startDate as string);
  if (endDate) query = query.lte("created_at", endDate as string);
  if (status === "success") query = query.eq("success", true);
  else if (status === "failed") query = query.eq("success", false);

  const { data: history, count, error } = await query;

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  // Filter by search if provided (client-side for simplicity)
  let filtered = history || [];
  if (search) {
    const searchLower = (search as string).toLowerCase();
    filtered = filtered.filter(h =>
      h.profiles?.name?.toLowerCase().includes(searchLower) ||
      h.profiles?.email?.toLowerCase().includes(searchLower)
    );
  }

  res.json({ data: filtered, total: count || 0, page: Number(page), limit: Number(limit) });
});

// Get suspicious login attempts
router.get("/login-history/suspicious", requireRole("admin", "super_admin"), async (req, res): Promise<void> => {
  const { hours = 24 } = req.query;
  const since = new Date(Date.now() - Number(hours) * 60 * 60 * 1000).toISOString();

  // Get failed logins grouped by IP and profile
  const { data: failedLogins, error } = await supabase
    .from("login_history")
    .select("*, profiles!inner(name, email, user_id)")
    .eq("success", false)
    .gte("created_at", since)
    .order("created_at", { ascending: false });

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  // Group suspicious activity
  const suspiciousByIP: Record<string, { ip: string; count: number; attempts: any[] }> = {};
  const suspiciousByProfile: Record<string, { profileId: string; name: string; count: number; attempts: any[] }> = {};

  failedLogins?.forEach(login => {
    // By IP
    if (login.ip_address) {
      if (!suspiciousByIP[login.ip_address]) {
        suspiciousByIP[login.ip_address] = { ip: login.ip_address, count: 0, attempts: [] };
      }
      suspiciousByIP[login.ip_address].count++;
      suspiciousByIP[login.ip_address].attempts.push(login);
    }

    // By profile
    if (login.profile_id) {
      const key = login.profile_id;
      if (!suspiciousByProfile[key]) {
        suspiciousByProfile[key] = {
          profileId: login.profile_id,
          name: login.profiles?.name || "Unknown",
          count: 0,
          attempts: [],
        };
      }
      suspiciousByProfile[key].count++;
      suspiciousByProfile[key].attempts.push(login);
    }
  });

  // Flag those with 5+ failed attempts
  const flaggedIPs = Object.values(suspiciousByIP)
    .filter(s => s.count >= 5)
    .sort((a, b) => b.count - a.count);

  const flaggedProfiles = Object.values(suspiciousByProfile)
    .filter(s => s.count >= 5)
    .sort((a, b) => b.count - a.count);

  res.json({
    summary: {
      totalFailedAttempts: failedLogins?.length || 0,
      uniqueIPs: Object.keys(suspiciousByIP).length,
      uniqueProfiles: Object.keys(suspiciousByProfile).length,
    },
    flaggedIPs,
    flaggedProfiles,
    allAttempts: failedLogins || [],
  });
});

// Get device breakdown for a member
router.get("/members/:memberId/devices", requireRole("admin", "super_admin"), async (req, res): Promise<void> => {
  const { memberId } = req.params;

  const { data: profile } = await supabase
    .from("profiles")
    .select("id")
    .or(`id.eq.${memberId},user_id.eq.${memberId}`)
    .single();

  if (!profile) {
    res.status(404).json({ error: "Member not found" });
    return;
  }

  const { data: history, error } = await supabase
    .from("login_history")
    .select("device_type, browser, os, ip_address, location")
    .eq("profile_id", profile.id)
    .eq("success", true)
    .order("created_at", { ascending: false });

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  // Aggregate unique devices
  const devices: Record<string, any> = {};
  history?.forEach(login => {
    const key = `${login.device_type || "unknown"}-${login.browser || "unknown"}`;
    if (!devices[key]) {
      devices[key] = {
        deviceType: login.device_type || "Unknown",
        browser: login.browser || "Unknown",
        os: login.os || "Unknown",
        lastUsed: login.created_at,
        lastIP: login.ip_address,
        loginCount: 0,
      };
    }
    devices[key].loginCount++;
  });

  res.json({ devices: Object.values(devices) });
});

// Block a device/IP
router.post("/security/block", requireRole("admin", "super_admin"), async (req, res): Promise<void> => {
  const { type, value, reason, expiresAt } = req.body;
  const userId = (req as any).user?.id;

  if (!["ip", "device"].includes(type)) {
    res.status(400).json({ error: "Invalid block type" });
    return;
  }

  const block = {
    id: crypto.randomUUID(),
    type,
    value,
    reason,
    blocked_by: userId,
    expires_at: expiresAt || null,
    created_at: new Date().toISOString(),
  };

  const { error } = await supabase.from("blocked_entities").insert(block);

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  res.json({ success: true, block });
});

// Get blocked entities
router.get("/security/blocked", requireRole("admin", "super_admin"), async (req, res): Promise<void> => {
  const { data: blocked, error } = await supabase
    .from("blocked_entities")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  res.json({ data: blocked || [] });
});

// Unblock entity
router.delete("/security/block/:id", requireRole("super_admin"), async (req, res): Promise<void> => {
  const { id } = req.params;

  const { error } = await supabase
    .from("blocked_entities")
    .delete()
    .eq("id", id);

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  res.json({ success: true });
});

// Get login statistics
router.get("/login-history/stats", requireRole("admin", "super_admin"), async (req, res): Promise<void> => {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const [
    todayLogins,
    weekLogins,
    monthLogins,
    todayFailed,
    weekFailed,
    uniqueUsersToday,
  ] = await Promise.all([
    supabase.from("login_history").select("*", { count: "exact", head: true }).gte("created_at", today),
    supabase.from("login_history").select("*", { count: "exact", head: true }).gte("created_at", weekAgo),
    supabase.from("login_history").select("*", { count: "exact", head: true }).gte("created_at", monthAgo),
    supabase.from("login_history").select("*", { count: "exact", head: true }).eq("success", false).gte("created_at", today),
    supabase.from("login_history").select("*", { count: "exact", head: true }).eq("success", false).gte("created_at", weekAgo),
    supabase.from("login_history").select("profile_id", { count: "exact", head: true }).gte("created_at", today).eq("success", true),
  ]);

  res.json({
    today: { logins: todayLogins.count ?? 0, failed: todayFailed.count ?? 0, uniqueUsers: uniqueUsersToday.count ?? 0 },
    week: { logins: weekLogins.count ?? 0, failed: weekFailed.count ?? 0 },
    month: { logins: monthLogins.count ?? 0 },
  });
});

export default router;