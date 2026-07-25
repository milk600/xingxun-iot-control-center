import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const deliveryRoot = resolve(process.argv[2] ?? "delivery");
const databasePath = resolve(
  deliveryRoot,
  "data",
  "telemetry-history.sqlite",
);

if (!existsSync(databasePath)) {
  throw new Error(`交付数据库不存在：${databasePath}`);
}

const database = new DatabaseSync(databasePath, { readOnly: true });
const integrity = database.prepare("PRAGMA integrity_check").get();
console.log(`SQLITE_INTEGRITY=${integrity.integrity_check}`);

const tables = database
  .prepare(
    "SELECT name FROM sqlite_master "
      + "WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  )
  .all()
  .map((row) => row.name);
console.log(`TABLES=${tables.join(",")}`);

for (const table of tables) {
  const safeTable = table.replaceAll("\"", "\"\"");
  const { count } = database
    .prepare(`SELECT COUNT(*) AS count FROM "${safeTable}"`)
    .get();
  console.log(`ROWS_${table}=${count}`);
}

database.close();
