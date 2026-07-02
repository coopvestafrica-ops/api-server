import { Router, type Request, type Response } from "express";
import { supabase } from "../lib/supabase";
import { logger } from "../lib/logger";

const router = Router();

// Request password reset — called by mobile app
router.post("/api/auth/request-password-reset", async (req: Request, res: Response) => {
  try {
    const { email, type } = req.body;

    if (!email) {
      res.status(400).json({ error: "Email is required" });
      return;
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      res.status(400).json({ error: "Invalid email format" });
      return;
    }

    // Determine redirect URL based on client type
    // Mobile app: coopvest://reset-password
    // Web dashboard: https://admin-dashboard-api-server.vercel.app/reset-password
    const redirectTo = type === 'mobile' 
      ? "coopvest://reset-password"
      : `${process.env.DASHBOARD_URL || 'https://admin-dashboard-api-server.vercel.app'}/reset-password`;

    // Call Supabase to send the password reset email
    const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
      redirectTo,
    });

    if (error) {
      logger.error({ error: error.message, email }, "Password reset request failed");
      // Always return success to prevent email enumeration
      // Even if user doesn't exist, we return success
    }

    // Always return success to prevent email enumeration attacks
    res.json({
      success: true,
      message: "If an account exists with this email, a password reset link has been sent.",
    });
  } catch (error) {
    logger.error({ error }, "Password reset request error");
    // Still return success for security
    res.json({
      success: true,
      message: "If an account exists with this email, a password reset link has been sent.",
    });
  }
});

// Verify OTP for password reset — called by mobile app
router.post("/api/auth/verify-otp", async (req: Request, res: Response) => {
  try {
    const { token, email, newPassword } = req.body;

    if (!token) {
      res.status(400).json({ error: "Token is required" });
      return;
    }

    if (!email) {
      res.status(400).json({ error: "Email is required" });
      return;
    }

    // Verify OTP using Supabase
    const { data, error } = await supabase.auth.verifyOtp({
      email: email.trim(),
      token: token,
      type: "recovery",
    });

    if (error) {
      logger.error({ error: error.message }, "OTP verification failed");
      res.status(400).json({ error: "Invalid or expired code" });
      return;
    }

    // If new password provided, update it
    if (newPassword && data.user) {
      const { error: updateError } = await supabase.auth.updateUser({
        password: newPassword,
      });

      if (updateError) {
        logger.error({ error: updateError.message }, "Password update failed");
        res.status(400).json({ error: "Failed to update password" });
        return;
      }
    }

    res.json({
      success: true,
      message: "Password reset successful",
    });
  } catch (error) {
    logger.error({ error }, "OTP verification error");
    res.status(500).json({ error: "Verification failed" });
  }
});

export default router;