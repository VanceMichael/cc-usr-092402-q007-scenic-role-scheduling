import { randomUUID } from "node:crypto";
import { DB, getRules } from "./db.js";
import { createNotification, expirePendingNotifications } from "./notify.js";
import { insertAssignment, pickCandidate } from "./planner.js";
import { confirmedVisitorCount, isSessionStarted, logEvent } from "./store.js";
import {
  ActorRow,
  AssignmentRow,
  Clock,
  SessionRow,
  TemplateRow,
  ZoneRow,
  isoAfter,
  notFound,
  unprocessable,
} from "./types.js";

export interface ReplanChange {
  sessionId: string;
  cancelledAssignmentId?: string;
  newAssignmentId?: string;
  substituteActorId?: string;
  role?: string;
}

export interface ReplanResult {
  kind: "zone_outage" | "late_checkin" | "session_cancel";
  affectedWindow: { from: string; to: string };
  changes: ReplanChange[];
  unmet: { sessionId: string; role: string | null; needed: number; reason: string; detail: string }[];
  /** 已开始、按规则不得静默改写而被跳过的场次 */
  skippedStartedSessionIds: string[];
}

/** 撤销一条分配：置为 cancelled，挂起的确认通知失效，并向演员发送取消通知。 */
export function cancelAssignmentRow(
  db: DB,
  clock: Clock,
  assignment: AssignmentRow,
  reason: string,
): void {
  const rules = getRules(db);
  db.prepare(
    "UPDATE assignments SET status = 'cancelled', version = version + 1 WHERE id = ? AND status = 'active'",
  ).run(assignment.id);
  expirePendingNotifications(db, clock, assignment.id);
  createNotification(db, clock, rules, {
    assignmentId: assignment.id,
    actorId: assignment.actorId,
    kind: "cancelled",
    payload: { sessionId: assignment.sessionId, role: assignment.role, reason },
  });
  logEvent(db, clock, "assignment_cancelled", "assignment", assignment.id, {
    sessionId: assignment.sessionId,
    actorId: assignment.actorId,
    reason,
  });
}

/** 取消场次及其全部生效分配；已开始的场次必须显式 force，杜绝静默改写。 */
export function cancelSession(
  db: DB,
  clock: Clock,
  session: SessionRow,
  reason: string,
  opts: { force?: boolean } = {},
): { cancelledAssignmentIds: string[] } {
  const nowIso = clock().toISOString();
  if (session.status === "cancelled") throw unprocessable("场次已取消，无需重复操作");
  if (session.status === "finished") throw unprocessable("场次已结束，不能取消");
  if (isSessionStarted(session, nowIso) && !opts.force) {
    throw unprocessable("场次已开始，不能静默改写；如确需停演请显式携带 force", {
      sessionId: session.id,
    });
  }
  const cancelled: string[] = [];
  const tx = db.transaction(() => {
    const assignments = db
      .prepare("SELECT * FROM assignments WHERE sessionId = ? AND status = 'active'")
      .all(session.id) as AssignmentRow[];
    for (const a of assignments) {
      cancelAssignmentRow(db, clock, a, reason);
      cancelled.push(a.id);
    }
    db.prepare("UPDATE sessions SET status = 'cancelled', version = version + 1 WHERE id = ?").run(
      session.id,
    );
    const confirmed = confirmedVisitorCount(db, session.id);
    if (confirmed > 0) {
      db.prepare(
        "INSERT INTO unmet_requirements (id, runId, sessionId, role, needed, reason, detail, createdTs) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        randomUUID(),
        `cancel-${session.id}`,
        session.id,
        null,
        confirmed,
        "session_cancelled",
        `场次停演（${reason}），${confirmed} 名已确认预约游客需要改签或退款`,
        nowIso,
      );
    }
    logEvent(db, clock, "session_cancelled", "session", session.id, {
      reason,
      force: opts.force === true,
      confirmedVisitors: confirmed,
      cancelledAssignments: cancelled.length,
    });
  });
  tx();
  return { cancelledAssignmentIds: cancelled };
}

/**
 * 设施故障：区域内 [from, to] 与故障窗口重叠的未开始场次停演，
 * 只重算受影响区间；已开始的场次列入 skipped，不做任何改动。
 */
export function handleZoneOutage(
  db: DB,
  clock: Clock,
  zoneId: string,
  window: { from: string; to: string },
  reason: string,
): ReplanResult {
  const zone = db.prepare("SELECT * FROM zones WHERE id = ?").get(zoneId) as ZoneRow | undefined;
  if (!zone) throw notFound(`区域不存在: ${zoneId}`);
  const nowIso = clock().toISOString();
  const result: ReplanResult = {
    kind: "zone_outage",
    affectedWindow: window,
    changes: [],
    unmet: [],
    skippedStartedSessionIds: [],
  };

  const tx = db.transaction(() => {
    db.prepare("UPDATE zones SET status = 'down', version = version + 1 WHERE id = ?").run(zoneId);
    const sessions = db
      .prepare(
        `SELECT s.* FROM sessions s JOIN templates t ON s.templateId = t.id
         WHERE t.zoneId = ? AND s.status IN ('scheduled', 'started')
           AND s.startTs < ? AND ? < s.endTs`,
      )
      .all(zoneId, window.to, window.from) as SessionRow[];
    for (const session of sessions) {
      if (isSessionStarted(session, nowIso)) {
        result.skippedStartedSessionIds.push(session.id);
        continue;
      }
      const { cancelledAssignmentIds } = cancelSession(
        db,
        clock,
        session,
        `设施故障停演：${reason}`,
      );
      for (const id of cancelledAssignmentIds) {
        result.changes.push({ sessionId: session.id, cancelledAssignmentId: id });
      }
    }
    result.unmet = db
      .prepare(
        "SELECT sessionId, role, needed, reason, detail FROM unmet_requirements WHERE runId LIKE 'cancel-%' AND createdTs >= ?",
      )
      .all(nowIso) as ReplanResult["unmet"];
    logEvent(db, clock, "zone_outage", "zone", zoneId, {
      window,
      reason,
      cancelledSessions: result.changes.length,
      skippedStarted: result.skippedStartedSessionIds,
    });
  });
  tx();
  return result;
}

/**
 * 迟到打卡：演员在 lateMinutes 后才能到岗。
 * 只重算受影响区间——即该演员在到岗时间之前开场、且尚未开始的场次；
 * 到岗之后以及已开始的场次一律不动。替补允许动用应急余量（这正是余量的用途）。
 */
export function handleLateCheckin(
  db: DB,
  clock: Clock,
  actorId: string,
  lateMinutes: number,
): ReplanResult {
  const actor = db.prepare("SELECT * FROM actors WHERE id = ?").get(actorId) as ActorRow | undefined;
  if (!actor) throw notFound(`演员不存在: ${actorId}`);
  const rules = getRules(db);
  const nowIso = clock().toISOString();
  const arrivalIso = isoAfter(nowIso, lateMinutes);

  const impacted = db
    .prepare(
      `SELECT a.*, s.startTs AS sessionStart, s.endTs AS sessionEnd FROM assignments a
       JOIN sessions s ON a.sessionId = s.id
       WHERE a.actorId = ? AND a.status = 'active' AND s.status IN ('scheduled', 'started')
         AND s.endTs > ? AND s.startTs < ?`,
    )
    .all(actorId, nowIso, arrivalIso) as (AssignmentRow & { sessionStart: string; sessionEnd: string })[];

  const result: ReplanResult = {
    kind: "late_checkin",
    affectedWindow: { from: nowIso, to: arrivalIso },
    changes: [],
    unmet: [],
    skippedStartedSessionIds: [],
  };

  const tx = db.transaction(() => {
    const touched: string[] = [];
    for (const row of impacted) {
      const session = db.prepare("SELECT * FROM sessions WHERE id = ?").get(row.sessionId) as SessionRow;
      if (isSessionStarted(session, nowIso)) {
        // 已开始的场次不静默改写，只记录演员未能到岗
        result.skippedStartedSessionIds.push(session.id);
        continue;
      }
      touched.push(session.id);
      cancelAssignmentRow(db, clock, row, `演员迟到 ${lateMinutes} 分钟，无法按时到岗`);
      const template = db
        .prepare("SELECT * FROM templates WHERE id = ?")
        .get(session.templateId) as TemplateRow;
      const pick = pickCandidate(db, rules, session, template, row.role, {
        excludeActorIds: new Set([actorId]),
        reserveMode: "dip",
        reserveNote: `演员「${actor.name}」迟到，启用应急替补`,
      });
      if (pick.kind === "assigned") {
        const created = insertAssignment(db, clock, rules, {
          sessionId: session.id,
          actorId: pick.actor.id,
          role: row.role,
          locked: row.locked === 1,
          trace: pick.trace,
        });
        result.changes.push({
          sessionId: session.id,
          cancelledAssignmentId: row.id,
          newAssignmentId: created.id,
          substituteActorId: pick.actor.id,
          role: row.role,
        });
      } else {
        result.unmet.push({
          sessionId: session.id,
          role: row.role,
          needed: 1,
          reason: "no_substitute",
          detail: `演员「${actor.name}」迟到 ${lateMinutes} 分钟：${pick.detail}`,
        });
        result.changes.push({ sessionId: session.id, cancelledAssignmentId: row.id, role: row.role });
      }
    }
    if (touched.length > 0) {
      db.prepare(
        `DELETE FROM unmet_requirements WHERE sessionId IN (${touched.map(() => "?").join(",")})`,
      ).run(...touched);
      const insertUnmet = db.prepare(
        "INSERT INTO unmet_requirements (id, runId, sessionId, role, needed, reason, detail, createdTs) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      );
      const runId = randomUUID();
      for (const u of result.unmet) {
        insertUnmet.run(randomUUID(), runId, u.sessionId, u.role, u.needed, u.reason, u.detail, nowIso);
      }
      db.prepare("INSERT INTO plan_runs (id, kind, scope, createdTs) VALUES (?, ?, ?, ?)").run(
        runId,
        "late_checkin",
        JSON.stringify({ actorId, lateMinutes, affectedWindow: result.affectedWindow }),
        nowIso,
      );
    }
    logEvent(db, clock, "late_checkin", "actor", actorId, {
      lateMinutes,
      affectedWindow: result.affectedWindow,
      reassigned: result.changes.filter((c) => c.newAssignmentId).length,
      unmet: result.unmet.length,
      skippedStarted: result.skippedStartedSessionIds,
    });
  });
  tx();
  return result;
}
