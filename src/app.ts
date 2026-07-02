import express, { type Express } from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";

// CORS configuration
const allowedOrigin = process.env.ALLOWED_ORIGIN || "*";

const app: Express = express();

// Security headers
app.use(helmet());

// CORS — use allowed origin
app.use(
  cors({
    origin: allowedOrigin,
    credentials: true,
  }),
);

// Rate limiting — 200 requests per 15 minutes per IP
app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 200,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests, please try again later." },
  }),
);

// Request logging (redacts auth headers)
app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return { id: req.id, method: req.method, url: req.url?.split("?")[0] };
      },
      res(res) {
        return { statusCode: res.statusCode };
      },
    },
  }),
);

app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ limit: "100kb", extended: true }));
app.use("/api", router);

// Global Express error handler
app.use((err: any, req: any, res: any, next: any) => {
  logger.error({ err }, "Unhandled error");
  res.status(500).json({ error: "Internal server error" });
});

// Catch-all 404 handler
app.use((req, res) => {
  logger.info({ path: req.path }, "Unhandled route");
  res.status(404).json({ success: false, error: "Endpoint not found", path: req.path });
});

export default app;
