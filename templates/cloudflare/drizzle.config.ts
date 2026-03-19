import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/cms/.generated/schema.ts",
  out: "./src/cms/migrations",
  dialect: "sqlite",
  dbCredentials: {
    // For local dev with wrangler, point to the local D1 database
    url: ".wrangler/state/v3/d1/miniflare-D1DatabaseObject/*.sqlite",
  },
});
