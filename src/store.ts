import { randomUUID } from "node:crypto";
import type { Db } from "./db.js";
import { badRequest, notFound } from "./errors.js";

export interface Actor {
  id: string;
  name: string;
  version: number;
}

export interface Qualification {
  actorId: string;
  role: string;
  validFrom: string;
  validUntil: string;
}

export interface Zone {
  id: string;
  name: string;
  capacity: number;
}

export interface ShowTemplate {
  id: string;
  name: string;
  zoneId: string;
  durationMinutes: number;
}

export interface TemplateRole {
  templateId: string;
  role: string;
  requiredCount: number;
  isKey: boolean;
}

export type SessionStatus = "scheduled" | "started" | "completed" | "cancelled";

export interface Session {
  id: string;
  templateId: string;
  startsAt: string;
  status: SessionStatus;
  version: number;
}

/** 场次 + 模板展开信息，约束评估与计划生成的主视图。 */
export interface SessionView extends Session {
  templateName: string;
  zoneId: string;
  durationMinutes: number;
  endsAt: string;
}

export interface Reservation {
  id: string;
  sessionId: string;
  partySize: number;
  status: "confirmed" | "cancelled";
}

export type AssignmentState = "notified" | "confirmed" | "superseded" | "cancelled";
export const ACTIVE_ASSIGNMENT_STATES: AssignmentState[] = ["notified", "confirmed"];

export interface Assignment {
  id: string;
  sessionId: string;
  role: string;
  actorId: string;
  state: AssignmentState;
  reason: string; // JSON：分配时采用的约束检查结果
  createdAt: string;
  version: number;
}

export interface Notification {
  id: string;
  actorId: string;
  assignmentId: string | null;
  kind: "assignment_offered" | "assignment_cancelled" | "escalation";
  payload: string;
  status: "pending" | "confirmed" | "escalated" | "cancelled";
  createdAt: string;
  deadline: string | null;
  confirmedAt: string | null;
}

export interface UnmetDemand {
  id: number;
  runId: string;
  sessionId: string | null;
  kind: string;
  detail: string;
  createdAt: string;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function mapActor(r: any): Actor {
  return { id: r.id, name: r.name, version: r.version };
}
function mapQual(r: any): Qualification {
  return { actorId: r.actor_id, role: r.role, validFrom: r.valid_from, validUntil: r.valid_until };
}
function mapZone(r: any): Zone {
  return { id: r.id, name: r.name, capacity: r.capacity };
}
function mapTemplate(r: any): ShowTemplate {
  return { id: r.id, name: r.name, zoneId: r.zone_id, durationMinutes: r.duration_minutes };
}
function mapTemplateRole(r: any): TemplateRole {
  return { templateId: r.template_id, role: r.role, requiredCount: r.required_count, isKey: !!r.is_key };
}
function mapSession(r: any): Session {
  return { id: r.id, templateId: r.template_id, startsAt: r.starts_at, status: r.status, version: r.version };
}
function mapSessionView(r: any): SessionView {
  const startsAt: string = r.starts_at;
  const endsAt = new Date(Date.parse(startsAt) + r.duration_minutes * 60_000).toISOString();
  return {
    ...mapSession(r),
    templateName: r.template_name,
    zoneId: r.zone_id,
    durationMinutes: r.duration_minutes,
    endsAt,
  };
}
function mapReservation(r: any): Reservation {
  return { id: r.id, sessionId: r.session_id, partySize: r.party_size, status: r.status };
}
function mapAssignment(r: any): Assignment {
  return {
    id: r.id,
    sessionId: r.session_id,
    role: r.role,
    actorId: r.actor_id,
    state: r.state,
    reason: r.reason,
    createdAt: r.created_at,
    version: r.version,
  };
}
function mapNotification(r: any): Notification {
  return {
    id: r.id,
    actorId: r.actor_id,
    assignmentId: r.assignment_id,
    kind: r.kind,
    payload: r.payload,
    status: r.status,
    createdAt: r.created_at,
    deadline: r.deadline,
    confirmedAt: r.confirmed_at,
  };
}
function mapUnmet(r: any): UnmetDemand {
  return { id: r.id, runId: r.run_id, sessionId: r.session_id, kind: r.kind, detail: r.detail, createdAt: r.created_at };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const SESSION_VIEW_SELECT = `
  SELECT s.id, s.template_id, s.starts_at, s.status, s.version,
         t.name AS template_name, t.zone_id, t.duration_minutes
  FROM sessions s JOIN show_templates t ON t.id = s.template_id`;

export class Store {
  constructor(public db: Db) {}

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  // ---- 配置 ----
  configNumber(key: string): number {
    const row = this.db.prepare(`SELECT value FROM config WHERE key = ?`).get(key) as { value: string } | undefined;
    if (!row) throw badRequest(`未知配置项: ${key}`);
    return Number(row.value);
  }
  configString(key: string): string {
    const row = this.db.prepare(`SELECT value FROM config WHERE key = ?`).get(key) as { value: string } | undefined;
    if (!row) throw badRequest(`未知配置项: ${key}`);
    return row.value;
  }
  setConfig(key: string, value: string): void {
    const r = this.db.prepare(`UPDATE config SET value = ? WHERE key = ?`).run(value, key);
    if (r.changes === 0) throw badRequest(`未知配置项: ${key}`);
  }
  allConfig(): Record<string, string> {
    const rows = this.db.prepare(`SELECT key, value FROM config ORDER BY key`).all() as { key: string; value: string }[];
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }

  // ---- 演员与资质 ----
  createActor(id: string | undefined, name: string): Actor {
    const actorId = id ?? randomUUID();
    this.db.prepare(`INSERT INTO actors(id, name) VALUES (?, ?)`).run(actorId, name);
    return this.getActor(actorId);
  }
  getActor(id: string): Actor {
    const r = this.db.prepare(`SELECT * FROM actors WHERE id = ?`).get(id);
    if (!r) throw notFound("actor", id);
    return mapActor(r);
  }
  findActor(id: string): Actor | null {
    const r = this.db.prepare(`SELECT * FROM actors WHERE id = ?`).get(id);
    return r ? mapActor(r) : null;
  }
  listActors(): Actor[] {
    return (this.db.prepare(`SELECT * FROM actors ORDER BY id`).all() as any[]).map(mapActor);
  }
  bumpActorVersion(id: string): number {
    this.db.prepare(`UPDATE actors SET version = version + 1 WHERE id = ?`).run(id);
    return this.getActor(id).version;
  }
  replaceQualifications(actorId: string, quals: { role: string; validFrom: string; validUntil: string }[]): void {
    this.db.prepare(`DELETE FROM qualifications WHERE actor_id = ?`).run(actorId);
    const ins = this.db.prepare(
      `INSERT INTO qualifications(actor_id, role, valid_from, valid_until) VALUES (?, ?, ?, ?)`,
    );
    for (const q of quals) ins.run(actorId, q.role, q.validFrom, q.validUntil);
  }
  qualificationsOf(actorId: string): Qualification[] {
    return (this.db.prepare(`SELECT * FROM qualifications WHERE actor_id = ?`).all(actorId) as any[]).map(mapQual);
  }
  /** 在指定时刻持有有效资质的所有演员。 */
  actorsQualifiedFor(role: string, atIso: string, endIso: string): Actor[] {
    const rows = this.db
      .prepare(
        `SELECT a.* FROM actors a JOIN qualifications q ON q.actor_id = a.id
         WHERE q.role = ? AND q.valid_from <= ? AND q.valid_until >= ? ORDER BY a.id`,
      )
      .all(role, atIso, endIso) as any[];
    return rows.map(mapActor);
  }

  // ---- 区域与转场 ----
  upsertZone(id: string, name: string, capacity: number): Zone {
    this.db
      .prepare(`INSERT INTO zones(id, name, capacity) VALUES (?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET name = excluded.name, capacity = excluded.capacity`)
      .run(id, name, capacity);
    return mapZone(this.db.prepare(`SELECT * FROM zones WHERE id = ?`).get(id));
  }
  getZone(id: string): Zone {
    const r = this.db.prepare(`SELECT * FROM zones WHERE id = ?`).get(id);
    if (!r) throw notFound("zone", id);
    return mapZone(r);
  }
  listZones(): Zone[] {
    return (this.db.prepare(`SELECT * FROM zones ORDER BY id`).all() as any[]).map(mapZone);
  }
  upsertTransfer(fromZone: string, toZone: string, minutes: number): void {
    this.db
      .prepare(`INSERT INTO transfer_times(from_zone, to_zone, minutes) VALUES (?, ?, ?)
                ON CONFLICT(from_zone, to_zone) DO UPDATE SET minutes = excluded.minutes`)
      .run(fromZone, toZone, minutes);
  }
  listTransfers(): { fromZone: string; toZone: string; minutes: number }[] {
    const rows = this.db.prepare(`SELECT * FROM transfer_times ORDER BY from_zone, to_zone`).all() as any[];
    return rows.map((r) => ({ fromZone: r.from_zone, toZone: r.to_zone, minutes: r.minutes }));
  }
  /** 已配置的转场分钟数；同区为 0；未配置返回 null（调用方决定兜底）。 */
  configuredTransferMinutes(fromZone: string, toZone: string): number | null {
    if (fromZone === toZone) return 0;
    const r = this.db
      .prepare(`SELECT minutes FROM transfer_times WHERE from_zone = ? AND to_zone = ?`)
      .get(fromZone, toZone) as { minutes: number } | undefined;
    return r ? r.minutes : null;
  }

  // ---- 模板 ----
  createTemplate(t: ShowTemplate, roles: { role: string; requiredCount: number; isKey: boolean }[]): ShowTemplate {
    this.getZone(t.zoneId);
    this.db
      .prepare(`INSERT INTO show_templates(id, name, zone_id, duration_minutes) VALUES (?, ?, ?, ?)`)
      .run(t.id, t.name, t.zoneId, t.durationMinutes);
    const ins = this.db.prepare(
      `INSERT INTO template_roles(template_id, role, required_count, is_key) VALUES (?, ?, ?, ?)`,
    );
    for (const r of roles) ins.run(t.id, r.role, r.requiredCount, r.isKey ? 1 : 0);
    return t;
  }
  getTemplate(id: string): ShowTemplate {
    const r = this.db.prepare(`SELECT * FROM show_templates WHERE id = ?`).get(id);
    if (!r) throw notFound("template", id);
    return mapTemplate(r);
  }
  listTemplates(): ShowTemplate[] {
    return (this.db.prepare(`SELECT * FROM show_templates ORDER BY id`).all() as any[]).map(mapTemplate);
  }
  templateRoles(templateId: string): TemplateRole[] {
    return (
      this.db.prepare(`SELECT * FROM template_roles WHERE template_id = ? ORDER BY role`).all(templateId) as any[]
    ).map(mapTemplateRole);
  }

  // ---- 场次 ----
  createSession(id: string | undefined, templateId: string, startsAt: string): Session {
    this.getTemplate(templateId);
    const sid = id ?? randomUUID();
    this.db.prepare(`INSERT INTO sessions(id, template_id, starts_at) VALUES (?, ?, ?)`).run(sid, templateId, startsAt);
    return this.getSession(sid);
  }
  getSession(id: string): Session {
    const r = this.db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id);
    if (!r) throw notFound("session", id);
    return mapSession(r);
  }
  getSessionView(id: string): SessionView {
    const r = this.db.prepare(`${SESSION_VIEW_SELECT} WHERE s.id = ?`).get(id);
    if (!r) throw notFound("session", id);
    return mapSessionView(r);
  }
  /** 开始时间落在 [from, to) 内的场次（含各状态），按计划开始时间排序。 */
  sessionsStartingBetween(fromIso: string, toIso: string): SessionView[] {
    const rows = this.db
      .prepare(`${SESSION_VIEW_SELECT} WHERE s.starts_at >= ? AND s.starts_at < ? ORDER BY s.starts_at, s.id`)
      .all(fromIso, toIso) as any[];
    return rows.map(mapSessionView);
  }
  /** 与 [from, to) 时间区间相交的场次。 */
  sessionsOverlapping(fromIso: string, toIso: string): SessionView[] {
    const rows = this.db
      .prepare(`${SESSION_VIEW_SELECT} WHERE s.starts_at < ? ORDER BY s.starts_at, s.id`)
      .all(toIso) as any[];
    const fromMs = Date.parse(fromIso);
    return rows.map(mapSessionView).filter((s) => Date.parse(s.endsAt) > fromMs);
  }
  setSessionStatus(id: string, status: SessionStatus): void {
    this.db.prepare(`UPDATE sessions SET status = ?, version = version + 1 WHERE id = ?`).run(status, id);
  }
  bumpSessionVersion(id: string): number {
    this.db.prepare(`UPDATE sessions SET version = version + 1 WHERE id = ?`).run(id);
    return this.getSession(id).version;
  }

  // ---- 预约 ----
  createReservation(sessionId: string, partySize: number): Reservation {
    this.getSession(sessionId);
    const id = randomUUID();
    this.db.prepare(`INSERT INTO reservations(id, session_id, party_size) VALUES (?, ?, ?)`).run(id, sessionId, partySize);
    return mapReservation(this.db.prepare(`SELECT * FROM reservations WHERE id = ?`).get(id));
  }
  getReservation(id: string): Reservation {
    const r = this.db.prepare(`SELECT * FROM reservations WHERE id = ?`).get(id);
    if (!r) throw notFound("reservation", id);
    return mapReservation(r);
  }
  cancelReservation(id: string): void {
    this.db.prepare(`UPDATE reservations SET status = 'cancelled' WHERE id = ?`).run(id);
  }
  confirmedSeats(sessionId: string): number {
    const r = this.db
      .prepare(`SELECT COALESCE(SUM(party_size), 0) AS seats FROM reservations WHERE session_id = ? AND status = 'confirmed'`)
      .get(sessionId) as { seats: number };
    return r.seats;
  }
  /** 有已确认预约的场次为“预约锁定”，重排时不可取消、已有分配保持稳定。 */
  isReservationLocked(sessionId: string): boolean {
    return this.confirmedSeats(sessionId) > 0;
  }
  reservationsOf(sessionId: string): Reservation[] {
    return (
      this.db.prepare(`SELECT * FROM reservations WHERE session_id = ? ORDER BY rowid`).all(sessionId) as any[]
    ).map(mapReservation);
  }

  // ---- 分配 ----
  createAssignment(a: { sessionId: string; role: string; actorId: string; reason: string; createdAt: string }): Assignment {
    const id = randomUUID();
    this.db
      .prepare(`INSERT INTO assignments(id, session_id, role, actor_id, state, reason, created_at)
                VALUES (?, ?, ?, ?, 'notified', ?, ?)`)
      .run(id, a.sessionId, a.role, a.actorId, a.reason, a.createdAt);
    return this.getAssignment(id);
  }
  getAssignment(id: string): Assignment {
    const r = this.db.prepare(`SELECT * FROM assignments WHERE id = ?`).get(id);
    if (!r) throw notFound("assignment", id);
    return mapAssignment(r);
  }
  setAssignmentState(id: string, state: AssignmentState): void {
    this.db.prepare(`UPDATE assignments SET state = ?, version = version + 1 WHERE id = ?`).run(state, id);
  }
  activeAssignmentsOfSession(sessionId: string): Assignment[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM assignments WHERE session_id = ? AND state IN ('notified','confirmed') ORDER BY role, actor_id`,
        )
        .all(sessionId) as any[]
    ).map(mapAssignment);
  }
  /** 演员当前的有效分配（含场次视图，按开始时间排序），用于转场/休息评估。 */
  activeAssignmentsOfActor(actorId: string): (Assignment & { session: SessionView })[] {
    const rows = this.db
      .prepare(
        `SELECT a.id, a.session_id, a.role, a.actor_id, a.state, a.reason, a.created_at, a.version,
                s.template_id, s.starts_at, s.status, s.version AS session_version,
                t.name AS template_name, t.zone_id, t.duration_minutes
         FROM assignments a
         JOIN sessions s ON s.id = a.session_id
         JOIN show_templates t ON t.id = s.template_id
         WHERE a.actor_id = ? AND a.state IN ('notified','confirmed') AND s.status != 'cancelled'
         ORDER BY s.starts_at`,
      )
      .all(actorId) as any[];
    return rows.map((r) => ({
      ...mapAssignment(r),
      session: mapSessionView({ ...r, id: r.session_id, version: r.session_version }),
    }));
  }
  /** 演员当前是否已在某场次持有有效分配（防同人同场多岗）。 */
  hasActiveAssignmentOn(sessionId: string, actorId: string): boolean {
    const r = this.db
      .prepare(
        `SELECT 1 AS x FROM assignments WHERE session_id = ? AND actor_id = ? AND state IN ('notified','confirmed') LIMIT 1`,
      )
      .get(sessionId, actorId);
    return !!r;
  }

  // ---- 通知 ----
  createNotification(n: {
    actorId: string;
    assignmentId: string | null;
    kind: Notification["kind"];
    payload: string;
    createdAt: string;
    deadline: string | null;
  }): Notification {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO notifications(id, actor_id, assignment_id, kind, payload, status, created_at, deadline)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(id, n.actorId, n.assignmentId, n.kind, n.payload, n.createdAt, n.deadline);
    return this.getNotification(id);
  }
  getNotification(id: string): Notification {
    const r = this.db.prepare(`SELECT * FROM notifications WHERE id = ?`).get(id);
    if (!r) throw notFound("notification", id);
    return mapNotification(r);
  }
  setNotificationStatus(id: string, status: Notification["status"], confirmedAt?: string): void {
    this.db
      .prepare(`UPDATE notifications SET status = ?, confirmed_at = COALESCE(?, confirmed_at) WHERE id = ?`)
      .run(status, confirmedAt ?? null, id);
  }
  pendingNotificationsOfAssignment(assignmentId: string): Notification[] {
    return (
      this.db
        .prepare(`SELECT * FROM notifications WHERE assignment_id = ? AND status = 'pending'`)
        .all(assignmentId) as any[]
    ).map(mapNotification);
  }
  listNotifications(filter: { actorId?: string; status?: string }): Notification[] {
    let sql = `SELECT * FROM notifications`;
    const cond: string[] = [];
    const args: string[] = [];
    if (filter.actorId) {
      cond.push(`actor_id = ?`);
      args.push(filter.actorId);
    }
    if (filter.status) {
      cond.push(`status = ?`);
      args.push(filter.status);
    }
    if (cond.length) sql += ` WHERE ${cond.join(" AND ")}`;
    sql += ` ORDER BY created_at, id`;
    return (this.db.prepare(sql).all(...args) as any[]).map(mapNotification);
  }
  overduePendingNotifications(nowIso: string): Notification[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM notifications WHERE status = 'pending' AND kind != 'escalation' AND deadline IS NOT NULL AND deadline <= ?`,
        )
        .all(nowIso) as any[]
    ).map(mapNotification);
  }

  // ---- 未满足需求 ----
  insertUnmet(runId: string, sessionId: string | null, kind: string, detail: unknown, createdAt: string): void {
    this.db
      .prepare(`INSERT INTO unmet_demands(run_id, session_id, kind, detail, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(runId, sessionId, kind, JSON.stringify(detail), createdAt);
  }
  unmetOfRun(runId: string): UnmetDemand[] {
    return (
      this.db.prepare(`SELECT * FROM unmet_demands WHERE run_id = ? ORDER BY id`).all(runId) as any[]
    ).map(mapUnmet);
  }
  /** 计划类运行互相替换：新一轮计划清除上一轮计划的未满足记录。 */
  deleteUnmetByRunPrefix(prefix: string): void {
    this.db.prepare(`DELETE FROM unmet_demands WHERE run_id LIKE ?`).run(`${prefix}%`);
  }
  /** 当前全部未满足需求：最新一轮计划 + 各事件运行累积。 */
  allUnmet(): UnmetDemand[] {
    return (this.db.prepare(`SELECT * FROM unmet_demands ORDER BY id DESC`).all() as any[]).map(mapUnmet);
  }

  // ---- 审计 ----
  audit(at: string, operator: string | null, action: string, detail: unknown): void {
    this.db
      .prepare(`INSERT INTO audit_log(at, operator, action, detail) VALUES (?, ?, ?, ?)`)
      .run(at, operator, action, JSON.stringify(detail));
  }
  listAudit(limit = 100): { id: number; at: string; operator: string | null; action: string; detail: string }[] {
    return this.db.prepare(`SELECT * FROM audit_log ORDER BY id DESC LIMIT ?`).all(limit) as any[];
  }
}
