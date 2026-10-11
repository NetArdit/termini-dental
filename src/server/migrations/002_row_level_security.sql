-- Termini Dental, migration 002: nobody but the application reads these tables.
--
-- The application connects as the role that owns the tables, and PostgreSQL lets a table's owner through
-- row-level security. Every other ORDINARY role is refused every row, because no policy grants it any.
-- (A superuser, or a role created with BYPASSRLS, is not held back by this; it is a second wall, not the only one.)
--
-- Why it matters: some hosted databases put more in front of PostgreSQL than a connection string. Supabase,
-- for one, serves every table of the public schema over a web API to its built-in roles "anon" and
-- "authenticated", using a key that is meant to be public. Without this, patient records in such a database
-- could be read through that API by anyone holding the key. With it, those roles see empty tables.
-- On a plain PostgreSQL server (and on the built-in database) it changes nothing for the application.
--
-- A table added by a later migration must enable row-level security too; a test checks that none is missed.

ALTER TABLE clinics ENABLE ROW LEVEL SECURITY;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE services ENABLE ROW LEVEL SECURITY;
ALTER TABLE working_hours ENABLE ROW LEVEL SECURITY;
ALTER TABLE time_off ENABLE ROW LEVEL SECURITY;
ALTER TABLE patients ENABLE ROW LEVEL SECURITY;
ALTER TABLE appointments ENABLE ROW LEVEL SECURITY;
ALTER TABLE visit_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE visit_report_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE schema_migrations ENABLE ROW LEVEL SECURITY;
