import { Router, type IRouter } from "express";
import { requireAuth } from "../middleware/auth";
import healthRouter from "./health";
import setupRouter from "./setup";
import authRouter from "./auth";
import passwordResetRouter from "./password_reset";
import dashboardRouter from "./dashboard";
import membersRouter from "./members";
import loansRouter from "./loans";
import contributionsRouter from "./contributions";
import investmentsRouter from "./investments";
import complianceRouter from "./compliance";
import notificationsRouter from "./notifications";
import auditLogsRouter from "./audit_logs";
import supportRouter from "./support";
import riskScoringRouter from "./risk_scoring";
import interestRatesRouter from "./interest_rates";
import rolloversRouter from "./rollovers";
import payrollRouter from "./payroll";
// New command-center routes
import mobileFeaturesRouter from "./mobile_features";
import rolesRouter from "./roles";
import fraudDetectionRouter from "./fraud_detection";
import organizationsRouter from "./organizations";
import analyticsRouter from "./analytics";
import securityRouter from "./security";
import walletsRouter from "./wallets";
import withdrawalsRouter from "./withdrawals";
import verificationRouter from "./verification";
import referralsRouter from "./referrals";
import guarantorsRouter from "./guarantors";
// New feature routes
import systemRouter from "./system";
import reportsRouter from "./reports";
import sessionsRouter from "./sessions";
import bulkRouter from "./bulk";
import reconciliationRouter from "./reconciliation";
import loginHistoryRouter from "./login_history";
import excelUploadsRouter from "./excel-uploads";
import depositsRouter from "./deposits";

const router: IRouter = Router();

// Public — no auth required
router.use(healthRouter);

// Auth routes — public endpoints for mobile app
router.use(authRouter);

// Password reset — public endpoint
router.use(passwordResetRouter);

// Setup endpoint — no auth required (but requires setup key)
router.use(setupRouter);

// Protected — all routes below require a valid Supabase JWT
router.use(requireAuth);
router.use(dashboardRouter);
router.use(membersRouter);
router.use(loansRouter);
router.use(contributionsRouter);
router.use(investmentsRouter);
router.use(complianceRouter);
router.use(notificationsRouter);
router.use(auditLogsRouter);
router.use(supportRouter);
router.use(riskScoringRouter);
router.use(interestRatesRouter);
router.use(rolloversRouter);
router.use(payrollRouter);
// New command-center modules
router.use(mobileFeaturesRouter);
router.use(rolesRouter);
router.use(fraudDetectionRouter);
router.use(organizationsRouter);
router.use(analyticsRouter);
router.use(securityRouter);
router.use(walletsRouter);
router.use(withdrawalsRouter);
router.use(verificationRouter);
router.use(referralsRouter);
router.use(guarantorsRouter);
// New feature routes
router.use(systemRouter);
router.use(reportsRouter);
router.use(sessionsRouter);
router.use(bulkRouter);
router.use(reconciliationRouter);
router.use(loginHistoryRouter);
router.use(excelUploadsRouter);
router.use(depositsRouter);

export default router;
