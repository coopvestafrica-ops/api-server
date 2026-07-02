import { Router, type IRouter } from "express";
import { supabase } from "../lib/supabase";
import { requireAuth, requireRole } from "../middleware/auth";

const router: IRouter = Router();
router.use(requireAuth);

// Bulk import members via CSV
router.post("/bulk/import-members", requireRole("admin", "super_admin"), async (req, res): Promise<void> => {
  const { members } = req.body;

  if (!Array.isArray(members)) {
    res.status(400).json({ error: "Members must be an array" });
    return;
  }

  const results = {
    success: 0,
    failed: 0,
    errors: [] as string[],
  };

  const insertData = members.map((m: any, index: number) => {
    try {
      if (!m.email) throw new Error(`Row ${index + 1}: Email is required`);
      if (!m.name && !m.firstName) throw new Error(`Row ${index + 1}: Name is required`);

      return {
        id: crypto.randomUUID(),
        user_id: "CVA-" + String(Date.now() + index).slice(-6),
        name: m.name || `${m.firstName} ${m.lastName || ""}`.trim(),
        email: m.email,
        phone: m.phone || null,
        role: "member",
        is_active: m.is_active ?? true,
        kyc_verified: false,
        is_flagged: false,
        occupation: m.occupation || null,
        organization_id: m.organizationId || null,
        created_at: new Date().toISOString(),
      };
    } catch (err: any) {
      results.failed++;
      results.errors.push(err.message);
      return null;
    }
  }).filter(Boolean);

  if (insertData.length > 0) {
    const { data, error } = await supabase
      .from("profiles")
      .insert(insertData as any[])
      .select("id, email");

    if (error) {
      res.status(500).json({ error: error.message, results });
      return;
    }

    results.success = insertData.length;
  }

  res.json({
    message: `Import complete: ${results.success} succeeded, ${results.failed} failed`,
    results,
  });
});

// Bulk update member status
router.post("/bulk/update-status", requireRole("admin", "super_admin"), async (req, res): Promise<void> => {
  const { memberIds, status } = req.body;

  if (!Array.isArray(memberIds) || memberIds.length === 0) {
    res.status(400).json({ error: "memberIds must be a non-empty array" });
    return;
  }

  if (!["active", "inactive", "suspended"].includes(status)) {
    res.status(400).json({ error: "Invalid status value" });
    return;
  }

  const updates: Record<string, any> = {
    updated_at: new Date().toISOString(),
  };

  switch (status) {
    case "active":
      updates.is_active = true;
      updates.kyc_verified = true;
      updates.is_flagged = false;
      break;
    case "inactive":
      updates.is_active = false;
      updates.is_flagged = false;
      break;
    case "suspended":
      updates.is_active = false;
      updates.is_flagged = true;
      break;
  }

  const { data, error } = await supabase
    .from("profiles")
    .update(updates)
    .in("id", memberIds)
    .select("id, email, status");

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  res.json({
    success: true,
    updated: data?.length || 0,
    members: data,
  });
});

// Bulk export members
router.get("/bulk/export-members", requireRole("admin", "super_admin"), async (req, res): Promise<void> => {
  const { status, organization, format = "csv" } = req.query;

  let query = supabase.from("profiles").select("*");
  
  if (status === "active") query = query.eq("is_active", true).eq("kyc_verified", true);
  else if (status === "inactive") query = query.eq("is_active", false);
  else if (status === "suspended") query = query.eq("is_flagged", true);
  else if (status === "pending") query = query.eq("is_active", true).eq("kyc_verified", false);

  const { data: profiles, error } = await query;

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  if (format === "csv") {
    const headers = ["ID", "User ID", "Name", "Email", "Phone", "Status", "Created"];
    const rows = (profiles || []).map(p => [
      p.id,
      p.user_id,
      p.name,
      p.email,
      p.phone || "",
      deriveStatus(p),
      p.created_at?.slice(0, 10) || "",
    ]);

    const csv = [headers.join(","), ...rows.map(r => r.join(","))].join("\n");
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="members-export-${Date.now()}.csv"`);
    res.send(csv);
  } else {
    res.json({ data: profiles || [] });
  }
});

// Bulk contribution import
router.post("/bulk/import-contributions", requireRole("admin", "super_admin"), async (req, res): Promise<void> => {
  const { contributions } = req.body;

  if (!Array.isArray(contributions)) {
    res.status(400).json({ error: "Contributions must be an array" });
    return;
  }

  const results = { success: 0, failed: 0, errors: [] as string[] };
  const insertData: any[] = [];

  for (let i = 0; i < contributions.length; i++) {
    const c = contributions[i];
    try {
      if (!c.profileId) throw new Error(`Row ${i + 1}: Profile ID is required`);
      if (!c.amount || c.amount <= 0) throw new Error(`Row ${i + 1}: Valid amount is required`);

      insertData.push({
        id: crypto.randomUUID(),
        profile_id: c.profileId,
        amount: c.amount,
        payment_method: c.paymentMethod || "bank_transfer",
        reference: c.reference || `BULK-${Date.now()}-${i}`,
        status: "completed",
        month: c.month || new Date().toISOString().slice(0, 7),
        created_at: c.date || new Date().toISOString(),
      });
    } catch (err: any) {
      results.failed++;
      results.errors.push(err.message);
    }
  }

  if (insertData.length > 0) {
    const { error } = await supabase.from("contributions").insert(insertData);
    if (error) {
      res.status(500).json({ error: error.message, results });
      return;
    }
    results.success = insertData.length;
  }

  res.json({
    message: `Import complete: ${results.success} succeeded, ${results.failed} failed`,
    results,
  });
});

// Download bulk import template
router.get("/bulk/template/:type", requireRole("admin", "super_admin"), async (req, res): Promise<void> => {
  const { type } = req.params;

  let headers: string[], sampleRows: string[][];

  switch (type) {
    case "members":
      headers = ["email", "firstName", "lastName", "phone", "occupation", "organizationId"];
      sampleRows = [
        ["john.doe@example.com", "John", "Doe", "08012345678", "Engineer", "ORG001"],
        ["jane.smith@example.com", "Jane", "Smith", "08098765432", "Teacher", "ORG001"],
      ];
      break;
    case "contributions":
      headers = ["profileId", "amount", "paymentMethod", "reference", "month", "date"];
      sampleRows = [
        ["PROFILE-ID-HERE", "5000", "payroll_deduction", "REF001", "2025-06", "2025-06-15"],
        ["PROFILE-ID-HERE", "5000", "bank_transfer", "REF002", "2025-06", "2025-06-20"],
      ];
      break;
    default:
      res.status(400).json({ error: "Invalid template type" });
      return;
  }

  const csv = [headers.join(","), ...sampleRows.map(r => r.join(","))].join("\n");
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="${type}-import-template.csv"`);
  res.send(csv);
});

// Get bulk operation history
router.get("/bulk/history", requireRole("admin", "super_admin"), async (req, res): Promise<void> => {
  const { data: history, error } = await supabase
    .from("bulk_operations")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(50);

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  res.json({ data: history || [] });
});

// Log bulk operation
router.post("/bulk/log", requireRole("admin", "super_admin"), async (req, res): Promise<void> => {
  const { type, success, failed, details } = req.body;
  const userId = (req as any).user?.id;

  const { data, error } = await supabase
    .from("bulk_operations")
    .insert({
      type,
      success_count: success,
      failed_count: failed,
      details,
      performed_by: userId,
      created_at: new Date().toISOString(),
    })
    .select()
    .single();

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  res.json(data);
});

// Helper function
function deriveStatus(row: any): string {
  if (row.is_flagged) return "suspended";
  if (!row.is_active) return "inactive";
  if (row.is_active && !row.kyc_verified) return "pending";
  return "active";
}

export default router;