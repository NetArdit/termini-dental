// The one place the web app talks to the server.

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    /** One message per form field, when the server refused the input. */
    public fields: Record<string, string> = {},
    /** Machine-readable reason, for the few cases the page reacts to specifically. */
    public code?: string,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: "same-origin",
      // The second header is the server's anti-forgery check: another site cannot set it.
      headers: { "content-type": "application/json", "x-requested-with": "termini", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError("Nuk u arrit lidhja me serverin. Kontrolloni internetin dhe provoni përsëri.", 0);
  }
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // A non-JSON reply (for example a proxy error page) is handled as a plain failure below.
  }
  if (!res.ok) {
    const d = (data ?? {}) as { error?: string; fields?: Record<string, string>; code?: string };
    throw new ApiError(d.error || "Diçka shkoi keq. Ju lutemi provoni përsëri.", res.status, d.fields, d.code);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string, headers?: Record<string, string>) => request<T>("GET", path, undefined, headers),
  post: <T>(path: string, body: unknown = {}, headers?: Record<string, string>) => request<T>("POST", path, body, headers),
  put: <T>(path: string, body: unknown = {}) => request<T>("PUT", path, body),
  patch: <T>(path: string, body: unknown = {}) => request<T>("PATCH", path, body),
  del: <T>(path: string) => request<T>("DELETE", path),
};

// ---- shapes the server returns ---------------------------------------------------------------------------

export interface Clinic {
  id: number;
  slug: string;
  name: string;
  phone: string | null;
  address: string | null;
  timezone: string;
  bookingNoticeHours: number;
  cancelNoticeHours: number;
  slotStepMinutes: number;
  bookingHorizonDays: number;
}

export interface User {
  id: number;
  clinicId: number;
  role: "admin" | "dentist";
  fullName: string;
  email: string;
  isBookable: boolean;
}

export interface Staff {
  id: number;
  role: "admin" | "dentist";
  fullName: string;
  email: string;
  isBookable: boolean;
  isActive: boolean;
}

export interface Service {
  id: number;
  name: string;
  durationMinutes: number;
  isActive?: boolean;
}

export type AppointmentStatus = "booked" | "completed" | "no_show" | "cancelled";

export interface Appointment {
  id: number;
  dentistId: number;
  dentistName: string;
  patientId: number;
  patientName: string;
  patientPhone: string | null;
  patientEmail: string | null;
  serviceId: number;
  serviceName: string;
  startsAt: string;
  endsAt: string;
  status: AppointmentStatus;
  source: "online" | "local";
  cancelledAt: string | null;
  cancelledBy: "clinic" | "patient" | null;
  cancelReason: string | null;
  cancelLate: boolean;
  hasReport: boolean;
  lastEmailStatus: "accepted" | "stored" | "failed" | null;
}

export interface Report {
  workDone: string;
  nextVisitDays: number | null;
  version: number;
  authorName: string;
  updatedAt: string;
}

export interface ReportVersion {
  version: number;
  workDone: string;
  nextVisitDays: number | null;
  authorName: string;
  savedAt: string;
}

export interface Patient {
  id: number;
  dentistId: number;
  dentistName: string;
  fullName: string;
  phone: string | null;
  email: string | null;
  birthDate: string | null;
  note: string | null;
  source: "online" | "local";
  createdAt: string;
}

export interface Visit extends Appointment {
  workDone: string | null;
  nextVisitDays: number | null;
}

export interface WorkingPeriod {
  weekday: number;
  startMinute: number;
  endMinute: number;
}
