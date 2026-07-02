import { Router, type IRouter } from "express";
import { readData, writeData } from "../lib/store";
import { supabase } from "../lib/supabase";

const router: IRouter = Router();

const defaultFeatures = [
  { id: "loan_requests",       name: "Loan Requests",         description: "Allow users to submit new loan applications",            enabled: true,  updatedAt: new Date().toISOString(), updatedBy: "Super Admin" },
  { id: "registration",        name: "Registration",          description: "Allow new users to register on the platform",            enabled: true,  updatedAt: new Date().toISOString(), updatedBy: "Super Admin" },
  { id: "salary_deduction",    name: "Salary Deduction",      description: "Enable salary deduction as a repayment method",          enabled: true,  updatedAt: new Date().toISOString(), updatedBy: "Super Admin" },
  { id: "direct_contribution", name: "Direct Contribution",   description: "Allow direct cash contributions to savings pool",        enabled: true,  updatedAt: new Date().toISOString(), updatedBy: "Super Admin" },
  { id: "wallet_transfers",    name: "Wallet Transfers",      description: "Enable peer-to-peer wallet transfers",                   enabled: false, updatedAt: new Date().toISOString(), updatedBy: "Super Admin" },
  { id: "investment_pool",     name: "Investment Pool",       description: "Allow members to invest in the cooperative pool",        enabled: true,  updatedAt: new Date().toISOString(), updatedBy: "Super Admin" },
  { id: "guarantor_system",    name: "Guarantor System",      description: "Require a guarantor for loan applications",              enabled: true,  updatedAt: new Date().toISOString(), updatedBy: "Super Admin" },
  { id: "referral_program",    name: "Referral Program",      description: "Enable member referral bonuses",                        enabled: true,  updatedAt: new Date().toISOString(), updatedBy: "Super Admin" },
  { id: "push_notifications",  name: "Push Notifications",    description: "Send push notifications to mobile devices",              enabled: true,  updatedAt: new Date().toISOString(), updatedBy: "Super Admin" },
];

const defaultSlides = [
  { id: "1", title: "Welcome to Coopvest",     description: "Your partner in secure cooperative investments and community growth", image: "welcome.png", order: 1 },
  { id: "2", title: "Save with Purpose",       description: "Earn high-yield returns on your monthly contributions with absolute peace of mind", image: "save.png", order: 2 },
  { id: "3", title: "Empower Your Business",   description: "Access collateral-free loans at low interest rates through our community vetting", image: "loans.png", order: 3 },
];

const defaultContentSections = [
  { key: "homepage_message", label: "Homepage Welcome Message",   value: "Welcome back! Your savings are growing. Keep contributing towards your goals." },
  { key: "terms",            label: "Terms & Conditions",          value: "By using Coopvest Africa, you agree to our terms of service and cooperative bylaws." },
  { key: "privacy_policy",   label: "Privacy Policy",             value: "Coopvest Africa is committed to protecting your personal data. We collect only what is necessary to provide our services." },
  { key: "about",            label: "About Us",                   value: "Coopvest Africa is a cooperative investment and savings platform dedicated to empowering individuals and organizations through collective financial growth." },
];

// Features List — backed by the real `mobile_features` table, merged with the
// known feature catalog so newly added catalog entries always appear.
router.get("/mobile-features", async (_req, res) => {
  const { data: rows } = await supabase
    .from("mobile_features")
    .select("key, label, enabled, updated_at");
  const overrides: Record<string, { enabled: boolean; updated_at: string | null; label: string | null }> = {};
  for (const r of rows ?? []) overrides[r.key] = { enabled: r.enabled, updated_at: r.updated_at, label: r.label };
  const features = defaultFeatures.map((f) => {
    const o = overrides[f.id];
    return {
      ...f,
      name: o?.label || f.name,
      enabled: o ? !!o.enabled : f.enabled,
      lastUpdated: o?.updated_at || f.updatedAt,
      updatedAt: o?.updated_at || f.updatedAt,
      updatedBy: f.updatedBy,
    };
  });
  res.json({ features });
});

router.put("/mobile-features/:id", async (req, res) => {
  const catalog = defaultFeatures.find((f) => f.id === req.params.id);
  if (!catalog) { res.status(404).json({ error: "Feature not found" }); return; }
  const enabled = req.body?.enabled !== undefined ? !!req.body.enabled : catalog.enabled;
  const now = new Date().toISOString();
  const { error } = await supabase
    .from("mobile_features")
    .upsert({ key: req.params.id, label: req.body?.name || catalog.name, enabled, updated_at: now }, { onConflict: "key" });
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json({
    feature: { ...catalog, enabled, lastUpdated: now, updatedAt: now },
    message: "Feature updated successfully",
  });
});

// Slides/Onboarding Content
router.get("/mobile-content/onboarding", async (_req, res) => {
  const slides = await readData("mobile_slides.json", defaultSlides);
  res.json({ slides });
});

router.post("/mobile-content/onboarding", async (req, res) => {
  const slides = await readData("mobile_slides.json", defaultSlides);
  const newSlide = { id: String(Date.now()), ...req.body, order: slides.length + 1 };
  slides.push(newSlide);
  await writeData("mobile_slides.json", slides);
  res.status(201).json({ slide: newSlide });
});

router.put("/mobile-content/onboarding/:id", async (req, res) => {
  const slides = await readData("mobile_slides.json", defaultSlides);
  const i = slides.findIndex((s) => s.id === req.params.id);
  if (i === -1) { res.status(404).json({ error: "Not found" }); return; }
  slides[i] = { ...slides[i], ...req.body };
  await writeData("mobile_slides.json", slides);
  res.json({ slide: slides[i] });
});

router.delete("/mobile-content/onboarding/:id", async (req, res) => {
  let slides = await readData("mobile_slides.json", defaultSlides);
  slides = slides.filter((s) => s.id !== req.params.id);
  await writeData("mobile_slides.json", slides);
  res.json({ success: true });
});

// Text Content
router.get("/mobile-content/text", async (_req, res) => {
  const contentSections = await readData("mobile_text.json", defaultContentSections);
  res.json({ sections: contentSections });
});

router.put("/mobile-content/text/:key", async (req, res) => {
  const contentSections = await readData("mobile_text.json", defaultContentSections);
  const i = contentSections.findIndex((s) => s.key === req.params.key);
  if (i === -1) { res.status(404).json({ error: "Section not found" }); return; }
  contentSections[i] = { ...contentSections[i], value: req.body.value };
  await writeData("mobile_text.json", contentSections);
  res.json({ section: contentSections[i], message: "Content updated successfully" });
});

export default router;
