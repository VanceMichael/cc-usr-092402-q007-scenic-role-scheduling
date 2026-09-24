import { randomUUID } from "node:crypto";
import { iso, parseIso, systemClock, type Clock } from "./clock.js";
import { ConstraintEvaluator } from "./constraints.js";
import type { Db } from "./db.js";
import { badRequest, conflict, HttpError } from "./errors.js";
import { checkVersion } from "./errors.js";
import { IncidentHandler } from "./incidents.js";
import { NotificationService } from "./notifications.js";
import { Planner, type PlanResult, type SlackInfo } from "./planner.js";
import { Store, type Assignment, type Notification, type Qualification, type SessionView, type UnmetDemand } from "./store.js";

export interface ExplainedSession {
  id: string;
  templateName: string;
  zoneId: string;
  startsAt: string;
  endsAt: string;
  status: string;
  version: number;
  reservationLocked: boolean;
  confirmedSeats: number;
  zoneCapacity: number;
  assignments: { id: string; actorId: string; role: string; state: string; version: number; reason: unknown }[];
  slack: SlackInfo[];
  unmet: UnmetDemand[];
}

/** 应用门面：所有多步写操作在此开事务，版本冲突统一 409。 */
export class ScheduleService {
  readonly store: Store;
  readonly evaluator: ConstraintEvaluator;
  readonly planner: Planner;
  readonly notifications: NotificationService;
  readonly incidents: IncidentHandler;

  constructor(
    db: Db,
    private clock: Clock = systemClock,
  ) {
    this.store = new Store(db);
    this.evaluator = new ConstraintEvaluator(this.store);
    this.planner = new Planner(this.store, this.evaluator, this.clock);
    this.notifications = new NotificationService(this.store, this.clock);
    this.incidents = new IncidentHandler(this.store, this.planner, this.evaluator, this.notifications, this.clock);
  }

  // ---- 演员与资质 ----
  updateQualifications(actorId: string, quals: Omit<Qualification, "actorId">[], expectedVersion: unknown): void {
    this.store.transaction(() => {
      const actor = this.store.getActor(actorId);
      checkVersion("actor", actorId, actor.version, expectedVersion);
      for (const q of quals) {
        if (parseIso(q.validFrom) >= parseIso(q.validUntil)) {
          throw badRequest(`资质「${q.role}」有效期起止非法`);
        }
      }
      this.store.replaceQualifications(actorId, quals);
      const version = this.store.bumpActorVersion(actorId);
      this.store.audit(iso(this.clock()), null, "actor.qualifications_updated", { actorId, qualifications: quals, version });
    });
  }

  // ---- 场次生命周期 ----
  startSession(sessionId: string, expectedVersion: unknown, operator?: string): void {
    this.store.transaction(() => {
      const s = this.store.getSession(sessionId);
      checkVersion("session", sessionId, s.version, expectedVersion);
      if (s.status !== "scheduled") throw conflict({ error: "invalid_session_state", sessionId, status: s.status });
      this.store.setSessionStatus(sessionId, "started");
      this.store.audit(iso(this.clock()), operator ?? null, "session.started", { sessionId });
    });
  }

  completeSession(sessionId: string, expectedVersion: unknown, operator?: string): void {
    this.store.transaction(() => {
      const s = this.store.getSession(sessionId);
      checkVersion("session", sessionId, s.version, expectedVersion);
      if (s.status !== "started") throw conflict({ error: "invalid_session_state", sessionId, status: s.status });
      this.store.setSessionStatus(sessionId, "completed");
      this.store.audit(iso(this.clock()), operator ?? null, "session.completed", { sessionId });
    });
  }

  /** 已开始场次不可被取消（不可静默改写），只能现场处置。 */
  cancelSession(sessionId: string, expectedVersion: unknown, reason: string, operator?: string): void {
    this.store.transaction(() => {
      const s = this.store.getSession(sessionId);
      checkVersion("session", sessionId, s.version, expectedVersion);
      if (s.status === "started") throw conflict({ error: "session_already_started", sessionId, message: "场次已开始，不能取消或改写" });
      if (s.status !== "scheduled") throw conflict({ error: "invalid_session_state", sessionId, status: s.status });
      const view = this.store.getSessionView(sessionId);
      this.store.setSessionStatus(sessionId, "cancelled");
      for (const a of this.store.activeAssignmentsOfSession(sessionId)) {
        this.notifications.voidPendingFor(a.id);
        this.store.setAssignmentState(a.id, "cancelled");
        this.notifications.cancelAssignment(a, view, `场次取消：${reason}`);
      }
      const seats = this.store.confirmedSeats(sessionId);
      if (seats > 0) {
        this.store.insertUnmet(`manual:${randomUUID()}`, sessionId, "reservation_orphaned",
          { seats, reason, message: `场次取消导致 ${seats} 个已确认预约失去场次` }, iso(this.clock()));
      }
      this.store.audit(iso(this.clock()), operator ?? null, "session.cancelled", { sessionId, reason });
    });
  }

  // ---- 方案生成 ----
  generatePlan(from: string, to: string, operator?: string): PlanResult {
    return this.store.transaction(() => {
      const result = this.planner.generate(from, to, operator);
      for (const a of result.createdAssignments) {
        this.notifications.offerAssignment(a, this.store.getSessionView(a.sessionId));
      }
      return result;
    });
  }

  // ---- 调度员手工调整（乐观锁） ----
  manualAssign(sessionId: string, actorId: string, role: string, expectedVersion: unknown, force = false, operator?: string): Assignment {
    return this.store.transaction(() => {
      const s = this.store.getSession(sessionId);
      checkVersion("session", sessionId, s.version, expectedVersion);
      if (s.status === "started") throw conflict({ error: "session_already_started", sessionId, message: "场次已开始，不能改写分配" });
      if (s.status !== "scheduled") throw conflict({ error: "invalid_session_state", sessionId, status: s.status });
      this.store.getActor(actorId);
      const view = this.store.getSessionView(sessionId);
      const { feasible, checks } = this.evaluator.isFeasible(actorId, role, view);
      if (!feasible && !force) {
        throw new HttpError(422, { error: "constraint_violation", sessionId, actorId, role, checks });
      }
      const assignment = this.store.createAssignment({
        sessionId,
        role,
        actorId,
        reason: JSON.stringify({ strategy: force ? "manual-forced" : "manual", operator: operator ?? null, forced: force && !feasible, checks }),
        createdAt: iso(this.clock()),
      });
      this.store.bumpSessionVersion(sessionId);
      this.notifications.offerAssignment(assignment, view);
      this.store.audit(iso(this.clock()), operator ?? null, "assignment.manual_created", { sessionId, actorId, role, forced: force && !feasible });
      return assignment;
    });
  }

  removeAssignment(assignmentId: string, expectedVersion: unknown, operator?: string): void {
    this.store.transaction(() => {
      const a = this.store.getAssignment(assignmentId);
      const s = this.store.getSession(a.sessionId);
      checkVersion("session", a.sessionId, s.version, expectedVersion);
      if (s.status === "started") throw conflict({ error: "session_already_started", sessionId: s.id, message: "场次已开始，不能改写分配" });
      if (a.state !== "notified" && a.state !== "confirmed") throw conflict({ error: "invalid_assignment_state", assignmentId, state: a.state });
      const view = this.store.getSessionView(a.sessionId);
      this.notifications.voidPendingFor(a.id);
      this.store.setAssignmentState(a.id, "cancelled");
      this.store.bumpSessionVersion(a.sessionId);
      this.notifications.cancelAssignment(a, view, "调度员手工移除");
      this.store.audit(iso(this.clock()), operator ?? null, "assignment.removed", { assignmentId, sessionId: a.sessionId, actorId: a.actorId });
    });
  }

  // ---- 通知 ----
  confirmNotification(notificationId: string, actorId: string): Notification {
    return this.store.transaction(() => {
      const n = this.notifications.confirm(notificationId, actorId);
      this.store.audit(iso(this.clock()), actorId, "notification.confirmed", { notificationId, kind: n.kind });
      return n;
    });
  }

  sweepNotifications(): { escalated: Notification[] } {
    return this.store.transaction(() => this.notifications.sweep());
  }

  recoverNotifications(): { recoveredPending: Notification[]; escalatedOnBoot: number } {
    return this.store.transaction(() => this.notifications.recover());
  }

  // ---- 解释接口 ----
  explain(from: string, to: string): { from: string; to: string; generatedAt: string; sessions: ExplainedSession[]; unmet: UnmetDemand[] } {
    const sessions = this.store.sessionsStartingBetween(from, to);
    const allUnmet = this.store.allUnmet();
    const unmetBySession = new Map<string, UnmetDemand[]>();
    for (const u of allUnmet) {
      if (!u.sessionId) continue;
      const list = unmetBySession.get(u.sessionId) ?? [];
      list.push(u);
      unmetBySession.set(u.sessionId, list);
    }
    const explained: ExplainedSession[] = sessions.map((s: SessionView) => {
      const assignments = this.store.activeAssignmentsOfSession(s.id).map((a) => ({
        id: a.id,
        actorId: a.actorId,
        role: a.role,
        state: a.state,
        version: a.version,
        reason: JSON.parse(a.reason) as unknown,
      }));
      const slack =
        s.status === "scheduled"
          ? this.store.templateRoles(s.templateId).map((tr) => this.planner.computeSlack(s, tr.role))
          : [];
      return {
        id: s.id,
        templateName: s.templateName,
        zoneId: s.zoneId,
        startsAt: s.startsAt,
        endsAt: s.endsAt,
        status: s.status,
        version: s.version,
        reservationLocked: this.store.isReservationLocked(s.id),
        confirmedSeats: this.store.confirmedSeats(s.id),
        zoneCapacity: this.store.getZone(s.zoneId).capacity,
        assignments,
        slack,
        unmet: unmetBySession.get(s.id) ?? [],
      };
    });
    return { from, to, generatedAt: iso(this.clock()), sessions: explained, unmet: allUnmet };
  }
}
