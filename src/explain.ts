import { DB, getRules } from "./db.js";
import { confirmedVisitorCount } from "./store.js";
import {
  ActorRow,
  AssignmentRow,
  NotificationRow,
  QualificationRow,
  Requirement,
  SessionRow,
  TemplateRow,
  TraceEntry,
  UnmetRow,
  ZoneRow,
} from "./types.js";

interface AssignmentExplanation {
  id: string;
  actorId: string;
  actorName: string;
  role: string;
  locked: boolean;
  confirmStatus: string | null;
  trace: TraceEntry[];
}

export interface SessionExplanation {
  sessionId: string;
  templateName: string;
  zoneId: string;
  zoneName: string;
  startTs: string;
  endTs: string;
  status: string;
  confirmedVisitors: number;
  zoneCapacity: number;
  capacityOk: boolean;
  requirements: { role: string; needed: number; filled: number }[];
  assignments: AssignmentExplanation[];
  unmet: { role: string | null; needed: number; reason: string; detail: string }[];
  /** 应急替补余量快照：每个角色当前仍可调用的持证演员数 */
  reserve: { role: string; qualified: number; freeInWindow: number; requiredReserve: number; ok: boolean }[];
}

function latestNotificationStatus(db: DB, assignmentId: string): string | null {
  const row = db
    .prepare(
      "SELECT status FROM notifications WHERE assignmentId = ? ORDER BY createdTs DESC, rowid DESC LIMIT 1",
    )
    .get(assignmentId) as Pick<NotificationRow, "status"> | undefined;
  return row?.status ?? null;
}

function reserveSnapshot(
  db: DB,
  session: SessionRow,
  role: string,
): { qualified: number; freeInWindow: number } {
  const quals = db
    .prepare("SELECT * FROM qualifications WHERE role = ? AND validFrom <= ? AND validUntil >= ?")
    .all(role, session.startTs, session.endTs) as QualificationRow[];
  const actorIds = new Set(quals.map((q) => q.actorId));
  let free = 0;
  for (const actorId of actorIds) {
    const actor = db.prepare("SELECT active FROM actors WHERE id = ?").get(actorId) as
      | Pick<ActorRow, "active">
      | undefined;
    if (!actor || actor.active !== 1) continue;
    const overlap = db
      .prepare(
        `SELECT COUNT(*) AS c FROM assignments a JOIN sessions s ON a.sessionId = s.id
         WHERE a.actorId = ? AND a.status = 'active' AND s.status != 'cancelled'
           AND s.startTs < ? AND ? < s.endTs`,
      )
      .get(actorId, session.endTs, session.startTs) as { c: number };
    if (overlap.c === 0) free += 1;
  }
  return { qualified: actorIds.size, freeInWindow: free };
}

export function buildSessionExplanation(db: DB, sessionId: string): SessionExplanation {
  const rules = getRules(db);
  const session = db.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId) as SessionRow;
  const template = db
    .prepare("SELECT * FROM templates WHERE id = ?")
    .get(session.templateId) as TemplateRow;
  const zone = db.prepare("SELECT * FROM zones WHERE id = ?").get(template.zoneId) as ZoneRow;
  const requirements = JSON.parse(template.requirements) as Requirement[];

  const assignments = db
    .prepare(
      `SELECT a.*, ac.name AS actorName FROM assignments a JOIN actors ac ON a.actorId = ac.id
       WHERE a.sessionId = ? AND a.status = 'active' ORDER BY a.role, a.createdTs`,
    )
    .all(sessionId) as (AssignmentRow & { actorName: string })[];

  const unmet = db
    .prepare("SELECT role, needed, reason, detail FROM unmet_requirements WHERE sessionId = ?")
    .all(sessionId) as UnmetRow[];

  const confirmed = confirmedVisitorCount(db, sessionId);
  return {
    sessionId: session.id,
    templateName: template.name,
    zoneId: zone.id,
    zoneName: zone.name,
    startTs: session.startTs,
    endTs: session.endTs,
    status: session.status,
    confirmedVisitors: confirmed,
    zoneCapacity: zone.capacity,
    capacityOk: confirmed <= zone.capacity,
    requirements: requirements.map((r) => ({
      role: r.role,
      needed: r.count,
      filled: assignments.filter((a) => a.role === r.role).length,
    })),
    assignments: assignments.map((a) => ({
      id: a.id,
      actorId: a.actorId,
      actorName: a.actorName,
      role: a.role,
      locked: a.locked === 1,
      confirmStatus: latestNotificationStatus(db, a.id),
      trace: JSON.parse(a.trace) as TraceEntry[],
    })),
    unmet: unmet.map((u) => ({ role: u.role, needed: u.needed, reason: u.reason, detail: u.detail })),
    reserve: requirements.map((r) => {
      const snap = reserveSnapshot(db, session, r.role);
      return {
        role: r.role,
        qualified: snap.qualified,
        freeInWindow: snap.freeInWindow,
        requiredReserve: rules.reservePerRole,
        ok: snap.freeInWindow >= rules.reservePerRole,
      };
    }),
  };
}

export function buildPlanExplanation(
  db: DB,
  scope: { from: string; to: string },
): {
  from: string;
  to: string;
  sessions: SessionExplanation[];
  unmetTotal: number;
  recentRuns: { id: string; kind: string; scope: unknown; createdTs: string }[];
} {
  const sessions = db
    .prepare("SELECT id FROM sessions WHERE startTs >= ? AND startTs <= ? ORDER BY startTs")
    .all(scope.from, scope.to) as { id: string }[];
  const explained = sessions.map((s) => buildSessionExplanation(db, s.id));
  const runs = db
    .prepare("SELECT id, kind, scope, createdTs FROM plan_runs ORDER BY createdTs DESC LIMIT 10")
    .all() as { id: string; kind: string; scope: string; createdTs: string }[];
  return {
    from: scope.from,
    to: scope.to,
    sessions: explained,
    unmetTotal: explained.reduce((n, s) => n + s.unmet.length, 0),
    recentRuns: runs.map((r) => ({ ...r, scope: JSON.parse(r.scope) })),
  };
}
