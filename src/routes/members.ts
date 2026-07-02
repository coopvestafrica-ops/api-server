import { Router, type IRouter } from "express";
import { supabase, splitName, deriveStatus } from "../lib/supabase";
import { CreateMemberBody } from "../lib/types";
import { requireAuth, requireRole } from "../middleware/auth";

const router: IRouter = Router();
router.use(requireAuth);

// Auto-sync Supabase Auth users → profiles so mobile registrations appear in admin
async function syncAuthUsersToProfiles(): Promise<void> {
  try {
    const { data, error } = await (supabase.auth.admin as any).listUsers({ perPage: 1000 });
    if (error || !data?.users?.length) return;

    const { data: existing } = await supabase.from("profiles").select("email");
    const knownEmails = new Set(
      (existing ?? []).map((p: any) => ((p.email as string) ?? "").toLowerCase())
    );

    const toInsert = (data.users as any[])
      .filter(u => u.email && !knownEmails.has(u.email.toLowerCase()))
      .map(u => ({
        id: crypto.randomUUID(),
        user_id: "CVA-" + u.id.replace(/-/g, "").slice(0, 8).toUpperCase(),
        name:
          u.user_metadata?.full_name ??
          u.user_metadata?.name ??
          u.email.split("@")[0],
        email: u.email,
        phone: (u.phone ?? u.user_metadata?.phone) || null,
        role: "member",
        is_active: true,
        kyc_verified: false,
        created_at: u.created_at ?? new Date().toISOString(),
      }));

    if (toInsert.length > 0) {
      await supabase.from("profiles").insert(toInsert);
    }
  } catch {
    // best-effort — never crash the route
  }
}

router.get("/members/stats", async (req, res): Promise<void> => {
  await syncAuthUsersToProfiles();
  const { count: total }     = await supabase.from("profiles").select("*", { count: "exact", head: true });
  const { count: active }    = await supabase.from("profiles").select("*", { count: "exact", head: true }).eq("is_active", true).eq("kyc_verified", true).eq("is_flagged", false);
  const { count: inactive }  = await supabase.from("profiles").select("*", { count: "exact", head: true }).eq("is_active", false);
  const { count: suspended } = await supabase.from("profiles").select("*", { count: "exact", head: true }).eq("is_flagged", true);
  const { count: pending }   = await supabase.from("profiles").select("*", { count: "exact", head: true }).eq("is_active", true).eq("kyc_verified", false).eq("is_flagged", false);
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const { count: newThisMonth } = await supabase.from("profiles").select("*", { count: "exact", head: true }).gte("created_at", monthStart);
  
  // Count loan defaulters (loans with overdue payments)
  const { count: loanDefaulters } = await supabase.from("loans").select("*", { count: "exact", head: true })
    .eq("status", "active")
    .lt("remaining_balance", 0);
  
  // Count high-risk accounts (profiles with risk_score > 70 or flagged)
  const { count: highRisk } = await supabase.from("profiles").select("*", { count: "exact", head: true })
    .eq("is_flagged", true);
  
  res.json({ 
    total: total ?? 0, 
    active: active ?? 0, 
    inactive: inactive ?? 0, 
    suspended: suspended ?? 0, 
    pending: pending ?? 0, 
    newThisMonth: newThisMonth ?? 0,
    loanDefaulters: loanDefaulters ?? 0,
    highRisk: highRisk ?? 0,
  });
});

router.get("/members", async (req, res): Promise<void> => {
  await syncAuthUsersToProfiles();

  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Number(req.query.limit) || 20);
  const offset = (page - 1) * limit;
  const status = req.query.status as string | undefined;
  const search = req.query.search as string | undefined;

  let query = supabase.from("profiles").select("*", { count: "exact" });
  if (status === "active")         query = query.eq("is_active", true).eq("kyc_verified", true).eq("is_flagged", false);
  else if (status === "inactive")  query = query.eq("is_active", false);
  else if (status === "suspended") query = query.eq("is_flagged", true);
  else if (status === "pending")   query = query.eq("is_active", true).eq("kyc_verified", false).eq("is_flagged", false);
  if (search) query = query.or(`name.ilike.%${search}%,email.ilike.%${search}%,user_id.ilike.%${search}%`);

  const { data: profiles, count, error } = await query.order("created_at", { ascending: false }).range(offset, offset + limit - 1);
  if (error) { res.status(500).json({ error: error.message }); return; }

  const profileIds = (profiles ?? []).map(p => p.id);
  const { data: savingsData } = profileIds.length > 0 ? await supabase.from("savings").select("profile_id, total_saved").in("profile_id", profileIds) : { data: [] };
  const { data: loanData }    = profileIds.length > 0 ? await supabase.from("loans").select("profile_id, remaining_balance").in("profile_id", profileIds).eq("status", "active") : { data: [] };
  const savingsMap = new Map((savingsData ?? []).map(s => [s.profile_id, Number(s.total_saved || 0)]));
  const loanMap = new Map<string, number>();
  for (const l of loanData ?? []) loanMap.set(l.profile_id, (loanMap.get(l.profile_id) ?? 0) + Number(l.remaining_balance || 0));

  res.json({
    data: (profiles ?? []).map(p => {
      const { firstName, lastName } = splitName(p.name);
      return { 
        id: p.id, 
        memberId: p.user_id, 
        firstName, 
        lastName, 
        email: p.email, 
        phone: p.phone ?? "", 
        status: deriveStatus(p), 
        role: p.role || "member",
        kycVerified: p.kyc_verified || false,
        profilePicture: p.avatar_url || null,
        occupation: p.occupation || null,
        organization: p.organization || null,
        employer: p.employer || null,
        address: p.address || null,
        joinDate: p.created_at ? p.created_at.slice(0, 10) : null, 
        createdAt: p.created_at, 
        totalContributions: savingsMap.get(p.id) ?? 0, 
        activeLoan: loanMap.get(p.id) ?? 0, 
        riskScore: 0, 
        avatarInitials: ((firstName[0] ?? "") + (lastName[0] ?? "")).toUpperCase() || "??" 
      };
    }),
    total: count ?? 0, page, limit,
  });
});

router.post("/members", async (req, res): Promise<void> => {
  const parsed = CreateMemberBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation failed", details: parsed.error.flatten().fieldErrors });
    return;
  }
  const { firstName, lastName, email, phone, address, occupation } = parsed.data;
  const name = `${firstName} ${lastName}`;
  const userId = "CVA-" + String(Date.now()).slice(-6);
  const { data: profile, error } = await supabase.from("profiles").insert({ id: crypto.randomUUID(), user_id: userId, name, email, phone, role: "member", is_active: true, kyc_verified: false }).select().single();
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.status(201).json({ id: profile.id, memberId: profile.user_id, firstName, lastName, email: profile.email, phone: profile.phone, status: "pending", joinDate: profile.created_at?.slice(0, 10) ?? null, address: address ?? null, occupation: occupation ?? null, createdAt: profile.created_at, totalContributions: 0, activeLoan: 0, riskScore: 0, avatarInitials: ((firstName[0] ?? "") + (lastName[0] ?? "")).toUpperCase() });
});

// Pull a string field from a registration data blob, trying several key spellings.
function pick(data: Record<string, any> | null | undefined, ...keys: string[]): string | null {
  if (!data) return null;
  for (const k of keys) {
    const v = data[k];
    if (v !== undefined && v !== null && String(v).trim() !== "") return String(v);
  }
  return null;
}

// Build the full member detail payload, gathering every piece of data the member
// supplied at registration plus their KYC, documents, savings, wallet and loans.
async function buildMemberDetail(profile: any) {
  const id = profile.id;
  const [
    { data: savings },
    { data: wallet },
    { data: activeLoans },
    { data: kyc },
    { data: documents },
    { data: bankAccounts },
    { data: userRow },
  ] = await Promise.all([
    supabase.from("savings").select("*").eq("profile_id", id).maybeSingle(),
    supabase.from("wallets").select("*").eq("profile_id", id).maybeSingle(),
    supabase.from("loans").select("remaining_balance").eq("profile_id", id).eq("status", "active"),
    supabase.from("kyc").select("*").eq("profile_id", id).maybeSingle(),
    supabase.from("kyc_documents").select("*").eq("profile_id", id),
    supabase.from("bank_accounts").select("*").eq("profile_id", id),
    supabase.from("users").select("*").eq("email", profile.email).maybeSingle(),
  ]);

  // The full registration form lives in kyc_submissions.data (JSONB), keyed by the
  // signup email. Fall back to the most recent submission for this email.
  let registration: Record<string, any> | null = null;
  let submittedAt: string | null = null;
  if (profile.email) {
    const { data: subs } = await supabase
      .from("kyc_submissions")
      .select("data, submitted_at")
      .eq("data->>email", profile.email)
      .order("submitted_at", { ascending: false })
      .limit(1);
    if (subs && subs.length > 0) {
      registration = (subs[0].data as Record<string, any>) ?? null;
      submittedAt = subs[0].submitted_at ?? null;
    }
  }

  const totalContributions = Number(savings?.total_saved ?? 0);
  const activeLoan = (activeLoans ?? []).reduce((sum: number, l: any) => sum + Number(l.remaining_balance || 0), 0);
  const { firstName, lastName } = splitName(profile.name);

  // Profile picture: prefer KYC selfie, then any photo field in the registration
  // form, then a document front image.
  const profilePicture =
    (kyc as any)?.selfie ||
    pick(registration, "selfie", "photo", "picture", "avatar", "passport", "passport_photo", "profile_picture", "image") ||
    (documents && documents.length > 0 ? (documents[0] as any).front_image_url : null) ||
    profile.avatar_url ||
    null;

  return {
    id: profile.id,
    memberId: profile.user_id,
    firstName,
    lastName,
    fullName: profile.name ?? `${firstName} ${lastName}`.trim(),
    email: profile.email,
    phone: profile.phone ?? pick(registration, "phone") ?? "",
    status: deriveStatus(profile),
    role: profile.role || "member",
    kycVerified: profile.kyc_verified || false,
    kycStatus: (kyc as any)?.status || userRow?.kyc_status || (profile.kyc_verified ? "verified" : "pending"),
    isActive: profile.is_active ?? null,
    isFlagged: profile.is_flagged ?? null,
    flaggedReason: profile.flagged_reason ?? null,
    profilePicture,
    // Registration / personal details (registration form first, then profile)
    gender: pick(registration, "gender"),
    dateOfBirth: pick(registration, "date_of_birth", "dob") || (kyc as any)?.date_of_birth || null,
    address: pick(registration, "address") || (kyc as any)?.address || profile.address || null,
    state: pick(registration, "state"),
    lga: pick(registration, "lga"),
    occupation: pick(registration, "occupation") || profile.occupation || null,
    employer: pick(registration, "employer_name", "employer") || profile.employer || null,
    workAddress: pick(registration, "work_address"),
    employmentType: pick(registration, "employment_type"),
    yearsOfEmployment: pick(registration, "years_of_employment"),
    staffId: pick(registration, "staff_id", "employer_staff_id"),
    idType: pick(registration, "id_type"),
    idNumber: pick(registration, "id_number") || (kyc as any)?.national_id || null,
    bvn: pick(registration, "bvn"),
    nin: pick(registration, "nin"),
    // Next of kin
    nextOfKin: {
      name: pick(registration, "nok_name"),
      phone: pick(registration, "nok_phone"),
      address: pick(registration, "nok_address"),
      relationship: pick(registration, "nok_relationship"),
    },
    // Contribution preferences chosen at signup
    monthlyAmount: pick(registration, "monthly_amount"),
    contributionMethod: pick(registration, "contribution_method") || "monthly",
    preferredPaymentDay: pick(registration, "preferred_payment_day"),
    // Membership / account
    membershipStatus: userRow?.membership_status ?? null,
    referralCode: userRow?.referral_code ?? null,
    emailVerified: userRow?.email_verified ?? null,
    // Financials
    walletBalance: Number((wallet as any)?.balance ?? 0),
    totalContributions,
    monthlySavings: Number(savings?.monthly_savings ?? 0),
    consecutiveMonths: Number(savings?.consecutive_months ?? 0),
    activeLoan,
    riskScore: 0,
    // Raw / nested data so the UI can render anything not explicitly mapped above
    registration: registration ?? {},
    kyc: kyc ?? null,
    documents: documents ?? [],
    bankAccounts: bankAccounts ?? [],
    registrationSubmittedAt: submittedAt,
    joinDate: profile.created_at?.slice(0, 10) ?? null,
    createdAt: profile.created_at,
    avatarInitials: ((firstName[0] ?? "") + (lastName[0] ?? "")).toUpperCase() || "??",
  };
}

router.get("/members/:id", async (req, res): Promise<void> => {
  const id = req.params.id;
  const { data: profile, error } = await supabase.from("profiles").select("*").eq("id", id).single();
  if (error || !profile) { res.status(404).json({ error: "Member not found" }); return; }
  res.json(await buildMemberDetail(profile));
});

// Get member by user_id (CVA-XXX format) - used by admin dashboard
router.get("/members/user/:userId", async (req, res): Promise<void> => {
  const userId = req.params.userId;
  const { data: profile, error } = await supabase.from("profiles").select("*").eq("user_id", userId).single();
  if (error || !profile) { res.status(404).json({ error: "Member not found" }); return; }
  res.json(await buildMemberDetail(profile));
});

// Update member status and other fields
router.patch("/members/:id", async (req, res): Promise<void> => {
  const id = req.params.id;
  const { status, kyc_verified, is_flagged, is_active } = req.body;

  // Build update object
  const updates: Record<string, any> = {};
  
  if (status !== undefined) {
    // Map status string to database fields
    switch (status) {
      case "active":
        updates.is_active = true;
        updates.kyc_verified = true;
        updates.is_flagged = false;
        break;
      case "suspended":
        updates.is_active = false;
        updates.is_flagged = true;
        break;
      case "inactive":
        updates.is_active = false;
        updates.is_flagged = false;
        break;
      case "pending":
        updates.is_active = true;
        updates.kyc_verified = false;
        updates.is_flagged = false;
        break;
      case "frozen":
        updates.is_active = false;
        updates.is_flagged = true;
        break;
    }
  }

  // Allow direct field updates too
  if (kyc_verified !== undefined) updates.kyc_verified = kyc_verified;
  if (is_flagged !== undefined) updates.is_flagged = is_flagged;
  if (is_active !== undefined) updates.is_active = is_active;

  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: "No valid fields to update" });
    return;
  }

  updates.updated_at = new Date().toISOString();

  const { data: profile, error } = await supabase
    .from("profiles")
    .update(updates)
    .eq("id", id)
    .select()
    .single();

  if (error) { 
    console.error("Error updating member:", error);
    res.status(500).json({ error: error.message }); 
    return; 
  }
  
  if (!profile) {
    res.status(404).json({ error: "Member not found" });
    return;
  }

  const { firstName, lastName } = splitName(profile.name);
  res.json({ id: profile.id, memberId: profile.user_id, firstName, lastName, email: profile.email, phone: profile.phone ?? "", status: deriveStatus(profile), joinDate: profile.created_at?.slice(0, 10) ?? null, address: null, occupation: null, createdAt: profile.created_at, totalContributions: 0, activeLoan: 0, riskScore: 0, avatarInitials: ((firstName[0] ?? "") + (lastName[0] ?? "")).toUpperCase() || "??" });
});

// Also support PUT method for update (OpenAPI spec uses PUT)
router.put("/members/:id", async (req, res): Promise<void> => {
  const id = req.params.id;
  const { status, kyc_verified, is_flagged, is_active, role } = req.body;

  // Build update object
  const updates: Record<string, any> = {};
  
  if (status !== undefined) {
    switch (status) {
      case "active":
        updates.is_active = true;
        updates.kyc_verified = true;
        updates.is_flagged = false;
        break;
      case "suspended":
        updates.is_active = false;
        updates.is_flagged = true;
        break;
      case "inactive":
        updates.is_active = false;
        updates.is_flagged = false;
        break;
      case "pending":
        updates.is_active = true;
        updates.kyc_verified = false;
        updates.is_flagged = false;
        break;
      case "frozen":
        updates.is_active = false;
        updates.is_flagged = true;
        break;
    }
  }

  if (kyc_verified !== undefined) updates.kyc_verified = kyc_verified;
  if (is_flagged !== undefined) updates.is_flagged = is_flagged;
  if (is_active !== undefined) updates.is_active = is_active;
  if (role !== undefined) updates.role = role;

  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: "No valid fields to update" });
    return;
  }

  updates.updated_at = new Date().toISOString();

  const { data: profile, error } = await supabase
    .from("profiles")
    .update(updates)
    .eq("id", id)
    .select()
    .single();

  if (error) { 
    console.error("Error updating member:", error);
    res.status(500).json({ error: error.message }); 
    return; 
  }
  
  if (!profile) {
    res.status(404).json({ error: "Member not found" });
    return;
  }

  const { firstName, lastName } = splitName(profile.name);
  res.json({ 
    id: profile.id, 
    memberId: profile.user_id, 
    firstName, 
    lastName, 
    email: profile.email, 
    phone: profile.phone ?? "", 
    status: deriveStatus(profile), 
    role: profile.role || "member",
    kycVerified: profile.kyc_verified || false,
    profilePicture: profile.avatar_url || null,
    occupation: profile.occupation || null,
    organization: profile.organization || null,
    employer: profile.employer || null,
    joinDate: profile.created_at?.slice(0, 10) ?? null, 
    address: profile.address || null,
    createdAt: profile.created_at, 
    totalContributions: 0, 
    activeLoan: 0, 
    riskScore: 0, 
    avatarInitials: ((firstName[0] ?? "") + (lastName[0] ?? "")).toUpperCase() || "??" 
  });
});

// Role management - only super_admin can assign roles
router.post("/members/:id/role", requireAuth, requireRole("super_admin"), async (req, res): Promise<void> => {
  const id = req.params.id;
  const { role } = req.body;

  if (!role || !["member", "viewer", "operator", "admin", "super_admin"].includes(role)) {
    res.status(400).json({ error: "Invalid role. Must be: member, viewer, operator, admin, or super_admin" });
    return;
  }

  const { data: profile, error } = await supabase
    .from("profiles")
    .update({ role, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select()
    .single();

  if (error) { 
    console.error("Error updating role:", error);
    res.status(500).json({ error: error.message }); 
    return; 
  }
  
  if (!profile) {
    res.status(404).json({ error: "Member not found" });
    return;
  }

  const { firstName, lastName } = splitName(profile.name);
  res.json({ 
    id: profile.id, 
    memberId: profile.user_id, 
    firstName, 
    lastName, 
    email: profile.email, 
    phone: profile.phone ?? "", 
    status: deriveStatus(profile), 
    role: profile.role,
    kycVerified: profile.kyc_verified || false,
    profilePicture: profile.avatar_url || null,
    occupation: profile.occupation || null,
    organization: profile.organization || null,
    employer: profile.employer || null,
    joinDate: profile.created_at?.slice(0, 10) ?? null, 
    address: profile.address || null,
    createdAt: profile.created_at, 
    totalContributions: 0, 
    activeLoan: 0, 
    riskScore: 0, 
    avatarInitials: ((firstName[0] ?? "") + (lastName[0] ?? "")).toUpperCase() || "??" 
});

// Delete member - only super_admin can delete members
// This will COMPLETELY remove the user - they cannot login again
router.delete("/members/:id", requireAuth, requireRole("super_admin"), async (req, res): Promise<void> => {
  const id = req.params.id;

  // First check if member exists
  const { data: profile, error: fetchError } = await supabase
    .from("profiles")
    .select("id, email, name, role, user_id")
    .eq("id", id)
    .single();

  if (fetchError || !profile) {
    res.status(404).json({ error: "Member not found" });
    return;
  }

  // Get current user's email
  const currentUserEmail = (req as AuthenticatedRequest).user?.email;

  // Prevent deleting yourself
  if (profile.id === (req as AuthenticatedRequest).user?.profileId) {
    res.status(400).json({ error: "Cannot delete your own account" });
    return;
  }

  // Only ayanlowo89@gmail.com can delete other super_admins
  if (profile.role === "super_admin") {
    if (currentUserEmail !== "ayanlowo89@gmail.com") {
      res.status(403).json({ error: "Only the primary admin can delete other super admins" });
      return;
    }
  }

  try {
    // Step 1: Delete user from Supabase Auth (this prevents login)
    if (profile.email) {
      const { data: authUsers, error: listError } = await (supabase.auth.admin as any).listUsers();
      
      if (!listError && authUsers?.users) {
        const authUser = authUsers.users.find((u: any) => u.email === profile.email);
        
        if (authUser) {
          const { error: authDeleteError } = await (supabase.auth.admin as any).deleteUser(authUser.id);
          
          if (authDeleteError) {
            console.error("Error deleting auth user:", authDeleteError);
          }
        }
      }
    }

    // Step 2: Delete related data from other tables (cascade)
    const tablesToClean = [
      "savings",
      "loans", 
      "transactions",
      "notifications",
      "contributions",
      "guarantors",
      "documents",
      "audit_logs",
    ];

    for (const table of tablesToClean) {
      try {
        await supabase.from(table).delete().eq("profile_id", id);
      } catch (e) {
        console.log(`Skipping cleanup of ${table}: ${e}`);
      }
    }

    // Step 3: Delete the profile
    const { error: deleteError } = await supabase
      .from("profiles")
      .delete()
      .eq("id", id);

    if (deleteError) {
      console.error("Error deleting profile:", deleteError);
      res.status(500).json({ error: deleteError.message });
      return;
    }

    res.json({
      success: true,
      message: `Member ${profile.name} (${profile.email}) has been COMPLETELY deleted. They cannot login again and must register fresh.`
    });

  } catch (error) {
    console.error("Error in delete member process:", error);
    res.status(500).json({ error: "Failed to delete member completely" });
  }
});

export default router;
