/**
 * Fix #8 – Integration tests for /members routes
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

const mockProfile = { id: "member-1", user_id: "CVA-000001", name: "Kemi Adeyemi", email: "kemi@test.com", phone: "08012345678", is_active: true, kyc_verified: false, is_flagged: false, created_at: "2024-01-01T00:00:00Z" };

const db: any = { from: vi.fn().mockReturnThis(), select: vi.fn().mockReturnThis(), insert: vi.fn().mockReturnThis(), update: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), in: vi.fn().mockReturnThis(), or: vi.fn().mockReturnThis(), gte: vi.fn().mockReturnThis(), order: vi.fn().mockReturnThis(), range: vi.fn().mockReturnThis(), single: vi.fn() };

vi.mock("@workspace/db", () => ({
  supabase: db,
  splitName: (n: string) => { const [f="",l=""] = (n ?? "").split(" "); return { firstName: f, lastName: l }; },
  deriveStatus: (p: any) => { if (p.is_flagged) return "suspended"; if (!p.is_active) return "inactive"; if (!p.kyc_verified) return "pending"; return "active"; },
}));

vi.mock("@workspace/api-zod", () => ({
  CreateMemberBody: {
    safeParse: (b: any) => {
      if (!b.firstName || !b.lastName || !b.email || !b.phone)
        return { success: false, error: { flatten: () => ({ fieldErrors: { firstName: ["Required"] } }) } };
      return { success: true, data: b };
    },
  },
}));

vi.mock("../middleware/auth", () => ({
  requireAuth: (_: any, __: any, next: any) => next(),
  requireRole: (..._: any[]) => (_: any, __: any, next: any) => next(),
}));

async function buildApp() {
  const { default: r } = await import("../routes/members");
  const app = express(); app.use(express.json()); app.use("/api", r); return app;
}

describe("POST /api/members – validation", () => {
  beforeEach(() => vi.clearAllMocks());
  it("rejects missing required fields", async () => {
    const app = await buildApp();
    const res = await request(app).post("/api/members").send({ firstName: "Kemi" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Validation failed");
  });
  it("creates member with valid payload", async () => {
    db.from.mockReturnThis(); db.insert.mockReturnThis(); db.select.mockReturnThis();
    db.single.mockResolvedValue({ data: mockProfile, error: null });
    const app = await buildApp();
    const res = await request(app).post("/api/members").send({ firstName: "Kemi", lastName: "Adeyemi", email: "kemi@test.com", phone: "08012345678" });
    expect(res.status).toBe(201);
    expect(res.body.email).toBe("kemi@test.com");
  });
});

describe("GET /api/members/:id", () => {
  beforeEach(() => vi.clearAllMocks());
  it("returns 404 for unknown member", async () => {
    db.from.mockReturnThis(); db.select.mockReturnThis(); db.eq.mockReturnThis();
    db.single.mockResolvedValue({ data: null, error: { message: "Not found" } });
    const app = await buildApp();
    const res = await request(app).get("/api/members/nonexistent");
    expect(res.status).toBe(404);
  });
});
