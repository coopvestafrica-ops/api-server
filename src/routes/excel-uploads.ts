import { Router, type IRouter } from "express";
import { supabase } from "../lib/supabase";
import { z } from "zod";
import { requireAuth } from "../middleware/auth";

const router: IRouter = Router();

// Schema for upload records
const UploadRecordSchema = z.object({
  filename: z.string().min(1),
  type: z.enum(["bulk_contributions", "user_import", "payroll", "reconciliation"]),
  uploaded_by: z.string().optional(),
  record_count: z.number().int().nonnegative().default(0),
  total_amount: z.number().optional(),
  status: z.enum(["processed", "pending", "failed", "reviewing"]).default("pending"),
  error_count: z.number().int().nonnegative().default(0),
  notes: z.string().optional(),
});

// Get all upload records
router.get("/excel-uploads", requireAuth, async (req, res): Promise<void> => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Number(req.query.limit) || 20);
    const offset = (page - 1) * limit;
    const status = req.query.status as string | undefined;
    const uploadType = req.query.type as string | undefined;

    let query = supabase
      .from("excel_uploads")
      .select("*", { count: "exact" })
      .order("created_at", { ascending: false });

    if (status) query = query.eq("status", status);
    if (uploadType) query = query.eq("type", uploadType);

    const { data: records, count, error } = await query.range(offset, offset + limit - 1);

    if (error) {
      console.error("Error fetching upload records:", error);
      res.status(500).json({ data: [], total: 0, page, limit });
      return;
    }

    const uploads = Array.isArray(records) ? records : [];
    res.json({
      data: uploads.map(r => ({
        id: r.id,
        filename: r.filename,
        type: r.type,
        uploadedBy: r.uploaded_by || "Admin",
        rows: r.record_count || 0,
        errors: r.error_count || 0,
        status: r.status,
        totalAmount: r.total_amount || 0,
        uploadedAt: r.created_at,
        notes: r.notes || null,
      })),
      total: count ?? 0,
      page,
      limit,
    });
  } catch (err) {
    console.error("Unexpected error:", err);
    res.status(500).json({ data: [], total: 0, page: 1, limit: 20 });
  }
});

// Get single upload record
router.get("/excel-uploads/:id", requireAuth, async (req, res): Promise<void> => {
  const { id } = req.params;

  const { data: record, error } = await supabase
    .from("excel_uploads")
    .select("*")
    .eq("id", id)
    .single();

  if (error || !record) {
    res.status(404).json({ error: "Upload record not found" });
    return;
  }

  res.json({
    id: record.id,
    filename: record.filename,
    type: record.type,
    uploadedBy: record.uploaded_by || "Admin",
    rows: record.record_count || 0,
    errors: record.error_count || 0,
    status: record.status,
    totalAmount: record.total_amount || 0,
    uploadedAt: record.created_at,
    notes: record.notes || null,
  });
});

// Create new upload record
router.post("/excel-uploads", requireAuth, async (req, res): Promise<void> => {
  const parsed = UploadRecordSchema.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({ error: "Validation failed", details: parsed.error.flatten().fieldErrors });
    return;
  }

  const { filename, type, uploaded_by, record_count, total_amount, status, error_count, notes } = parsed.data;

  // Get current user's name if not provided
  let uploaderName = uploaded_by;
  if (!uploaderName) {
    const userId = (req as any).user?.id;
    if (userId) {
      const { data: profile } = await supabase
        .from("profiles")
        .select("first_name, last_name")
        .eq("id", userId)
        .single();
      if (profile) {
        uploaderName = `${profile.first_name || ""} ${profile.last_name || ""}`.trim() || "Admin";
      }
    }
  }

  const { data: record, error } = await supabase
    .from("excel_uploads")
    .insert({
      filename,
      type,
      uploaded_by: uploaderName || "Admin",
      record_count,
      total_amount: total_amount || 0,
      status,
      error_count,
      notes,
    })
    .select()
    .single();

  if (error) {
    console.error("Error creating upload record:", error);
    res.status(500).json({ error: error.message });
    return;
  }

  res.status(201).json({
    id: record.id,
    filename: record.filename,
    type: record.type,
    uploadedBy: record.uploaded_by,
    rows: record.record_count,
    errors: record.error_count,
    status: record.status,
    totalAmount: record.total_amount,
    uploadedAt: record.created_at,
    notes: record.notes,
  });
});

// Update upload record status
router.patch("/excel-uploads/:id", requireAuth, async (req, res): Promise<void> => {
  const { id } = req.params;
  const { status, error_count, notes, record_count } = req.body;

  const updates: Record<string, any> = { updated_at: new Date().toISOString() };
  if (status) updates.status = status;
  if (error_count !== undefined) updates.error_count = error_count;
  if (notes !== undefined) updates.notes = notes;
  if (record_count !== undefined) updates.record_count = record_count;

  const { data: record, error } = await supabase
    .from("excel_uploads")
    .update(updates)
    .eq("id", id)
    .select()
    .single();

  if (error) {
    console.error("Error updating upload record:", error);
    res.status(500).json({ error: error.message });
    return;
  }

  if (!record) {
    res.status(404).json({ error: "Upload record not found" });
    return;
  }

  res.json({
    id: record.id,
    filename: record.filename,
    type: record.type,
    uploadedBy: record.uploaded_by,
    rows: record.record_count,
    errors: record.error_count,
    status: record.status,
    totalAmount: record.total_amount,
    uploadedAt: record.created_at,
    notes: record.notes,
  });
});

// Delete upload record
router.delete("/excel-uploads/:id", requireAuth, async (req, res): Promise<void> => {
  const { id } = req.params;

  const { error } = await supabase
    .from("excel_uploads")
    .delete()
    .eq("id", id);

  if (error) {
    console.error("Error deleting upload record:", error);
    res.status(500).json({ error: error.message });
    return;
  }

  res.json({ success: true, message: "Upload record deleted" });
});

export default router;