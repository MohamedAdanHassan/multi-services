import jwt from "jsonwebtoken";
import crypto from "node:crypto";
import { env } from "../../../config/env";
import { sha256, randomToken } from "../../../utils/crypto";
import type { AccessTokenClaims, RefreshTokenClaims } from "../../../types/jwt";

const jwtOptions = {
  issuer: env.jwt.issuer,
  audience: env.jwt.audience,
} as const;

export function signAccessToken(adminId: number, groupId: number): string {
  const claims: Omit<AccessTokenClaims, "iat" | "exp"> = {
    sub: String(adminId),
    gid: groupId,
    typ: "access",
  };
  return jwt.sign(claims, env.jwt.accessSecret, {
    ...jwtOptions,
    expiresIn: env.jwt.accessTtlSeconds,
  });
}

export interface IssuedRefreshToken {
  token: string;
  jti: string;
  familyId: string;
  expiresAt: Date;
  tokenHash: string;
}

export function signRefreshToken(adminId: number, familyId?: string): IssuedRefreshToken {
  const jti = crypto.randomUUID();
  const fam = familyId ?? crypto.randomUUID();
  const expiresAt = new Date(Date.now() + env.jwt.refreshTtlSeconds * 1000);
  const claims: Omit<RefreshTokenClaims, "iat" | "exp"> = {
    sub: String(adminId),
    jti,
    fam,
    typ: "refresh",
  };
  const token = jwt.sign(claims, env.jwt.refreshSecret, {
    ...jwtOptions,
    expiresIn: env.jwt.refreshTtlSeconds,
  });
  return { token, jti, familyId: fam, expiresAt, tokenHash: sha256(token) };
}

export function verifyAccessToken(token: string): AccessTokenClaims {
  return jwt.verify(token, env.jwt.accessSecret, jwtOptions) as AccessTokenClaims;
}

export function verifyRefreshToken(token: string): RefreshTokenClaims {
  return jwt.verify(token, env.jwt.refreshSecret, jwtOptions) as RefreshTokenClaims;
}

/** Password-reset token: `"<adminId>.<secret>"`; only the SHA-256 is stored. */
export interface IssuedResetToken {
  raw: string;
  tokenHash: string;
  adminId: number;
  expiresAt: Date;
}

export function createResetToken(adminId: number): IssuedResetToken {
  const secret = randomToken(32);
  const raw = `${adminId}.${secret}`;
  return {
    raw,
    tokenHash: sha256(raw),
    adminId,
    expiresAt: new Date(Date.now() + env.password.resetTtlMinutes * 60_000),
  };
}

export function parseResetToken(raw: string): { adminId: number; ok: boolean } {
  const dot = raw.indexOf(".");
  if (dot <= 0) return { adminId: 0, ok: false };
  const adminId = Number(raw.slice(0, dot));
  if (!Number.isInteger(adminId) || adminId <= 0) return { adminId: 0, ok: false };
  return { adminId, ok: raw.length > dot + 8 };
}
