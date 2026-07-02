import { Router, type IRouter } from "express";
import { supabase } from "../lib/supabase";

const router: IRouter = Router();

router.get("/audit-logs", async (req, res): Promise<void> => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Number(req.query.limit) || 20);
  const offset = (page - 1) * limit;
  const action = req.query.action as string | undefined;
  const entity = req.query.entity as string | undefined;

  let query = supabase.from("audit_logs").select("*", { count: "exact" });
  if (action) query = query.eq("action", action);
  if (entity) query = query.eq("entity_type", entity);

  const { data: logs, count, error } = await query
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) { res.status(500).json({ error: error.message }); return; }

  res.json({
    data: (logs ?? []).map(l => ({
      id: l.id,
      action: l.action,
      entity: l.entity_type,
      entityId: l.entity_id,
      userId: l.profile_id,
      details: l.description ?? l.metadata ?? null,
      ipAddress: l.ip_address ?? null,
      createdAt: l.created_at,
    })),
    total: count ?? 0,
    page,
    limit,
  });
});

export default router;
