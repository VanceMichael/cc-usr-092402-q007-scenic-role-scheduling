import { createApp } from "./app.js";

const port = Number(process.env.PORT ?? 8080);
const dbPath = process.env.DB_PATH ?? "data/schedule.sqlite";

const handle = createApp({
  dbPath,
  sweepIntervalMs: Number(process.env.SWEEP_INTERVAL_MS ?? 10_000),
});

handle.app.listen(port, () => {
  console.log(`景区角色排班服务已启动，端口 ${port}，数据库 ${dbPath}`);
});
