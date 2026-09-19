import { GHActServer } from "./deps.ts";
import { colConfig, ghActConfig } from "../config/config.ts";
import { scheduleColUpdates } from "./col_update.ts";

const worker = new Worker(import.meta.resolve("./worker.ts"), {
  type: "module",
});
const server = new GHActServer(worker, ghActConfig);
if (colConfig.enabled) scheduleColUpdates();
await server.serve(); // defaults to port 4505
