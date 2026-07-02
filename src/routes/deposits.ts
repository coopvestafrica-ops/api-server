import { Router, type IRouter } from "express";
import { supabase } from "../lib/supabase";
import { requireAuth, requireRole } from "../middleware/auth";

const router: IRouter = Router();
router.use(requireAuth);

// GET /api/deposits - List all deposit requests
router.get("/deposits", requireRole("viewer", "operator", "admin", "super_admin"), async (req, res): Promise<void> => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Number(req.query.limit) || 20);
  const offset = (page - 1) * limit;
  const status = req.query.status as string | undefined;
  const memberId = req.query.memberId as string | undefined;

  let query = supabase
    .from("deposit_requests")
    .select(`
      id,
      profile_id,
      amount,
      currency,
      status,
      payment_proof_url,
      payment_reference,
      payment_date,
      bank_name,
      sender_account_name,
      sender_account_number,
      admin_notes,
      verified_by,
      verified_at,
      created_at,
      updated_at,
      profiles!deposit_requests_profile_id_fkey(name, first_name, last_name, email, phone)
    `, { count: "exact" });

  if (status) query = query.eq("status", status);
  if (memberId) query = query.eq("profile_id", memberId);

  const { data: rows, count, error } = await query
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) {
    console.error("Error fetching deposits:", error);
    res.status(500).json({ error: error.message });
    return;
  }

  res.json({
    data: (rows ?? []).map(r => ({
      id: r.id,
      profileId: r.profile_id,
      memberName: ((r.profiles as unknown as { name?: string; first_name?: string; last_name?: string }) ?? {}).name 
        || [((r.profiles as unknown as { first_name?: string }) ?? {}).first_name, ((r.profiles as unknown as { last_name?: string }) ?? {}).last_name].filter(Boolean).join(" ") 
        || ((r.profiles as unknown as { email?: string }) ?? {}).email 
        || "Unknown",
      memberEmail: ((r.profiles as unknown as { email?: string }) ?? {}).email || null,
      memberPhone: ((r.profiles as unknown as { phone?: string }) ?? {}).phone || null,
      amount: Number(r.amount),
      currency: r.currency || "NGN",
      status: r.status,
      paymentProofUrl: r.payment_proof_url,
      paymentReference: r.payment_reference,
      paymentDate: r.payment_date,
      bankName: r.bank_name,
      senderAccountName: r.sender_account_name,
      senderAccountNumber: r.sender_account_number,
      adminNotes: r.admin_notes,
      verifiedBy: r.verified_by,
      verifiedAt: r.verified_at,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    })),
    total: count ?? 0,
    page,
    limit,
  });
});

// GET /api/deposits/summary - Get deposit summary statistics
router.get("/deposits/summary", requireRole("viewer", "operator", "admin", "super_admin"), async (req, res): Promise<void> => {
  const { count: pendingCount } = await supabase
    .from("deposit_requests")
    .select("*", { count: "exact", head: true })
    .eq("status", "pending");

  const { count: verifiedCount } = await supabase
    .from("deposit_requests")
    .select("*", { count: "exact", head: true })
    .eq("status", "verified");

  const { count: rejectedCount } = await supabase
    .from("deposit_requests")
    .select("*", { count: "exact", head: true })
    .eq("status", "rejected");

  const { data: pendingRows } = await supabase
    .from("deposit_requests")
    .select("amount")
    .eq("status", "pending");

  const { data: verifiedRows } = await supabase
    .from("deposit_requests")
    .select("amount")
    .eq("status", "verified");

  const pendingAmount = (pendingRows ?? []).reduce((s, r) => s + Number(r.amount || 0), 0);
  const verifiedAmount = (verifiedRows ?? []).reduce((s, r) => s + Number(r.amount || 0), 0);

  res.json({
    pendingCount: pendingCount ?? 0,
    verifiedCount: verifiedCount ?? 0,
    rejectedCount: rejectedCount ?? 0,
    pendingAmount,
    verifiedAmount,
    totalCount: (pendingCount ?? 0) + (verifiedCount ?? 0) + (rejectedCount ?? 0),
  });
});

// PATCH /api/deposits/:id/verify - Verify a deposit request
router.patch("/deposits/:id/verify", requireRole("operator", "admin", "super_admin"), async (req, res): Promise<void> => {
  const { id } = req.params;
  const { adminNotes } = req.body as { adminNotes?: string };
  
  // Get the admin's profile ID from the auth context
  const authHeader = req.headers.authorization;
  let adminProfileId: string | null = null;
  
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice(7);
    try {
      const { data: { user } } = await supabase.auth.getUser(token);
      adminProfileId = user?.id ?? null;
    } catch {
      // Continue without admin ID
    }
  }

  // Get the deposit request
  const { data: deposit, error: fetchError } = await supabase
    .from("deposit_requests")
    .select("*, profiles!deposit_requests_profile_id_fkey(name)")
    .eq("id", id)
    .single();

  if (fetchError || !deposit) {
    res.status(404).json({ error: "Deposit request not found" });
    return;
  }

  // Update the deposit request
  const { data: updated, error: updateError } = await supabase
    .from("deposit_requests")
    .update({
      status: "verified",
      verified_by: adminProfileId,
      verified_at: new Date().toISOString(),
      admin_notes: adminNotes || null,
    })
    .eq("id", id)
    .select()
    .single();

  if (updateError) {
    res.status(500).json({ error: updateError.message });
    return;
  }

  // If there's a linked transaction, update its status too
  if (deposit.transaction_id) {
    await supabase
      .from("transactions")
      .update({ status: "completed" })
      .eq("id", deposit.transaction_id);
  }

  // Update the member's savings balance
  const memberProfileId = deposit.profile_id;
  const amount = Number(deposit.amount);

  const { data: existingSavings } = await supabase
    .from("savings")
    .select("id, total_saved, consecutive_months")
    .eq("profile_id", memberProfileId)
    .maybeSingle();

  const nowIso = new Date().toISOString();
  if (existingSavings) {
    await supabase
      .from("savings")
      .update({
        total_saved: Number(existingSavings.total_saved || 0) + amount,
        monthly_savings: amount,
        last_savings_date: nowIso,
        consecutive_months: Number(existingSavings.consecutive_months || 0) + 1,
        updated_at: nowIso,
      })
      .eq("id", existingSavings.id);
  } else {
    await supabase.from("savings").insert({
      profile_id: memberProfileId,
      total_saved: amount,
      monthly_savings: amount,
      first_savings_date: nowIso,
      last_savings_date: nowIso,
      consecutive_months: 1,
    });
  }

  // Update wallet balance
  const { data: wallet } = await supabase
    .from("wallets")
    .select("id, balance")
    .eq("profile_id", memberProfileId)
    .maybeSingle();

  if (wallet) {
    await supabase
      .from("wallets")
      .update({
        balance: Number(wallet.balance || 0) + amount,
        last_updated: nowIso,
      })
      .eq("id", wallet.id);
  }

  res.json({
    success: true,
    message: "Deposit verified successfully",
    deposit: updated,
  });
});

// PATCH /api/deposits/:id/reject - Reject a deposit request
router.patch("/deposits/:id/reject", requireRole("operator", "admin", "super_admin"), async (req, res): Promise<void> => {
  const { id } = req.params;
  const { adminNotes } = req.body as { adminNotes?: string };

  // Get the admin's profile ID from the auth context
  const authHeader = req.headers.authorization;
  let adminProfileId: string | null = null;
  
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice(7);
    try {
      const { data: { user } } = await supabase.auth.getUser(token);
      adminProfileId = user?.id ?? null;
    } catch {
      // Continue without admin ID
    }
  }

  // Update the deposit request
  const { data: updated, error: updateError } = await supabase
    .from("deposit_requests")
    .update({
      status: "rejected",
      verified_by: adminProfileId,
      verified_at: new Date().toISOString(),
      admin_notes: adminNotes || null,
    })
    .eq("id", id)
    .select()
    .single();

  if (updateError) {
    res.status(500).json({ error: updateError.message });
    return;
  }

  res.json({
    success: true,
    message: "Deposit rejected",
    deposit: updated,
  });
});

// PATCH /api/deposits/:id/cancel - Cancel a deposit request
router.patch("/deposits/:id/cancel", requireRole("operator", "admin", "super_admin"), async (req, res): Promise<void> => {
  const { id } = req.params;

  const { data: updated, error } = await supabase
    .from("deposit_requests")
    .update({ status: "cancelled" })
    .eq("id", id)
    .select()
    .single();

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  res.json({
    success: true,
    message: "Deposit cancelled",
    deposit: updated,
  });
});

export default router;