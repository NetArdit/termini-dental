import type { Request } from "express";
import type { Db, Queryer } from "./db";
import { HttpError } from "./errors";
import type { RateLimiter } from "./limits";
import type { Logger } from "./log";
import type { Mailer } from "./mail";

/** Everything a route needs from outside. The clock is injected so tests can pin "now". */
export interface Ctx {
  db: Db;
  now: () => Date;
  mailer: Mailer | null;
  /** Public address of the site, for links in emails. No trailing slash. */
  publicUrl: string;
  /** Where log lines go. Default: nowhere (tests); the server passes a real one. */
  log?: Logger;
  /** Behind a hosting proxy the visitor's address is in X-Forwarded-For; believed only when this is set. */
  trustProxy?: boolean;
  /** Folder holding the built web app. Default: dist/web of this repository. */
  webDir?: string;
  /** Online bookings allowed per client address per hour. Default 6. */
  maxBookingsPerHour?: number;
  /**
   * Counts failed logins and online bookings. Default: in this process's memory, which is right only for
   * one long-running server; anything that runs as several instances must pass the database-backed one.
   */
  limiter?: RateLimiter;
  /**
   * The visitor's network address, where the host hands it over in a way of its own that a visitor cannot
   * forge (a header the host's edge always overwrites). Default: what Express works out (`req.ip`).
   */
  clientAddress?: (req: Request) => string | undefined;
}

/** The address the limits on logins and bookings count by. */
export function addressOf(ctx: Ctx, req: Request): string {
  return (ctx.clientAddress ? ctx.clientAddress(req) : req.ip) ?? "unknown";
}

export interface ClinicRow {
  id: number;
  slug: string;
  name: string;
  phone: string | null;
  address: string | null;
  timezone: string;
  booking_notice_hours: number;
  cancel_notice_hours: number;
  slot_step_minutes: number;
  booking_horizon_days: number;
}

export async function clinicById(q: Queryer, id: number): Promise<ClinicRow> {
  const rows = await q.query<ClinicRow>("SELECT * FROM clinics WHERE id = $1", [id]);
  if (!rows[0]) throw new HttpError(404, "Klinika nuk u gjet.");
  return rows[0];
}

export function mapClinic(c: ClinicRow) {
  return {
    id: c.id,
    slug: c.slug,
    name: c.name,
    phone: c.phone,
    address: c.address,
    timezone: c.timezone,
    bookingNoticeHours: c.booking_notice_hours,
    cancelNoticeHours: c.cancel_notice_hours,
    slotStepMinutes: c.slot_step_minutes,
    bookingHorizonDays: c.booking_horizon_days,
  };
}

/** Records a sensitive action. Kept deliberately small: who, what, on which record, when. */
export async function audit(
  q: Queryer,
  entry: { clinicId: number; userId: number | null; action: string; entity: string; entityId: number | null; meta?: unknown },
) {
  await q.query("INSERT INTO audit_log (clinic_id, user_id, action, entity, entity_id, meta) VALUES ($1, $2, $3, $4, $5, $6)", [
    entry.clinicId,
    entry.userId,
    entry.action,
    entry.entity,
    entry.entityId,
    entry.meta === undefined ? null : JSON.stringify(entry.meta),
  ]);
}
