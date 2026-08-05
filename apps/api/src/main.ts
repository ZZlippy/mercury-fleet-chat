import "dotenv/config";
import { getDb, migrate } from "@mercury/db";
import { startWorkerLoop } from "@mercury/application";
import { buildServer } from "./server.ts";

const db = getDb();
await migrate(db);
const app = await buildServer(db);

// In dev the outbox worker runs in-process; apps/worker runs it standalone.
if (process.env.SEPARATE_WORKER !== "true") startWorkerLoop(db);

const port = Number(process.env.PORT ?? 4000);
await app.listen({ port, host: "0.0.0.0" });
console.log(JSON.stringify({ level: "info", msg: `Mercury API listening on :${port}` }));
