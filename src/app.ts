import Koa from "koa";
import Router from "@koa/router";
import bodyParser from "koa-bodyparser";
import { DB, openDatabase } from "./db.js";
import { sweepExpired, countPending } from "./notify.js";
import { buildRouter } from "./routes.js";
import { Clock, HttpError } from "./types.js";

export interface AppOptions {
  dbPath: string;
  clock?: Clock;
  /** 超时清扫间隔毫秒；0 表示不自动清扫（测试用手动 sweep） */
  sweepIntervalMs?: number;
  logger?: (msg: string) => void;
}

export interface AppHandle {
  app: Koa;
  db: DB;
  clock: Clock;
  /** 启动时从持久化存储恢复的未确认通知数 */
  recoveredPending: number;
  /** 手动执行一次超时清扫（测试与定时器共用） */
  sweep: () => { escalated: unknown[] };
  close: () => void;
}

export function createApp(options: AppOptions): AppHandle {
  const clock: Clock = options.clock ?? (() => new Date());
  const logger = options.logger ?? ((msg: string) => console.log(msg));
  const db = openDatabase(options.dbPath);

  // 重启恢复：未确认通知持久化在 SQLite 中，启动时清点并继续由清扫器跟踪
  const recoveredPending = countPending(db);
  if (recoveredPending > 0) {
    logger(`[recovery] 恢复服务重启前尚未确认的通知 ${recoveredPending} 条`);
  }

  const app = new Koa();
  app.use(async (ctx, next) => {
    try {
      await next();
    } catch (e) {
      if (e instanceof HttpError) {
        ctx.status = e.status;
        ctx.body = { error: e.message, details: e.details ?? null };
      } else {
        logger(`[error] ${(e as Error).stack ?? e}`);
        ctx.status = 500;
        ctx.body = { error: "内部错误" };
      }
    }
  });
  app.use(bodyParser());
  const router: Router = buildRouter(db, clock);
  app.use(router.routes()).use(router.allowedMethods());

  const sweep = () => sweepExpired(db, clock);
  let timer: NodeJS.Timeout | null = null;
  const interval = options.sweepIntervalMs ?? 10_000;
  if (interval > 0) {
    timer = setInterval(() => {
      try {
        sweep();
      } catch (e) {
        logger(`[sweep] ${(e as Error).message}`);
      }
    }, interval);
    timer.unref();
  }

  return {
    app,
    db,
    clock,
    recoveredPending,
    sweep,
    close: () => {
      if (timer) clearInterval(timer);
      db.close();
    },
  };
}
