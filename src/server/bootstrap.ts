import { hashPassword } from "./auth";
import { UNIQUE_VIOLATION, pgErrorCode, type Db, type Queryer } from "./db";

// The one clinic and its first administrator are made here, by hand, from the command line
// (npm run clinic:create). Nothing reachable from the internet can make a clinic or an administrator: the
// public sign-up that used to do it is gone. Further staff are added by the administrator, signed in.

/** Monday to Friday, 09:00 to 17:00: a sensible start a clinic then edits. */
export async function insertDefaultHours(q: Queryer, userId: number) {
  for (let weekday = 1; weekday <= 5; weekday++) {
    await q.query("INSERT INTO working_hours (user_id, weekday, start_minute, end_minute) VALUES ($1, $2, $3, $4)", [userId, weekday, 9 * 60, 17 * 60]);
  }
}

const DEFAULT_SERVICES: Array<[string, number]> = [
  ["Kontroll", 30],
  ["Mbushje", 45],
  ["Pastrim i gurëzave", 45],
  ["Nxjerrje dhëmbi", 30],
];

export interface FirstSetup {
  clinicName: string;
  adminName: string;
  adminEmail: string;
  password: string;
  /** The administrator also treats patients (the usual case in a small clinic). */
  isDentist: boolean;
}

/** Why a first set-up was refused. Nothing was changed. */
export class BootstrapError extends Error {}

/** What a person typed, checked the way the application checks it everywhere else. */
export function checkFirstSetup(input: FirstSetup): FirstSetup {
  const clinicName = input.clinicName.trim();
  const adminName = input.adminName.trim();
  const adminEmail = input.adminEmail.trim().toLowerCase();
  if (clinicName.length < 2 || clinicName.length > 120) throw new BootstrapError("The clinic's name must have 2 to 120 characters.");
  if (adminName.length < 2 || adminName.length > 120) throw new BootstrapError("The administrator's name must have 2 to 120 characters.");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adminEmail) || adminEmail.length > 200) throw new BootstrapError("That is not an email address.");
  if (input.password.length < 8 || input.password.length > 200) throw new BootstrapError("The password must have at least 8 characters.");
  return { clinicName, adminName, adminEmail, password: input.password, isDentist: input.isDentist };
}

/**
 * Sets a new password for one member of staff, by hand, from the command line: the way back in for an
 * administrator who cannot be sent a link (no mail server, or a mailbox that is gone). Signs that person out
 * everywhere and ends any link for a new password that was still open. Changes nobody else.
 */
export async function setPasswordByHand(db: Db, email: string, password: string): Promise<{ fullName: string }> {
  const address = email.trim().toLowerCase();
  if (password.length < 8 || password.length > 200) throw new BootstrapError("The password must have at least 8 characters.");
  const passwordHash = await hashPassword(password);
  return db.tx(async (q) => {
    const user = (await q.query<{ id: number; clinic_id: number; full_name: string }>("SELECT id, clinic_id, full_name FROM users WHERE email = $1", [address]))[0];
    if (!user) throw new BootstrapError("No member of staff has that email address. Nothing was changed.");
    await q.query("UPDATE users SET password_hash = $2 WHERE id = $1", [user.id, passwordHash]);
    await q.query("DELETE FROM sessions WHERE user_id = $1", [user.id]);
    await q.query("UPDATE password_resets SET used_at = now() WHERE user_id = $1 AND used_at IS NULL", [user.id]);
    await q.query("INSERT INTO audit_log (clinic_id, user_id, action, entity, entity_id, meta) VALUES ($1, NULL, 'password_set_from_command_line', 'user', $2, NULL)", [user.clinic_id, user.id]);
    return { fullName: user.full_name };
  });
}

/**
 * Creates the clinic, its first administrator, their working hours and the starting list of services, in one
 * transaction. Refuses when a clinic already exists: it never makes a second one and never touches an
 * existing administrator or their password. (The database refuses a second clinic too: migration 006.)
 */
export async function createClinic(db: Db, input: FirstSetup): Promise<{ clinicId: number; adminId: number }> {
  const setup = checkFirstSetup(input);
  const passwordHash = await hashPassword(setup.password);
  try {
    return await db.tx(async (q) => {
      if ((await q.query("SELECT 1 FROM clinics LIMIT 1")).length) {
        throw new BootstrapError("This database already has its clinic. Nothing was changed. Staff are added by the administrator, in the application.");
      }
      const clinicId = (await q.query<{ id: number }>("INSERT INTO clinics (name) VALUES ($1) RETURNING id", [setup.clinicName]))[0]!.id;
      const adminId = (
        await q.query<{ id: number }>(
          "INSERT INTO users (clinic_id, role, full_name, email, password_hash, is_bookable) VALUES ($1, 'admin', $2, $3, $4, $5) RETURNING id",
          [clinicId, setup.adminName, setup.adminEmail, passwordHash, setup.isDentist],
        )
      )[0]!.id;
      if (setup.isDentist) await insertDefaultHours(q, adminId);
      for (const [serviceName, minutes] of DEFAULT_SERVICES) {
        await q.query("INSERT INTO services (clinic_id, name, duration_minutes) VALUES ($1, $2, $3)", [clinicId, serviceName, minutes]);
      }
      return { clinicId, adminId };
    });
  } catch (err) {
    // Two set-ups at the same moment: the database let one through.
    if (pgErrorCode(err) === UNIQUE_VIOLATION) throw new BootstrapError("This database already has its clinic. Nothing was changed.");
    throw err;
  }
}
