import Router from "@koa/router";
import { randomUUID } from "node:crypto";
import { DB, getRules, updateRules } from "./db.js";
import { checkAssignment, violationsOf } from "./constraints.js";
import { confirmNotification } from "./notify.js";
import { generatePlan, insertAssignment } from "./planner.js";
import { cancelAssignmentRow, cancelSession, handleLateCheckin, handleZoneOutage } from "./replan.js";
import { buildPlanExplanation, buildSessionExplanation } from "./explain.js";
import {
  activeAssignmentsOfActor,
  confirmedVisitorCount,
  isSessionFrozen,
  isSessionStarted,
  loadTransfers,
  logEvent,
  transferMinutesLookup,
  updateWithVersion,
} from "./store.js";
import {
  ActorRow,
  AssignmentRow,
  Clock,
  QualificationRow,
  Requirement,
  Rules,
  SessionRow,
  TemplateRow,
  TraceEntry,
  badRequest,
  conflict,
  notFound,
  unprocessable,
} from "./types.js";

interface Ctx {
  params: Record<string, string>;
  request: { body?: Record<string, unknown> };
  query: Record<string, string | undefined>;
  status: number;
  body: unknown;
}

type Handler = (ctx: Ctx) => void | Promise<void>;

function bodyOf(ctx: Ctx): Record<string, unknown> {
  return (ctx.request.body ?? {}) as Record<string, unknown>;
}

function need(body: Record<string, unknown>, fields: string[]): void {
  const missing = fields.filter((f) => body[f] === undefined || body[f] === null || body[f] === "");
  if (missing.length > 0) throw badRequest(`缺少必填字段: ${missing.join(", ")}`);
}

function expectedVersionOf(body: Record<string, unknown>): number {
  const v = body.expectedVersion;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1) {
    throw badRequest("必须携带整数 expectedVersion 以检测并发修改");
  }
  return v;
}

function str(v: unknown, field: string): string {
  if (typeof v !== "string" || v.length === 0) throw badRequest(`字段 ${field} 必须是非空字符串`);
  return v;
}

function num(v: unknown, field: string, min = 0): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < min) {
    throw badRequest(`字段 ${field} 必须是不小于 ${min} 的数字`);
  }
  return v;
}

function isoTs(v: unknown, field: string): string {
  const s = str(v, field);
  if (Number.isNaN(Date.parse(s))) throw badRequest(`字段 ${field} 不是合法时间: ${s}`);
  return new Date(Date.parse(s)).toISOString();
}

export function buildRouter(db: DB, clock: Clock): Router {
  const router = new Router();
  const rules = () => getRules(db);
  const nowIso = () => clock().toISOString();

  const get = (path: string, h: Handler) => router.get(path, h as never);
  const post = (path: string, h: Handler) => router.post(path, h as never);
  const patch = (path: string, h: Handler) => router.patch(path, h as never);
  const put = (path: string, h: Handler) => router.put(path, h as never);
  const del = (path: string, h: Handler) => router.delete(path, h as never);

  const mustGet = <T>(sql: string, id: string, label: string): T => {
    const row = db.prepare(sql).get(id) as T | undefined;
    if (!row) throw notFound(`${label}不存在: ${id}`);
    return row;
  };
  const getActor = (id: string) => mustGet<ActorRow>("SELECT * FROM actors WHERE id = ?", id, "演员");
  const getZone = (id: string) => mustGet<{ id: string; name: string; capacity: number; status: string; version: number }>("SELECT * FROM zones WHERE id = ?", id, "区域");
  const getTemplate = (id: string) => mustGet<TemplateRow>("SELECT * FROM templates WHERE id = ?", id, "场次模板");
  const getSessionOr404 = (id: string) => mustGet<SessionRow>("SELECT * FROM sessions WHERE id = ?", id, "场次");
  const getAssignment = (id: string) => mustGet<AssignmentRow>("SELECT * FROM assignments WHERE id = ?", id, "分配");

  /** 场次仍可被自动/人工调整；已开始或已结束的场次一律拒绝改写。 */
  const assertSessionMutable = (session: SessionRow): void => {
    if (session.status === "cancelled") throw unprocessable("场次已取消，不能调整");
    if (isSessionFrozen(session, nowIso())) {
      throw unprocessable("场次已开始或已结束，不能静默改写", { sessionId: session.id });
    }
  };

  // ---------- 规则 ----------
  get("/rules", (ctx) => {
    ctx.body = rules();
  });
  put("/rules", (ctx) => {
    const b = bodyOf(ctx);
    const patch: Partial<Rules> = {};
    for (const key of ["minRestMinutes", "maxSessionsPerDay", "reservePerRole", "confirmTimeoutSec"] as const) {
      if (b[key] !== undefined) patch[key] = num(b[key], key, key === "reservePerRole" ? 0 : 1);
    }
    if (b.dutySupervisor !== undefined) patch.dutySupervisor = str(b.dutySupervisor, "dutySupervisor");
    ctx.body = updateRules(db, patch);
  });

  // ---------- 演员与资质 ----------
  post("/actors", (ctx) => {
    const b = bodyOf(ctx);
    need(b, ["name"]);
    const id = typeof b.id === "string" && b.id ? b.id : randomUUID();
    db.prepare("INSERT INTO actors (id, name, active, version) VALUES (?, ?, 1, 1)").run(
      id,
      str(b.name, "name"),
    );
    ctx.status = 201;
    ctx.body = getActor(id);
  });
  get("/actors", (ctx) => {
    ctx.body = db.prepare("SELECT * FROM actors ORDER BY id").all();
  });
  get("/actors/:id", (ctx) => {
    const actor = getActor(ctx.params.id);
    const qualifications = db
      .prepare("SELECT * FROM qualifications WHERE actorId = ? ORDER BY validFrom")
      .all(actor.id);
    ctx.body = { ...actor, qualifications };
  });
  patch("/actors/:id", (ctx) => {
    const actor = getActor(ctx.params.id);
    const b = bodyOf(ctx);
    const version = expectedVersionOf(b);
    const sets: Record<string, unknown> = {};
    if (b.name !== undefined) sets.name = str(b.name, "name");
    if (b.active !== undefined) sets.active = b.active ? 1 : 0;
    if (Object.keys(sets).length === 0) throw badRequest("没有需要修改的字段");
    updateWithVersion(db, "actors", actor.id, version, sets);
    logEvent(db, clock, "actor_updated", "actor", actor.id, sets);
    ctx.body = getActor(actor.id);
  });
  post("/actors/:id/qualifications", (ctx) => {
    const actor = getActor(ctx.params.id);
    const b = bodyOf(ctx);
    need(b, ["role", "validFrom", "validUntil"]);
    const validFrom = isoTs(b.validFrom, "validFrom");
    const validUntil = isoTs(b.validUntil, "validUntil");
    if (validUntil <= validFrom) throw badRequest("validUntil 必须晚于 validFrom");
    const id = randomUUID();
    db.prepare(
      "INSERT INTO qualifications (id, actorId, role, validFrom, validUntil, version) VALUES (?, ?, ?, ?, ?, 1)",
    ).run(id, actor.id, str(b.role, "role"), validFrom, validUntil);
    ctx.status = 201;
    ctx.body = db.prepare("SELECT * FROM qualifications WHERE id = ?").get(id);
  });
  del("/qualifications/:id", (ctx) => {
    const qual = mustGet<QualificationRow>(
      "SELECT * FROM qualifications WHERE id = ?",
      ctx.params.id,
      "资质",
    );
    const version = expectedVersionOf(bodyOf(ctx));
    updateWithVersion(db, "qualifications", qual.id, version, {
      validUntil: nowIso(),
    });
    ctx.body = { id: qual.id, revoked: true };
  });

  // ---------- 区域与转场 ----------
  post("/zones", (ctx) => {
    const b = bodyOf(ctx);
    need(b, ["name", "capacity"]);
    const id = typeof b.id === "string" && b.id ? b.id : randomUUID();
    db.prepare("INSERT INTO zones (id, name, capacity, status, version) VALUES (?, ?, ?, 'open', 1)").run(
      id,
      str(b.name, "name"),
      num(b.capacity, "capacity", 1),
    );
    ctx.status = 201;
    ctx.body = getZone(id);
  });
  get("/zones", (ctx) => {
    ctx.body = db.prepare("SELECT * FROM zones ORDER BY id").all();
  });
  post("/zones/:id/outage", (ctx) => {
    getZone(ctx.params.id);
    const b = bodyOf(ctx);
    need(b, ["from", "to", "reason"]);
    const from = isoTs(b.from, "from");
    const to = isoTs(b.to, "to");
    if (to <= from) throw badRequest("to 必须晚于 from");
    ctx.body = handleZoneOutage(db, clock, ctx.params.id, { from, to }, str(b.reason, "reason"));
  });
  post("/zones/:id/reopen", (ctx) => {
    const zone = getZone(ctx.params.id);
    db.prepare("UPDATE zones SET status = 'open', version = version + 1 WHERE id = ?").run(zone.id);
    logEvent(db, clock, "zone_reopened", "zone", zone.id, {});
    ctx.body = getZone(zone.id);
  });
  post("/transfers", (ctx) => {
    const b = bodyOf(ctx);
    need(b, ["fromZone", "toZone", "minutes"]);
    const fromZone = str(b.fromZone, "fromZone");
    const toZone = str(b.toZone, "toZone");
    getZone(fromZone);
    getZone(toZone);
    db.prepare(
      "INSERT INTO transfers (fromZone, toZone, minutes) VALUES (?, ?, ?) ON CONFLICT(fromZone, toZone) DO UPDATE SET minutes = excluded.minutes",
    ).run(fromZone, toZone, num(b.minutes, "minutes"));
    ctx.status = 201;
    ctx.body = { fromZone, toZone, minutes: b.minutes };
  });
  get("/transfers", (ctx) => {
    ctx.body = db.prepare("SELECT * FROM transfers ORDER BY fromZone, toZone").all();
  });

  // ---------- 场次模板 ----------
  post("/templates", (ctx) => {
    const b = bodyOf(ctx);
    need(b, ["name", "zoneId", "durationMinutes", "requirements"]);
    getZone(str(b.zoneId, "zoneId"));
    if (!Array.isArray(b.requirements) || b.requirements.length === 0) {
      throw badRequest("requirements 必须是非空数组 [{role, count}]");
    }
    for (const r of b.requirements as Requirement[]) {
      if (typeof r.role !== "string" || typeof r.count !== "number" || r.count < 1) {
        throw badRequest("requirements 元素必须是 {role: string, count: >=1}");
      }
    }
    const id = typeof b.id === "string" && b.id ? b.id : randomUUID();
    db.prepare(
      "INSERT INTO templates (id, name, zoneId, durationMinutes, requirements, version) VALUES (?, ?, ?, ?, ?, 1)",
    ).run(id, str(b.name, "name"), b.zoneId, num(b.durationMinutes, "durationMinutes", 1), JSON.stringify(b.requirements));
    ctx.status = 201;
    ctx.body = getTemplate(id);
  });
  get("/templates", (ctx) => {
    ctx.body = db.prepare("SELECT * FROM templates ORDER BY id").all();
  });

  // ---------- 场次 ----------
  post("/sessions", (ctx) => {
    const b = bodyOf(ctx);
    need(b, ["templateId", "startTs"]);
    const template = getTemplate(str(b.templateId, "templateId"));
    const startTs = isoTs(b.startTs, "startTs");
    const endTs = new Date(Date.parse(startTs) + template.durationMinutes * 60000).toISOString();
    const id = typeof b.id === "string" && b.id ? b.id : randomUUID();
    db.prepare(
      "INSERT INTO sessions (id, templateId, startTs, endTs, status, version) VALUES (?, ?, ?, ?, 'scheduled', 1)",
    ).run(id, template.id, startTs, endTs);
    ctx.status = 201;
    ctx.body = getSessionOr404(id);
  });
  get("/sessions", (ctx) => {
    const from = ctx.query.from ?? "0000-01-01";
    const to = ctx.query.to ?? "9999-12-31";
    ctx.body = db
      .prepare(
        `SELECT s.*, t.name AS templateName, t.zoneId, z.name AS zoneName
         FROM sessions s JOIN templates t ON s.templateId = t.id JOIN zones z ON t.zoneId = z.id
         WHERE s.startTs >= ? AND s.startTs <= ? ORDER BY s.startTs`,
      )
      .all(from, to);
  });
  get("/sessions/:id", (ctx) => {
    const session = getSessionOr404(ctx.params.id);
    const template = getTemplate(session.templateId);
    const assignments = db
      .prepare(
        `SELECT a.*, ac.name AS actorName FROM assignments a JOIN actors ac ON a.actorId = ac.id
         WHERE a.sessionId = ? AND a.status = 'active'`,
      )
      .all(session.id);
    const reservations = db
      .prepare("SELECT * FROM reservations WHERE sessionId = ? AND status = 'confirmed'")
      .all(session.id);
    ctx.body = {
      ...session,
      template,
      confirmedVisitors: confirmedVisitorCount(db, session.id),
      assignments: (assignments as (AssignmentRow & { actorName: string })[]).map((a) => ({
        ...a,
        trace: JSON.parse(a.trace),
      })),
      reservations,
    };
  });
  patch("/sessions/:id", (ctx) => {
    const session = getSessionOr404(ctx.params.id);
    const b = bodyOf(ctx);
    const version = expectedVersionOf(b);
    need(b, ["startTs"]);
    assertSessionMutable(session);
    const startTs = isoTs(b.startTs, "startTs");
    const template = getTemplate(session.templateId);
    const endTs = new Date(Date.parse(startTs) + template.durationMinutes * 60000).toISOString();
    const tx = db.transaction(() => {
      updateWithVersion(db, "sessions", session.id, version, { startTs, endTs });
      // 改期使原分配失效：撤销并向演员发送待确认的取消通知，由重新生成补齐
      const active = db
        .prepare("SELECT * FROM assignments WHERE sessionId = ? AND status = 'active'")
        .all(session.id) as AssignmentRow[];
      for (const a of active) {
        cancelAssignmentRow(db, clock, a, "场次改期，原分配失效");
      }
      db.prepare("DELETE FROM unmet_requirements WHERE sessionId = ?").run(session.id);
      logEvent(db, clock, "session_rescheduled", "session", session.id, {
        from: session.startTs,
        to: startTs,
        cancelledAssignments: active.length,
      });
    });
    tx();
    ctx.body = getSessionOr404(session.id);
  });
  post("/sessions/:id/cancel", (ctx) => {
    const session = getSessionOr404(ctx.params.id);
    const b = bodyOf(ctx);
    const version = expectedVersionOf(b);
    need(b, ["reason"]);
    if (session.version !== version) {
      throw conflict(`版本冲突：期望版本 ${version}，场次已被他人修改，请刷新后重试`, {
        id: session.id,
        expectedVersion: version,
      });
    }
    if (session.status === "cancelled") throw unprocessable("场次已取消");
    if (session.status === "finished") throw unprocessable("场次已结束，不能取消");
    const started = isSessionStarted(session, nowIso());
    if (started && b.force !== true) {
      throw unprocessable("场次已开始，不能静默停演；如确需中断请显式携带 force: true", {
        sessionId: session.id,
      });
    }
    const result = cancelSession(db, clock, session, str(b.reason, "reason"), {
      force: b.force === true,
    });
    ctx.body = { sessionId: session.id, status: "cancelled", ...result };
  });
  post("/sessions/:id/start", (ctx) => {
    const session = getSessionOr404(ctx.params.id);
    const version = expectedVersionOf(bodyOf(ctx));
    if (session.status !== "scheduled") throw unprocessable(`场次状态为 ${session.status}，不能开始`);
    updateWithVersion(db, "sessions", session.id, version, { status: "started" });
    logEvent(db, clock, "session_started", "session", session.id, {});
    ctx.body = getSessionOr404(session.id);
  });
  post("/sessions/:id/finish", (ctx) => {
    const session = getSessionOr404(ctx.params.id);
    const version = expectedVersionOf(bodyOf(ctx));
    if (session.status !== "started") throw unprocessable(`场次状态为 ${session.status}，不能结束`);
    updateWithVersion(db, "sessions", session.id, version, { status: "finished" });
    logEvent(db, clock, "session_finished", "session", session.id, {});
    ctx.body = getSessionOr404(session.id);
  });

  // ---------- 预约 ----------
  post("/sessions/:id/reservations", (ctx) => {
    const session = getSessionOr404(ctx.params.id);
    if (session.status !== "scheduled") throw unprocessable(`场次状态为 ${session.status}，不能预约`);
    const b = bodyOf(ctx);
    need(b, ["visitorGroup", "size"]);
    const id = randomUUID();
    db.prepare(
      "INSERT INTO reservations (id, sessionId, visitorGroup, size, status, version) VALUES (?, ?, ?, ?, 'confirmed', 1)",
    ).run(id, session.id, str(b.visitorGroup, "visitorGroup"), num(b.size, "size", 1));
    ctx.status = 201;
    ctx.body = db.prepare("SELECT * FROM reservations WHERE id = ?").get(id);
  });
  del("/reservations/:id", (ctx) => {
    const r = mustGet<{ id: string; status: string; version: number }>(
      "SELECT * FROM reservations WHERE id = ?",
      ctx.params.id,
      "预约",
    );
    const version = expectedVersionOf(bodyOf(ctx));
    updateWithVersion(db, "reservations", r.id, version, { status: "cancelled" });
    ctx.body = { id: r.id, status: "cancelled" };
  });

  // ---------- 方案生成与解释 ----------
  post("/plans/generate", (ctx) => {
    const b = bodyOf(ctx);
    need(b, ["from", "to"]);
    const from = isoTs(b.from, "from");
    const to = isoTs(b.to, "to");
    if (to <= from) throw badRequest("to 必须晚于 from");
    ctx.body = generatePlan(db, clock, { from, to });
  });
  get("/plans/explain", (ctx) => {
    const from = ctx.query.from ?? "0000-01-01";
    const to = ctx.query.to ?? "9999-12-31";
    ctx.body = buildPlanExplanation(db, { from, to });
  });
  get("/sessions/:id/explain", (ctx) => {
    getSessionOr404(ctx.params.id);
    ctx.body = buildSessionExplanation(db, ctx.params.id);
  });

  // ---------- 人工调整（并发版本冲突检测） ----------
  post("/sessions/:id/assignments", (ctx) => {
    const session = getSessionOr404(ctx.params.id);
    const b = bodyOf(ctx);
    const version = expectedVersionOf(b);
    need(b, ["actorId", "role"]);
    assertSessionMutable(session);
    if (session.version !== version) {
      throw conflict(`版本冲突：期望版本 ${version}，场次已被他人修改，请刷新后重试`, {
        id: session.id,
        expectedVersion: version,
      });
    }
    const actor = getActor(str(b.actorId, "actorId"));
    const role = str(b.role, "role");
    const template = getTemplate(session.templateId);
    const quals = db
      .prepare("SELECT * FROM qualifications WHERE actorId = ?")
      .all(actor.id) as QualificationRow[];
    const trace = checkAssignment({
      role,
      actor,
      qualifications: quals,
      session,
      zoneId: template.zoneId,
      actorAssignments: activeAssignmentsOfActor(db, actor.id),
      transferMinutes: transferMinutesLookup(loadTransfers(db)),
      rules: rules(),
    });
    const violations = violationsOf(trace);
    const force = b.force === true;
    if (violations.length > 0 && !force) {
      throw unprocessable("分配违反约束，未执行；如确需强制请携带 force: true", {
        violations,
      });
    }
    if (force) {
      for (const t of trace) if (!t.ok) t.overridden = true;
    }
    trace.push({
      constraint: "manual",
      ok: true,
      detail: force ? "调度员人工强制分配，违规项已标记 overridden" : "调度员人工分配",
    });
    let created: AssignmentRow | undefined;
    const tx = db.transaction(() => {
      created = insertAssignment(db, clock, rules(), {
        sessionId: session.id,
        actorId: actor.id,
        role,
        locked: true,
        trace: trace as TraceEntry[],
      });
      // 场次人员变化即版本递增：并发调整同一场次会在版本检查处被发现
      db.prepare("UPDATE sessions SET version = version + 1 WHERE id = ?").run(session.id);
    });
    tx();
    ctx.status = 201;
    ctx.body = { ...created!, trace: JSON.parse(created!.trace) };
  });
  del("/assignments/:id", (ctx) => {
    const assignment = getAssignment(ctx.params.id);
    const b = bodyOf(ctx);
    const version = expectedVersionOf(b);
    const session = getSessionOr404(assignment.sessionId);
    assertSessionMutable(session);
    if (assignment.status !== "active") throw conflict("分配已撤销，不能重复操作");
    if (assignment.version !== version) {
      throw conflict(`版本冲突：期望版本 ${version}，分配已被他人修改，请刷新后重试`, {
        id: assignment.id,
        expectedVersion: version,
      });
    }
    const tx = db.transaction(() => {
      cancelAssignmentRow(db, clock, assignment, String(b.reason ?? "调度员手动撤销"));
      // 场次人员变化即版本递增：并发调整同一场次会在版本检查处被发现
      db.prepare("UPDATE sessions SET version = version + 1 WHERE id = ?").run(session.id);
    });
    tx();
    ctx.body = { id: assignment.id, status: "cancelled" };
  });

  // ---------- 打卡 ----------
  post("/actors/:id/checkin", (ctx) => {
    const actor = getActor(ctx.params.id);
    const b = bodyOf(ctx);
    need(b, ["status"]);
    const status = str(b.status, "status");
    if (status === "on_time") {
      logEvent(db, clock, "checkin_on_time", "actor", actor.id, {});
      ctx.body = { actorId: actor.id, status: "on_time", replanned: false };
      return;
    }
    if (status !== "late") throw badRequest("status 必须是 on_time 或 late");
    const lateMinutes = num(b.lateMinutes ?? 0, "lateMinutes", 1);
    ctx.body = handleLateCheckin(db, clock, actor.id, lateMinutes);
  });

  // ---------- 通知与升级 ----------
  get("/notifications", (ctx) => {
    const conds: string[] = [];
    const args: unknown[] = [];
    if (ctx.query.status) {
      conds.push("n.status = ?");
      args.push(ctx.query.status);
    }
    if (ctx.query.actorId) {
      conds.push("n.actorId = ?");
      args.push(ctx.query.actorId);
    }
    const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
    ctx.body = db
      .prepare(
        `SELECT n.*, a.name AS actorName FROM notifications n JOIN actors a ON n.actorId = a.id ${where} ORDER BY n.createdTs DESC LIMIT 200`,
      )
      .all(...args);
  });
  post("/notifications/:id/confirm", (ctx) => {
    const b = bodyOf(ctx);
    need(b, ["actorId"]);
    ctx.body = confirmNotification(db, clock, ctx.params.id, str(b.actorId, "actorId"));
  });
  get("/escalations", (ctx) => {
    ctx.body = db
      .prepare(
        `SELECT e.*, n.actorId, n.kind, a.name AS actorName FROM escalations e
         JOIN notifications n ON e.notificationId = n.id
         JOIN actors a ON n.actorId = a.id ORDER BY e.createdTs DESC LIMIT 200`,
      )
      .all();
  });

  // ---------- 审计 ----------
  get("/events", (ctx) => {
    const limit = Math.min(Number(ctx.query.limit ?? 100), 500);
    ctx.body = db.prepare("SELECT * FROM events ORDER BY ts DESC, id DESC LIMIT ?").all(limit);
  });

  return router;
}
