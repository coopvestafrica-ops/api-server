import { Router, type IRouter } from "express";
import { supabase } from "../lib/supabase";
import { requireAuth, requireRole } from "../middleware/auth";
import { z } from "zod";

const router: IRouter = Router();
router.use(requireAuth);

// Get system health and metrics
router.get("/system/health", requireRole("admin", "super_admin"), async (req, res): Promise<void> => {
  try {
    // Check database connectivity
    const startDb = Date.now();
    const { error: dbError } = await supabase.from("profiles").select("count").limit(1);
    const dbLatency = Date.now() - startDb;

    // Check recent activity (last 5 minutes)
    const fiveMinsAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const { count: recentLogins } = await supabase
      .from("audit_logs")
      .select("*", { count: "exact", head: true })
      .eq("action", "login")
      .gte("created_at", fiveMinsAgo);

    // Get active sessions count (users with activity in last 30 mins)
    const thirtyMinsAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const { count: activeUsers } = await supabase
      .from("audit_logs")
      .select("*", { count: "exact", head: true })
      .gte("created_at", thirtyMinsAgo);

    // Calculate uptime (simplified - in production this would be from server start time)
    const uptimeHours = process.uptime ? Math.floor(process.uptime() / 3600) : 24;

    res.json({
      status: dbError ? "degraded" : "healthy",
      timestamp: new Date().toISOString(),
      database: {
        status: dbError ? "error" : "connected",
        latency: dbLatency,
        error: dbError?.message || null,
      },
      api: {
        uptime: uptimeHours,
        version: process.env.npm_package_version || "1.0.0",
        region: process.env.VERCEL_REGION || "unknown",
      },
      metrics: {
        recentLogins: recentLogins ?? 0,
        activeUsers: activeUsers ?? 0,
      },
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch system health" });
  }
});

// Get API rate limit settings
router.get("/system/rate-limits", requireRole("admin", "super_admin"), async (req, res): Promise<void> => {
  const { data: settings } = await supabase
    .from("admin_settings")
    .select("*")
    .eq("category", "rate_limits")
    .single();

  // Default rate limits if not configured
  const defaults = {
    global: { requests: 100, window: "minute" },
    endpoints: {
      "/api/auth": { requests: 10, window: "minute" },
      "/api/members": { requests: 50, window: "minute" },
      "/api/transactions": { requests: 30, window: "minute" },
    }
  };

  res.json(settings?.settings || defaults);
});

// Update API rate limit settings
const RateLimitSchema = z.object({
  global: z.object({
    requests: z.number().min(1).max(1000),
    window: z.enum(["second", "minute", "hour"]),
  }),
  endpoints: z.record(z.object({
    requests: z.number().min(1).max(1000),
    window: z.enum(["second", "minute", "hour"]),
  })),
});

router.put("/system/rate-limits", requireRole("super_admin"), async (req, res): Promise<void> => {
  const parsed = RateLimitSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid rate limit configuration", details: parsed.error.flatten() });
    return;
  }

  const { data: existing } = await supabase
    .from("admin_settings")
    .select("id")
    .eq("category", "rate_limits")
    .single();

  if (existing) {
    await supabase
      .from("admin_settings")
      .update({ settings: parsed.data, updated_at: new Date().toISOString() })
      .eq("id", existing.id);
  } else {
    await supabase
      .from("admin_settings")
      .insert({ category: "rate_limits", settings: parsed.data });
  }

  res.json({ success: true, settings: parsed.data });
});

// Get IP allowlist settings
router.get("/system/ip-allowlist", requireRole("super_admin"), async (req, res): Promise<void> => {
  const { data: settings } = await supabase
    .from("admin_settings")
    .select("*")
    .eq("category", "ip_allowlist")
    .single();

  res.json({
    enabled: settings?.settings?.enabled ?? false,
    ips: settings?.settings?.ips ?? [],
    updated_at: settings?.updated_at,
  });
});

// Update IP allowlist
const IPAllowlistSchema = z.object({
  enabled: z.boolean(),
  ips: z.array(z.string().ip()),
});

router.put("/system/ip-allowlist", requireRole("super_admin"), async (req, res): Promise<void> => {
  const parsed = IPAllowlistSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid IP allowlist configuration" });
    return;
  }

  const { data: existing } = await supabase
    .from("admin_settings")
    .select("id")
    .eq("category", "ip_allowlist")
    .single();

  if (existing) {
    await supabase
      .from("admin_settings")
      .update({ settings: parsed.data, updated_at: new Date().toISOString() })
      .eq("id", existing.id);
  } else {
    await supabase
      .from("admin_settings")
      .insert({ category: "ip_allowlist", settings: parsed.data });
  }

  res.json({ success: true });
});

// Get penalty/fee configuration
router.get("/system/penalties", requireRole("admin", "super_admin"), async (req, res): Promise<void> => {
  const { data: settings } = await supabase
    .from("admin_settings")
    .select("*")
    .eq("category", "penalties")
    .single();

  const defaults = {
    latePaymentFee: 500, // Flat fee in kobo
    latePaymentPercentage: 2.5, // Percentage of outstanding
    loanProcessingFee: 1.0, // Percentage of loan amount
    accountMaintenanceFee: 0, // Monthly
    minimumBalance: 1000, // Minimum account balance
    maxPenaltyCycle: 3, // Max months before escalation
  };

  res.json(settings?.settings || defaults);
});

// Update penalty/fee configuration
const PenaltySchema = z.object({
  latePaymentFee: z.number().min(0),
  latePaymentPercentage: z.number().min(0).max(100),
  loanProcessingFee: z.number().min(0).max(10),
  accountMaintenanceFee: z.number().min(0),
  minimumBalance: z.number().min(0),
  maxPenaltyCycle: z.number().min(1).max(12),
});

router.put("/system/penalties", requireRole("super_admin"), async (req, res): Promise<void> => {
  const parsed = PenaltySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid penalty configuration" });
    return;
  }

  const { data: existing } = await supabase
    .from("admin_settings")
    .select("id")
    .eq("category", "penalties")
    .single();

  if (existing) {
    await supabase
      .from("admin_settings")
      .update({ settings: parsed.data, updated_at: new Date().toISOString() })
      .eq("id", existing.id);
  } else {
    await supabase
      .from("admin_settings")
      .insert({ category: "penalties", settings: parsed.data });
  }

  res.json({ success: true, settings: parsed.data });
});

// Get admin settings overview
router.get("/system/settings", requireRole("admin", "super_admin"), async (req, res): Promise<void> => {
  const { data: settings } = await supabase
    .from("admin_settings")
    .select("category, updated_at");

  const categories = settings?.map(s => s.category) || [];
  
  res.json({
    configured: categories,
    lastUpdated: settings?.reduce((latest, s) => 
      !latest || s.updated_at > latest ? s.updated_at : latest, null),
  });
});

export default router;