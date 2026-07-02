import { Router, type IRouter } from "express";
import { supabase, splitName } from "../lib/supabase";
// Fix #2: Import generated Zod schemas for input validation
import { CreateLoanBody } from "../lib/types";
import { requireAuth, requireRole } from "../middleware/auth";

const router: IRouter = Router();

// All loan routes require authentication
router.use(requireAuth);

router.get("/loans/portfolio-summary", async (req, res): Promise<void> => {
  const { data: loans } = await supabase.from("loans").select("amount, remaining_balance, status");
  const rows = loans ?? [];

  const activeOrCompleted = rows.filter(l => l.status === "active" || l.status === "completed");
  const totalDisbursed = activeOrCompleted.reduce((s, l) => s + Number(l.amount || 0), 0);
  const outstanding = rows.filter(l => l.status === "active").reduce((s, l) => s + Number(l.remaining_balance || 0), 0);
  const defaultedAmt = rows.filter(l => l.status === "defaulted").reduce((s, l) => s + Number(l.amount || 0), 0);
  const collected = totalDisbursed - outstanding;

  const activeCount = rows.filter(l => l.status === "active").length;
  const completedCount = rows.filter(l => l.status === "completed").length;
  const defaultedCount = rows.filter(l => l.status === "defaulted").length;
  const pendingCount = rows.filter(l => l.status === "pending").length;

  const totalLoans = activeCount + completedCount;
  const repaymentRate = totalLoans > 0 ? (completedCount / totalLoans) * 100 : 0;

  res.json({
    totalDisbursed, outstanding, collected, defaulted: defaultedAmt,
    repaymentRate: Math.round(repaymentRate * 10) / 10,
    activeCount, defaultedCount, pendingCount,
  });
});

router.get("/loans", async (req, res): Promise<void> => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Number(req.query.limit) || 20);
  const offset = (page - 1) * limit;
  const status = req.query.status as string | undefined;
  const memberId = req.query.memberId as string | undefined;

  let query = supabase.from("loans").select("*, profiles!loans_profile_id_fkey(id, first_name, last_name, name, email, phone)", { count: "exact" });
  if (status) query = query.eq("status", status === "repaid" ? "completed" : status);
  if (memberId) query = query.eq("profile_id", memberId);

  const { data: loans, count, error } = await query
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) { res.status(500).json({ error: error.message }); return; }

  // Fetch guarantors for all loans
  const loanIds = (loans ?? []).map((l: any) => l.id);
  let guarantorsMap: Record<string, any[]> = {};
  
  if (loanIds.length > 0) {
    const { data: guarantors } = await supabase
      .from("loan_guarantors")
      .select("*, guarantor_profile:profiles!loan_guarantors_guarantor_id_fkey(id, name, first_name, last_name, email, phone)")
      .in("loan_id", loanIds);
    
    if (guarantors) {
      for (const g of guarantors) {
        if (!guarantorsMap[g.loan_id]) guarantorsMap[g.loan_id] = [];
        const guarantorProfile = g.guarantor_profile as unknown as { name?: string; first_name?: string; last_name?: string; email?: string; phone?: string } | null;
        let guarantorName = guarantorProfile?.name ?? "";
        if (!guarantorName && guarantorProfile) {
          guarantorName = [guarantorProfile.first_name, guarantorProfile.last_name].filter(Boolean).join(" ") || guarantorProfile.email || "Unknown";
        }
        guarantorsMap[g.loan_id].push({
          id: g.id,
          name: guarantorName,
          email: guarantorProfile?.email ?? null,
          phone: guarantorProfile?.phone ?? null,
          status: g.status,
          consentedAt: g.consented_at ?? null,
          createdAt: g.created_at,
        });
      }
    }
  }

  res.json({
    data: (loans ?? []).map(l => {
      const profile = l.profiles as unknown as { name?: string; first_name?: string; last_name?: string; email?: string; phone?: string } | null;
      // Try different name fields in order of preference
      let memberName = profile?.name ?? "";
      if (!memberName && profile) {
        memberName = [profile.first_name, profile.last_name].filter(Boolean).join(" ") || profile?.email || `Member ${l.profile_id?.slice(0, 8)}`;
      }
      return {
        id: l.id, loanId: l.loan_id, memberId: l.profile_id,
        memberName,
        memberPhone: profile?.phone ?? null,
        memberEmail: profile?.email ?? null,
        amount: Number(l.amount), balance: Number(l.remaining_balance ?? l.amount),
        interestRate: Number(l.effective_interest_rate), tenure: l.tenure_months,
        status: l.status === "completed" ? "repaid" : l.status,
        purpose: l.purpose, disbursedDate: l.approved_at?.slice(0, 10) ?? null,
        dueDate: l.next_due_date ?? null,
        monthlyPayment: l.monthly_repayment ? Number(l.monthly_repayment) : undefined,
        nextPaymentDate: l.next_due_date ?? null,
        rejectionReason: l.rejected_reason ?? null, createdAt: l.created_at,
        guarantors: guarantorsMap[l.id] ?? [],
      };
    }),
    total: count ?? 0, page, limit,
  });
});

// Fix #2: Validate POST body with Zod before inserting
// POST /loans/apply - Mobile app endpoint for applying loans
router.post("/loans/apply", async (req, res): Promise<void> => {
  try {
    // Mobile app sends: { memberId, amount, tenure, purpose, guarantorIds? }
    const { memberId, amount, tenure, purpose, guarantorIds } = req.body;
    
    if (!memberId || !amount || !tenure) {
      res.status(400).json({ error: "Missing required fields: memberId, amount, tenure" });
      return;
    }

    const loanId = "LN-" + crypto.randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase();
    const interestRate = 10; // 10% base rate
    const monthlyPayment = (amount * (interestRate / 100 / 12)) / (1 - Math.pow(1 + interestRate / 100 / 12, -tenure));

    const { data: loan, error } = await supabase.from("loans").insert({
      loan_id: loanId, profile_id: memberId, loan_type: "Quick Loan",
      amount, tenure_months: tenure, purpose: purpose || "Personal",
      base_interest_rate: interestRate, referral_bonus_percent: 0,
      effective_interest_rate: interestRate,
      monthly_repayment: Number(monthlyPayment.toFixed(2)),
      total_repayment: Number((monthlyPayment * tenure).toFixed(2)),
      remaining_balance: amount, remaining_months: tenure, status: "pending",
    }).select().single();

    if (error) { res.status(500).json({ error: error.message }); return; }

    // Add guarantors if provided
    if (guarantorIds && Array.isArray(guarantorIds)) {
      const guarantorRecords = guarantorIds.map((gid: string) => ({
        loan_id: loan.id, guarantor_id: gid, status: "pending", consented_at: null,
      }));
      await supabase.from("loan_guarantors").insert(guarantorRecords);
    }

    const { data: profile } = await supabase.from("profiles").select("name, first_name, last_name, email").eq("id", memberId).single();
    let memberName = profile?.name ?? "";
    if (!memberName && profile) {
      memberName = [profile.first_name, profile.last_name].filter(Boolean).join(" ") || profile.email || `Member ${memberId?.slice(0, 8)}`;
    }

    res.status(201).json({
      success: true, loanId: loan.loan_id,
      message: "Loan application submitted successfully",
      loan: {
        id: loan.id, loanId: loan.loan_id, memberId: loan.profile_id,
        memberName, amount: Number(loan.amount),
        balance: Number(loan.remaining_balance), interestRate: Number(loan.effective_interest_rate),
        tenure: loan.tenure_months, status: loan.status, purpose: loan.purpose,
        monthlyPayment: Number(loan.monthly_repayment), createdAt: loan.created_at,
      },
    });
  } catch (err) {
    console.error("Loan apply error:", err);
    res.status(500).json({ error: "Failed to process loan application" });
  }
});

router.post("/loans", async (req, res): Promise<void> => {
  const parsed = CreateLoanBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation failed", details: parsed.error.flatten().fieldErrors });
    return;
  }

  const { memberId, amount, tenure, purpose, interestRate = 5 } = parsed.data;
  const loanId = "LN-" + crypto.randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase();
  const monthlyPayment = (amount * (interestRate / 100 / 12)) / (1 - Math.pow(1 + interestRate / 100 / 12, -tenure));

  const { data: loan, error } = await supabase.from("loans").insert({
    loan_id: loanId, profile_id: memberId, loan_type: "Quick Loan",
    amount, tenure_months: tenure, purpose,
    base_interest_rate: interestRate, referral_bonus_percent: 0,
    effective_interest_rate: interestRate,
    monthly_repayment: Number(monthlyPayment.toFixed(2)),
    total_repayment: Number((monthlyPayment * tenure).toFixed(2)),
    remaining_balance: amount, remaining_months: tenure, status: "pending",
  }).select().single();

  if (error) { res.status(500).json({ error: error.message }); return; }

  const { data: profile } = await supabase.from("profiles").select("name, first_name, last_name, email").eq("id", memberId).single();
  let memberName = profile?.name ?? "";
  if (!memberName && profile) {
    memberName = [profile.first_name, profile.last_name].filter(Boolean).join(" ") || profile.email || `Member ${memberId?.slice(0, 8)}`;
  }

  res.status(201).json({
    id: loan.id, loanId: loan.loan_id, memberId: loan.profile_id,
    memberName, amount: Number(loan.amount),
    balance: Number(loan.remaining_balance), interestRate: Number(loan.effective_interest_rate),
    tenure: loan.tenure_months, status: loan.status, purpose: loan.purpose,
    monthlyPayment: Number(loan.monthly_repayment), createdAt: loan.created_at,
  });
});

router.get("/loans/:id", async (req, res): Promise<void> => {
  const id = req.params.id;
  const { data: loan, error } = await supabase.from("loans")
    .select("*, profiles!loans_profile_id_fkey(id, first_name, last_name, name, email, phone)").eq("id", id).single();
  if (error || !loan) { res.status(404).json({ error: "Loan not found" }); return; }

  // Fetch guarantors for this loan
  const { data: guarantors } = await supabase
    .from("loan_guarantors")
    .select("*, guarantor_profile:profiles!loan_guarantors_guarantor_id_fkey(id, name, first_name, last_name, email, phone)")
    .eq("loan_id", id);
  
  const guarantorsList = (guarantors ?? []).map((g: any) => {
    const guarantorProfile = g.guarantor_profile as unknown as { name?: string; first_name?: string; last_name?: string; email?: string; phone?: string } | null;
    let guarantorName = guarantorProfile?.name ?? "";
    if (!guarantorName && guarantorProfile) {
      guarantorName = [guarantorProfile.first_name, guarantorProfile.last_name].filter(Boolean).join(" ") || guarantorProfile.email || "Unknown";
    }
    return {
      id: g.id,
      name: guarantorName,
      email: guarantorProfile?.email ?? null,
      phone: guarantorProfile?.phone ?? null,
      status: g.status,
      consentedAt: g.consented_at ?? null,
      createdAt: g.created_at,
    };
  });

  const profile = loan.profiles as unknown as { name?: string; first_name?: string; last_name?: string; email?: string; phone?: string } | null;
  let memberName = profile?.name ?? "";
  if (!memberName && profile) {
    memberName = [profile.first_name, profile.last_name].filter(Boolean).join(" ") || profile.email || `Member ${loan.profile_id?.slice(0, 8)}`;
  }
  res.json({
    id: loan.id, loanId: loan.loan_id, memberId: loan.profile_id,
    memberName,
    memberPhone: profile?.phone ?? null,
    memberEmail: profile?.email ?? null,
    amount: Number(loan.amount),
    balance: Number(loan.remaining_balance ?? loan.amount),
    interestRate: Number(loan.effective_interest_rate), tenure: loan.tenure_months,
    status: loan.status === "completed" ? "repaid" : loan.status,
    purpose: loan.purpose, disbursedDate: loan.approved_at?.slice(0, 10) ?? null,
    dueDate: loan.next_due_date ?? null,
    monthlyPayment: loan.monthly_repayment ? Number(loan.monthly_repayment) : undefined,
    nextPaymentDate: loan.next_due_date ?? null,
    rejectionReason: loan.rejected_reason ?? null, createdAt: loan.created_at,
    guarantors: guarantorsList,
  });
});

// Fix #4: Approve/reject require at minimum "operator" role
router.post("/loans/:id/approve", requireRole("operator"), async (req, res): Promise<void> => {
  const id = req.params.id;
  const now = new Date();
  const dueDate = new Date(now);
  dueDate.setMonth(dueDate.getMonth() + 12);
  
  // Get admin info from session
  const adminId = (req as any).session?.profileId || req.headers["x-admin-id"] as string || "";
  const adminName = (req as any).session?.profileName || req.headers["x-admin-name"] as string || "Admin";

  const { data: loan, error } = await supabase.from("loans").update({
    status: "active", approved_at: now.toISOString(),
    next_due_date: dueDate.toISOString().slice(0, 10),
    approved_by: adminId || null,
  }).eq("id", id).select().single();

  if (error || !loan) { res.status(404).json({ error: "Loan not found" }); return; }

  // Create audit log entry
  await supabase.from("loan_audit_log").insert({
    loan_id: loan.loan_id,
    action: "APPROVED",
    old_status: "pending",
    new_status: "active",
    admin_id: adminId || null,
    admin_name: adminName,
    notes: `Loan approved by ${adminName}`,
  });

  const { data: profile } = await supabase.from("profiles").select("name, first_name, last_name, email").eq("id", loan.profile_id).single();
  let memberName = profile?.name ?? "";
  if (!memberName && profile) {
    memberName = [profile.first_name, profile.last_name].filter(Boolean).join(" ") || profile.email || `Member ${loan.profile_id?.slice(0, 8)}`;
  }
  res.json({
    id: loan.id, loanId: loan.loan_id, memberId: loan.profile_id,
    memberName, amount: Number(loan.amount),
    balance: Number(loan.remaining_balance ?? loan.amount),
    interestRate: Number(loan.effective_interest_rate),
    status: loan.status, approvedBy: adminName, approvedAt: now.toISOString(),
    createdAt: loan.created_at,
  });
});

// Fix #4: Reject requires at minimum "operator" role
router.post("/loans/:id/reject", requireRole("operator"), async (req, res): Promise<void> => {
  const id = req.params.id;
  const { reason } = req.body;
  if (!reason || typeof reason !== "string" || reason.trim().length === 0) {
    res.status(400).json({ error: "reason is required" });
    return;
  }
  
  // Get admin info from session
  const adminId = (req as any).session?.profileId || req.headers["x-admin-id"] as string || "";
  const adminName = (req as any).session?.profileName || req.headers["x-admin-name"] as string || "Admin";

  const { data: loan, error } = await supabase.from("loans").update({
    status: "rejected", rejected_reason: reason.trim(),
    rejected_by: adminId || null,
  }).eq("id", id).select().single();

  if (error || !loan) { res.status(404).json({ error: "Loan not found" }); return; }

  // Create audit log entry
  await supabase.from("loan_audit_log").insert({
    loan_id: loan.loan_id,
    action: "REJECTED",
    old_status: "pending",
    new_status: "rejected",
    admin_id: adminId || null,
    admin_name: adminName,
    notes: reason.trim(),
  });

  const { data: profile } = await supabase.from("profiles").select("name, first_name, last_name, email").eq("id", loan.profile_id).single();
  let memberName = profile?.name ?? "";
  if (!memberName && profile) {
    memberName = [profile.first_name, profile.last_name].filter(Boolean).join(" ") || profile.email || `Member ${loan.profile_id?.slice(0, 8)}`;
  }
  res.json({
    id: loan.id, loanId: loan.loan_id, memberId: loan.profile_id,
    memberName, amount: Number(loan.amount),
    balance: Number(loan.remaining_balance ?? loan.amount),
    interestRate: Number(loan.effective_interest_rate),
    status: loan.status, rejectionReason: loan.rejected_reason,
    rejectedBy: adminName, createdAt: loan.created_at,
  });
});

// Get loan audit log
router.get("/loans/:id/audit", async (req, res): Promise<void> => {
  const id = req.params.id;
  const { data: loan } = await supabase.from("loans").select("loan_id").eq("id", id).single();
  if (!loan) { res.status(404).json({ error: "Loan not found" }); return; }

  const { data: logs, error } = await supabase
    .from("loan_audit_log")
    .select("*")
    .eq("loan_id", loan.loan_id)
    .order("created_at", { ascending: true });

  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json({ logs: logs ?? [] });
});

// Get guarantors for a loan
router.get("/loans/:id/guarantors", async (req, res): Promise<void> => {
  const loanId = req.params.id;
  
  // Get the loan to verify it exists
  const { data: loan, error: loanError } = await supabase
    .from("loans")
    .select("id, loan_id, profile_id")
    .eq("id", loanId)
    .single();
  
  if (loanError || !loan) {
    res.status(404).json({ error: "Loan not found" });
    return;
  }

  // Get guarantors for this loan
  const { data: guarantors, error } = await supabase
    .from("loan_guarantors")
    .select("*, profiles!loan_guarantors_guarantor_id_fkey(id, name, email, phone)")
    .eq("loan_id", loan.id);

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  // Get borrower profile
  const { data: borrower } = await supabase
    .from("profiles")
    .select("id, name, email")
    .eq("id", loan.profile_id)
    .single();

  res.json({
    loanId: loan.id,
    loanNumber: loan.loan_id,
    borrowerName: borrower?.name || borrower?.email || "Unknown",
    guarantors: (guarantors ?? []).map(g => ({
      id: g.id,
      guarantorId: g.guarantor_id,
      guarantorName: g.profiles?.name || g.profiles?.email || "Unknown",
      guarantorEmail: g.profiles?.email,
      guarantorPhone: g.profiles?.phone,
      status: g.status,
      consentedAt: g.consented_at,
      createdAt: g.created_at,
    })),
  });
});

// Confirm guarantee (guarantor accepts the request)
router.post("/loans/:id/guarantors/confirm", async (req, res): Promise<void> => {
  const loanIdParam = req.params.id;
  const { guarantorId, guarantor_id, consentToken } = req.body;
  // Support both camelCase and snake_case
  const guarantorIdToUse = guarantorId || guarantor_id;

  if (!guarantorIdToUse) {
    res.status(400).json({ error: "guarantorId is required" });
    return;
  }

  try {
    // First, try to find the loan by loan_id (e.g., "LN-XXXX") or by UUID
    // The mobile app sends loan_id like "LN-XXXX" in the URL
    let loan;
    
    // Check if it looks like a UUID (contains hyphens and is longer)
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(loanIdParam);
    
    if (isUuid) {
      // It's a UUID, query by id
      const { data, error } = await supabase
        .from("loans")
        .select("id, loan_id, amount, profile_id")
        .eq("id", loanIdParam)
        .single();
      loan = data;
      if (error) {
        console.error("Error finding loan by UUID:", error);
      }
    }
    
    // If not found by UUID, try by loan_id
    if (!loan) {
      const { data, error } = await supabase
        .from("loans")
        .select("id, loan_id, amount, profile_id")
        .eq("loan_id", loanIdParam)
        .single();
      loan = data;
      if (error) {
        console.error("Error finding loan by loan_id:", error);
      }
    }

    if (!loan) {
      res.status(404).json({ error: "Loan not found" });
      return;
    }

    // Get the guarantor profile
    const { data: guarantorProfile, error: profileError } = await supabase
      .from("profiles")
      .select("id, name, email, phone")
      .eq("id", guarantorIdToUse)
      .single();

    if (profileError || !guarantorProfile) {
      res.status(404).json({ error: "Guarantor not found" });
      return;
    }

    // Find or create the guarantor record
    const { data: existingGuarantor, error: findError } = await supabase
      .from("loan_guarantors")
      .select("*")
      .eq("loan_id", loan.id)
      .eq("guarantor_id", guarantorIdToUse)
      .maybeSingle();

    let guarantorRecord;
    if (existingGuarantor) {
      // Update existing record
      const { data, error } = await supabase
        .from("loan_guarantors")
        .update({
          status: "confirmed",
          consented_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", existingGuarantor.id)
        .select()
        .single();

      if (error) {
        console.error("Error updating guarantor:", error);
        res.status(500).json({ error: "Failed to confirm guarantee: " + error.message });
        return;
      }
      guarantorRecord = data;
    } else {
      // Create new guarantor record
      const { data, error } = await supabase
        .from("loan_guarantors")
        .insert({
          loan_id: loan.id,
          guarantor_id: guarantorIdToUse,
          status: "confirmed",
          consented_at: new Date().toISOString(),
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .select()
        .single();

      if (error) {
        console.error("Error creating guarantor:", error);
        res.status(500).json({ error: "Failed to create guarantee record: " + error.message });
        return;
      }
      guarantorRecord = data;
    }

    // Count how many guarantors are now confirmed for this loan
    const { count: guarantorsNowConfirmed } = await supabase
      .from("loan_guarantors")
      .select("*", { count: "exact", head: true })
      .eq("loan_id", loan.id)
      .eq("status", "confirmed");

    res.json({
      success: true,
      message: "Guarantee confirmed successfully",
      guarantor_status: "confirmed",
      guarantors_now_confirmed: guarantorsNowConfirmed ?? 0,
      guarantee: {
        id: guarantorRecord.id,
        loanId: loan.id,
        loanNumber: loan.loan_id,
        guarantorId: guarantorIdToUse,
        guarantorName: guarantorProfile.name || guarantorProfile.email,
        status: "confirmed",
        confirmedAt: guarantorRecord.consented_at,
      },
    });
  } catch (err) {
    console.error("Error confirming guarantee:", err);
    res.status(500).json({ error: "Failed to confirm guarantee" });
  }
});

// Decline guarantee (guarantor rejects the request)
router.post("/loans/:id/guarantors/decline", async (req, res): Promise<void> => {
  const loanIdParam = req.params.id;
  const { guarantorId, guarantor_id, reason } = req.body;
  const guarantorIdToUse = guarantorId || guarantor_id;

  if (!guarantorIdToUse) {
    res.status(400).json({ error: "guarantorId is required" });
    return;
  }

  try {
    // First, try to find the loan by loan_id or by UUID
    let loan;
    
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(loanIdParam);
    
    if (isUuid) {
      const { data, error } = await supabase
        .from("loans")
        .select("id, loan_id")
        .eq("id", loanIdParam)
        .single();
      loan = data;
    }
    
    if (!loan) {
      const { data, error } = await supabase
        .from("loans")
        .select("id, loan_id")
        .eq("loan_id", loanIdParam)
        .single();
      loan = data;
    }

    if (!loan) {
      res.status(404).json({ error: "Loan not found" });
      return;
    }

    // Update the guarantor record
    const { data, error } = await supabase
      .from("loan_guarantors")
      .update({
        status: "rejected",
        updated_at: new Date().toISOString(),
        consent_reason: reason || null,
      })
      .eq("loan_id", loan.id)
      .eq("guarantor_id", guarantorIdToUse)
      .select()
      .single();

    if (error) {
      console.error("Error declining guarantee:", error);
      res.status(500).json({ error: "Failed to decline guarantee: " + error.message });
      return;
    }

    res.json({
      success: true,
      message: "Guarantee declined",
      guarantee: {
        id: data.id,
        status: "rejected",
      },
    });
  } catch (err) {
    console.error("Error declining guarantee:", err);
    res.status(500).json({ error: "Failed to decline guarantee" });
  }
});

// Get current user's guarantor requests (for guarantors viewing incoming requests)
router.get("/guarantor/pending-requests", async (req, res): Promise<void> => {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    res.status(401).json({ error: "Authorization required" });
    return;
  }

  try {
    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);

    if (authError || !user) {
      res.status(401).json({ error: "Invalid token" });
      return;
    }

    // Get user profile
    const { data: profile } = await supabase
      .from("profiles")
      .select("id")
      .eq("user_id", user.id)
      .single();

    if (!profile) {
      res.status(404).json({ error: "Profile not found" });
      return;
    }

    // Get pending guarantor requests where this user is the guarantor
    const { data: requests, error } = await supabase
      .from("loan_guarantors")
      .select(`
        *,
        loans:loan_id(id, loan_id, amount, tenure_months, status, created_at),
        borrower:loans!loan_id(profiles!loans_profile_id_fkey(name, email, phone))
      `)
      .eq("guarantor_id", profile.id)
      .in("status", ["pending", "requested", "scanned"]);

    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }

    res.json({
      success: true,
      requests: (requests ?? []).map(r => ({
        id: r.id,
        loanId: r.loans?.id,
        loanNumber: r.loans?.loan_id,
        amount: r.loans?.amount,
        tenure: r.loans?.tenure_months,
        borrowerName: r.borrower?.profiles?.name || r.borrower?.profiles?.email || "Unknown",
        status: r.status,
        requestedAt: r.created_at,
      })),
    });
  } catch (err) {
    console.error("Error fetching pending requests:", err);
    res.status(500).json({ error: "Failed to fetch requests" });
  }
});

// Get all guarantor requests for current user
router.get("/guarantor/requests", async (req, res): Promise<void> => {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    res.status(401).json({ error: "Authorization required" });
    return;
  }

  try {
    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);

    if (authError || !user) {
      res.status(401).json({ error: "Invalid token" });
      return;
    }

    const { data: profile } = await supabase
      .from("profiles")
      .select("id")
      .eq("user_id", user.id)
      .single();

    if (!profile) {
      res.status(404).json({ error: "Profile not found" });
      return;
    }

    const { data: requests, error } = await supabase
      .from("loan_guarantors")
      .select(`
        *,
        loans:loan_id(id, loan_id, amount, tenure_months, status, created_at)
      `)
      .eq("guarantor_id", profile.id)
      .order("created_at", { ascending: false });

    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }

    res.json({
      success: true,
      requests: (requests ?? []).map(r => ({
        id: r.id,
        loanId: r.loans?.id,
        loanNumber: r.loans?.loan_id,
        amount: r.loans?.amount,
        status: r.status,
        consentedAt: r.consented_at,
        createdAt: r.created_at,
      })),
    });
  } catch (err) {
    console.error("Error fetching requests:", err);
    res.status(500).json({ error: "Failed to fetch requests" });
  }
});

// Accept guarantor request
router.post("/guarantor/requests/:id/accept", async (req, res): Promise<void> => {
  const requestId = req.params.id;
  const authHeader = req.headers.authorization;
  
  if (!authHeader) {
    res.status(401).json({ error: "Authorization required" });
    return;
  }

  try {
    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);

    if (authError || !user) {
      res.status(401).json({ error: "Invalid token" });
      return;
    }

    const { data: profile } = await supabase
      .from("profiles")
      .select("id, name, email")
      .eq("user_id", user.id)
      .single();

    if (!profile) {
      res.status(404).json({ error: "Profile not found" });
      return;
    }

    const { data: guarantorRequest, error: findError } = await supabase
      .from("loan_guarantors")
      .select("*")
      .eq("id", requestId)
      .eq("guarantor_id", profile.id)
      .single();

    if (findError || !guarantorRequest) {
      res.status(404).json({ error: "Request not found" });
      return;
    }

    const { data, error } = await supabase
      .from("loan_guarantors")
      .update({
        status: "confirmed",
        consented_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", requestId)
      .select()
      .single();

    if (error) {
      res.status(500).json({ error: "Failed to accept request: " + error.message });
      return;
    }

    res.json({
      success: true,
      message: "Guarantor request accepted",
      request: {
        id: data.id,
        status: data.status,
        confirmedAt: data.consented_at,
      },
    });
  } catch (err) {
    console.error("Error accepting request:", err);
    res.status(500).json({ error: "Failed to accept request" });
  }
});

// Decline guarantor request
router.post("/guarantor/requests/:id/decline", async (req, res): Promise<void> => {
  const requestId = req.params.id;
  const { reason } = req.body;
  const authHeader = req.headers.authorization;
  
  if (!authHeader) {
    res.status(401).json({ error: "Authorization required" });
    return;
  }

  try {
    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);

    if (authError || !user) {
      res.status(401).json({ error: "Invalid token" });
      return;
    }

    const { data: profile } = await supabase
      .from("profiles")
      .select("id")
      .eq("user_id", user.id)
      .single();

    if (!profile) {
      res.status(404).json({ error: "Profile not found" });
      return;
    }

    const { data, error } = await supabase
      .from("loan_guarantors")
      .update({
        status: "rejected",
        updated_at: new Date().toISOString(),
        consent_reason: reason || null,
      })
      .eq("id", requestId)
      .eq("guarantor_id", profile.id)
      .select()
      .single();

    if (error) {
      res.status(500).json({ error: "Failed to decline request: " + error.message });
      return;
    }

    res.json({
      success: true,
      message: "Guarantor request declined",
      request: {
        id: data.id,
        status: data.status,
      },
    });
  } catch (err) {
    console.error("Error declining request:", err);
    res.status(500).json({ error: "Failed to decline request" });
  }
});

export default router;
