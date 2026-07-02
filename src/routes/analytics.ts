import { Router, type IRouter } from "express";
import { supabase } from "../lib/supabase";
import { requireAuth, requireRole } from "../middleware/auth";

const router: IRouter = Router();
router.use(requireAuth);

// Helper to calculate trend percentage
function calcTrend(current: number, previous: number): number {
  if (previous === 0) return current > 0 ? 100 : 0;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

// ── Repayment Trend (last 6 months) ──────────────────────────────────────────
router.get("/analytics/repayment-trend", requireRole("operator", "admin", "super_admin"), async (req, res): Promise<void> => {
  const now = new Date();
  const trends = [];

  for (let i = 5; i >= 0; i--) {
    const monthStart = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const monthEnd = new Date(now.getFullYear(), now.getMonth() - i + 1, 0);

    const { data: loans } = await supabase.from("loans")
      .select("status, approved_at")
      .gte("approved_at", monthStart.toISOString())
      .lt("approved_at", monthEnd.toISOString());

    const total = (loans ?? []).length;
    const completed = (loans ?? []).filter(l => l.status === "completed").length;
    const rate = total > 0 ? Math.round((completed / total) * 1000) / 10 : 0;

    trends.push({
      month: monthStart.toLocaleString("default", { month: "short", year: "2-digit" }),
      rate,
      totalLoans: total,
      completedLoans: completed,
    });
  }

  res.json({ trends });
});

// ── Risk Exposure Over Time ──────────────────────────────────────────────────
router.get("/analytics/risk-exposure", requireRole("operator", "admin", "super_admin"), async (req, res): Promise<void> => {
  const now = new Date();
  const exposures = [];

  for (let i = 5; i >= 0; i--) {
    const monthStart = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const monthEnd = new Date(now.getFullYear(), now.getMonth() - i + 1, 0);

    const { data: defaulted } = await supabase.from("loans")
      .select("remaining_balance, amount, status")
      .eq("status", "defaulted")
      .gte("created_at", monthStart.toISOString())
      .lt("created_at", monthEnd.toISOString());

    const totalExposure = (defaulted ?? []).reduce(
      (sum, l) => sum + Number(l.remaining_balance || l.amount || 0), 0
    );

    exposures.push({
      month: monthStart.toLocaleString("default", { month: "short", year: "2-digit" }),
      exposure: totalExposure,
      count: (defaulted ?? []).length,
    });
  }

  res.json({ exposures });
});

// ── Defaulter Trends ─────────────────────────────────────────────────────────
router.get("/analytics/defaulter-trend", requireRole("operator", "admin", "super_admin"), async (req, res): Promise<void> => {
  const now = new Date();
  const trends = [];

  for (let i = 5; i >= 0; i--) {
    const monthStart = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const monthEnd = new Date(now.getFullYear(), now.getMonth() - i + 1, 0);

    const { count: defaultedCount } = await supabase.from("loans")
      .select("*", { count: "exact", head: true })
      .eq("status", "defaulted")
      .gte("created_at", monthStart.toISOString())
      .lt("created_at", monthEnd.toISOString());

    const { count: totalLoans } = await supabase.from("loans")
      .select("*", { count: "exact", head: true })
      .gte("created_at", monthStart.toISOString())
      .lt("created_at", monthEnd.toISOString());

    const rate = (totalLoans ?? 0) > 0
      ? Math.round(((defaultedCount ?? 0) / (totalLoans ?? 1)) * 1000) / 10
      : 0;

    trends.push({
      month: monthStart.toLocaleString("default", { month: "short", year: "2-digit" }),
      count: defaultedCount ?? 0,
      rate,
    });
  }

  res.json({ trends });
});

// ── Platform KPIs Summary ───────────────────────────────────────────────────
router.get("/analytics/kpis", requireRole("viewer", "operator", "admin", "super_admin"), async (req, res): Promise<void> => {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const prevMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString();
  const prevMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0).toISOString();

  // Total users
  const { count: totalUsers } = await supabase.from("profiles").select("*", { count: "exact", head: true });

  // Active users (active in last 30 days)
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const { count: activeUsers30d } = await supabase.from("profiles")
    .select("*", { count: "exact", head: true })
    .eq("is_active", true)
    .gte("updated_at", thirtyDaysAgo.toISOString());

  // Revenue MTD
  const { data: txnsThisMonth } = await supabase.from("transactions")
    .select("amount").eq("status", "completed").gte("created_at", monthStart);
  const revenueMTD = (txnsThisMonth ?? []).reduce((s, t) => s + Number(t.amount || 0), 0);

  // Revenue last month for trend
  const { data: txnsLastMonth } = await supabase.from("transactions")
    .select("amount").eq("status", "completed")
    .gte("created_at", prevMonthStart).lt("created_at", prevMonthEnd);
  const revenueLastMonth = (txnsLastMonth ?? []).reduce((s, t) => s + Number(t.amount || 0), 0);

  // Loan portfolio
  const { data: activeLoans } = await supabase.from("loans")
    .select("remaining_balance").eq("status", "active");
  const loanPortfolio = (activeLoans ?? []).reduce((s, l) => s + Number(l.remaining_balance || 0), 0);

  // Savings pool
  const { data: savings } = await supabase.from("savings").select("total_saved");
  const savingsPool = (savings ?? []).reduce((s, r) => s + Number(r.total_saved || 0), 0);

  // New users this month
  const { count: newUsersThisMonth } = await supabase.from("profiles")
    .select("*", { count: "exact", head: true }).gte("created_at", monthStart);

  // Organizations count
  const { count: totalOrganizations } = await supabase.from("organizations")
    .select("*", { count: "exact", head: true });

  // Growth rate
  const growthRate = calcTrend(revenueMTD, revenueLastMonth);

  res.json({
    kpis: {
      totalUsers: totalUsers ?? 0,
      activeUsers30d: activeUsers30d ?? 0,
      revenueMTD,
      loanPortfolio,
      savingsPool,
      growthRate,
      newUsersThisMonth: newUsersThisMonth ?? 0,
      totalOrganizations: totalOrganizations ?? 0,
    },
  });
});

export default router;
