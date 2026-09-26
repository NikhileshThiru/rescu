import postgres from "postgres";
import { REPO_ROOT } from "./lib.js";

export function connect() {
  try {
    process.loadEnvFile(new URL(".env", REPO_ROOT));
  } catch {
    // Fall back to the process environment (e.g. on the server).
  }
  const url = process.env.TIGER_DATABASE_URL;
  if (!url) throw new Error("TIGER_DATABASE_URL is not set");
  return postgres(url, { max: 4, onnotice: () => {} });
}
