import { randomUUID } from "node:crypto";
import { iso, parseIso, type Clock } from "./clock.js";
import type { ConstraintEvaluator } from "./constraints.js";
import type { NotificationService } from "./notifications.js";
import type { Planner, PlanResult } from "./planner.js";
import type { Assignment, SessionView, Store, UnmetDemand } from "./store.js";

export interface OutageResult {
  runId: string;
  affectedWindow: { from: string; to: string };
  cancelledSessionIds: string[];
  blockedStarted: { sessionId: string; startsAt: string }[];
  replan: PlanResult;
  unmet: UnmetDemand[];
}

export interface LateCheckinResult {
  runId: string;
  affectedWindow: { from: string; to: string };
  replacedAssignments: { sessionId: string; role: string; lateActorId: string; substitute: Assignment | null }[];
  blockedStarted: { sessionId: string; startsAt: string; role: string }[];
  unmet: UnmetDemand[];
}

/**
 * 事件局部重算：只触碰受影响时间区间内的场次；
 * 已开始场次一律不静默改写，进入 blocked 清单交人工处置。
 */
export class IncidentHandler {
  constructor(
    private store: Store,
    private planner: Planner,
    private evaluator: ConstraintEvaluator,
    private notifications: NotificationService,
    private clock: Clock,
  ) {}

  /** 设施故障停演：取消区间内该区域未开始的场次，释放演员后在同区间内补位重排。 */
  facilityOutage(zoneId: string, fromIso: string, toIso: string, reason: string, operator?: string): OutageResult {
    const runId = `incident:${randomUUID()}`;
    const now = iso(this.clock());
    const affected = this.store.sessionsOverlapping(fromIso, toIso).filter((s) => s.zoneId === zoneId);

    const cancelledSessionIds: string[] = [];
    const blockedStarted: { sessionId: string; startsAt: string }[] = [];
    const unmet: { sessionId: string | null; kind: string; detail: unknown }[] = [];

    for (const session of affected) {
      if (session.status === "cancelled" || session.status === "completed") continue;
      if (session.status === "started") {
        blockedStarted.push({ sessionId: session.id, startsAt: session.startsAt });
        unmet.push({
          sessionId: session.id,
          kind: "outage_started_session",
          detail: { zoneId, reason, message: "场次已开始，系统不静默改写，请现场处置" },
        });
        continue;
      }
      // 取消场次与其全部分配，通知相关演员
      this.store.setSessionStatus(session.id, "cancelled");
      cancelledSessionIds.push(session.id);
      for (const a of this.store.activeAssignmentsOfSession(session.id)) {
        this.notifications.voidPendingFor(a.id);
        this.store.setAssignmentState(a.id, "cancelled");
        this.notifications.cancelAssignment(a, session, `设施故障停演：${reason}`);
      }
      const seats = this.store.confirmedSeats(session.id);
      if (seats > 0) {
        unmet.push({
          sessionId: session.id,
          kind: "reservation_orphaned",
          detail: { seats, zoneId, reason, message: `停演导致 ${seats} 个已确认预约失去场次，需改签或退款` },
        });
      }
    }

    for (const u of unmet) this.store.insertUnmet(runId, u.sessionId, u.kind, u.detail, now);

    // 只在受影响区间内重排：释放出的演员可补该区间其他空缺
    const replan = this.planner.generate(fromIso, toIso, operator);

    this.store.audit(now, operator ?? null, "incident.facility_outage", {
      runId,
      zoneId,
      from: fromIso,
      to: toIso,
      reason,
      cancelledSessions: cancelledSessionIds,
      blockedStarted,
    });

    return {
      runId,
      affectedWindow: { from: fromIso, to: toIso },
      cancelledSessionIds,
      blockedStarted,
      replan,
      unmet: this.store.unmetOfRun(runId),
    };
  }

  /** 迟到打卡：演员在 availableFrom 前不可用，只重算其与区间相交的分配，寻找替补。 */
  lateCheckin(actorId: string, availableFromIso: string, operator?: string): LateCheckinResult {
    const runId = `incident:${randomUUID()}`;
    const now = iso(this.clock());
    const nowMs = parseIso(now);
    const availMs = parseIso(availableFromIso);

    const replaced: LateCheckinResult["replacedAssignments"] = [];
    const blockedStarted: LateCheckinResult["blockedStarted"] = [];
    const unmet: { sessionId: string | null; kind: string; detail: unknown }[] = [];

    const affected = this.store
      .activeAssignmentsOfActor(actorId)
      .filter((a) => parseIso(a.session.startsAt) < availMs && parseIso(a.session.endsAt) > nowMs);

    for (const a of affected) {
      const session = this.store.getSessionView(a.sessionId);
      if (session.status === "started") {
        // 已开始的场次不能静默改写
        blockedStarted.push({ sessionId: session.id, startsAt: session.startsAt, role: a.role });
        unmet.push({
          sessionId: session.id,
          kind: "started_session_uncovered",
          detail: { actorId, role: a.role, message: "演员迟到但场次已开始，岗位空缺需现场处置，系统未改写" },
        });
        continue;
      }
      if (session.status !== "scheduled") continue;

      // 顶替原分配并寻找替补
      this.notifications.voidPendingFor(a.id);
      this.store.setAssignmentState(a.id, "superseded");
      this.notifications.cancelAssignment(a, session, `迟到至 ${availableFromIso}，原分配被顶替`);
      this.store.bumpSessionVersion(session.id);

      const substitute = this.findSubstitute(a.role, session, actorId);
      replaced.push({ sessionId: session.id, role: a.role, lateActorId: actorId, substitute });
      if (!substitute) {
        unmet.push({
          sessionId: session.id,
          kind: "role_unfilled",
          detail: { role: a.role, cause: "late_checkin", lateActorId: actorId, message: `岗位「${a.role}」无可用替补` },
        });
      }
    }

    for (const u of unmet) this.store.insertUnmet(runId, u.sessionId, u.kind, u.detail, now);
    this.store.audit(now, operator ?? null, "incident.late_checkin", {
      runId,
      actorId,
      availableFrom: availableFromIso,
      replaced: replaced.length,
      blockedStarted,
    });

    return {
      runId,
      affectedWindow: { from: now, to: availableFromIso },
      replacedAssignments: replaced,
      blockedStarted,
      unmet: this.store.unmetOfRun(runId),
    };
  }

  /** 替补搜索：排除迟到演员，取负载最低的可行人选，并生成待确认通知。 */
  private findSubstitute(role: string, session: SessionView, excludeActorId: string): Assignment | null {
    const candidates = this.store
      .actorsQualifiedFor(role, session.startsAt, session.endsAt)
      .filter((a) => a.id !== excludeActorId)
      .map((a) => ({
        actor: a,
        feasible: this.evaluator.isFeasible(a.id, role, session).feasible,
        load: this.store.activeAssignmentsOfActor(a.id).length,
      }))
      .filter((c) => c.feasible)
      .sort((x, y) => x.load - y.load || x.actor.id.localeCompare(y.actor.id));
    const chosen = candidates[0];
    if (!chosen) return null;
    const checks = this.evaluator.evaluate(chosen.actor.id, role, session);
    const assignment = this.store.createAssignment({
      sessionId: session.id,
      role,
      actorId: chosen.actor.id,
      reason: JSON.stringify({
        strategy: "late-checkin-substitute",
        chosen: { actorId: chosen.actor.id, load: chosen.load, why: "迟到事件触发的应急替补，取负载最低的可行人选" },
        checks,
      }),
      createdAt: iso(this.clock()),
    });
    this.notifications.offerAssignment(assignment, session);
    return assignment;
  }
}
