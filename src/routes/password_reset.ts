import { Router, type Request, type Response } from "express";
import { logger } from "../lib/logger";

const router = Router();

// In-memory store for password reset tokens (for demo purposes)
// In production, use a database
const resetTokens = new Map<string, { email: string; expires: number }>();

// Generate a random token
function generateToken(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let token = '';
  for (let i = 0; i < 32; i++) {
    token += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return token;
}

// Request password reset
router.post("/api/password-reset/request", async (req: Request, res: Response) => {
  try {
    const { email } = req.body;

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

    // Generate reset token
    const token = generateToken();
    const expires = Date.now() + 60 * 60 * 1000; // 1 hour

    // Store token
    resetTokens.set(token, { email, expires });

    // In production, you would send an email here using a service like:
    // - Resend (resend.com)
    // - SendGrid
    // - AWS SES
    // - Nodemailer with SMTP

    // For now, log the reset link (in development)
    logger.info({ email, resetLink: `https://admin-dashboard-api-server.vercel.app/reset-password?token=${token}` }, "Password reset requested");

    // In production, send actual email
    // await sendPasswordResetEmail(email, token);

    res.json({
      success: true,
      message: "If an account exists with this email, a password reset link has been sent.",
      // In development, include the token for testing
      ...(process.env.NODE_ENV === "development" && {
        devToken: token,
        devResetLink: `https://admin-dashboard-api-server.vercel.app/reset-password?token=${token}`
      })
    });
  } catch (error) {
    logger.error({ error }, "Password reset request failed");
    res.status(500).json({ error: "Failed to process password reset request" });
  }
});

// Verify reset token
router.post("/api/password-reset/verify", async (req: Request, res: Response) => {
  try {
    const { token } = req.body;

    if (!token) {
      res.status(400).json({ error: "Token is required" });
      return;
    }

    const tokenData = resetTokens.get(token);

    if (!tokenData) {
      res.status(400).json({ error: "Invalid or expired token" });
      return;
    }

    if (Date.now() > tokenData.expires) {
      resetTokens.delete(token);
      res.status(400).json({ error: "Token has expired" });
      return;
    }

    res.json({
      success: true,
      valid: true,
      email: tokenData.email
    });
  } catch (error) {
    logger.error({ error }, "Token verification failed");
    res.status(500).json({ error: "Failed to verify token" });
  }
});

// Reset password with token
router.post("/api/password-reset/reset", async (req: Request, res: Response) => {
  try {
    const { token, newPassword } = req.body;

    if (!token || !newPassword) {
      res.status(400).json({ error: "Token and new password are required" });
      return;
    }

    // Validate password strength
    if (newPassword.length < 8) {
      res.status(400).json({ error: "Password must be at least 8 characters" });
      return;
    }

    const tokenData = resetTokens.get(token);

    if (!tokenData) {
      res.status(400).json({ error: "Invalid or expired token" });
      return;
    }

    if (Date.now() > tokenData.expires) {
      resetTokens.delete(token);
      res.status(400).json({ error: "Token has expired" });
      return;
    }

    // In production, you would update the password in Supabase here
    // const { error } = await supabase.auth.admin.updateUserById(userId, { password: newPassword });

    // Delete the token after use
    resetTokens.delete(token);

    logger.info({ email: tokenData.email }, "Password reset completed");

    res.json({
      success: true,
      message: "Password has been reset successfully"
    });
  } catch (error) {
    logger.error({ error }, "Password reset failed");
    res.status(500).json({ error: "Failed to reset password" });
  }
});

export default router;