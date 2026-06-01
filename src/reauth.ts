import "dotenv/config";
import { getAuthClient } from "./google-auth.js";
import { readFile } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

console.log("🔑 מתחיל תהליך אישור Google OAuth...\n");

try {
  await getAuthClient();
  const token = await readFile(join(__dirname, "..", "token.json"), "utf-8");
  console.log("\n✅ אישור הצליח! תוכן ה-token.json:\n");
  console.log("=".repeat(60));
  console.log(token);
  console.log("=".repeat(60));
  console.log("\nהעתק את התוכן שלמעלה ל-Railway → Variables → GOOGLE_TOKEN_JSON");
} catch (err) {
  console.error("❌ שגיאה:", err);
}

process.exit(0);
