import { Router, type IRouter } from "express";
import { supabase } from "../lib/supabase";
import { z } from "zod";

const router: IRouter = Router();

const CreateInterestRateBody = z.object({
  name: z.string().min(1, "name is required"),
  baseRate: z.number().min(0, "baseRate must be non-negative"),
  minTenure: z.number().int().positive("minTenure must be a positive integer"),
  maxTenure: z.number().int().positive("maxTenure must be a positive integer"),
  minAmount: z.number().min(0).optional().default(0),
  maxAmount: z.number().min(0).optional().default(0),
});

const UpdateInterestRateBody = z.object({
  name: z.string().min(1).optional(),
  baseRate: z.number().min(0).optional(),
  minTenure: z.number().int().positive().optional(),
  maxTenure: z.number().int().positive().optional(),
  minAmount: z.number().min(0).optional(),
  maxAmount: z.number().min(0).optional(),
  isActive: z.boolean().optional(),
});

router.get("/interest-rates", async (req, res): Promise<void> => {
  const { data: settings } = await supabase
    .from("system_settings")
    .select("*")
    .eq("key", "interest_rates")
    .single();

  if (settings?.value) {
    try {
      const rates = JSON.parse(settings.value);
      if (Array.isArray(rates)) {
        // Transform to match frontend schema
        const transformed = rates.map((r: any, idx: number) => ({
          id: r.id ?? idx + 1,
          loanType: r.name?.toLowerCase().replace(/\s+/g, "_") ?? `loan_type_${idx}`,
          minAmount: r.minAmount ?? r.min_amount ?? 0,
          maxAmount: r.maxAmount ?? r.max_amount ?? 0,
          rate: r.baseRate ?? r.rate ?? r.interest_rate ?? 0,
          tenure: r.minTenure ?? r.tenure ?? 12,
          description: r.name ?? "",
          isActive: r.isActive ?? r.is_active ?? true,
          createdAt: new Date().toISOString(),
        }));
        res.json({ data: transformed });
        return;
      }
    } catch {
      // fall through to default
    }
  }

  // Return default rates matching frontend schema
  res.json({
    data: [
      { id: 1, loanType: "personal", minAmount: 10000, maxAmount: 500000, rate: 5.0, tenure: 12, description: "Quick Loan", isActive: true, createdAt: new Date().toISOString() },
      { id: 2, loanType: "business", minAmount: 50000, maxAmount: 2000000, rate: 8.0, tenure: 24, description: "Business Loan", isActive: true, createdAt: new Date().toISOString() },
      { id: 3, loanType: "emergency", minAmount: 5000, maxAmount: 200000, rate: 3.5, tenure: 6, description: "Emergency Loan", isActive: true, createdAt: new Date().toISOString() },
    ],
  });
});

router.post("/interest-rates", async (req, res): Promise<void> => {
  const parsed = CreateInterestRateBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation failed", details: parsed.error.flatten().fieldErrors });
    return;
  }

  const { name, baseRate, minTenure, maxTenure, minAmount, maxAmount } = parsed.data;

  const { data: settings } = await supabase.from("system_settings").select("value").eq("key", "interest_rates").single();
  let rates: unknown[] = [];
  if (settings?.value) {
    try { rates = JSON.parse(settings.value); } catch { /* empty */ }
  }

  const newRate = {
    id: crypto.randomUUID(),
    name,
    baseRate,
    minTenure,
    maxTenure,
    minAmount,
    maxAmount,
    isActive: true,
  };
  rates.push(newRate);

  await supabase.from("system_settings").upsert({
    key: "interest_rates",
    value: JSON.stringify(rates),
    description: "Loan interest rate configurations",
  });

  // Return in frontend schema format
  res.status(201).json({
    id: rates.length,
    loanType: name.toLowerCase().replace(/\s+/g, "_"),
    minAmount,
    maxAmount,
    rate: baseRate,
    tenure: minTenure,
    description: name,
    isActive: true,
    createdAt: new Date().toISOString(),
  });
});

router.put("/interest-rates/:id", async (req, res): Promise<void> => {
  const parsed = UpdateInterestRateBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation failed", details: parsed.error.flatten().fieldErrors });
    return;
  }

  const id = req.params.id;
  const updates = parsed.data;

  const { data: settings } = await supabase.from("system_settings").select("value").eq("key", "interest_rates").single();
  let rates: { id: string; [key: string]: unknown }[] = [];
  if (settings?.value) {
    try { rates = JSON.parse(settings.value); } catch { /* empty */ }
  }

  const idx = rates.findIndex(r => r.id === id);
  if (idx === -1) { res.status(404).json({ error: "Rate not found" }); return; }

  rates[idx] = { ...rates[idx], ...updates };

  await supabase.from("system_settings").upsert({
    key: "interest_rates",
    value: JSON.stringify(rates),
    description: "Loan interest rate configurations",
  });

  res.json(rates[idx]);
});

export default router;
