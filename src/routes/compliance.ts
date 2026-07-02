import { Router, type IRouter } from "express";
import { supabase } from "../lib/supabase";
import { requireAuth, requireRole } from "../middleware/auth";

const router: IRouter = Router();
router.use(requireAuth);

router.get("/compliance/summary", requireRole("viewer", "operator", "admin", "super_admin"), async (req, res): Promise<void> => {
  const { count: pending } = await supabase.from("kyc").select("*", { count: "exact", head: true }).eq("status", "pending");
  const { count: approved } = await supabase.from("kyc").select("*", { count: "exact", head: true }).eq("status", "verified");
  const { count: flagged } = await supabase.from("kyc").select("*", { count: "exact", head: true }).eq("status", "in_review");
  const { count: rejected } = await supabase.from("kyc").select("*", { count: "exact", head: true }).eq("status", "rejected");

  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const { count: thisMonth } = await supabase.from("kyc").select("*", { count: "exact", head: true }).gte("created_at", monthStart);

  const totalReviewed = (approved ?? 0) + (rejected ?? 0);
  const approvalRate = totalReviewed > 0 ? ((approved ?? 0) / totalReviewed) * 100 : 0;

  res.json({
    pending: pending ?? 0,
    approved: approved ?? 0,
    flagged: flagged ?? 0,
    rejected: rejected ?? 0,
    totalThisMonth: thisMonth ?? 0,
    approvalRate: Math.round(approvalRate * 10) / 10,
  });
});

router.get("/compliance", requireRole("viewer", "operator", "admin", "super_admin"), async (req, res): Promise<void> => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Number(req.query.limit) || 20);
  const offset = (page - 1) * limit;
  const status = req.query.status as string | undefined;

  const statusMap: Record<string, string> = { pending: "pending", approved: "verified", flagged: "in_review", rejected: "rejected" };
  let query = supabase.from("kyc").select("*, profiles!kyc_profile_id_fkey(id, first_name, last_name, name, email, user_id)", { count: "exact" });
  if (status && statusMap[status]) query = query.eq("status", statusMap[status]);

  const { data: kycItems, count, error } = await query
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) { res.status(500).json({ error: error.message }); return; }

  const reverseStatusMap: Record<string, string> = { pending: "pending", verified: "approved", in_review: "flagged", rejected: "rejected", expired: "rejected" };

  res.json({
    data: (kycItems ?? []).map(k => {
      const profile = k.profiles as unknown as { name?: string; first_name?: string; last_name?: string; email?: string; user_id?: string } | null;
      const memberName = [profile?.first_name, profile?.last_name].filter(Boolean).join(" ") || profile?.email || `Member ${k.profile_id?.slice(0, 8)}`;
      return {
        id: k.id,
        memberId: k.profile_id,
        memberName,
        type: "KYC Verification",
        status: reverseStatusMap[k.status] ?? k.status,
        description: `KYC level ${k.verification_level ?? 0} verification`,
        riskLevel: "low",
        reviewedBy: null,
        notes: k.rejection_reason ?? null,
        submittedAt: k.submitted_at ?? k.created_at,
        reviewedAt: k.verified_at ?? null,
      };
    }),
    total: count ?? 0,
    page,
    limit,
  });
});

// Compliance approve/reject require operator role minimum
router.post("/compliance/:id/approve", requireRole("operator", "admin", "super_admin"), async (req, res): Promise<void> => {
  const id = req.params.id;
  const { data: updated, error } = await supabase.from("kyc").update({
    status: "verified",
    verified: true,
    verified_at: new Date().toISOString(),
  }).eq("id", id).select().single();

  if (error || !updated) { res.status(404).json({ error: "Not found" }); return; }

  // Also update profile
  if (updated.profile_id) {
    await supabase.from("profiles").update({ kyc_verified: true }).eq("id", updated.profile_id);
  }

  res.json({ id: updated.id, status: "approved", reviewedAt: updated.verified_at });
});

router.post("/compliance/:id/reject", requireRole("operator", "admin", "super_admin"), async (req, res): Promise<void> => {
  const id = req.params.id;
  const { reason } = req.body;

  const { data: updated, error } = await supabase.from("kyc").update({
    status: "rejected",
    verified: false,
    rejection_reason: reason ?? "Rejected by admin",
  }).eq("id", id).select().single();

  if (error || !updated) { res.status(404).json({ error: "Not found" }); return; }
  res.json({ id: updated.id, status: "rejected", reviewedAt: new Date().toISOString() });
});

export default router;
