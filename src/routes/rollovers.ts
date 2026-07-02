import { Router, type IRouter } from "express";
import { supabase } from "../lib/supabase";
import { z } from "zod";

const router: IRouter = Router();

const RequestRolloverBody = z.object({
  loan_id: z.string().min(1, "loan_id is required"),
  member_id: z.string().min(1, "member_id is required"),
  reason: z.string().min(1, "reason is required"),
  new_tenure: z.number().int().positive("new_tenure must be a positive integer"),
});

const AddGuarantorBody = z.object({
  guarantor_id: z.string().min(1, "guarantor_id is required"),
  guarantor_name: z.string().min(1, "guarantor_name is required"),
  guarantor_phone: z.string().min(1, "guarantor_phone is required"),
});

const GuarantorRespondBody = z.object({
  accepted: z.boolean({ required_error: "accepted (boolean) is required" }),
  reason: z.string().optional(),
});

const ApproveRolloverBody = z.object({
  admin_id: z.string().optional(),
  notes: z.string().optional(),
});

const RejectRolloverBody = z.object({
  reason: z.string().min(1, "reason is required"),
  admin_id: z.string().optional(),
});

router.post("/rollovers/request", async (req, res): Promise<void> => {
  const parsed = RequestRolloverBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, message: "Validation failed", details: parsed.error.flatten().fieldErrors });
    return;
  }

  const { loan_id, member_id, reason, new_tenure } = parsed.data;

  const { data: loan } = await supabase.from("loans").select("*").eq("id", loan_id).single();
  if (!loan) { res.status(404).json({ success: false, message: "Loan not found" }); return; }

  const outstandingBalance = Number(loan.remaining_balance ?? loan.amount);
  const rolloverFee = outstandingBalance * 0.02;
  const newMonthly = (outstandingBalance + rolloverFee) / new_tenure;

  const rolloverId = "ROL-" + crypto.randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase();
  const { data: rollover, error } = await supabase.from("rollovers").insert({
    rollover_id: rolloverId,
    loan_id: loan.id,
    profile_id: member_id,
    original_amount: Number(loan.amount),
    outstanding_balance: outstandingBalance,
    rollover_fee: rolloverFee,
    new_tenure,
    new_monthly_payment: Number(newMonthly.toFixed(2)),
    reason,
    status: "pending_guarantors",
  }).select().single();

  if (error) { res.status(500).json({ success: false, message: error.message }); return; }

  res.status(201).json({
    success: true,
    message: "Rollover requested",
    rollover: {
      id: rollover.id,
      rolloverId: rollover.rollover_id,
      loanId: rollover.loan_id,
      memberId: rollover.profile_id,
      originalAmount: Number(rollover.original_amount),
      outstandingBalance: Number(rollover.outstanding_balance),
      rolloverFee: Number(rollover.rollover_fee),
      newTenure: rollover.new_tenure,
      newMonthlyPayment: Number(rollover.new_monthly_payment),
      status: rollover.status,
      createdAt: rollover.created_at,
    },
  });
});

router.get("/rollovers/:rolloverId", async (req, res): Promise<void> => {
  const rolloverId = req.params.rolloverId;
  const { data: rollover } = await supabase.from("rollovers").select("*, profiles!rollovers_profile_id_fkey(id, first_name, last_name, name, email)").eq("rollover_id", rolloverId).single();
  if (!rollover) { res.status(404).json({ success: false, message: "Rollover not found" }); return; }

  const profile = rollover.profiles as unknown as { name?: string; first_name?: string; last_name?: string; email?: string } | null;
  const memberName = [profile?.first_name, profile?.last_name].filter(Boolean).join(" ") || profile?.email || `Member ${rollover.profile_id?.slice(0, 8)}`;
  res.json({
    success: true,
    rollover: {
      id: rollover.id,
      rolloverId: rollover.rollover_id,
      loanId: rollover.loan_id,
      memberId: rollover.profile_id,
      memberName,
      originalAmount: Number(rollover.original_amount),
      outstandingBalance: Number(rollover.outstanding_balance),
      rolloverFee: Number(rollover.rollover_fee),
      newTenure: rollover.new_tenure,
      newMonthlyPayment: rollover.new_monthly_payment ? Number(rollover.new_monthly_payment) : undefined,
      status: rollover.status,
      reason: rollover.reason,
      createdAt: rollover.created_at,
    },
  });
});

router.post("/rollovers/:rolloverId/guarantors", async (req, res): Promise<void> => {
  const parsed = AddGuarantorBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, message: "Validation failed", details: parsed.error.flatten().fieldErrors });
    return;
  }

  const rolloverId = req.params.rolloverId;
  const { guarantor_id } = parsed.data;

  const { data: rollover } = await supabase.from("rollovers").select("id").eq("rollover_id", rolloverId).single();
  if (!rollover) { res.status(404).json({ success: false, message: "Rollover not found" }); return; }

  // Get guarantor profile info
  const { data: guarantorProfile } = await supabase
    .from("profiles")
    .select("name, email, phone")
    .eq("id", guarantor_id)
    .single();

  const { data: guarantor, error } = await supabase.from("loan_guarantors").insert({
    loan_id: rollover.id,
    guarantor_id,
    status: "pending",
  }).select().single();

  if (error) { res.status(500).json({ success: false, message: error.message }); return; }
  
  res.status(201).json({ 
    success: true, 
    message: "Guarantor added successfully", 
    guarantor: {
      ...guarantor,
      guarantor_name: guarantorProfile?.name || guarantorProfile?.email || "Unknown",
      guarantor_phone: guarantorProfile?.phone || null,
    }
  });
});

router.get("/rollovers/:rolloverId/guarantors", async (req, res): Promise<void> => {
  const rolloverId = req.params.rolloverId;
  const { data: rollover } = await supabase.from("rollovers").select("id").eq("rollover_id", rolloverId).single();
  if (!rollover) { res.status(404).json({ success: false, message: "Rollover not found" }); return; }

  const { data: guarantors } = await supabase.from("loan_guarantors").select("*").eq("loan_id", rollover.id);
  res.json({ success: true, message: "Guarantors retrieved", guarantors: guarantors ?? [] });
});

router.post("/rollovers/:rolloverId/guarantors/:guarantorId/respond", async (req, res): Promise<void> => {
  const parsed = GuarantorRespondBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, message: "Validation failed", details: parsed.error.flatten().fieldErrors });
    return;
  }

  const rolloverId = req.params.rolloverId;
  const guarantorId = req.params.guarantorId;
  const { accepted, reason } = parsed.data;

  const { data: rollover } = await supabase.from("rollovers").select("id").eq("rollover_id", rolloverId).single();
  if (!rollover) { res.status(404).json({ success: false, message: "Rollover not found" }); return; }

  const updatedFields: Record<string, unknown> = {
    status: accepted ? "accepted" : "declined",
  };
  if (!accepted && reason) updatedFields.decline_reason = reason;

  const { data: updatedGuarantor, error } = await supabase
    .from("loan_guarantors")
    .update(updatedFields)
    .eq("id", guarantorId)
    .eq("loan_id", rollover.id)
    .select()
    .single();

  if (error || !updatedGuarantor) {
    res.status(404).json({ success: false, message: "Guarantor not found" });
    return;
  }

  const { data: guarantors } = await supabase.from("loan_guarantors").select("*").eq("loan_id", rollover.id);
  const acceptedCount = (guarantors ?? []).filter(g => g.status === "accepted").length;
  const declinedCount = (guarantors ?? []).filter(g => g.status === "declined").length;
  const allConsented = acceptedCount >= 3;

  if (allConsented) {
    await supabase.from("rollovers").update({ status: "awaiting_admin_approval" }).eq("id", rollover.id);
  }

  res.json({
    success: true,
    message: accepted ? "Consent accepted" : "Consent declined",
    guarantor: updatedGuarantor,
    accepted_count: acceptedCount,
    declined_count: declinedCount,
    all_consented: allConsented,
  });
});

router.post("/rollovers/:rolloverId/cancel", async (req, res): Promise<void> => {
  const rolloverId = req.params.rolloverId;
  const { reason } = req.body;

  const { data: rollover, error } = await supabase
    .from("rollovers")
    .update({ status: "cancelled", rejection_reason: reason || "Cancelled by member" })
    .eq("rollover_id", rolloverId)
    .select()
    .single();

  if (error || !rollover) { res.status(404).json({ success: false, message: "Rollover not found" }); return; }

  res.json({
    success: true,
    message: "Rollover cancelled",
    rollover: {
      ...rollover,
      outstandingBalance: Number(rollover.outstanding_balance),
      rolloverFee: Number(rollover.rollover_fee),
    },
  });
});

router.put("/rollovers/:rolloverId/guarantors/:guarantorId", async (req, res): Promise<void> => {
  const parsed = AddGuarantorBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, message: "Validation failed", details: parsed.error.flatten().fieldErrors });
    return;
  }

  const rolloverId = req.params.rolloverId;
  const oldGuarantorId = req.params.guarantorId;
  const { guarantor_id, guarantor_name, guarantor_phone } = parsed.data;

  const { data: rollover } = await supabase.from("rollovers").select("id").eq("rollover_id", rolloverId).single();
  if (!rollover) { res.status(404).json({ success: false, message: "Rollover not found" }); return; }

  await supabase.from("loan_guarantors").delete().eq("id", oldGuarantorId).eq("loan_id", rollover.id);

  const { data: newGuarantor } = await supabase.from("loan_guarantors").insert({
    loan_id: rollover.id,
    guarantor_id,
    name: guarantor_name,
    phone: guarantor_phone,
    status: "pending",
  }).select().single();

  const { data: guarantors } = await supabase.from("loan_guarantors").select("*").eq("loan_id", rollover.id);

  res.json({
    success: true,
    message: "Guarantor replaced successfully",
    new_guarantor: newGuarantor,
    guarantors: guarantors ?? [],
  });
});

router.post("/rollovers/:rolloverId/approve", async (req, res): Promise<void> => {
  const parsed = ApproveRolloverBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, message: "Validation failed", details: parsed.error.flatten().fieldErrors });
    return;
  }

  const rolloverId = req.params.rolloverId;
  const { admin_id, notes } = parsed.data;

  const { data: rollover, error } = await supabase
    .from("rollovers")
    .update({
      status: "approved",
      approved_at: new Date().toISOString(),
      approved_by: admin_id ?? null,
      admin_notes: notes ?? null,
    })
    .eq("rollover_id", rolloverId)
    .select()
    .single();

  if (error || !rollover) { res.status(404).json({ success: false, message: "Rollover not found" }); return; }

  const now = new Date();
  const dueDate = new Date(now);
  dueDate.setMonth(dueDate.getMonth() + rollover.new_tenure);

  await supabase.from("loans").update({
    tenure_months: rollover.new_tenure,
    monthly_repayment: rollover.new_monthly_payment,
    next_due_date: dueDate.toISOString().slice(0, 10),
  }).eq("id", rollover.loan_id);

  res.json({
    success: true,
    message: "Rollover approved successfully",
    rollover: {
      ...rollover,
      outstandingBalance: Number(rollover.outstanding_balance),
      rolloverFee: Number(rollover.rollover_fee),
      newMonthlyPayment: rollover.new_monthly_payment ? Number(rollover.new_monthly_payment) : undefined,
    },
  });
});

router.post("/rollovers/:rolloverId/reject", async (req, res): Promise<void> => {
  const parsed = RejectRolloverBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, message: "Validation failed", details: parsed.error.flatten().fieldErrors });
    return;
  }

  const rolloverId = req.params.rolloverId;
  const { reason, admin_id } = parsed.data;

  const { data: rollover, error } = await supabase
    .from("rollovers")
    .update({
      status: "rejected",
      rejection_reason: reason,
      approved_by: admin_id ?? null,
    })
    .eq("rollover_id", rolloverId)
    .select()
    .single();

  if (error || !rollover) { res.status(404).json({ success: false, message: "Rollover not found" }); return; }

  res.json({
    success: true,
    message: "Rollover rejected",
    rollover: {
      ...rollover,
      outstandingBalance: Number(rollover.outstanding_balance),
      rolloverFee: Number(rollover.rollover_fee),
    },
  });
});

router.get("/rollovers", async (req, res): Promise<void> => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Number(req.query.limit) || 20);
  const offset = (page - 1) * limit;
  const status = req.query.status as string | undefined;

  let query = supabase.from("rollovers").select("*, profiles!rollovers_profile_id_fkey(id, first_name, last_name, name, email)", { count: "exact" });
  if (status) query = query.eq("status", status);

  const { data: rollovers, count, error } = await query
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) { res.status(500).json({ error: error.message }); return; }

  res.json({
    data: (rollovers ?? []).map(r => {
      const profile = r.profiles as unknown as { name?: string; first_name?: string; last_name?: string; email?: string } | null;
      const memberName = [profile?.first_name, profile?.last_name].filter(Boolean).join(" ") || profile?.email || `Member ${r.profile_id?.slice(0, 8)}`;
      return {
        id: r.id,
        rolloverId: r.rollover_id,
        loanId: r.loan_id,
        memberId: r.profile_id,
        memberName,
        originalAmount: Number(r.original_amount),
        outstandingBalance: Number(r.outstanding_balance),
        rolloverFee: Number(r.rollover_fee),
        newTenure: r.new_tenure,
        newMonthlyPayment: r.new_monthly_payment ? Number(r.new_monthly_payment) : undefined,
        status: r.status,
        createdAt: r.created_at,
      };
    }),
    total: count ?? 0,
    page,
    limit,
  });
});

export default router;
