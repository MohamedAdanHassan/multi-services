import type { AuthPrincipal } from "./models";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Populated by the auth middleware after token verification. */
      auth?: AuthPrincipal;
    }
  }
}

export {};
