/**
 * Fix #8 – Integration tests for /contributions routes
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

const mockContribution = { id: "con-1", profile_id: "member-1", amount: "5000", status: "successful", contribution_month: "2024-06", payment_method: "wallet", transaction_reference: "TXN-12345678", created_at: "2024-06-01T00:00:00Z" };

const db: any = { from: vi.fn().mockReturnThis(), select: vi.fn().mockReturnThis(), insert: vi.fn().mockReturnThis(), update: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), in: vi.fn().mockReturnThis(), gte: vi.fn().mockReturnThis(), lt: vi.fn().mockReturnThis(), order: vi.fn().mockReturnThis(), range: vi.fn().mockReturnThis(), single: vi.fn(), maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }) };

vi.mock("@workspace/db", () => ({ supabase: db }));

vi.mock("../middleware/auth", () => ({
  requireAuth: (_: any, __: any, next: any) => next(),
  requireRole: (..._: any[]) => (_: any, __: any, next: any) => next(),
}));

async function buildApp() {
  const { default: r } = await import("../routes/contributions");
  const app = express(); app.use(express.json()); app.use("/api", r); return app;
}

describe("POST /api/contributions – validation", () => {
  beforeEach(() => vi.clearAllMocks());
  it("rejects missing fields", async () => {
    const app = await buildApp();
    const res = await request(app).post("/api/contributions").send({ amount: 5000 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Validation failed");
  });
  it("creates a contribution with valid payload", async () => {
    db.from.mockReturnThis(); db.insert.mockReturnThis(); db.select.mockReturnThis(); db.update.mockReturnThis();
    db.maybeSingle.mockResolvedValue({ data: null, error: null });
    db.single.mockResolvedValueOnce({ data: mockContribution, error: null })
             .mockResolvedValueOnce({ data: { name: "Amaka Obi" }, error: null });
    const app = await buildApp();
    const res = await request(app).post("/api/contributions").send({ memberId: "m1", amount: 5000, month: "2024-06", paymentMethod: "wallet" });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("paid");
  });
});
