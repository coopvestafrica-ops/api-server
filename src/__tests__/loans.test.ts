/**
 * Fix #8 – Integration tests for /loans routes
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

const mockLoan = {
  id: "loan-1", loan_id: "LN-0000001", profile_id: "member-1",
  amount: "50000", remaining_balance: "50000", effective_interest_rate: "5",
  tenure_months: 12, status: "pending", purpose: "Business expansion",
  approved_at: null, next_due_date: null, monthly_repayment: "4281",
  rejected_reason: null, created_at: "2024-01-01T00:00:00Z", profiles: { name: "Tunde Bello" },
};

const db: any = {
  from: vi.fn().mockReturnThis(), select: vi.fn().mockReturnThis(),
  insert: vi.fn().mockReturnThis(), update: vi.fn().mockReturnThis(),
  eq: vi.fn().mockReturnThis(), in: vi.fn().mockReturnThis(),
  order: vi.fn().mockReturnThis(), range: vi.fn().mockReturnThis(),
  single: vi.fn(),
};

vi.mock("@workspace/db", () => ({
  supabase: db,
  splitName: (name: string) => { const [f="",l=""] = (name ?? "").split(" "); return { firstName: f, lastName: l }; },
}));

vi.mock("@workspace/api-zod", () => ({
  CreateLoanBody: {
    safeParse: (b: any) => {
      if (!b.memberId || !b.amount || !b.tenure || !b.purpose)
        return { success: false, error: { flatten: () => ({ fieldErrors: { memberId: ["Required"] } }) } };
      return { success: true, data: b };
    },
  },
}));

vi.mock("../middleware/auth", () => ({
  requireAuth: (_: any, __: any, next: any) => next(),
  requireRole: (..._: any[]) => (_: any, __: any, next: any) => next(),
}));

async function buildApp() {
  const { default: r } = await import("../routes/loans");
  const app = express(); app.use(express.json()); app.use("/api", r); return app;
}

describe("GET /api/loans", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.from.mockReturnThis(); db.select.mockReturnThis();
    db.eq.mockReturnThis(); db.order.mockReturnThis();
    db.range.mockResolvedValue({ data: [mockLoan], count: 1, error: null });
  });
  it("returns paginated loans", async () => {
    const app = await buildApp();
    const res = await request(app).get("/api/loans");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });
});

describe("POST /api/loans – validation", () => {
  beforeEach(() => vi.clearAllMocks());
  it("rejects missing fields", async () => {
    const app = await buildApp();
    const res = await request(app).post("/api/loans").send({ amount: 50000 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Validation failed");
  });
  it("creates a loan with valid payload", async () => {
    db.from.mockReturnThis(); db.insert.mockReturnThis(); db.select.mockReturnThis();
    db.single.mockResolvedValueOnce({ data: mockLoan, error: null })
             .mockResolvedValueOnce({ data: { name: "Tunde Bello" }, error: null });
    const app = await buildApp();
    const res = await request(app).post("/api/loans").send({ memberId: "m1", amount: 50000, tenure: 12, purpose: "Biz" });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("pending");
  });
});

describe("POST /api/loans/:id/approve", () => {
  it("approves a loan", async () => {
    db.from.mockReturnThis(); db.update.mockReturnThis(); db.eq.mockReturnThis(); db.select.mockReturnThis();
    db.single.mockResolvedValueOnce({ data: { ...mockLoan, status: "active" }, error: null })
             .mockResolvedValueOnce({ data: { name: "Tunde" }, error: null });
    const app = await buildApp();
    const res = await request(app).post("/api/loans/loan-1/approve");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("active");
  });
});

describe("POST /api/loans/:id/reject", () => {
  it("rejects with reason", async () => {
    db.from.mockReturnThis(); db.update.mockReturnThis(); db.eq.mockReturnThis(); db.select.mockReturnThis();
    db.single.mockResolvedValueOnce({ data: { ...mockLoan, status: "rejected", rejected_reason: "Low income" }, error: null })
             .mockResolvedValueOnce({ data: { name: "Tunde" }, error: null });
    const app = await buildApp();
    const res = await request(app).post("/api/loans/loan-1/reject").send({ reason: "Low income" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("rejected");
  });
  it("returns 400 when reason missing", async () => {
    const app = await buildApp();
    const res = await request(app).post("/api/loans/loan-1/reject").send({});
    expect(res.status).toBe(400);
  });
});
