import { Router, type IRouter } from "express";
import { supabase } from "../lib/supabase";

const router: IRouter = Router();

function newRef(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

// GET /wallets — real wallets joined with profiles
router.get("/wallets", async (req, res): Promise<void> => {
  const { status, search } = req.query as { status?: string; search?: string };

  const { data: walletRows, error } = await supabase
    .from("wallets")
    .select("id, profile_id, balance, is_active, last_updated")
    .order("last_updated", { ascending: false });
  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }
  const wallets = walletRows ?? [];

  const profileIds = [...new Set(wallets.map((w) => w.profile_id).filter(Boolean))];
  const profileMap: Record<string, { name: string | null; email: string | null }> = {};
  if (profileIds.length) {
    const { data: profs } = await supabase
      .from("profiles")
      .select("id, name, email")
      .in("id", profileIds);
    for (const p of profs ?? []) profileMap[p.id] = { name: p.name, email: p.email };
  }

  let data = wallets.map((w) => {
    const prof = profileMap[w.profile_id] ?? { name: null, email: null };
    return {
      id: w.id,
      userId: w.profile_id,
      userName: prof.name || prof.email || "Unknown",
      userEmail: prof.email || "",
      balance: Number(w.balance || 0),
      status: w.is_active ? "active" : "frozen",
      lastTransactionAt: w.last_updated,
      lastTransactionAmount: 0,
    };
  });

  if (status && status !== "all") data = data.filter((w) => w.status === status);
  if (search) {
    const q = String(search).toLowerCase();
    data = data.filter(
      (w) => w.userName.toLowerCase().includes(q) || w.userEmail.toLowerCase().includes(q),
    );
  }

  const totalBalance = wallets.reduce((s, w) => s + Number(w.balance || 0), 0);
  const frozenCount = wallets.filter((w) => !w.is_active).length;

  const { count: pendingTransfers } = await supabase
    .from("withdrawal_requests")
    .select("id", { count: "exact", head: true })
    .eq("status", "pending");

  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const { data: todayTx } = await supabase
    .from("transactions")
    .select("amount")
    .gte("created_at", startOfDay.toISOString());
  const todayVolume = (todayTx ?? []).reduce((s, t) => s + Number(t.amount || 0), 0);

  res.json({
    data,
    total: data.length,
    pendingTransfers: pendingTransfers ?? 0,
    todayVolume,
    frozenCount,
    totalBalance,
  });
});

// GET /wallets/stats — summary
router.get("/wallets/stats", async (_req, res): Promise<void> => {
  const { data: wallets } = await supabase.from("wallets").select("balance, is_active");
  const rows = wallets ?? [];
  res.json({
    totalBalance: rows.reduce((s, w) => s + Number(w.balance || 0), 0),
    activeWallets: rows.filter((w) => w.is_active).length,
    frozenWallets: rows.filter((w) => !w.is_active).length,
    suspendedWallets: 0,
    totalWallets: rows.length,
  });
});

// PATCH /wallets/:id/status — { status: active|frozen|suspended }
router.patch("/wallets/:id/status", async (req, res): Promise<void> => {
  const { status } = req.body as { status?: string };
  const isActive = status === "active";
  const { data, error } = await supabase
    .from("wallets")
    .update({ is_active: isActive, updated_at: new Date().toISOString() })
    .eq("id", req.params.id)
    .select("*")
    .single();
  if (error || !data) {
    res.status(404).json({ error: error?.message || "Wallet not found" });
    return;
  }
  res.json({ wallet: data, message: "Wallet status updated" });
});

// POST /wallets/:id/adjust — { amount, note } manual balance adjustment
router.post("/wallets/:id/adjust", async (req, res): Promise<void> => {
  const amount = Number(req.body?.amount ?? 0);
  const note = String(req.body?.note ?? "Manual adjustment");
  if (!Number.isFinite(amount) || amount === 0) {
    res.status(400).json({ error: "A non-zero amount is required" });
    return;
  }

  const { data: wallet, error: fetchErr } = await supabase
    .from("wallets")
    .select("id, profile_id, balance")
    .eq("id", req.params.id)
    .single();
  if (fetchErr || !wallet) {
    res.status(404).json({ error: fetchErr?.message || "Wallet not found" });
    return;
  }

  const balanceBefore = Number(wallet.balance || 0);
  const balanceAfter = balanceBefore + amount;

  const { data: updated, error: updErr } = await supabase
    .from("wallets")
    .update({ balance: balanceAfter, last_updated: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", req.params.id)
    .select("*")
    .single();
  if (updErr || !updated) {
    res.status(500).json({ error: updErr?.message || "Failed to adjust balance" });
    return;
  }

  // Record an audit transaction so the change reflects in the member's app history
  await supabase.from("transactions").insert({
    transaction_id: newRef("ADJ"),
    reference: newRef("ADJ"),
    profile_id: wallet.profile_id,
    wallet_id: wallet.id,
    type: amount >= 0 ? "credit" : "debit",
    category: "adjustment",
    amount: Math.abs(amount),
    status: "completed",
    description: note,
    balance_before: balanceBefore,
    balance_after: balanceAfter,
  });

  res.json({ wallet: updated, message: "Balance adjusted successfully" });
});

export default router;
