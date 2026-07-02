import { Router, type IRouter } from "express";
import { supabase } from "../lib/supabase";
import { z } from "zod";
import { requireAuth, requireRole } from "../middleware/auth";

const router: IRouter = Router();
router.use(requireAuth);

const CreateInvestmentBody = z.object({
  name: z.string().min(1, "name is required"),
  type: z.string().min(1, "type is required"),
  amount: z.number().positive("amount must be a positive number"),
  startDate: z.string().min(1, "startDate is required"),
  maturityDate: z.string().optional(),
  description: z.string().optional(),
});

router.get("/investments/portfolio", requireRole("viewer", "operator", "admin", "super_admin"), async (req, res): Promise<void> => {
  const { data: pools, error } = await supabase.from("investment_pools").select("*");
  
  if (error) {
    res.status(500).json({ 
      totalInvested: 0,
      currentValue: 0,
      totalReturns: 0,
      returnPercentage: 0,
      activeCount: 0,
      maturedCount: 0,
      breakdown: [],
    });
    return;
  }

  const rows = Array.isArray(pools) ? pools : [];

  const totalInvested = rows.reduce((s, p) => s + Number(p.target_amount || 0), 0);
  const currentValue = rows.reduce((s, p) => s + Number(p.raised_amount || 0), 0);
  const totalReturns = currentValue - totalInvested;
  const returnPct = totalInvested > 0 ? (totalReturns / totalInvested) * 100 : 0;

  const activeCount = rows.filter(p => p.status === "active" || p.status === "open" || p.status === "funded").length;
  const maturedCount = rows.filter(p => p.status === "completed").length;

  const grouped = new Map<string, { count: number; amount: number }>();
  for (const p of rows) {
    const s = p.status;
    const existing = grouped.get(s) ?? { count: 0, amount: 0 };
    grouped.set(s, { count: existing.count + 1, amount: existing.amount + Number(p.raised_amount || 0) });
  }

  const total = rows.length;
  res.json({
    totalInvested,
    currentValue,
    totalReturns: Math.max(0, totalReturns),
    returnPercentage: Math.round(returnPct * 10) / 10,
    activeCount,
    maturedCount,
    breakdown: Array.from(grouped.entries()).map(([status, v]) => ({
      status,
      count: v.count,
      amount: v.amount,
      percentage: total > 0 ? Math.round((v.count / total) * 1000) / 10 : 0,
    })),
  });
});

router.get("/investments", async (req, res): Promise<void> => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Number(req.query.limit) || 20);
  const offset = (page - 1) * limit;
  const status = req.query.status as string | undefined;
  const profileId = req.query.profile_id as string | undefined;

  // If profile_id is provided, fetch user's investments from user_investments table
  if (profileId) {
    let query = supabase.from("user_investments").select("*", { count: "exact" }).eq("profile_id", profileId);
    if (status) query = query.eq("status", status);

    const { data: userInv, count, error } = await query
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) { res.status(500).json({ error: error.message }); return; }

    const investments = Array.isArray(userInv) ? userInv : [];
    res.json({
      data: investments.map(inv => ({
        id: inv.id,
        name: inv.investment_name || "Investment",
        type: inv.investment_type || "pool",
        amount: Number(inv.amount_invested || 0),
        currentValue: Number(inv.current_value || inv.amount_invested || 0),
        returns: Number(inv.current_value || inv.amount_invested || 0) - Number(inv.amount_invested || 0),
        returnPercentage: Number(inv.return_rate || 0),
        status: inv.status || "active",
        startDate: inv.start_date?.slice(0, 10) ?? null,
        maturityDate: inv.maturity_date?.slice(0, 10) ?? null,
        description: inv.notes || null,
        createdAt: inv.created_at,
      })),
      total: count ?? 0,
      page,
      limit,
    });
    return;
  }

  // Otherwise, fetch from investment_pools (the pool listings)
  let query = supabase.from("investment_pools").select("*", { count: "exact" });
  if (status) query = query.eq("status", status);

  const { data: pools, count, error } = await query
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) { res.status(500).json({ error: error.message }); return; }

  const poolData = Array.isArray(pools) ? pools : [];
  res.json({
    data: poolData.map(p => ({
      id: p.id,
      name: p.name,
      type: p.category ?? "pool",
      amount: Number(p.target_amount),
      currentValue: Number(p.raised_amount),
      returns: Number(p.raised_amount) - Number(p.target_amount),
      returnPercentage: Number(p.expected_return_percent ?? 0),
      status: p.status === "completed" ? "matured" : p.status === "open" || p.status === "funded" ? "active" : p.status,
      startDate: p.opens_at?.slice(0, 10) ?? p.created_at?.slice(0, 10) ?? null,
      maturityDate: p.closes_at?.slice(0, 10) ?? null,
      description: p.description ?? null,
      createdAt: p.created_at,
    })),
    total: count ?? 0,
    page,
    limit,
  });
});

router.post("/investments", async (req, res): Promise<void> => {
  const parsed = CreateInvestmentBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation failed", details: parsed.error.flatten().fieldErrors });
    return;
  }

  const { name, type, amount, startDate, maturityDate, description } = parsed.data;

  const poolId = "POOL-" + crypto.randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase();
  const { data: pool, error } = await supabase.from("investment_pools").insert({
    pool_id: poolId,
    name,
    category: type,
    target_amount: amount,
    raised_amount: 0,
    expected_return_percent: 0,
    duration_months: maturityDate
      ? Math.round((new Date(maturityDate).getTime() - new Date(startDate).getTime()) / (30 * 24 * 60 * 60 * 1000))
      : null,
    risk_level: "medium",
    status: "open",
    opens_at: startDate,
    closes_at: maturityDate ?? null,
    description,
  }).select().single();

  if (error) { res.status(500).json({ error: error.message }); return; }

  res.status(201).json({
    id: pool.id,
    name: pool.name,
    type: pool.category ?? "pool",
    amount: Number(pool.target_amount),
    currentValue: Number(pool.raised_amount),
    returns: 0,
    returnPercentage: 0,
    status: "active",
    startDate: pool.opens_at?.slice(0, 10) ?? null,
    maturityDate: pool.closes_at?.slice(0, 10) ?? null,
    description: pool.description,
    createdAt: pool.created_at,
  });
});

export default router;
