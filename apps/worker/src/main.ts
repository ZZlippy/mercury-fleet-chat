import "dotenv/config";
import { getDb } from "@mercury/db";
import { startWorkerLoop } from "@mercury/application";

const db = getDb();
startWorkerLoop(db);
console.log(JSON.stringify({ level: "info", msg: "Mercury worker started" }));
