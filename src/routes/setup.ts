import { Router, type IRouter } from "express";
import { createClient } from "../lib/supabase";

const router = Router();

// This endpoint allows setting up the initial super admin
// It should be called once after deployment and then disabled
router.post("/setup/super-admin", async (req, res): Promise<void> => {
  const { email, supabase_service_key } = req.body;

  // Security: Only allow if the correct service key is provided
  const expectedKey = process.env.SETUP_SECRET_KEY || "super-admin-setup-key";
  
  if (req.headers["x-setup-key"] !== expectedKey) {
    res.status(401).json({ error: "Unauthorized - invalid setup key" });
    return;
  }

  if (!email) {
    res.status(400).json({ error: "Email is required" });
    return;
  }

  if (!supabase_service_key) {
    res.status(400).json({ error: "Supabase service key is required" });
    return;
  }

  try {
    const supabase = createClient(
      process.env.SUPABASE_URL || "",
      supabase_service_key,
      { auth: { autoRefreshToken: false, persistSession: false } }
    );

    // Find the profile by email
    const { data: profiles, error: searchError } = await supabase
      .from("profiles")
      .select("*")
      .eq("email", email);

    if (searchError) {
      console.error("Error searching profiles:", searchError);
      res.status(500).json({ error: "Database error: " + searchError.message });
      return;
    }

    if (!profiles || profiles.length === 0) {
      res.status(404).json({ error: `No profile found with email: ${email}` });
      return;
    }

    const profile = profiles[0];

    // Update the profile to super_admin
    const { data: updated, error: updateError } = await supabase
      .from("profiles")
      .update({ 
        role: "super_admin",
        is_active: true,
        kyc_verified: true,
        updated_at: new Date().toISOString()
      })
      .eq("id", profile.id)
      .select()
      .single();

    if (updateError) {
      console.error("Error updating profile:", updateError);
      res.status(500).json({ error: "Failed to update profile: " + updateError.message });
      return;
    }

    console.log(`✅ Super admin set successfully: ${email}`);
    res.json({ 
      success: true, 
      message: `Super admin privileges granted to ${email}`,
      profile: {
        id: updated.id,
        email: updated.email,
        role: updated.role,
        is_active: updated.is_active,
        kyc_verified: updated.kyc_verified
      }
    });
  } catch (err: any) {
    console.error("Setup error:", err);
    res.status(500).json({ error: err.message || "Setup failed" });
  }
});

export default router;