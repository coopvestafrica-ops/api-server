import { z } from "zod";

export const HealthCheckResponse = z.object({
  status: z.string()
});

export const CreateMemberBody = z.object({
  firstName: z.string(),
  lastName: z.string(),
  email: z.string(),
  phone: z.string(),
  address: z.string().optional(),
  occupation: z.string().optional()
});

export const CreateLoanBody = z.object({
  memberId: z.string(),
  principalAmount: z.number(),
  interestRate: z.number(),
  termMonths: z.number(),
  purpose: z.string().optional()
});
