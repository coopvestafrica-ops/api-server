import { Router, type IRouter } from "express";
import { supabase } from "../lib/supabase";

const router: IRouter = Router();

// ── Firebase Admin SDK (lazy-init) ──────────────────────────────────────────
let _firebaseApp: any = null;

function getFirebaseAdmin() {
  if (_firebaseApp !== null) return _firebaseApp;

  const hasEnvCreds =
    process.env.FIREBASE_PROJECT_ID &&
    process.env.FIREBASE_CLIENT_EMAIL &&
    process.env.FIREBASE_PRIVATE_KEY;

  const hasAppCreds = !!process.env.GOOGLE_APPLICATION_CREDENTIALS;

  if (!hasEnvCreds && !hasAppCreds) {
    _firebaseApp = false; // sentinel: not available
    return false;
  }

  try {
    // Dynamic import — firebase-admin is an optional dependency
    const admin = require("firebase-admin");

    if (admin.apps.length > 0) {
      _firebaseApp = admin.apps[0];
    } else {
      const credential = hasEnvCreds
        ? admin.credential.cert({
            projectId: process.env.FIREBASE_PROJECT_ID,
            clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
            privateKey: process.env.FIREBASE_PRIVATE_KEY!.replace(/\\n/g, "\n"),
          })
        : admin.credential.applicationDefault();

      _firebaseApp = admin.initializeApp({ credential });
    }
    return _firebaseApp;
  } catch {
    _firebaseApp = false;
    return false;
  }
}

/**
 * Send FCM push notifications to all active device tokens.
 * Returns the number of tokens targeted (0 if Firebase is not configured).
 */
async function dispatchPushNotifications(
  title: string,
  message: string,
  type: string,
): Promise<{ targeted: number; errors: number }> {
  const app = getFirebaseAdmin();
  if (!app) return { targeted: 0, errors: 0 };

  // Fetch active device tokens
  const { data: tokens, error } = await supabase
    .from("device_tokens")
    .select("token")
    .eq("active", true);

  if (error || !tokens || tokens.length === 0) return { targeted: 0, errors: 0 };

  const admin = require("firebase-admin");
  const messaging = admin.messaging(app);

  const fcmTokens = tokens.map((t: { token: string }) => t.token);

  // Multicast send (up to 500 tokens per batch)
  let targeted = 0;
  let errors = 0;

  for (let i = 0; i < fcmTokens.length; i += 500) {
    const batch = fcmTokens.slice(i, i + 500);
    try {
      const response = await messaging.sendEachForMulticast({
        tokens: batch,
        notification: { title, body: message },
        data: { type: type || "system" },
        android: {
          notification: {
            clickAction: "FLUTTER_NOTIFICATION_CLICK",
            channelId: "coopvest_notifications",
          },
        },
        apns: {
          payload: { aps: { alert: { title, body: message }, badge: 1, sound: "default" } },
        },
      });
      targeted += batch.length;
      errors += response.failureCount ?? 0;
    } catch {
      errors += batch.length;
    }
  }

  return { targeted, errors };
}

// ── GET /notifications ──────────────────────────────────────────────────────

router.get("/notifications", async (req, res): Promise<void> => {
  const page       = Math.max(1, Number(req.query.page) || 1);
  const limit      = Math.min(100, Number(req.query.limit) || 20);
  const offset     = (page - 1) * limit;
  const unreadOnly = req.query.unreadOnly === "true";

  let query = supabase.from("notifications").select("*", { count: "exact" });
  if (unreadOnly) query = query.eq("is_read", false);

  const { data: notifications, count, error } = await query
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) { res.status(500).json({ error: error.message }); return; }

  const { count: unreadCount } = await supabase
    .from("notifications").select("*", { count: "exact", head: true }).eq("is_read", false);

  res.json({
    data: (notifications ?? []).map((n: Record<string, unknown>) => ({
      id:             n.id,
      title:          n.title,
      message:        n.message,
      type:           n.category ?? n.type ?? "info",
      isRead:         n.is_read,
      targetAudience: null,
      createdAt:      n.created_at,
    })),
    total:       count       ?? 0,
    unreadCount: unreadCount ?? 0,
    page,
    limit,
  });
});

// ── POST /notifications ─────────────────────────────────────────────────────

router.post("/notifications", async (req, res): Promise<void> => {
  const { title, message, type, targetAudience, channels, audience } = req.body;
  if (!title || !message || !type) {
    res.status(400).json({ error: "title, message, type are required" }); return;
  }

  // Persist the notification in the DB (broadcast — no profile_id)
  const { data: notification, error } = await supabase.from("notifications").insert({
    title,
    message,
    type:     "system",
    category: type,
    is_read:  false,
    priority: "normal",
  }).select().single();

  if (error) { res.status(500).json({ error: error.message }); return; }

  const deliveredVia = (channels ?? ["push"]) as string[];
  const targetGroup  = audience ?? targetAudience ?? "all";

  // Dispatch push notifications to mobile devices if "push" channel selected
  let pushResult = { targeted: 0, errors: 0 };
  if (deliveredVia.includes("push")) {
    pushResult = await dispatchPushNotifications(title, message, type);
  }

  res.status(201).json({
    id:             notification.id,
    title:          notification.title,
    message:        notification.message,
    type:           notification.category ?? "info",
    isRead:         notification.is_read,
    targetAudience: targetGroup,
    channels:       deliveredVia,
    createdAt:      notification.created_at,
    status:         "sent",
    push:           pushResult,
  });
});

// ── POST /notifications/read-all ────────────────────────────────────────────

router.post("/notifications/read-all", async (_req, res): Promise<void> => {
  await supabase.from("notifications")
    .update({ is_read: true, read_at: new Date().toISOString() })
    .eq("is_read", false);
  res.json({ success: true });
});

// ── POST /notifications/:id/read ────────────────────────────────────────────

router.post("/notifications/:id/read", async (req, res): Promise<void> => {
  const id = req.params.id;
  const { data: updated, error } = await supabase.from("notifications")
    .update({ is_read: true, read_at: new Date().toISOString() })
    .eq("id", id).select().single();

  if (error || !updated) { res.status(404).json({ error: "Not found" }); return; }

  res.json({
    id:        updated.id,
    title:     updated.title,
    message:   updated.message,
    type:      updated.category ?? "info",
    isRead:    updated.is_read,
    createdAt: updated.created_at,
  });
});

export default router;
