import { randomUUID } from "node:crypto";
import { DB } from "./db.js";
import {
  AssignmentRow,
  Clock,
  SessionRow,
  TransferRow,
  conflict,
  notFound,
} from "./types.js";

/** 写审计事件，支撑“每次变更可追溯”。 */
export function logEvent(
  db: DB,
  clock: Clock,
  kind: string,
  entityType: string,
  entityId: string,
  detail: unknown = {},
): void {
  db.prepare(
    "INSERT INTO events (id, ts, kind, entityType, entityId, detail) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(randomUUID(), clock().toISOString(), kind, entityType, entityId, JSON.stringify(detail));
}

/**
 * 乐观锁更新：仅当版本匹配时写入并自增版本。
 * 版本不匹配时区分 404（不存在）与 409（并发冲突）。
 */
export function updateWithVersion(
  db: DB,
  table: "actors" | "sessions" | "assignments" | "reservations" | "qualifications" | "notifications" | "zones",
  id: string,
  expectedVersion: number,
  sets: Record<string, unknown>,
): void {
  const keys = Object.keys(sets);
  const sql = `UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(", ")}, version = version + 1 WHERE id = ? AND version = ?`;
  const res = db.prepare(sql).run(...keys.map((k) => sets[k]), id, expectedVersion);
  if (res.changes === 0) {
    const exists = db.prepare(`SELECT id FROM ${table} WHERE id = ?`).get(id);
    if (!exists) throw notFound(`${table} 记录不存在: ${id}`);
    throw conflict(`版本冲突：期望版本 ${expectedVersion}，记录已被他人修改，请刷新后重试`, {
      entity: table,
      id,
      expectedVersion,
    });
  }
}

/** 场次是否已开始（含按时间自然开始），已开始的场次不允许被静默改写。 */
export function isSessionStarted(session: SessionRow, nowIso: string): boolean {
  return session.status === "started" || session.startTs <= nowIso;
}

export function isSessionFrozen(session: SessionRow, nowIso: string): boolean {
  return (
    session.status === "started" ||
    session.status === "finished" ||
    session.startTs <= nowIso
  );
}

export function loadTransfers(db: DB): Map<string, number> {
  const rows = db.prepare("SELECT fromZone, toZone, minutes FROM transfers").all() as TransferRow[];
  return new Map(rows.map((r) => [`${r.fromZone}->${r.toZone}`, r.minutes]));
}

export function transferMinutesLookup(transfers: Map<string, number>) {
  return (fromZone: string, toZone: string): number => {
    if (fromZone === toZone) return 0;
    return transfers.get(`${fromZone}->${toZone}`) ?? 0;
  };
}

/** 演员当前生效中的分配（联表带出场次时间与区域），供约束检查使用。 */
export interface AssignmentWithSession extends AssignmentRow {
  sessionStart: string;
  sessionEnd: string;
  sessionStatus: string;
  zoneId: string;
}

export function activeAssignmentsOfActor(db: DB, actorId: string): AssignmentWithSession[] {
  return db
    .prepare(
      `SELECT a.*, s.startTs AS sessionStart, s.endTs AS sessionEnd, s.status AS sessionStatus, t.zoneId AS zoneId
       FROM assignments a
       JOIN sessions s ON a.sessionId = s.id
       JOIN templates t ON s.templateId = t.id
       WHERE a.actorId = ? AND a.status = 'active' AND s.status != 'cancelled'`,
    )
    .all(actorId) as AssignmentWithSession[];
}

export function getSession(db: DB, id: string): SessionRow | undefined {
  return db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;
}

export function confirmedVisitorCount(db: DB, sessionId: string): number {
  const row = db
    .prepare(
      "SELECT COALESCE(SUM(size), 0) AS total FROM reservations WHERE sessionId = ? AND status = 'confirmed'",
    )
    .get(sessionId) as { total: number };
  return row.total;
}
