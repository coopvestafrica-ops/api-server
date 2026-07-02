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
  const { default: r } = await import("../routes/wallets");
  const app = express();
  app.use(express.json());
  app.use("/api", r);
  return app;
}

describe("Wallets Route tests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("GET /api/wallets retrieves wallet list", async () => {
    const app = await buildApp();
    const res = await request(app).get("/api/wallets");
    expect(res.status).toBe(200);
    expect(res.body.wallets).toBeInstanceOf(Array);
    expect(res.body.total).toBeGreaterThan(0);
  });

  it("GET /api/wallets/stats retrieves financial summary stats", async () => {
    const app = await buildApp();
    const res = await request(app).get("/api/wallets/stats");
    expect(res.status).toBe(200);
    expect(res.body.totalBalance).toBeGreaterThan(0);
    expect(res.body.totalWallets).toBe(20);
  });

  it("PUT /api/wallets/:id/freeze freezes a wallet record", async () => {
    const app = await buildApp();
    const res = await request(app).put("/api/wallets/1/freeze");
    expect(res.status).toBe(200);
    expect(res.body.wallet.status).toBe("frozen");
    expect(res.body.message).toBe("Wallet frozen successfully");
  });

  it("PUT /api/wallets/:id/unfreeze unfreezes a wallet record", async () => {
    const app = await buildApp();
    const res = await request(app).put("/api/wallets/4/unfreeze");
    expect(res.status).toBe(200);
    expect(res.body.wallet.status).toBe("active");
    expect(res.body.message).toBe("Wallet unfrozen successfully");
  });
});
