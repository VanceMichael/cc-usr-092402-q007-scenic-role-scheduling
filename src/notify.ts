import { randomUUID } from "node:crypto";
import { DB, getRules } from "./db.js";
import { logEvent } from "./store.js";
import {
  Clock,
  EscalationRow,
  NotificationRow,
  Rules,
  conflict,
  notFound,
  unprocessable,
} from "./types.js";

/**
 * 为一次分配/取消创建待确认通知。
 * 通知持久化在 SQLite 中：服务重启后未确认的通知仍在，
 * 由 sweepExpired 按 deadlineTs 继续超时升级。
 */
export function createNotification(
  db: DB,
  clock: Clock,
  rules: Rules,
  input: { assignmentId: string; actorId: string; kind: "assigned" | "cancelled"; payload: unknown },
): NotificationRow {
  const now = clock();
  const row: NotificationRow = {
    id: randomUUID(),
    assignmentId: input.assignmentId,
    actorId: input.actorId,
    kind: input.kind,
    status: "pending",
    payload: JSON.stringify(input.payload ?? {}),
    deadlineTs: new Date(now.getTime() + rules.confirmTimeoutSec * 1000).toISOString(),
    createdTs: now.toISOString(),
    resolvedTs: null,
    version: 1,
  };
  db.prepare(
    `INSERT INTO notifications (id, assignmentId, actorId, kind, status, payload, deadlineTs, createdTs, resolvedTs, version)
     VALUES (@id, @assignmentId, @actorId, @kind, @status, @payload, @deadlineTs, @createdTs, @resolvedTs, @version)`,
  ).run(row);
  return row;
}

export function confirmNotification(
  db: DB,
  clock: Clock,
  notificationId: string,
  actorId: string,
): NotificationRow {
  const row = db.prepare("SELECT * FROM notifications WHERE id = ?").get(notificationId) as
    | NotificationRow
    | undefined;
  if (!row) throw notFound(`通知不存在: ${notificationId}`);
  if (row.actorId !== actorId) throw unprocessable("该通知不属于此演员，不能代为确认");
  if (row.status !== "pending") {
    throw conflict(`通知当前状态为 ${row.status}，不能重复确认`, { id: notificationId, status: row.status });
  }
  const res = db
    .prepare(
      "UPDATE notifications SET status = 'confirmed', resolvedTs = ?, version = version + 1 WHERE id = ? AND status = 'pending'",
    )
    .run(clock().toISOString(), notificationId);
  if (res.changes === 0) throw conflict("通知已被并发处理，请刷新", { id: notificationId });
  logEvent(db, clock, "notification_confirmed", "notification", notificationId, { actorId });
  return db.prepare("SELECT * FROM notifications WHERE id = ?").get(notificationId) as NotificationRow;
}

/** 把某分配上仍未确认的通知置为 expired（分配被撤销时调用）。 */
export function expirePendingNotifications(db: DB, clock: Clock, assignmentId: string): void {
  db.prepare(
    "UPDATE notifications SET status = 'expired', resolvedTs = ?, version = version + 1 WHERE assignmentId = ? AND status = 'pending'",
  ).run(clock().toISOString(), assignmentId);
}

/**
 * 超时清扫：所有超过确认时限仍 pending 的通知升级为值班主管。
 * 该函数只依赖数据库中的持久化状态，因此服务重启后直接调用即可恢复处理。
 */
export function sweepExpired(db: DB, clock: Clock): { escalated: NotificationRow[] } {
  const nowIso = clock().toISOString();
  const rules = getRules(db);
  const due = db
    .prepare("SELECT * FROM notifications WHERE status = 'pending' AND deadlineTs <= ?")
    .all(nowIso) as NotificationRow[];
  const escalated: NotificationRow[] = [];
  const tx = db.transaction(() => {
    for (const n of due) {
      const res = db
        .prepare(
          "UPDATE notifications SET status = 'escalated', resolvedTs = ?, version = version + 1 WHERE id = ? AND status = 'pending'",
        )
        .run(nowIso, n.id);
      if (res.changes === 0) continue;
      const esc: EscalationRow = {
        id: randomUUID(),
        notificationId: n.id,
        supervisor: rules.dutySupervisor,
        reason: `演员未在 ${rules.confirmTimeoutSec} 秒内确认${n.kind === "assigned" ? "新分配" : "取消变更"}，超时升级`,
        createdTs: nowIso,
      };
      db.prepare(
        "INSERT INTO escalations (id, notificationId, supervisor, reason, createdTs) VALUES (@id, @notificationId, @supervisor, @reason, @createdTs)",
      ).run(esc);
      logEvent(db, clock, "notification_escalated", "notification", n.id, {
        actorId: n.actorId,
        supervisor: rules.dutySupervisor,
      });
      escalated.push({ ...n, status: "escalated", resolvedTs: nowIso });
    }
  });
  tx();
  return { escalated };
}

export function countPending(db: DB): number {
  const row = db.prepare("SELECT COUNT(*) AS c FROM notifications WHERE status = 'pending'").get() as {
    c: number;
  };
  return row.c;
}
