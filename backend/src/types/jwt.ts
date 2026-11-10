import type { JwtPayload } from "jsonwebtoken";

/** Access token claims (issued on login/refresh, short-lived). */
export interface AccessTokenClaims extends JwtPayload {
  sub: string; // admin id (as string)
  gid: number; // primary group/role id
  typ: "access";
}

/** Refresh token claims (jti is stored hashed for rotation/revocation). */
export interface RefreshTokenClaims extends JwtPayload {
  sub: string;
  jti: string; // unique token id
  fam: string; // token family id (reuse detection)
  typ: "refresh";
}
