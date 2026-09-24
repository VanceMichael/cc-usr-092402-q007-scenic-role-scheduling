import Koa from "koa";
import Router from "@koa/router";
import bodyParser from "koa-bodyparser";
import { badRequest, HttpError } from "./errors.js";
import type { ScheduleService } from "./service.js";

type Body = Record<string, unknown>;

function body(ctx: Koa.Context): Body {
  const b = ctx.request.body;
  if (b === null || typeof b !== "object" || Array.isArray(b)) throw badRequest("请求体必须是 JSON 对象");
  return b as Body;
}

function reqString(b: Body, key: string): string {
  const v = b[key];
  if (typeof v !== "string" || v.length === 0) throw badRequest(`缺少字段 ${key}（字符串）`);
  return v;
}

function optString(b: Body, key: string): string | undefined {
  const v = b[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw badRequest(`字段 ${key} 必须是字符串`);
  return v;
}

function reqInt(b: Body, key: string): number {
  const v = b[key];
  if (typeof v !== "number" || !Number.isInteger(v)) throw badRequest(`缺少字段 ${key}（整数）`);
  return v;
}

export function createApp(service: ScheduleService): Koa {
  const app = new Koa();
  const router = new Router();
  const { store } = service;

  app.use(async (ctx, next) => {
    try {
      await next();
    } catch (err) {
      if (err instanceof HttpError) {
        ctx.status = err.status;
        ctx.body = err.body;
      } else {
        ctx.status = 500;
        ctx.body = { error: "internal_error", message: err instanceof Error ? err.message : String(err) };
      }
    }
  });
  app.use(bodyParser());

  router.get("/healthz", (ctx) => {
    ctx.body = { status: "ok" };
  });

  // ---- 配置 ----
  router.get("/config", (ctx) => {
    ctx.body = store.allConfig();
  });
  router.put("/config", (ctx) => {
    const b = body(ctx);
    store.setConfig(reqString(b, "key"), reqString(b, "value"));
    ctx.body = store.allConfig();
  });

  // ---- 演员与资质 ----
  router.post("/actors", (ctx) => {
    const b = body(ctx);
    ctx.status = 201;
    ctx.body = store.createActor(optString(b, "id"), reqString(b, "name"));
  });
  router.get("/actors", (ctx) => {
    ctx.body = store.listActors().map((a) => ({ ...a, qualifications: store.qualificationsOf(a.id) }));
  });
  router.get("/actors/:id", (ctx) => {
    const a = store.getActor(ctx.params.id);
    ctx.body = { ...a, qualifications: store.qualificationsOf(a.id) };
  });
  router.put("/actors/:id/qualifications", (ctx) => {
    const b = body(ctx);
    const quals = b.qualifications;
    if (!Array.isArray(quals)) throw badRequest("缺少字段 qualifications（数组）");
    service.updateQualifications(
      ctx.params.id,
      quals.map((q) => {
        const o = q as Body;
        return { role: reqString(o, "role"), validFrom: reqString(o, "validFrom"), validUntil: reqString(o, "validUntil") };
      }),
      b.expectedVersion,
    );
    const a = store.getActor(ctx.params.id);
    ctx.body = { ...a, qualifications: store.qualificationsOf(a.id) };
  });

  // ---- 区域与转场 ----
  router.post("/zones", (ctx) => {
    const b = body(ctx);
    ctx.status = 201;
    ctx.body = store.upsertZone(reqString(b, "id"), reqString(b, "name"), reqInt(b, "capacity"));
  });
  router.get("/zones", (ctx) => {
    ctx.body = store.listZones();
  });
  router.put("/transfers", (ctx) => {
    const b = body(ctx);
    const fromZone = reqString(b, "fromZone");
    const toZone = reqString(b, "toZone");
    store.getZone(fromZone);
    store.getZone(toZone);
    store.upsertTransfer(fromZone, toZone, reqInt(b, "minutes"));
    ctx.body = store.listTransfers();
  });
  router.get("/transfers", (ctx) => {
    ctx.body = store.listTransfers();
  });

  // ---- 场次模板 ----
  router.post("/templates", (ctx) => {
    const b = body(ctx);
    const roles = b.roles;
    if (!Array.isArray(roles) || roles.length === 0) throw badRequest("缺少字段 roles（非空数组）");
    const id = reqString(b, "id");
    ctx.status = 201;
    ctx.body = {
      ...store.createTemplate(
        { id, name: reqString(b, "name"), zoneId: reqString(b, "zoneId"), durationMinutes: reqInt(b, "durationMinutes") },
        roles.map((r) => {
          const o = r as Body;
          return { role: reqString(o, "role"), requiredCount: reqInt(o, "requiredCount"), isKey: o.isKey === true };
        }),
      ),
      roles: store.templateRoles(id),
    };
  });
  router.get("/templates", (ctx) => {
    ctx.body = store.listTemplates().map((t) => ({ ...t, roles: store.templateRoles(t.id) }));
  });

  // ---- 场次 ----
  router.post("/sessions", (ctx) => {
    const b = body(ctx);
    ctx.status = 201;
    ctx.body = store.createSession(optString(b, "id"), reqString(b, "templateId"), reqString(b, "startsAt"));
  });
  router.get("/sessions", (ctx) => {
    const from = typeof ctx.query.from === "string" ? ctx.query.from : "0000-01-01T00:00:00.000Z";
    const to = typeof ctx.query.to === "string" ? ctx.query.to : "9999-12-31T00:00:00.000Z";
    ctx.body = store.sessionsStartingBetween(from, to).map((s) => ({
      ...s,
      reservationLocked: store.isReservationLocked(s.id),
      confirmedSeats: store.confirmedSeats(s.id),
      assignments: store.activeAssignmentsOfSession(s.id),
    }));
  });
  router.post("/sessions/:id/start", (ctx) => {
    service.startSession(ctx.params.id, body(ctx).expectedVersion, optString(body(ctx), "operator"));
    ctx.body = store.getSessionView(ctx.params.id);
  });
  router.post("/sessions/:id/complete", (ctx) => {
    service.completeSession(ctx.params.id, body(ctx).expectedVersion, optString(body(ctx), "operator"));
    ctx.body = store.getSessionView(ctx.params.id);
  });
  router.post("/sessions/:id/cancel", (ctx) => {
    const b = body(ctx);
    service.cancelSession(ctx.params.id, b.expectedVersion, optString(b, "reason") ?? "人工取消", optString(b, "operator"));
    ctx.body = store.getSessionView(ctx.params.id);
  });

  // ---- 预约 ----
  router.post("/reservations", (ctx) => {
    const b = body(ctx);
    ctx.status = 201;
    ctx.body = store.createReservation(reqString(b, "sessionId"), reqInt(b, "partySize"));
  });
  router.post("/reservations/:id/cancel", (ctx) => {
    store.cancelReservation(ctx.params.id);
    ctx.body = store.getReservation(ctx.params.id);
  });

  // ---- 方案生成与解释 ----
  router.post("/plan/generate", (ctx) => {
    const b = body(ctx);
    ctx.body = service.generatePlan(reqString(b, "from"), reqString(b, "to"), optString(b, "operator"));
  });
  router.get("/plan/explain", (ctx) => {
    const from = typeof ctx.query.from === "string" ? ctx.query.from : "0000-01-01T00:00:00.000Z";
    const to = typeof ctx.query.to === "string" ? ctx.query.to : "9999-12-31T00:00:00.000Z";
    ctx.body = service.explain(from, to);
  });
  router.get("/demands/unmet", (ctx) => {
    ctx.body = store.allUnmet();
  });

  // ---- 手工调整（乐观锁） ----
  router.post("/sessions/:id/assignments", (ctx) => {
    const b = body(ctx);
    ctx.status = 201;
    ctx.body = service.manualAssign(
      ctx.params.id,
      reqString(b, "actorId"),
      reqString(b, "role"),
      b.expectedVersion,
      b.force === true,
      optString(b, "operator"),
    );
  });
  router.post("/assignments/:id/remove", (ctx) => {
    const b = body(ctx);
    service.removeAssignment(ctx.params.id, b.expectedVersion, optString(b, "operator"));
    ctx.status = 204;
  });

  // ---- 事件 ----
  router.post("/incidents/facility-outage", (ctx) => {
    const b = body(ctx);
    ctx.body = store.transaction(() =>
      service.incidents.facilityOutage(
        reqString(b, "zoneId"),
        reqString(b, "from"),
        reqString(b, "to"),
        reqString(b, "reason"),
        optString(b, "operator"),
      ),
    );
  });
  router.post("/incidents/late-checkin", (ctx) => {
    const b = body(ctx);
    ctx.body = store.transaction(() =>
      service.incidents.lateCheckin(reqString(b, "actorId"), reqString(b, "availableFrom"), optString(b, "operator")),
    );
  });

  // ---- 通知 ----
  router.get("/notifications", (ctx) => {
    ctx.body = store.listNotifications({
      actorId: typeof ctx.query.actorId === "string" ? ctx.query.actorId : undefined,
      status: typeof ctx.query.status === "string" ? ctx.query.status : undefined,
    });
  });
  router.get("/notifications/pending", (ctx) => {
    ctx.body = store.listNotifications({ status: "pending" });
  });
  router.post("/notifications/:id/confirm", (ctx) => {
    ctx.body = service.confirmNotification(ctx.params.id, reqString(body(ctx), "actorId"));
  });
  router.post("/notifications/sweep", (ctx) => {
    ctx.body = service.sweepNotifications();
  });

  // ---- 审计 ----
  router.get("/audit", (ctx) => {
    ctx.body = store.listAudit();
  });

  app.use(router.routes()).use(router.allowedMethods());
  return app;
}
