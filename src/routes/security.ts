import { Router, type IRouter } from "express";
import { supabase } from "../lib/supabase";

const router: IRouter = Router();

interface SettingsRow {
  id: number;
  two_factor_required: boolean;
  session_timeout_minutes: number;
  max_login_attempts: number;
  ip_allowlist_enabled: boolean;
  allowed_ips: string[] | null;
  blocked_ips: string[] | null;
  password_expiry_days: number;
}

function settingsToCamel(s: SettingsRow | null) {
  return {
    twoFactorRequired: s?.two_factor_required ?? false,
    sessionTimeoutMinutes: s?.session_timeout_minutes ?? 60,
    maxLoginAttempts: s?.max_login_attempts ?? 5,
    ipAllowlistEnabled: s?.ip_allowlist_enabled ?? false,
    allowedIPs: s?.allowed_ips ?? [],
    blockedIPs: s?.blocked_ips ?? [],
    passwordExpiryDays: s?.password_expiry_days ?? 90,
  };
}

async function loadSettingsRow(): Promise<SettingsRow | null> {
  const { data } = await supabase.from("security_settings").select("*").limit(1).maybeSingle();
  return (data as SettingsRow) ?? null;
}

router.get("/security/sessions", async (_req, res): Promise<void> => {
  const { data, error } = await supabase
    .from("security_sessions")
    .select("*")
    .order("login_time", { ascending: false });
  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }
  const sessions = (data ?? []).map((s) => ({
    id: s.id,
    userId: s.user_id || "",
    userName: s.user_name || "Unknown",
    role: s.role || "member",
    ipAddress: s.ip_address || "",
    device: s.device || "",
    location: s.location || "",
    loginTime: s.login_time,
    isCurrentSession: !!s.is_current,
  }));
  res.json({ sessions, total: sessions.length });
});

router.delete("/security/sessions/:id", async (req, res): Promise<void> => {
  const { error } = await supabase.from("security_sessions").delete().eq("id", req.params.id);
  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }
  res.json({ message: "Session terminated" });
});

router.get("/security/events", async (_req, res): Promise<void> => {
  const { data, error } = await supabase
    .from("security_events")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }
  const events = (data ?? []).map((e) => ({
    id: e.id,
    event: e.event || "",
    user: e.username || "",
    ipAddress: e.ip_address || "",
    severity: e.severity || "info",
    timestamp: e.created_at,
    details: e.details || "",
    resolved: !!e.resolved,
  }));
  res.json({ events, total: events.length });
});

router.get("/security/settings", async (_req, res): Promise<void> => {
  res.json({ settings: settingsToCamel(await loadSettingsRow()) });
});

router.put("/security/settings", async (req, res): Promise<void> => {
  const b = req.body ?? {};
  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (b.twoFactorRequired !== undefined) update.two_factor_required = !!b.twoFactorRequired;
  if (b.sessionTimeoutMinutes !== undefined) update.session_timeout_minutes = Number(b.sessionTimeoutMinutes);
  if (b.maxLoginAttempts !== undefined) update.max_login_attempts = Number(b.maxLoginAttempts);
  if (b.ipAllowlistEnabled !== undefined) update.ip_allowlist_enabled = !!b.ipAllowlistEnabled;
  if (b.allowedIPs !== undefined) update.allowed_ips = b.allowedIPs;
  if (b.blockedIPs !== undefined) update.blocked_ips = b.blockedIPs;
  if (b.passwordExpiryDays !== undefined) update.password_expiry_days = Number(b.passwordExpiryDays);

  const existing = await loadSettingsRow();
  if (existing?.id) {
    await supabase.from("security_settings").update(update).eq("id", existing.id);
  } else {
    await supabase.from("security_settings").insert(update);
  }
  res.json({ settings: settingsToCamel(await loadSettingsRow()), message: "Security settings updated" });
});

router.post("/security/ip-block", async (req, res): Promise<void> => {
  const { ip, action } = req.body ?? {};
  if (!ip) {
    res.status(400).json({ error: "ip is required" });
    return;
  }
  const existing = await loadSettingsRow();
  const blocked = new Set(existing?.blocked_ips ?? []);
  if (action === "unblock") blocked.delete(ip);
  else blocked.add(ip);
  const update = { blocked_ips: [...blocked], updated_at: new Date().toISOString() };
  if (existing?.id) {
    await supabase.from("security_settings").update(update).eq("id", existing.id);
  } else {
    await supabase.from("security_settings").insert(update);
  }
  res.json({ settings: settingsToCamel(await loadSettingsRow()), message: action === "unblock" ? "IP unblocked" : "IP blocked" });
});

export default router;
