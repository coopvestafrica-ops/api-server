import { Router, type IRouter } from "express";
import { supabase } from "../lib/supabase";

const router: IRouter = Router();

const RISK_LABEL: Record<string, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
};
const STATUS_LABEL: Record<string, string> = {
  open: "Open",
  under_review: "Under Review",
  resolved: "Resolved",
  escalated: "Escalated",
  frozen: "Under Review",
};

interface AlertRow {
  id: string;
  user_id: string | null;
  user_name: string | null;
  action: string | null;
  risk_level: string | null;
  amount: number | string | null;
  status: string | null;
  details: string | null;
  created_at: string | null;
}

function toCamel(a: AlertRow) {
  return {
    id: a.id,
    user: a.user_name || "Unknown",
    userId: a.user_id || "",
    action: a.action || "",
    riskLevel: RISK_LABEL[String(a.risk_level)] ?? a.risk_level ?? "Low",
    timestamp: a.created_at,
    status: STATUS_LABEL[String(a.status)] ?? a.status ?? "Open",
    details: a.details || "",
    amount: a.amount != null ? Number(a.amount) : undefined,
  };
}

// GET /fraud-detection — returns a bare array of alerts
router.get("/fraud-detection", async (req, res): Promise<void> => {
  const { riskLevel, status } = req.query as { riskLevel?: string; status?: string };
  let query = supabase.from("fraud_alerts").select("*").order("created_at", { ascending: false });
  if (riskLevel) query = query.eq("risk_level", String(riskLevel).toLowerCase());
  if (status) query = query.eq("status", String(status).toLowerCase());
  const { data, error } = await query;
  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }
  res.json((data ?? []).map((a) => toCamel(a as AlertRow)));
});

router.get("/fraud-detection/stats", async (_req, res): Promise<void> => {
  const { data } = await supabase.from("fraud_alerts").select("risk_level, status, amount, created_at");
  const rows = data ?? [];
  const since = Date.now() - 86400000;
  res.json({
    totalFlagsToday: rows.filter((f) => f.created_at && new Date(f.created_at).getTime() > since).length,
    highRiskUsers: rows.filter((f) => f.risk_level === "critical" || f.risk_level === "high").length,
    flaggedTransactions: rows.filter((f) => f.amount != null).length,
    resolvedCases: rows.filter((f) => f.status === "resolved").length,
    openCases: rows.filter((f) => f.status === "open").length,
  });
});

const ACTION_STATUS: Record<string, string> = {
  freeze: "under_review",
  clear: "resolved",
  escalate: "escalated",
  review: "under_review",
  resolve: "resolved",
};

// PATCH /fraud-detection/:id  { action }
router.patch("/fraud-detection/:id", async (req, res): Promise<void> => {
  const action = String(req.body?.action ?? "");
  const newStatus = ACTION_STATUS[action];
  if (!newStatus) {
    res.status(400).json({ error: "Unknown action" });
    return;
  }
  const { data, error } = await supabase
    .from("fraud_alerts")
    .update({ status: newStatus, updated_at: new Date().toISOString() })
    .eq("id", req.params.id)
    .select("*")
    .single();
  if (error || !data) {
    res.status(404).json({ error: error?.message || "Alert not found" });
    return;
  }
  res.json({ alert: toCamel(data as AlertRow), message: `Action '${action}' applied` });
});

// keep PUT variant for backward compatibility
router.put("/fraud-detection/:id/action", async (req, res): Promise<void> => {
  const action = String(req.body?.action ?? "");
  const newStatus = ACTION_STATUS[action];
  if (!newStatus) {
    res.status(400).json({ error: "Unknown action" });
    return;
  }
  const { data, error } = await supabase
    .from("fraud_alerts")
    .update({ status: newStatus, updated_at: new Date().toISOString() })
    .eq("id", req.params.id)
    .select("*")
    .single();
  if (error || !data) {
    res.status(404).json({ error: error?.message || "Alert not found" });
    return;
  }
  res.json({ flag: toCamel(data as AlertRow), message: `Action '${action}' applied successfully` });
});

export default router;
