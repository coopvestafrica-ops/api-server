import { Router, type IRouter } from "express";
import { supabase } from "../lib/supabase";

const router: IRouter = Router();

// GET /api/payroll/batches — list payroll batches
router.get("/payroll/batches", async (req, res): Promise<void> => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Number(req.query.limit) || 20);
  const offset = (page - 1) * limit;

  const { data, count, error } = await supabase
    .from("payroll_batches")
    .select(
      "id, organization, month, uploaded_at, uploaded_by, record_count, total_amount, status, matched_count, unmatched_count",
      { count: "exact" },
    )
    .order("uploaded_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) { res.status(500).json({ error: error.message }); return; }

  res.json({ data: data ?? [], total: count ?? 0, page, limit });
});

// GET /api/payroll/batches/:id — single batch details
router.get("/payroll/batches/:id", async (req, res): Promise<void> => {
  const { id } = req.params;

  const { data, error } = await supabase
    .from("payroll_batches")
    .select("*")
    .eq("id", id)
    .single();

  if (error) { res.status(error.code === "PGRST116" ? 404 : 500).json({ error: error.message }); return; }

  res.json(data);
});

// POST /api/payroll/batches — create a new batch
router.post("/payroll/batches", async (req, res): Promise<void> => {
  const { organization, month, record_count, total_amount, uploaded_by } = req.body as {
    organization: string;
    month: string;
    record_count: number;
    total_amount: number;
    uploaded_by: string;
  };

  if (!organization || !month || record_count == null || total_amount == null) {
    res.status(400).json({ error: "organization, month, record_count, and total_amount are required" });
    return;
  }

  const { data, error } = await supabase
    .from("payroll_batches")
    .insert({
      organization,
      month,
      record_count,
      total_amount,
      uploaded_by: uploaded_by ?? "Admin",
      status: "pending",
      matched_count: 0,
      unmatched_count: 0,
    })
    .select()
    .single();

  if (error) { res.status(500).json({ error: error.message }); return; }

  res.status(201).json(data);
});

// PATCH /api/payroll/batches/:id/status — update status (processing, completed, failed)
router.patch("/payroll/batches/:id/status", async (req, res): Promise<void> => {
  const { id } = req.params;
  const { status, matched_count, unmatched_count } = req.body as {
    status: "pending" | "processing" | "completed" | "failed";
    matched_count?: number;
    unmatched_count?: number;
  };

  const allowed = ["pending", "processing", "completed", "failed"];
  if (!status || !allowed.includes(status)) {
    res.status(400).json({ error: `status must be one of: ${allowed.join(", ")}` });
    return;
  }

  const { data, error } = await supabase
    .from("payroll_batches")
    .update({ status, ...(matched_count != null && { matched_count }), ...(unmatched_count != null && { unmatched_count }) })
    .eq("id", id)
    .select()
    .single();

  if (error) { res.status(error.code === "PGRST116" ? 404 : 500).json({ error: error.message }); return; }

  res.json(data);
});

export default router;
