import "dotenv/config";
import { getDb, migrate, closeDb } from "./index.ts";

const db = getDb();
const applied = await migrate(db);
console.log(applied.length ? `Applied: ${applied.join(", ")}` : "No pending migrations.");
await closeDb();
