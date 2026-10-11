// Read-only facts about the database in DATABASE_URL (.env), for checking a hosted database before it is
// trusted with anything:  node e2e/check-hosted-database.mjs
// Prints no secret: no password, no user name, no connection string; the host is shown without its id.
import pg from "pg";

try {
  process.loadEnvFile();
} catch {
  /* no .env */
}
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}
const u = new URL(url);
console.log(`target: ${u.hostname.replace(/^[a-z]+-[a-z0-9-]+?(?=\.)/, "<endpoint>")} / database ${u.pathname.slice(1)} / sslmode ${u.searchParams.get("sslmode") ?? "(none)"}`);

const one = async (client, sql, params = []) => (await client.query(sql, params)).rows;
const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  const [{ version }] = await one(client, "SELECT version()");
  console.log("server:", version.split(" on ")[0]);
  const [tz] = await one(client, "SHOW timezone");
  console.log("session timezone:", tz.TimeZone);
  const [iso] = await one(client, "SHOW default_transaction_isolation");
  console.log("default isolation:", iso.default_transaction_isolation);
  // Encryption is judged from this side of the wire. (A provider that ends TLS at its own front door, as
  // Neon does, shows the inner hop as unencrypted in pg_stat_ssl; that says nothing about our connection.)
  const socket = client.connection.stream;
  console.log("this connection encrypted:", Boolean(socket.encrypted), socket.encrypted ? `${socket.getProtocol()}, certificate verified: ${socket.authorized}` : "");
  // And the server must not accept us without encryption at all.
  const plainUrl = new URL(url);
  plainUrl.searchParams.set("sslmode", "disable");
  plainUrl.searchParams.delete("channel_binding");
  const plain = new pg.Client({ connectionString: plainUrl.toString(), connectionTimeoutMillis: 15000 });
  const refused = await plain.connect().then(
    async () => {
      await plain.end();
      return false;
    },
    () => true,
  );
  console.log("server refuses an unencrypted connection:", refused);
  const [role] = await one(client, "SELECT r.rolsuper, r.rolbypassrls, r.rolcreatedb FROM pg_roles r WHERE r.rolname = current_user");
  console.log("application role: superuser", role.rolsuper, "| bypasses row-level security", role.rolbypassrls, "| may create databases", role.rolcreatedb);
  const tables = await one(
    client,
    `SELECT c.relname, (pg_get_userbyid(c.relowner) = current_user) AS owned, c.relrowsecurity AS rls
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = current_schema() AND c.relkind = 'r' ORDER BY c.relname`,
  );
  console.log(`tables: ${tables.length} | owned by the application role: ${tables.filter((t) => t.owned).length} | row-level security on: ${tables.filter((t) => t.rls).length}`);
  const notOurs = tables.filter((t) => !t.owned || !t.rls).map((t) => t.relname);
  if (notOurs.length) console.log("  NOT owned or without row-level security:", notOurs.join(", "));
  const [mig] = await one(client, "SELECT max(version)::int AS v, count(*)::int AS n FROM schema_migrations");
  console.log("schema version:", mig.v, `(${mig.n} migrations recorded)`);
  const ext = await one(client, "SELECT extname FROM pg_extension WHERE extname IN ('btree_gist', 'plpgsql') ORDER BY 1");
  console.log("extensions:", ext.map((e) => e.extname).join(", "));
  const trig = await one(client, "SELECT tgname FROM pg_trigger WHERE tgname IN ('users_clinic_keeps_an_administrator', 'clinics_start_with_an_administrator') ORDER BY 1");
  console.log("administrator triggers:", trig.length, "of 2");
  // Roles other than ours that could read the tables: any that bypass row-level security, or are superusers.
  const strong = await one(client, "SELECT count(*)::int AS n FROM pg_roles WHERE (rolsuper OR rolbypassrls) AND rolname <> current_user AND rolcanlogin");
  console.log("other login roles that are superuser or bypass row-level security:", strong[0].n);
  const grants = await one(client, "SELECT DISTINCT grantee FROM information_schema.role_table_grants WHERE table_schema = current_schema() AND grantee NOT IN (current_user, 'postgres')");
  console.log("roles other than ours holding grants on the tables:", grants.length ? grants.map((g) => g.grantee).join(", ") : "none");
  const counts = await one(client, "SELECT (SELECT count(*)::int FROM clinics) AS clinics, (SELECT count(*)::int FROM users) AS users, (SELECT count(*)::int FROM patients) AS patients, (SELECT count(*)::int FROM appointments) AS appointments");
  console.log("rows:", JSON.stringify(counts[0]));
} finally {
  await client.end();
}
