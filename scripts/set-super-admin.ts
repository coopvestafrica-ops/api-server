import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL || "https://your-project.supabase.co";
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;

if (!supabaseServiceKey) {
  console.error("Missing SUPABASE_SERVICE_ROLE_KEY environment variable");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseServiceKey, {
  auth: { autoRefreshToken: false, persistSession: false }
});

const SUPER_ADMIN_EMAIL = "ayanlowo89@gmail.com";

async function setSuperAdmin() {
  console.log(`Setting up super admin: ${SUPER_ADMIN_EMAIL}`);
  
  // Find the user by email in profiles table
  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("*")
    .eq("email", SUPER_ADMIN_EMAIL)
    .single();
  
  if (profileError) {
    console.error("Error finding profile:", profileError);
    
    // Try to find by name or create a placeholder
    console.log("Looking for user in auth.users...");
    
    // If profile doesn't exist, we need to create one
    // First, let's check if there's an auth user
    try {
      // List users to find the right one
      const { data: authUsers, error: listError } = await supabase.auth.admin.listUsers();
      
      if (!listError && authUsers?.users) {
        const user = authUsers.users.find(u => u.email === SUPER_ADMIN_EMAIL);
        
        if (user) {
          console.log(`Found auth user: ${user.id}`);
          
          // Create profile for this user
          const { data: newProfile, error: createError } = await supabase
            .from("profiles")
            .insert({ 
              id: user.id,
              user_id: user.id,
              name: user.user_metadata?.full_name || user.email?.split('@')[0] || "Super Admin",
              email: user.email,
              phone: user.phone || null,
              role: "super_admin",
              is_active: true,
              kyc_verified: true
            })
            .select()
            .single();
          
          if (createError) {
            // Profile might already exist, try updating
            const { data: updated, updateError } = await supabase
              .from("profiles")
              .update({ 
                role: "super_admin",
                is_active: true,
                kyc_verified: true
              })
              .eq("id", user.id)
              .select()
              .single();
            
            if (updateError) {
              console.error("Error updating profile:", updateError);
              process.exit(1);
            }
            
            console.log("✅ Super admin set successfully!");
            console.log(`Profile ID: ${updated.id}`);
            console.log(`Role: ${updated.role}`);
            return;
          }
          
          console.log("✅ Super admin created and set successfully!");
          console.log(`Profile ID: ${newProfile.id}`);
          console.log(`Role: ${newProfile.role}`);
          return;
        }
      }
    } catch (e) {
      console.log("Could not list auth users:", e);
    }
    
    process.exit(1);
  }
  
  // Update the existing profile
  const { data: updated, error: updateError } = await supabase
    .from("profiles")
    .update({ 
      role: "super_admin",
      is_active: true,
      kyc_verified: true
    })
    .eq("id", profile.id)
    .select()
    .single();
  
  if (updateError) {
    console.error("Error updating profile:", updateError);
    process.exit(1);
  }
  
  console.log("✅ Super admin set successfully!");
  console.log(`Profile ID: ${updated.id}`);
  console.log(`Email: ${updated.email}`);
  console.log(`Name: ${updated.name}`);
  console.log(`Role: ${updated.role}`);
  console.log(`is_active: ${updated.is_active}`);
  console.log(`kyc_verified: ${updated.kyc_verified}`);
}

setSuperAdmin().catch(err => {
  console.error("Unhandled error:", err);
  process.exit(1);
});