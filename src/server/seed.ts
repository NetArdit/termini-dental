import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { DateTime } from "luxon";
import { hashPassword } from "./auth";
import { openPostgres, type Db } from "./db";
import { openPglite } from "./db-local";
import { seedRefusal } from "./seed-guard";

// Fills the database with one demo clinic so the app can be explored at once:
//   npm run seed
// Log in as arta@demo.test (administrator) or besnik@demo.test (dentist), password "demo12345".
// Refuses to run when the demo clinic already exists, and against anything that looks like a real
// database (see seed-guard.ts).

const ZONE = "Europe/Belgrade";
// The default is printed in the README, so it is for a machine nobody else reaches. A demo clinic on a
// public address gets a password of its own: DEMO_PASSWORD.
const PASSWORD = process.env.DEMO_PASSWORD || "demo12345";
const SHOWN = process.env.DEMO_PASSWORD ? "(the DEMO_PASSWORD you set)" : PASSWORD;

async function seed(db: Db) {
  if ((await db.query("SELECT 1 FROM clinics LIMIT 1")).length) {
    console.log("This database already has its clinic. Nothing done: the demo data is for an empty database.");
    return;
  }
  const hash = await hashPassword(PASSWORD);
  const now = DateTime.now().setZone(ZONE);
  /** A local wall-clock time `dayOffset` days from today. */
  const at = (dayOffset: number, hour: number, minute = 0) => now.plus({ days: dayOffset }).set({ hour, minute, second: 0, millisecond: 0 }).toJSDate();
  /** The nearest working day (Monday to Friday) at or after/before `dayOffset`, stepping by `step`. */
  const workday = (dayOffset: number, step: 1 | -1) => {
    let d = dayOffset;
    while (now.plus({ days: d }).weekday > 5) d += step;
    return d;
  };

  await db.tx(async (q) => {
    const one = async (sql: string, params: unknown[]) => (await q.query<{ id: number }>(sql, params))[0]!.id;

    const clinic = await one("INSERT INTO clinics (name, phone, address) VALUES ('Rrënja Dental', '+383 44 123 456', 'Rr. Nëna Terezë 12, Prishtinë') RETURNING id", []);
    // A title and a portrait for each dentist: what a patient sees on the public page. The portraits are
    // illustrative (from the design direction), not people of any real clinic.
    const portrait = (name: string) => readFileSync(new URL(`../web/public/media/staff/${name}.jpg`, import.meta.url)).toString("base64");
    const staff = async (role: "admin" | "dentist", fullName: string, email: string, title: string, photo: string) =>
      one(
        "INSERT INTO users (clinic_id, role, full_name, email, password_hash, title, photo_type, photo_base64) VALUES ($1, $2, $3, $4, $5, $6, 'image/jpeg', $7) RETURNING id",
        [clinic, role, fullName, email, hash, title, portrait(photo)],
      );
    const arta = await staff("admin", "Dr. Arta Krasniqi", "arta@demo.test", "Kirurgji Orale & Implantologji", "arta");
    const besnik = await staff("dentist", "Dr. Besnik Gashi", "besnik@demo.test", "Stomatologji Estetike & Protetikë", "besnik");
    const linda = await staff("dentist", "Dr. Linda Hoxha", "linda@demo.test", "Ortodonci & Pedodonci", "linda");
    for (const dentist of [arta, besnik, linda]) {
      for (let weekday = 1; weekday <= 5; weekday++) {
        // A lunch break, so the schedule shows two periods a day.
        await q.query("INSERT INTO working_hours (user_id, weekday, start_minute, end_minute) VALUES ($1, $2, 540, 780), ($1, $2, 840, 1020)", [dentist, weekday]);
      }
    }

    const service: Record<string, number> = {};
    // Demo prices in cents, each "from": what such a service starts at in this made-up clinic.
    for (const [name, minutes, priceFrom] of [["Kontroll", 30, 1000], ["Mbushje", 45, 2500], ["Pastrim i gurëzave", 45, 2500], ["Nxjerrje dhëmbi", 30, 2000], ["Zbardhim dhëmbësh", 60, 12000]] as const) {
      service[name] = await one("INSERT INTO services (clinic_id, name, duration_minutes, price_from_minor) VALUES ($1, $2, $3, $4) RETURNING id", [clinic, name, minutes, priceFrom]);
    }
    const minutesOf: Record<string, number> = { Kontroll: 30, Mbushje: 45, "Pastrim i gurëzave": 45, "Nxjerrje dhëmbi": 30, "Zbardhim dhëmbësh": 60 };

    const patient = async (dentist: number, name: string, phone: string, email: string | null, source: "online" | "local", note: string | null = null) =>
      one("INSERT INTO patients (clinic_id, dentist_id, full_name, phone, email, source, note, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id", [
        clinic,
        dentist,
        name,
        phone,
        email,
        source,
        note,
        source === "local" ? dentist : null,
      ]);

    const agron = await patient(arta, "Agron Morina", "+38344111222", "agron@example.test", "online");
    const vjosa = await patient(arta, "Vjosa Kelmendi", "+38349333444", "vjosa@example.test", "local", "Alergji në penicilinë.");
    const liridona = await patient(arta, "Liridona Shala", "+38345555666", null, "local");
    const drilon = await patient(besnik, "Drilon Berisha", "+38344777888", "drilon@example.test", "online");
    const mimoza = await patient(besnik, "Mimoza Hoxha", "+38349999000", "mimoza@example.test", "local");
    const blerim = await patient(arta, "Blerim Rexhepi", "+38344222333", "blerim@example.test", "online");

    type Status = "booked" | "completed" | "no_show" | "cancelled";
    const appointment = async (dentist: number, who: number, what: string, start: Date, status: Status, source: "online" | "local", extra: { reason?: string; late?: boolean } = {}) =>
      one(
        `INSERT INTO appointments (clinic_id, dentist_id, patient_id, service_id, starts_at, ends_at, status, source, notice_accepted_at,
                                   cancelled_at, cancelled_by, cancelled_by_user, cancel_reason, cancel_late, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING id`,
        [
          clinic,
          dentist,
          who,
          service[what],
          start,
          new Date(start.getTime() + minutesOf[what]! * 60000),
          status,
          source,
          source === "online" ? new Date(start.getTime() - 3 * 24 * 3600 * 1000) : null,
          status === "cancelled" ? new Date(start.getTime() - 30 * 3600 * 1000) : null,
          status === "cancelled" ? "clinic" : null,
          status === "cancelled" ? dentist : null,
          extra.reason ?? null,
          extra.late ?? false,
          source === "local" ? dentist : null,
        ],
      );

    const report = async (appt: number, author: number, text: string, nextDays: number | null, savedAt: Date) => {
      await q.query("INSERT INTO visit_reports (appointment_id, work_done, next_visit_days, author_id, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $5)", [appt, text, nextDays, author, savedAt]);
      await q.query("INSERT INTO visit_report_versions (appointment_id, version, work_done, next_visit_days, author_id, saved_at) VALUES ($1, 1, $2, $3, $4, $5)", [appt, text, nextDays, author, savedAt]);
    };

    // Two weeks ago: a filling with "come back in 14 days" and nothing booked since, so the patient is due.
    const twoWeeksAgo = workday(-14, -1);
    const filling = await appointment(arta, agron, "Mbushje", at(twoWeeksAgo, 10), "completed", "online");
    await report(filling, arta, "Mbushje me ilaç në dhëmbin 36. Pacienti pa dhimbje pas ndërhyrjes.", 14, at(twoWeeksAgo, 11));

    // Last week: visits with reports, one patient who did not come, one cancelled by the clinic.
    const lastWeek = workday(-6, -1);
    const cleaning = await appointment(arta, vjosa, "Pastrim i gurëzave", at(lastWeek, 9), "completed", "local");
    await report(cleaning, arta, "Pastrim i plotë i gurëzave. Udhëzime për higjienën e gojës.", 180, at(lastWeek, 10));
    await appointment(besnik, drilon, "Kontroll", at(lastWeek, 11), "no_show", "online");
    await appointment(besnik, mimoza, "Mbushje", at(lastWeek, 14), "cancelled", "local", { reason: "Stomatologu mungoi atë ditë." });
    const extraction = await appointment(besnik, mimoza, "Nxjerrje dhëmbi", at(workday(-3, -1), 15), "completed", "local");
    await report(extraction, besnik, "Nxjerrje e dhëmbit 48. Qepje me dy pe. Antibiotik 5 ditë.", 7, at(workday(-3, -1), 16));

    // Demo pictures on the demo visits, so that the pictures of a visit can be seen at work. They are the
    // stock photograph of X-ray films that the public site also uses (public/media/photographs.json): an
    // illustration, not anybody's X-ray.
    const demoXray = readFileSync(new URL("../web/public/media/rentgen-800.webp", import.meta.url));
    const picture = (appt: number, author: number, caption: string, when: Date) =>
      q.query("INSERT INTO visit_images (clinic_id, appointment_id, kind, caption, content_type, size_bytes, data_base64, uploaded_by, created_at) VALUES ($1, $2, 'xray', $3, 'image/webp', $4, $5, $6, $7)", [clinic, appt, caption, demoXray.length, demoXray.toString("base64"), author, when]);
    await picture(filling, arta, "Para mbushjes, dhëmbi 36", at(twoWeeksAgo, 11));
    await picture(cleaning, arta, "Panoramik para pastrimit", at(lastWeek, 10));
    await picture(cleaning, arta, "Pas pastrimit", at(lastWeek, 10));
    await picture(extraction, besnik, "Dhëmbi 48 para nxjerrjes", at(workday(-3, -1), 16));

    // "Punët tona" in the demo: the site's own stock photographs, marked illustrative (which the public page
    // then says under each). No picture of anybody's treatment is made up.
    const stock = (name: string) => readFileSync(new URL(`../web/public/media/${name}`, import.meta.url)).toString("base64");
    const work = (title: string, description: string, file: string) =>
      q.query("INSERT INTO gallery_items (clinic_id, title, description, after_type, after_base64, basis, status, created_by) VALUES ($1, $2, $3, 'image/webp', $4, 'illustrative', 'published', $5)", [clinic, title, description, stock(file), arta]);
    await work("Kabina e trajtimit", "Pajisje moderne dhe sterilizim pas çdo pacienti.", "kabina-800.webp");
    await work("Konsulta e parë", "Para çdo trajtimi flasim për planin, kohën dhe çmimin.", "hero-konsulte-800.webp");
    await work("Diagnostikimi", "Rentgeni na tregon atë që nuk shihet me sy.", "rentgen-800.webp");

    // What the patients of the demo "wrote" afterwards: made-up reviews for made-up visits, already published,
    // so that the public pages of the demo show how reviews look. A real clinic starts with none.
    const review = (appt: number, dentist: number, rating: number, comment: string | null) =>
      q.query("INSERT INTO dentist_reviews (clinic_id, appointment_id, dentist_id, rating, comment, status, moderated_by, moderated_at) VALUES ($1, $2, $3, $4, $5, 'published', $6, now())", [clinic, appt, dentist, rating, comment, arta]);
    await review(filling, arta, 5, "Më shpjegoi çdo hap para se të fillonte dhe nuk ndjeva dhimbje fare.");
    await review(cleaning, arta, 5, "E saktë me orarin dhe shumë e kujdesshme. Do të vij përsëri.");
    await review(extraction, besnik, 4, "Nxjerrja shkoi shpejt. Prita pak në fillim, por më telefonuan të nesërmen për të pyetur si jam.");

    // The coming days: something to see in the calendar.
    const soon = workday(1, 1);
    await appointment(arta, liridona, "Kontroll", at(soon, 9, 30), "booked", "local");
    await appointment(arta, blerim, "Zbardhim dhëmbësh", at(soon, 11), "booked", "online");
    await appointment(besnik, drilon, "Kontroll", at(soon, 10), "booked", "online");
    await appointment(arta, vjosa, "Mbushje", at(workday(3, 1), 14), "booked", "local");
    await appointment(besnik, mimoza, "Kontroll", at(workday(4, 1), 9), "booked", "local");
  });

  console.log("Demo clinic created.");
  console.log("  Booking page:   /rezervo");
  console.log(`  Administrator:  arta@demo.test   / ${SHOWN}`);
  console.log(`  Dentist:        besnik@demo.test / ${SHOWN}`);
}

try {
  process.loadEnvFile();
} catch {
  // No .env file: defaults apply.
}
const refusal = seedRefusal(process.env);
if (refusal) {
  console.error(refusal);
  process.exit(1);
}
let db: Db;
if (process.env.DATABASE_URL) {
  db = await openPostgres(process.env.DATABASE_URL);
} else {
  const dir = path.resolve(process.env.PGLITE_DIR || "data/pg");
  mkdirSync(dir, { recursive: true });
  db = await openPglite(dir);
}
await seed(db);
await db.close();
