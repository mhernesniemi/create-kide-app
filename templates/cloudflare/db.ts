import { drizzle } from "drizzle-orm/d1";

let dbInstance: ReturnType<typeof drizzle> | null = null;
let currentDb: D1Database | null = null;

export const getDb = async () => {
  // Access the D1 binding from the Cloudflare runtime context
  // The binding is set in wrangler.toml as "CMS_DB"
  const env = (globalThis as any).__env__;
  if (!env?.CMS_DB) {
    throw new Error("D1 database binding CMS_DB not found. Check wrangler.toml.");
  }

  if (dbInstance && currentDb === env.CMS_DB) return dbInstance;

  currentDb = env.CMS_DB;
  dbInstance = drizzle(env.CMS_DB);
  return dbInstance;
};

export const closeDb = () => {
  dbInstance = null;
  currentDb = null;
};
