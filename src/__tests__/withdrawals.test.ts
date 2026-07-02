import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

// Mock store helper so we don't read/write actual files during testing
vi.mock("../lib/store", () => ({
  readData: vi.fn().mockImplementation((_, fallback) => Promise.resolve(fallback)),
  writeData: vi.fn().mockImplementation(() => Promise.resolve()),
}));

vi.mock("../middleware/auth", () => ({
  requireAuth: (_: any, __: any, next: any) => next(),
  requireRole: (..._: any[]) => (_: any, __: any, next: any) => next(),
}));

async function buildApp() {
  const { default: r } = await import("../routes/withdrawals");
  const app = reportApp();
  app.use(express.json());
  app.use("/api", r);
  return app;
}

function reportApp() {
  return express();
}

describe("Withdrawals Route tests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("GET /api/withdrawals retrieves list of withdrawals", async () => {
    const app = await buildApp();
    const res = await request(app).get("/api/withdrawals");
    expect(res.status).toBe(200);
    expect(res.body.withdrawals).toBeInstanceOf(Array);
    expect(res.body.total).toBe(5);
  });

  it("PUT /api/withdrawals/:id/approve approves a request", async () => {
    const app = await buildApp();
    const res = await request(app).put("/api/withdrawals/1/approve");
    expect(res.status).toBe(200);
    expect(res.body.withdrawal.status).toBe("approved");
    expect(res.body.message).toBe("Withdrawal approved");
  });

  it("PUT /api/withdrawals/:id/reject rejects a request", async () => {
    const app = await buildApp();
    const res = await request(app).put("/api/withdrawals/2/reject");
    expect(res.status).toBe(200);
    expect(res.body.withdrawal.status).toBe("rejected");
    expect(res.body.message).toBe("Withdrawal rejected");
  });

  it("PUT /api/withdrawals/:id/hold holds a request", async () => {
    const app = await buildApp();
    const res = await request(app).put("/api/withdrawals/3/hold");
    expect(res.status).toBe(200);
    expect(res.body.withdrawal.status).toBe("on_hold");
    expect(res.body.message).toBe("Withdrawal placed on hold");
  });

  it("GET /api/withdrawals/settings retrieves settings", async () => {
    const app = await buildApp();
    const res = await request(app).get("/api/withdrawals/settings");
    expect(res.status).toBe(200);
    expect(res.body.settings.dailyLimit).toBe(1000000);
  });
});
