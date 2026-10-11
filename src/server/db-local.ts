import { runMigrations, type Db, type Migration, type Queryer } from "./db";

// The built-in database: PostgreSQL compiled to WebAssembly, running inside this process. Development, tests,
// a demo. Kept apart from db.ts so that it is loaded only by what uses it.

/** `dataDir` undefined keeps the database in memory (tests). */
export async function openPglite(dataDir?: string): Promise<Db> {
  const { PGlite } = await import("@electric-sql/pglite");
  const { btree_gist } = await import("@electric-sql/pglite/contrib/btree_gist");
  const pg = new PGlite({ dataDir, extensions: { btree_gist } });
  const migrate = (migrations?: Migration[]) =>
    runMigrations(
      (fn) =>
        pg.transaction(async (t) =>
          fn({
            exec: async (sql) => {
              await t.exec(sql);
            },
            query: async <T>(sql: string, params: unknown[] = []) => (await t.query<T>(sql, params)).rows,
          }),
        ) as Promise<never>,
      migrations,
    );
  await migrate();
  return {
    async query<T>(sql: string, params: unknown[] = []) {
      return (await pg.query<T>(sql, params)).rows;
    },
    tx<T>(fn: (q: Queryer) => Promise<T>) {
      return pg.transaction(async (t) =>
        fn({
          async query<R>(sql: string, params: unknown[] = []) {
            return (await t.query<R>(sql, params)).rows;
          },
        }),
      ) as Promise<T>;
    },
    migrate,
    close: () => pg.close(),
  };
}
