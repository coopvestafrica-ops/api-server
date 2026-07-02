import { Router, type IRouter } from "express";
import { supabase } from "../lib/supabase";

const router: IRouter = Router();

interface SubmissionRow {
  id: string;
  user_id: string | null;
  data: Record<string, unknown> | null;
  submitted_at: string | null;
}

interface ProfileLite {
  id: string;
  name: string | null;
  email: string | null;
  kyc_verified: boolean | null;
  is_flagged: boolean | null;
  flagged_reason: string | null;
  updated_at: string | null;
}

function deriveDocType(data: Record<string, unknown> | null): string {
  const raw = String((data?.idType ?? data?.documentType ?? "") as string).toLowerCase();
  if (raw.includes("nin")) return "NIN";
  if (raw.includes("bvn")) return "BVN";
  if (raw.includes("passport")) return "passport";
  if (raw.includes("licen")) return "drivers_license";
  if (data?.nin) return "NIN";
  if (data?.bvn) return "BVN";
  return "NIN";
}

function deriveStatus(p: ProfileLite | undefined): string {
  if (!p) return "pending";
  if (p.kyc_verified) return "verified";
  if (p.is_flagged) return "rejected";
  return "pending";
}

router.get("/verification", async (req, res): Promise<void> => {
  const { status, search, page = "1", limit = "20" } = req.query as Record<string, string>;

  const { data: subs, error } = await supabase
    .from("kyc_submissions")
    .select("id, user_id, data, submitted_at")
    .order("submitted_at", { ascending: false });
  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }
  const submissions = (subs ?? []) as SubmissionRow[];

  const userIds = [...new Set(submissions.map((s) => s.user_id).filter(Boolean) as string[])];
  const profMap: Record<string, ProfileLite> = {};
  if (userIds.length) {
    const { data: profs } = await supabase
      .from("profiles")
      .select("id, name, email, kyc_verified, is_flagged, flagged_reason, updated_at")
      .in("id", userIds);
    for (const p of (profs ?? []) as ProfileLite[]) profMap[p.id] = p;
  }

  let records = submissions.map((s) => {
    const p = s.user_id ? profMap[s.user_id] : undefined;
    return {
      id: s.id,
      userId: s.user_id || "",
      userName: p?.name || p?.email || "Unknown",
      userEmail: p?.email || "",
      submittedAt: s.submitted_at,
      documentType: deriveDocType(s.data),
      status: deriveStatus(p),
      reviewedAt: p?.kyc_verified || p?.is_flagged ? p?.updated_at : undefined,
      rejectionReason: p?.flagged_reason || undefined,
    };
  });

  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const pendingCount = records.filter((r) => r.status === "pending").length;
  const rejectedCount = records.filter((r) => r.status === "rejected").length;
  const totalVerified = records.filter((r) => r.status === "verified").length;
  const verifiedToday = records.filter(
    (r) => r.status === "verified" && r.reviewedAt && new Date(r.reviewedAt) >= startOfDay,
  ).length;

  if (status && status !== "all") records = records.filter((r) => r.status === status);
  if (search) {
    const q = String(search).toLowerCase();
    records = records.filter(
      (r) => r.userName.toLowerCase().includes(q) || r.userEmail.toLowerCase().includes(q),
    );
  }

  const total = records.length;
  const p = Math.max(1, Number(page));
  const l = Math.max(1, Number(limit));
  const paged = records.slice((p - 1) * l, (p - 1) * l + l);

  res.json({ data: paged, total, pendingCount, verifiedToday, rejectedCount, totalVerified });
});

// POST /verification/:id/:action  (verify | reject | request_resubmission)
router.post("/verification/:id/:action", async (req, res): Promise<void> => {
  const { id, action } = req.params;
  const reason = req.body?.reason as string | undefined;

  const { data: sub } = await supabase
    .from("kyc_submissions")
    .select("id, user_id")
    .eq("id", id)
    .maybeSingle();
  if (!sub?.user_id) {
    res.status(404).json({ error: "Submission not found" });
    return;
  }

  let update: Record<string, unknown>;
  if (action === "verify") {
    update = { kyc_verified: true, is_active: true, is_flagged: false, flagged_reason: null };
  } else if (action === "reject" || action === "request_resubmission") {
    update = { kyc_verified: false, is_flagged: true, flagged_reason: reason || (action === "reject" ? "KYC rejected" : "Re-submission requested") };
  } else {
    res.status(400).json({ error: "Unknown action" });
    return;
  }
  update.updated_at = new Date().toISOString();

  const { error } = await supabase.from("profiles").update(update).eq("id", sub.user_id);
  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }
  res.json({ message: `KYC ${action.replace("_", " ")} applied` });
});

export default router;
