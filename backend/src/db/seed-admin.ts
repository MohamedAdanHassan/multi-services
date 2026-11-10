import * as admins from "../modules/auth/models/administrators";
import * as pwd from "../modules/auth/services/passwordService";
import { closePool } from "./mysql";

/**
 * Ensure a known Super Administrator exists so the auth flow is testable.
 * Idempotent: creates the account if missing, or resets its password if present.
 * Override via env: SEED_EMAIL / SEED_PASSWORD.
 */
const EMAIL = (process.env.SEED_EMAIL ?? "admin.test@ondemand.local").toLowerCase();
const PASSWORD = process.env.SEED_PASSWORD ?? "TestPass123!";
const SUPER_GROUP = 1;

async function seed() {
  const hash = await pwd.hashPassword(PASSWORD);
  const existing = await admins.findByEmail(EMAIL);
  if (existing) {
    await admins.updatePasswordHash(existing.iAdminId, hash);
    console.log(`updated admin #${existing.iAdminId} <${EMAIL}> password`);
    return { id: existing.iAdminId, created: false };
  }
  const id = await admins.create({
    firstName: "Test",
    lastName: "SuperAdmin",
    email: EMAIL,
    contactNo: "",
    code: "TEST",
    groupId: SUPER_GROUP,
    passwordHash: hash,
  });
  console.log(`created super admin #${id} <${EMAIL}>`);
  return { id, created: true };
}

if (require.main === module) {
  seed()
    .then((r) => console.log(JSON.stringify({ ...r, email: EMAIL, password: PASSWORD })))
    .catch((e) => {
      console.error(e);
      process.exitCode = 1;
    })
    .finally(() => closePool());
}

export { seed };
