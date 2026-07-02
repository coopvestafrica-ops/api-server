import { Router, type IRouter } from "express";
import { supabase } from "../lib/supabase";

const router: IRouter = Router();

const ACTIVE_STATUSES = ["confirmed", "consented", "active", "accepted"];
const PENDING_STATUSES = ["pending", "requested", "scanned"];

async function loadSettings() {
  const { data } = await supabase.from("guarantor_settings").select("*").limit(1).maybeSingle();
  return {
    requireGuarantor: data?.system_enabled ?? false,
    minimumGuarantorBalance: Number(data?.minimum_balance ?? 0),
    minimumMembershipMonths: Number(data?.minimum_membership_months ?? 0),
  };
}

// GET /guarantors — real loan_guarantors joined with loans + profiles
router.get("/guarantors", async (_req, res): Promise<void> => {
  const { data: links, error } = await supabase
    .from("loan_guarantors")
    .select("id, loan_id, guarantor_id, status, consented_at, created_at")
    .order("created_at", { ascending: false });
  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }
  const rows = links ?? [];

  const loanIds = [...new Set(rows.map((r) => r.loan_id).filter(Boolean))];
  const loanMap: Record<string, { amount: number; profile_id: string | null }> = {};
  if (loanIds.length) {
    const { data: loans } = await supabase
      .from("loans")
      .select("id, amount, profile_id")
      .in("id", loanIds);
    for (const l of loans ?? []) loanMap[l.id] = { amount: Number(l.amount || 0), profile_id: l.profile_id };
  }

  const profileIds = [
    ...new Set([
      ...rows.map((r) => r.guarantor_id),
      ...Object.values(loanMap).map((l) => l.profile_id),
    ].filter(Boolean) as string[]),
  ];
  const nameMap: Record<string, string> = {};
  if (profileIds.length) {
    const { data: profs } = await supabase.from("profiles").select("id, name, email").in("id", profileIds);
    for (const p of profs ?? []) nameMap[p.id] = p.name || p.email || "Unknown";
  }

  const mapRow = (r: (typeof rows)[number]) => {
    const loan = loanMap[r.loan_id] ?? { amount: 0, profile_id: null };
    return {
      id: r.id,
      borrowerId: loan.profile_id,
      borrowerName: loan.profile_id ? nameMap[loan.profile_id] || "Unknown" : "Unknown",
      guarantorId: r.guarantor_id,
      guarantorName: r.guarantor_id ? nameMap[r.guarantor_id] || "Unknown" : "Unknown",
      loanAmount: loan.amount,
      status: ACTIVE_STATUSES.includes(String(r.status)) ? "active" : (r.status || "pending"),
      startedAt: r.consented_at || r.created_at,
      requestedAt: r.created_at,
    };
  };

  const relationships = rows
    .filter((r) => ACTIVE_STATUSES.includes(String(r.status)))
    .map(mapRow);
  const pendingRequests = rows
    .filter((r) => PENDING_STATUSES.includes(String(r.status)))
    .map(mapRow);

  res.json({
    relationships,
    pendingRequests,
    settings: await loadSettings(),
    totalRelationships: relationships.length,
  });
});

// PUT /guarantors/settings
router.put("/guarantors/settings", async (req, res): Promise<void> => {
  const body = req.body ?? {};
  const update = {
    system_enabled: !!body.requireGuarantor,
    minimum_balance: Number(body.minimumGuarantorBalance ?? 0),
    minimum_membership_months: Number(body.minimumMembershipMonths ?? 0),
    updated_at: new Date().toISOString(),
  };
  const { data: existing } = await supabase.from("guarantor_settings").select("id").limit(1).maybeSingle();
  if (existing?.id) {
    await supabase.from("guarantor_settings").update(update).eq("id", existing.id);
  } else {
    await supabase.from("guarantor_settings").insert(update);
  }
  res.json({ settings: await loadSettings(), message: "Guarantor settings updated" });
});

// POST /guarantors/requests/:id/:action (approve|reject)
router.post("/guarantors/requests/:id/:action", async (req, res): Promise<void> => {
  const { id, action } = req.params;
  const newStatus = action === "approve" ? "confirmed" : "rejected";
  const { data, error } = await supabase
    .from("loan_guarantors")
    .update({
      status: newStatus,
      ...(action === "approve" ? { consented_at: new Date().toISOString() } : {}),
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .select("*")
    .single();
  if (error || !data) {
    res.status(404).json({ error: error?.message || "Request not found" });
    return;
  }
  res.json({ message: `Request ${action}d`, request: data });
});

export default router;
