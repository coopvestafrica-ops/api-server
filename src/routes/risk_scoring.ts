import { Router, type IRouter } from "express";
import { supabase } from "../lib/supabase";

const router: IRouter = Router();

router.get("/risk-scoring", async (req, res): Promise<void> => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Number(req.query.limit) || 20);
  const offset = (page - 1) * limit;

  const { data: profiles, count, error } = await supabase
    .from("profiles")
    .select("id, name, user_id, is_active, is_flagged, kyc_verified, created_at", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) { res.status(500).json({ error: error.message }); return; }

  const profileIds = (profiles ?? []).map(p => p.id);
  const { data: loanData } = profileIds.length > 0
    ? await supabase.from("loans").select("profile_id, status, remaining_balance").in("profile_id", profileIds)
    : { data: [] };

  const loanMap = new Map<string, { active: number; defaulted: number; balance: number }>();
  for (const l of loanData ?? []) {
    const existing = loanMap.get(l.profile_id) ?? { active: 0, defaulted: 0, balance: 0 };
    if (l.status === "active") existing.active++;
    if (l.status === "defaulted") existing.defaulted++;
    existing.balance += Number(l.remaining_balance || 0);
    loanMap.set(l.profile_id, existing);
  }

  res.json({
    data: (profiles ?? []).map(p => {
      const loans = loanMap.get(p.id) ?? { active: 0, defaulted: 0, balance: 0 };
      const score = Math.max(0, 100 - loans.defaulted * 30 - (p.is_flagged ? 20 : 0));
      return {
        id: p.id,
        memberId: p.user_id,
        memberName: p.name ?? "",
        score,
        riskLevel: score >= 70 ? "low" : score >= 40 ? "medium" : "high",
        factors: {
          activeLoans: loans.active,
          defaultedLoans: loans.defaulted,
          totalBalance: loans.balance,
          isFlagged: p.is_flagged ?? false,
          kycVerified: p.kyc_verified ?? false,
        },
        lastUpdated: p.created_at,
      };
    }),
    total: count ?? 0,
    page,
    limit,
  });
});

export default router;
