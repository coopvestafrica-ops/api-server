import { Router, type IRouter } from "express";
import { supabase } from "../lib/supabase";
import { requireAuth, requireRole } from "../middleware/auth";
import { z } from "zod";

const router: IRouter = Router();
router.use(requireAuth);

// Get all scheduled reports
router.get("/reports/scheduled", requireRole("admin", "super_admin"), async (req, res): Promise<void> => {
  const { data: reports, error } = await supabase
    .from("scheduled_reports")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  res.json({ data: reports || [] });
});

// Create scheduled report
const CreateReportSchema = z.object({
  name: z.string().min(1),
  type: z.enum(["daily", "weekly", "monthly"]),
  reportType: z.enum(["members", "contributions", "loans", "financial", "compliance", "custom"]),
  recipients: z.array(z.string().email()),
  format: z.enum(["csv", "pdf", "excel"]),
  filters: z.object({
    dateRange: z.enum(["today", "week", "month", "quarter", "custom"]).optional(),
    startDate: z.string().optional(),
    endDate: z.string().optional(),
    organization: z.string().optional(),
    status: z.string().optional(),
  }).optional(),
  enabled: z.boolean().default(true),
  sendTime: z.string(), // HH:MM format
  dayOfWeek: z.number().min(0).max(6).optional(), // For weekly reports
  dayOfMonth: z.number().min(1).max(28).optional(), // For monthly reports
});

router.post("/reports/scheduled", requireRole("super_admin"), async (req, res): Promise<void> => {
  const parsed = CreateReportSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
    return;
  }

  const { data: report, error } = await supabase
    .from("scheduled_reports")
    .insert({
      name: parsed.data.name,
      type: parsed.data.type,
      report_type: parsed.data.reportType,
      recipients: parsed.data.recipients,
      format: parsed.data.format,
      filters: parsed.data.filters,
      enabled: parsed.data.enabled,
      send_time: parsed.data.sendTime,
      day_of_week: parsed.data.dayOfWeek,
      day_of_month: parsed.data.dayOfMonth,
      last_sent: null,
      next_send: calculateNextSend(parsed.data),
    })
    .select()
    .single();

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  res.status(201).json(report);
});

// Update scheduled report
router.patch("/reports/scheduled/:id", requireRole("super_admin"), async (req, res): Promise<void> => {
  const { id } = req.params;
  const updates: Record<string, any> = { ...req.body };

  // Convert camelCase to snake_case
  if (updates.reportType) { updates.report_type = updates.reportType; delete updates.reportType; }
  if (updates.sendTime) { updates.send_time = updates.sendTime; delete updates.sendTime; }
  if (updates.dayOfWeek !== undefined) { updates.day_of_week = updates.dayOfWeek; delete updates.dayOfWeek; }
  if (updates.dayOfMonth !== undefined) { updates.day_of_month = updates.dayOfMonth; delete updates.dayOfMonth; }

  if (updates.type && updates.sendTime) {
    updates.next_send = calculateNextSend({
      type: updates.type,
      sendTime: updates.sendTime,
      dayOfWeek: updates.dayOfWeek,
      dayOfMonth: updates.dayOfMonth,
    });
  }

  updates.updated_at = new Date().toISOString();

  const { data: report, error } = await supabase
    .from("scheduled_reports")
    .update(updates)
    .eq("id", id)
    .select()
    .single();

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  res.json(report);
});

// Delete scheduled report
router.delete("/reports/scheduled/:id", requireRole("super_admin"), async (req, res): Promise<void> => {
  const { id } = req.params;
  const { error } = await supabase
    .from("scheduled_reports")
    .delete()
    .eq("id", id);

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  res.json({ success: true });
});

// Toggle report enabled/disabled
router.post("/reports/scheduled/:id/toggle", requireRole("super_admin"), async (req, res): Promise<void> => {
  const { id } = req.params;
  const { enabled } = req.body;

  const { data: report, error } = await supabase
    .from("scheduled_reports")
    .update({ enabled, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select()
    .single();

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  res.json(report);
});

// Trigger report generation (manual)
router.post("/reports/scheduled/:id/run", requireRole("admin", "super_admin"), async (req, res): Promise<void> => {
  const { id } = req.params;

  const { data: report } = await supabase
    .from("scheduled_reports")
    .select("*")
    .eq("id", id)
    .single();

  if (!report) {
    res.status(404).json({ error: "Report not found" });
    return;
  }

  // Generate report data based on type
  const reportData = await generateReportData(report.report_type, report.filters);

  // Update last_sent
  await supabase
    .from("scheduled_reports")
    .update({ 
      last_sent: new Date().toISOString(),
      next_send: calculateNextSend(report),
    })
    .eq("id", id);

  res.json({
    success: true,
    reportId: id,
    generatedAt: new Date().toISOString(),
    rowCount: Array.isArray(reportData) ? reportData.length : 0,
    data: reportData,
  });
});

// Get report history
router.get("/reports/history", requireRole("admin", "super_admin"), async (req, res): Promise<void> => {
  const { data: history } = await supabase
    .from("report_history")
    .select("*")
    .order("generated_at", { ascending: false })
    .limit(50);

  res.json({ data: history || [] });
});

// Helper functions
function calculateNextSend(config: any): string {
  const now = new Date();
  const [hours, minutes] = (config.sendTime || "09:00").split(":").map(Number);
  let next = new Date(now);
  next.setHours(hours, minutes, 0, 0);

  if (config.type === "daily") {
    if (next <= now) next.setDate(next.getDate() + 1);
  } else if (config.type === "weekly") {
    const targetDay = config.dayOfWeek ?? 1; // Default Monday
    while (next.getDay() !== targetDay || next <= now) {
      next.setDate(next.getDate() + 1);
    }
  } else if (config.type === "monthly") {
    const targetDay = config.dayOfMonth ?? 1;
    next.setDate(targetDay);
    if (next <= now) next.setMonth(next.getMonth() + 1);
  }

  return next.toISOString();
}

async function generateReportData(reportType: string, filters: any) {
  const { startDate, endDate, organization, status } = filters || {};

  let query;
  switch (reportType) {
    case "members":
      query = supabase.from("profiles").select("*");
      if (status) query = query.eq("status", status);
      break;
    case "contributions":
      query = supabase.from("contributions").select("*");
      if (startDate) query = query.gte("created_at", startDate);
      if (endDate) query = query.lte("created_at", endDate);
      break;
    case "loans":
      query = supabase.from("loans").select("*");
      if (status) query = query.eq("status", status);
      break;
    case "financial":
      // Combined financial data
      const [savings, loans, contributions] = await Promise.all([
        supabase.from("savings").select("*"),
        supabase.from("loans").select("*"),
        supabase.from("contributions").select("*"),
      ]);
      return { savings: savings.data, loans: loans.data, contributions: contributions.data };
    default:
      return [];
  }

  const { data } = await query;
  return data || [];
}

export default router;