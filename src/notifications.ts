import { iso, type Clock } from "./clock.js";
import { conflict } from "./errors.js";
import type { Assignment, Notification, SessionView, Store } from "./store.js";

/**
 * 通知 outbox：全部落库，服务重启后未确认通知不丢失；
 * 超时未确认由 sweep 升级为值班主管（escalation 通知）。
 */
export class NotificationService {
  constructor(
    private store: Store,
    private clock: Clock,
  ) {}

  private timeoutSeconds(): number {
    return this.store.configNumber("confirm_timeout_seconds");
  }

  private deadlineFromNow(): string {
    return new Date(this.clock().getTime() + this.timeoutSeconds() * 1000).toISOString();
  }

  /** 新分配 → 向演员发出待确认通知。 */
  offerAssignment(assignment: Assignment, session: SessionView): Notification {
    return this.store.createNotification({
      actorId: assignment.actorId,
      assignmentId: assignment.id,
      kind: "assignment_offered",
      payload: JSON.stringify({
        assignmentId: assignment.id,
        sessionId: session.id,
        templateName: session.templateName,
        zoneId: session.zoneId,
        role: assignment.role,
        startsAt: session.startsAt,
        endsAt: session.endsAt,
      }),
      createdAt: iso(this.clock()),
      deadline: this.deadlineFromNow(),
    });
  }

  /** 分配被取消/顶替 → 通知原演员确认知悉。 */
  cancelAssignment(assignment: Assignment, session: SessionView, cause: string): Notification {
    return this.store.createNotification({
      actorId: assignment.actorId,
      assignmentId: assignment.id,
      kind: "assignment_cancelled",
      payload: JSON.stringify({
        assignmentId: assignment.id,
        sessionId: session.id,
        templateName: session.templateName,
        role: assignment.role,
        startsAt: session.startsAt,
        cause,
      }),
      createdAt: iso(this.clock()),
      deadline: this.deadlineFromNow(),
    });
  }

  /** 分配被顶替/取消前，先作废其未确认通知，避免演员确认到失效内容。 */
  voidPendingFor(assignmentId: string): void {
    for (const n of this.store.pendingNotificationsOfAssignment(assignmentId)) {
      this.store.setNotificationStatus(n.id, "cancelled");
    }
  }

  /** 演员确认。已升级的通知仍允许确认（主管可见已补救）。 */
  confirm(notificationId: string, actorId: string): Notification {
    const n = this.store.getNotification(notificationId);
    if (n.actorId !== actorId) throw conflict({ error: "actor_mismatch", notificationId, actorId });
    if (n.status === "cancelled") throw conflict({ error: "notification_cancelled", notificationId });
    if (n.status === "confirmed") return n; // 幂等
    this.store.setNotificationStatus(notificationId, "confirmed", iso(this.clock()));
    if (n.kind === "assignment_offered" && n.assignmentId) {
      const a = this.store.getAssignment(n.assignmentId);
      if (a.state === "notified") this.store.setAssignmentState(a.id, "confirmed");
    }
    return this.store.getNotification(notificationId);
  }

  /** 清扫超时未确认通知：标记 escalated 并向值班主管生成 escalation 通知。返回本次升级数。 */
  sweep(): { escalated: Notification[] } {
    const now = iso(this.clock());
    const overdue = this.store.overduePendingNotifications(now);
    const supervisor = this.store.configString("supervisor_actor_id");
    const escalated: Notification[] = [];
    for (const n of overdue) {
      this.store.setNotificationStatus(n.id, "escalated");
      escalated.push(this.store.getNotification(n.id));
      this.store.createNotification({
        actorId: supervisor,
        assignmentId: n.assignmentId,
        kind: "escalation",
        payload: JSON.stringify({
          sourceNotificationId: n.id,
          actorId: n.actorId,
          kind: n.kind,
          payload: JSON.parse(n.payload),
          message: `演员 ${n.actorId} 超时未确认（${n.kind}），请值班主管介入`,
        }),
        createdAt: now,
        deadline: null,
      });
      this.store.audit(now, null, "notification.escalated", { notificationId: n.id, actorId: n.actorId, kind: n.kind });
    }
    return { escalated };
  }

  /** 服务重启恢复：补一次清扫（重启期间过期的立即升级），返回仍未确认的通知。 */
  recover(): { recoveredPending: Notification[]; escalatedOnBoot: number } {
    const { escalated } = this.sweep();
    const pending = this.store.listNotifications({ status: "pending" });
    this.store.audit(iso(this.clock()), null, "notification.recover", {
      recoveredPending: pending.length,
      escalatedOnBoot: escalated.length,
    });
    return { recoveredPending: pending, escalatedOnBoot: escalated.length };
  }
}
