import { Router, type IRouter } from "express";
import { supabase } from "../lib/supabase";

const router: IRouter = Router();

interface OrgRow {
  id: string;
  name: string | null;
  type: string | null;
  member_count: number | null;
  status: string | null;
  date_added: string | null;
  contact_email: string | null;
  address: string | null;
}

function toCamel(o: OrgRow) {
  return {
    id: o.id,
    name: o.name || "",
    type: o.type || "",
    memberCount: o.member_count ?? 0,
    status: o.status || "active",
    dateAdded: o.date_added,
    contactEmail: o.contact_email || "",
    address: o.address || "",
  };
}

router.get("/organizations", async (_req, res): Promise<void> => {
  const { data, error } = await supabase
    .from("organizations")
    .select("*")
    .order("date_added", { ascending: false });
  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }
  const organizations = (data ?? []).map((o) => toCamel(o as OrgRow));
  res.json({ organizations, total: organizations.length });
});

router.post("/organizations", async (req, res): Promise<void> => {
  const b = req.body ?? {};
  const { data, error } = await supabase
    .from("organizations")
    .insert({
      name: b.name,
      type: (b.type || b.deduction_type || "").toLowerCase(),
      contact_email: b.contactEmail,
      address: b.address,
      status: b.status || "active",
      member_count: 0,
      date_added: new Date().toISOString(),
    })
    .select("*")
    .single();
  if (error || !data) {
    res.status(500).json({ success: false, error: error?.message || "Failed to create organization" });
    return;
  }
  res.status(201).json({ success: true, organization: toCamel(data as OrgRow) });
});

router.put("/organizations/:id", async (req, res): Promise<void> => {
  const b = req.body ?? {};
  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (b.name !== undefined) update.name = b.name;
  if (b.type !== undefined) update.type = String(b.type).toLowerCase();
  if (b.contactEmail !== undefined) update.contact_email = b.contactEmail;
  if (b.address !== undefined) update.address = b.address;
  if (b.status !== undefined) update.status = b.status;
  const { data, error } = await supabase
    .from("organizations")
    .update(update)
    .eq("id", req.params.id)
    .select("*")
    .single();
  if (error || !data) {
    res.status(404).json({ error: error?.message || "Organization not found" });
    return;
  }
  res.json({ organization: toCamel(data as OrgRow) });
});

router.get("/organizations/:id/staff", async (req, res): Promise<void> => {
  const { data } = await supabase
    .from("profiles")
    .select("id, name, email, role, department")
    .eq("organization_id", req.params.id);
  const staff = (data ?? []).map((p) => ({
    id: p.id,
    name: p.name || p.email || "Unknown",
    email: p.email || "",
    designation: p.department || p.role || "Member",
    memberId: p.id,
  }));
  res.json({ staff, organizationId: req.params.id });
});

export default router;
