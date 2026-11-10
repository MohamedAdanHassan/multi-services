import { Router } from "express";
import { z } from "zod";
import * as ctrl from "../modules/auth/controllers/auth.controller";
import { asyncHandler } from "../utils/asyncHandler";
import { validate, fields } from "../middleware/validate";
import { authLimiter } from "../middleware/rateLimit";
import { requireAuth } from "../middleware/auth";

const loginSchema = z.object({
  email: fields.email,
  password: z.string().min(1, "Password is required"),
});

const forgotSchema = z.object({ email: fields.email });

const resetSchema = z.object({
  token: z.string().min(10, "Invalid reset token"),
  newPassword: fields.password,
});

export const authRouter = Router();

authRouter.post(
  "/login",
  authLimiter,
  validate({ body: loginSchema }),
  asyncHandler(ctrl.login),
);

authRouter.post("/refresh", authLimiter, asyncHandler(ctrl.refresh));

authRouter.post("/logout", asyncHandler(ctrl.logout));

authRouter.get("/me", requireAuth(), asyncHandler(ctrl.me));

authRouter.post(
  "/forgot-password",
  authLimiter,
  validate({ body: forgotSchema }),
  asyncHandler(ctrl.forgotPassword),
);

authRouter.post(
  "/reset-password",
  authLimiter,
  validate({ body: resetSchema }),
  asyncHandler(ctrl.resetPassword),
);
