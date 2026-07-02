import { Router, type IRouter } from "express";
import { supabase } from "../lib/supabase";
import { requireAuth, requireRole } from "../middleware/auth";

const router: IRouter = Router();
router.use(requireAuth);

// Get reconciliation overview
router.get("/reconciliation/overview", requireRole("admin", "super_admin"), async (req, res): Promise<void> => {
  const { month } = req.query;
  const targetMonth = month || new Date().toISOString().slice(0, 7);

  // Get expected contributions (from member profiles + contribution schedules)
  const { data: contributions } = await supabase
    .from("contributions")
    .select("profile_id, amount, status, payment_method")
    .like("month", `${targetMonth}%`);

  // Calculate expected vs actual
  const totalExpected = (contributions || []).reduce((sum, c) => sum + Number(c.amount || 0), 0);
  const totalReceived = (contributions || [])
    .filter(c => c.status === "completed")
    .reduce((sum, c) => sum + Number(c.amount || 0), 0);
  const totalPending = (contributions || [])
    .filter(c => c.status === "pending")
    .reduce((sum, c) => sum + Number(c.amount || 0), 0);
  const totalFailed = (contributions || [])
    .filter(c => c.status === "failed")
    .reduce((sum, c) => sum + Number(c.amount || 0), 0);

  // Get breakdown by payment method
  const byMethod: Record<string, number> = {};
  (contributions || []).filter(c => c.status === "completed").forEach(c => {
    byMethod[c.payment_method || "unknown"] = (byMethod[c.payment_method || "unknown"] || 0) + Number(c.amount || 0);
  });

  res.json({
    month: targetMonth,
    summary: {
      expected: totalExpected,
      received: totalReceived,
      pending: totalPending,
      failed: totalFailed,
      variance: totalExpected - totalReceived,
      collectionRate: totalExpected > 0 ? ((totalReceived / totalExpected) * 100).toFixed(1) : "0",
    },
    byPaymentMethod: byMethod,
    transactionCount: contributions?.length || 0,
  });
});

// Get unreconciled transactions
router.get("/reconciliation/unreconciled", requireRole("admin", "super_admin"), async (req, res): Promise<void> => {
  const { type = "contributions" } = req.query;

  let query;
  if (type === "contributions") {
    query = supabase
      .from("contributions")
      .select("*, profiles!inner(name, email, user_id)")
      .eq("status", "pending")
      .order("created_at", { ascending: false });
  } else if (type === "withdrawals") {
    query = supabase
      .from("withdrawals")
      .select("*, profiles!inner(name, email, user_id)")
      .eq("status", "pending")
      .order("created_at", { ascending: false });
  }

  const { data, error } = await query;

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  res.json({ data: data || [] });
});

// Reconcile a single transaction
router.post("/reconciliation/reconcile", requireRole("admin", "super_admin"), async (req, res): Promise<void> => {
  const { transactionId, transactionType, action, note } = req.body;
  const userId = (req as any).user?.id;

  if (!["approve", "reject"].includes(action)) {
    res.status(400).json({ error: "Invalid action. Use 'approve' or 'reject'" });
    return;
  }

  const table = transactionType === "contribution" ? "contributions" : "withdrawals";
  const newStatus = action === "approve" ? "completed" : "failed";

  const { data, error } = await supabase
    .from(table)
    .update({ 
      status: newStatus,
      reconciled_by: userId,
      reconciled_at: new Date().toISOString(),
      reconciliation_note: note,
    })
    .eq("id", transactionId)
    .select()
    .single();

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  // Log in audit
  await supabase.from("audit_logs").insert({
    action: `reconcile_${action}`,
    target_type: transactionType,
    target_id: transactionId,
    actor_id: userId,
    details: { note },
    created_at: new Date().toISOString(),
  });

  res.json({ success: true, transaction: data });
});

// Bulk reconcile transactions
router.post("/reconciliation/bulk-reconcile", requireRole("super_admin"), async (req, res): Promise<void> => {
  const { transactionIds, transactionType, action, note } = req.body;
  const userId = (req as any).user?.id;

  if (!Array.isArray(transactionIds) || transactionIds.length === 0) {
    res.status(400).json({ error: "transactionIds must be a non-empty array" });
    return;
  }

  const table = transactionType === "contribution" ? "contributions" : "withdrawals";
  const newStatus = action === "approve" ? "completed" : "failed";

  const { data, error } = await supabase
    .from(table)
    .update({
      status: newStatus,
      reconciled_by: userId,
      reconciled_at: new Date().toISOString(),
      reconciliation_note: note,
    })
    .in("id", transactionIds);

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  res.json({
    success: true,
    reconciled: transactionIds.length,
    status: newStatus,
  });
});

// Get reconciliation history
router.get("/reconciliation/history", requireRole("admin", "super_admin"), async (req, res): Promise<void> => {
  const { page = 1, limit = 50 } = req.query;
  const offset = (Number(page) - 1) * Number(limit);

  const { data: history, count, error } = await supabase
    .from("reconciliation_logs")
    .select("*", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(offset, offset + Number(limit) - 1);

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  res.json({ data: history || [], total: count || 0, page: Number(page), limit: Number(limit) });
});

// Get monthly reconciliation report
router.get("/reconciliation/monthly-report", requireRole("admin", "super_admin"), async (req, res): Promise<void> => {
  const { months = 6 } = req.query;

  const reports = [];
  const now = new Date();

  for (let i = 0; i < Number(months); i++) {
    const date = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const monthStr = date.toISOString().slice(0, 7);

    const { data: contributions } = await supabase
      .from("contributions")
      .select("amount, status")
      .like("month", `${monthStr}%`);

    const total = (contributions || []).reduce((sum, c) => sum + Number(c.amount || 0), 0);
    const completed = (contributions || [])
      .filter(c => c.status === "completed")
      .reduce((sum, c) => sum + Number(c.amount || 0), 0);

    reports.push({
      month: monthStr,
      totalExpected: total,
      totalReceived: completed,
      collectionRate: total > 0 ? ((completed / total) * 100).toFixed(1) : "0",
      transactionCount: contributions?.length || 0,
    });
  }

  res.json({ data: reports.reverse() });
});

// Get discrepancy report
router.get("/reconciliation/discrepancies", requireRole("admin", "super_admin"), async (req, res): Promise<void> => {
  const { startDate, endDate } = req.query;

  let query = supabase
    .from("contributions")
    .select("*, profiles!inner(name, email, user_id)")
    .eq("status", "failed")
    .order("created_at", { ascending: false })
    .limit(100);

  if (startDate) query = query.gte("created_at", startDate as string);
  if (endDate) query = query.lte("created_at", endDate as string);

  const { data: failed, error } = await query;

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  // Group by reason if available
  const byReason: Record<string, number> = {};
  failed?.forEach(f => {
    const reason = f.failure_reason || "Unknown";
    byReason[reason] = (byReason[reason] || 0) + 1;
  });

  res.json({
    data: failed || [],
    summary: {
      totalDiscrepancies: failed?.length || 0,
      totalAmount: failed?.reduce((sum, f) => sum + Number(f.amount || 0), 0) || 0,
      byReason,
    },
  });
});

export default router;