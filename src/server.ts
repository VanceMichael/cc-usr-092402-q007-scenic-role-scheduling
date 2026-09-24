import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createApp } from "./app.js";
import { openDatabase } from "./db.js";
import { ScheduleService } from "./service.js";

const dbPath = process.env.SCHEDULE_DB_PATH ?? "./data/schedule.db";
if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });

const db = openDatabase(dbPath);
const service = new ScheduleService(db);

// 服务重启：恢复重启前未确认的通知（过期的立即升级为值班主管）
const recovery = service.recoverNotifications();
console.log(
  `[boot] 通知恢复完成：待确认 ${recovery.recoveredPending.length} 条，重启期间过期升级 ${recovery.escalatedOnBoot} 条`,
);

// 周期性清扫超时未确认通知
const sweepIntervalMs = service.store.configNumber("sweep_interval_seconds") * 1000;
const timer = setInterval(() => {
  try {
    const { escalated } = service.sweepNotifications();
    if (escalated.length > 0) console.log(`[sweep] ${escalated.length} 条通知超时未确认，已升级值班主管`);
  } catch (err) {
    console.error("[sweep] 清扫失败", err);
  }
}, sweepIntervalMs);
timer.unref();

const app = createApp(service);
const port = Number(process.env.PORT ?? 8080);
app.listen(port, () => console.log(`[boot] 排班服务已启动，端口 ${port}，数据文件 ${dbPath}`));
