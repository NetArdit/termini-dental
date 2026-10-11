import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import type { Db } from "./db";
import { HttpError } from "./errors";

export const SESSION_COOKIE = "td_session";
const SESSION_DAYS = 14;

export interface SessionUser {
  id: number;
  clinicId: number;
  role: "admin" | "dentist";
  fullName: string;
  email: string;
  isBookable: boolean;
}

declare module "express-serve-static-core" {
  interface Request {
    user?: SessionUser;
  }
}

function scryptAsync(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(password, salt, 64, (err, key) => (err ? reject(err) : resolve(key))));
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  return `${salt.toString("hex")}:${(await scryptAsync(password, salt)).toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = await scryptAsync(password, Buffer.from(saltHex, "hex"));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** A long random token for cookies and private links. Only its hash is ever stored. */
export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function createSession(db: Db, userId: number, now: Date): Promise<{ token: string; expires: Date }> {
  const token = newToken();
  const expires = new Date(now.getTime() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  await db.query("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)", [hashToken(token), userId, expires]);
  return { token, expires };
}

export function setSessionCookie(res: Response, token: string, expires: Date) {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    expires,
    path: "/",
  });
}

/** Attaches req.user when the request carries a valid, unexpired session of an active user. */
export function attachUser(db: Db, now: () => Date) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const token = (req.cookies as Record<string, string> | undefined)?.[SESSION_COOKIE];
    if (token) {
      const rows = await db.query<{ id: number; clinic_id: number; role: "admin" | "dentist"; full_name: string; email: string; is_bookable: boolean }>(
        `SELECT u.id, u.clinic_id, u.role, u.full_name, u.email, u.is_bookable
           FROM sessions s JOIN users u ON u.id = s.user_id
          WHERE s.token_hash = $1 AND s.expires_at > $2 AND u.is_active`,
        [hashToken(token), now()],
      );
      const u = rows[0];
      if (u) req.user = { id: u.id, clinicId: u.clinic_id, role: u.role, fullName: u.full_name, email: u.email, isBookable: u.is_bookable };
    }
    next();
  };
}

export function requireUser(req: Request): SessionUser {
  if (!req.user) throw new HttpError(401, "Duhet të kyçeni.");
  return req.user;
}

export function requireAdmin(req: Request): SessionUser {
  const user = requireUser(req);
  if (user.role !== "admin") throw new HttpError(403, "Vetëm administratori i klinikës e ka këtë të drejtë.");
  return user;
}
