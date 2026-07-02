import { createClient, SupabaseClient } from "@supabase/supabase-js";

const supabaseUrl = process.env["SUPABASE_URL"];
const supabaseKey = process.env["SUPABASE_SERVICE_ROLE_KEY"];

if (!supabaseUrl || !supabaseKey) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.");
}

export const supabase: SupabaseClient = createClient(supabaseUrl, supabaseKey);
export { createClient };

export function splitName(name: string | null): { firstName: string; lastName: string } {
  if (!name) return { firstName: "", lastName: "" };
  const parts = name.trim().split(/\s+/);
  return { firstName: parts[0] ?? "", lastName: parts.slice(1).join(" ") || "" };
}

export function deriveStatus(row: { is_active?: boolean; is_flagged?: boolean; kyc_verified?: boolean }): string {
  if (row.is_flagged) return "suspended";
  if (!row.is_active) return "inactive";
  if (row.kyc_verified) return "active";
  return "pending";
}
