import { Router, type IRouter } from "express";
import { supabase } from "../lib/supabase";

const router: IRouter = Router();

interface WithdrawalRow {
  id: string;
  user_id: string | null;
  user_name: string | null;
  amount: number | string | null;
  bank_name: string | null;
  account_number: string | null;
  account_name: string | null;
  status: string | null;
  risk_flag: boolean | null;
  risk_reason: string | null;
  created_at: string | null;
}

function toCamel(w: WithdrawalRow) {
  return {
    id: w.id,
    userId: w.user_id,
    userName: w.user_name || "Unknown",
    amount: Number(w.amount || 0),
    bankName: w.bank_name || "",
    accountNumber: w.account_number || "",
    accountName: w.account_name || "",
    requestedAt: w.created_at,
    status: w.status || "pending",
    riskFlag: !!w.risk_flag,
    riskReason: w.risk_reason || undefined,
  };
}

// GET /withdrawals
router.get("/withdrawals", async (req, res): Promise<void> => {
  const { status, search } = req.query as { status?: string; search?: string };
  let query = supabase
    .from("withdrawal_requests")
    .select("*")
    .order("created_at", { ascending: false });
  if (status && status !== "all") query = query.eq("status", status);
  const { data, error } = await query;
  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }
  let rows = (data ?? []).map(toCamel);
  if (search) {
    const q = String(search).toLowerCase();
    rows = rows.filter(
      (w) =>
        w.userName.toLowerCase().includes(q) ||
        w.accountNumber.toLowerCase().includes(q) ||
        w.bankName.toLowerCase().includes(q),
    );
  }
  res.json({ data: rows, total: rows.length });
});

const ACTION_STATUS: Record<string, string> = {
  approve: "approved",
  reject: "rejected",
  hold: "on_hold",
  flag: "pending",
};

// POST /withdrawals/:id/:action  (approve|reject|hold|flag)
router.post("/withdrawals/:id/:action", async (req, res): Promise<void> => {
  const { id, action } = req.params;
  const newStatus = ACTION_STATUS[action];
  if (!newStatus) {
    res.status(400).json({ error: "Unknown action" });
    return;
  }
  const update: Record<string, unknown> = { status: newStatus, updated_at: new Date().toISOString() };
  if (action === "flag") {
    update.risk_flag = true;
    if (req.body?.reason) update.risk_reason = String(req.body.reason);
  }
  if (action === "reject" && req.body?.reason) update.risk_reason = String(req.body.reason);
  const { data, error } = await supabase
    .from("withdrawal_requests")
    .update(update)
    .eq("id", id)
    .select("*")
    .single();
  if (error || !data) {
    res.status(404).json({ error: error?.message || "Request not found" });
    return;
  }
  res.json({ withdrawal: toCamel(data as WithdrawalRow), message: `Withdrawal ${newStatus}` });
});

// POST /withdrawals/bulk-approve
router.post("/withdrawals/bulk-approve", async (req, res): Promise<void> => {
  const ids: string[] = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [];
  if (!ids.length) {
    res.status(400).json({ error: "No ids provided" });
    return;
  }
  const { error } = await supabase
    .from("withdrawal_requests")
    .update({ status: "approved", updated_at: new Date().toISOString() })
    .in("id", ids);
  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }
  res.json({ message: `${ids.length} withdrawal(s) approved`, count: ids.length });
});

// GET /withdrawals/settings
router.get("/withdrawals/settings", async (_req, res): Promise<void> => {
  const { data } = await supabase.from("withdrawal_settings").select("*").limit(1).maybeSingle();
  res.json({
    settings: {
      dailyLimit: Number(data?.daily_limit ?? 1000000),
      requireApprovalAbove: Number(data?.require_approval_above ?? 500000),
      autoApproveBelow: Number(data?.auto_approve_below ?? 5000),
      maxPendingPerUser: Number(data?.max_pending_per_user ?? 3),
    },
  });
});

// PUT /withdrawals/daily-limit
router.put("/withdrawals/daily-limit", async (req, res): Promise<void> => {
  const limit = Number(req.body?.limit ?? 0);
  const { data: existing } = await supabase.from("withdrawal_settings").select("id").limit(1).maybeSingle();
  if (existing?.id) {
    await supabase
      .from("withdrawal_settings")
      .update({ daily_limit: limit, updated_at: new Date().toISOString() })
      .eq("id", existing.id);
  } else {
    await supabase.from("withdrawal_settings").insert({ daily_limit: limit });
  }
  res.json({ message: "Daily limit updated", dailyLimit: limit });
});

export default router;
