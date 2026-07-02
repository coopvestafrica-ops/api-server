import { Router, type IRouter } from "express";
import { supabase } from "../lib/supabase";

const router: IRouter = Router();

async function loadSettings() {
  const { data } = await supabase.from("referral_settings").select("*").limit(1).maybeSingle();
  return {
    enabled: data?.program_enabled ?? true,
    bonusAmount: Number(data?.bonus_per_referral ?? 0),
    maxReferralsPerUser: Number(data?.max_referrals_per_user ?? 0),
  };
}

router.get("/referrals", async (_req, res): Promise<void> => {
  const { data: refs, error } = await supabase
    .from("referrals")
    .select("profile_id, referral_count, confirmed_referral_count, current_tier_bonus")
    .order("referral_count", { ascending: false });
  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }
  const rows = refs ?? [];

  const profileIds = [...new Set(rows.map((r) => r.profile_id).filter(Boolean))];
  const nameMap: Record<string, string> = {};
  if (profileIds.length) {
    const { data: profs } = await supabase.from("profiles").select("id, name, email").in("id", profileIds);
    for (const p of profs ?? []) nameMap[p.id] = p.name || p.email || "Unknown";
  }

  const settings = await loadSettings();
  const leaderboard = rows.map((r, i) => ({
    rank: i + 1,
    userId: r.profile_id,
    userName: r.profile_id ? nameMap[r.profile_id] || "Unknown" : "Unknown",
    referralsMade: Number(r.referral_count || 0),
    bonusEarned: Number(r.current_tier_bonus || 0) || Number(r.confirmed_referral_count || 0) * settings.bonusAmount,
    status: "active" as const,
  }));

  const totalReferrals = leaderboard.reduce((s, r) => s + r.referralsMade, 0);
  const totalConfirmed = rows.reduce((s, r) => s + Number(r.confirmed_referral_count || 0), 0);
  const totalBonusPaid = leaderboard.reduce((s, r) => s + r.bonusEarned, 0);

  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);
  const { count: thisMonth } = await supabase
    .from("referrals")
    .select("id", { count: "exact", head: true })
    .gte("created_at", startOfMonth.toISOString());

  res.json({
    settings,
    leaderboard,
    analytics: {
      totalThisMonth: thisMonth ?? 0,
      totalBonusPaid,
      conversionRate: totalReferrals > 0 ? Math.round((totalConfirmed / totalReferrals) * 1000) / 10 : 0,
    },
  });
});

router.get("/referrals/settings", async (_req, res): Promise<void> => {
  res.json({ settings: await loadSettings() });
});

router.put("/referrals/settings", async (req, res): Promise<void> => {
  const b = req.body ?? {};
  const update = {
    program_enabled: b.enabled !== undefined ? !!b.enabled : undefined,
    bonus_per_referral: b.bonusAmount !== undefined ? Number(b.bonusAmount) : undefined,
    max_referrals_per_user: b.maxReferralsPerUser !== undefined ? Number(b.maxReferralsPerUser) : undefined,
    updated_at: new Date().toISOString(),
  };
  const { data: existing } = await supabase.from("referral_settings").select("id").limit(1).maybeSingle();
  if (existing?.id) {
    await supabase.from("referral_settings").update(update).eq("id", existing.id);
  } else {
    await supabase.from("referral_settings").insert(update);
  }
  res.json({ settings: await loadSettings(), message: "Referral settings updated" });
});

export default router;
