import { randomUUID } from "node:crypto";
import { iso, type Clock } from "./clock.js";
import type { ConstraintCheck, ConstraintEvaluator } from "./constraints.js";
import type { Assignment, SessionView, Store, UnmetDemand } from "./store.js";

export interface Slot {
  session: SessionView;
  role: string;
}

export interface SlackInfo {
  sessionId: string;
  role: string;
  assignedActorIds: string[];
  backupActorIds: string[];
  requiredBackup: number;
  ok: boolean;
}

export interface PlanResult {
  runId: string;
  from: string;
  to: string;
  createdAssignments: Assignment[];
  keptAssignmentIds: string[];
  lockedSessionIds: string[]; // 有已确认预约、被锁定不改写的场次
  blockedStartedIds: string[]; // 已开始、跳过不重算的场次
  slack: SlackInfo[];
  unmet: UnmetDemand[];
}

interface CandidateScore {
  actorId: string;
  feasible: boolean;
  load: number;
  alternatives: number;
  violations: string[];
}

/**
 * 动态编排器：
 * - 有已确认预约的场次锁定：不取消、既有分配保持稳定，只补空缺；
 * - 已确认/已通知的既有分配一律保留（不静默改写），失效则记入未满足需求；
 * - 贪心分配：候选最紧缺的岗位优先，人选上偏向负载低、其他岗位替代者多的演员，
 *   以此为应急替补保留余量；每个岗位的替补余量显式计算并解释。
 */
export class Planner {
  constructor(
    private store: Store,
    private evaluator: ConstraintEvaluator,
    private clock: Clock,
  ) {}

  /** 计算某场次某岗位当前的应急替补余量（基于库中最新分配状态）。 */
  computeSlack(session: SessionView, role: string): SlackInfo {
    const assigned = this.store.activeAssignmentsOfSession(session.id).filter((a) => a.role === role);
    const assignedIds = assigned.map((a) => a.actorId);
    const backups: string[] = [];
    for (const actor of this.store.actorsQualifiedFor(role, session.startsAt, session.endsAt)) {
      if (this.store.hasActiveAssignmentOn(session.id, actor.id)) continue; // 同场其他岗位也不算替补
      if (this.evaluator.isFeasible(actor.id, role, session).feasible) backups.push(actor.id);
    }
    const requiredBackup = this.store.configNumber("min_backup_slack");
    return {
      sessionId: session.id,
      role,
      assignedActorIds: assignedIds,
      backupActorIds: backups.sort(),
      requiredBackup,
      ok: backups.length >= requiredBackup,
    };
  }

  private candidatesFor(slot: Slot, openSlots: Slot[]): CandidateScore[] {
    const { session, role } = slot;
    const actors = this.store.actorsQualifiedFor(role, session.startsAt, session.endsAt);
    return actors.map((actor) => {
      const { feasible, checks } = this.evaluator.isFeasible(actor.id, role, session);
      const load = this.store.activeAssignmentsOfActor(actor.id).length;
      // 该演员还能覆盖多少个其他空缺岗位：越少越“稀缺”，应尽量留给别处
      const alternatives = openSlots.filter(
        (s) => s !== slot && this.evaluator.isFeasible(actor.id, s.role, s.session).feasible,
      ).length;
      return {
        actorId: actor.id,
        feasible,
        load,
        alternatives,
        violations: checks.filter((c: ConstraintCheck) => !c.ok).map((c) => c.detail),
      };
    });
  }

  generate(fromIso: string, toIso: string, operator?: string): PlanResult {
    const runId = `plan:${randomUUID()}`;
    const now = iso(this.clock());
    // 新一轮计划替换上一轮计划的未满足记录（事件类记录保留）
    this.store.deleteUnmetByRunPrefix("plan:");
    const sessions = this.store.sessionsStartingBetween(fromIso, toIso);
    const plannable = sessions.filter((s) => s.status === "scheduled");
    const blockedStartedIds = sessions.filter((s) => s.status === "started").map((s) => s.id);

    const created: Assignment[] = [];
    const keptAssignmentIds: string[] = [];
    const lockedSessionIds: string[] = [];
    const unmet: { sessionId: string | null; kind: string; detail: unknown }[] = [];

    // 1. 区域容量与既有分配体检（只报告，不静默改写）
    for (const session of plannable) {
      const locked = this.store.isReservationLocked(session.id);
      if (locked) lockedSessionIds.push(session.id);
      const seats = this.store.confirmedSeats(session.id);
      const capacity = this.store.getZone(session.zoneId).capacity;
      if (seats > capacity) {
        unmet.push({
          sessionId: session.id,
          kind: "capacity_overflow",
          detail: { seats, capacity, over: seats - capacity, message: `已确认预约 ${seats} 人超出区域容量 ${capacity}，需加场或分流` },
        });
      }
      for (const a of this.store.activeAssignmentsOfSession(session.id)) {
        keptAssignmentIds.push(a.id);
        const recheck = this.evaluator.isFeasible(a.actorId, a.role, session, { excludeAssignmentId: a.id });
        if (!recheck.feasible) {
          unmet.push({
            sessionId: session.id,
            kind: "existing_assignment_violates",
            detail: {
              assignmentId: a.id,
              actorId: a.actorId,
              role: a.role,
              violations: recheck.checks.filter((c) => !c.ok).map((c) => c.detail),
              message: "既有分配已违反当前约束（如资质过期），需人工处置，系统未静默改写",
            },
          });
        }
      }
    }

    // 2. 汇总空缺岗位
    const openSlots: Slot[] = [];
    for (const session of plannable) {
      const active = this.store.activeAssignmentsOfSession(session.id);
      for (const tr of this.store.templateRoles(session.templateId)) {
        const filled = active.filter((a) => a.role === tr.role).length;
        for (let i = filled; i < tr.requiredCount; i++) openSlots.push({ session, role: tr.role });
      }
    }

    // 3. 贪心填充：每轮挑“可行候选最少”的岗位，人选取负载最低者（并列时取对他处可替代性最高者）
    const remaining = [...openSlots];
    while (remaining.length > 0) {
      let bestSlotIdx = 0;
      let bestCandidates = this.candidatesFor(remaining[0], remaining);
      let bestFeasibleCount = bestCandidates.filter((c) => c.feasible).length;
      for (let i = 1; i < remaining.length; i++) {
        const candidates = this.candidatesFor(remaining[i], remaining);
        const feasibleCount = candidates.filter((c) => c.feasible).length;
        const cur = remaining[i];
        const best = remaining[bestSlotIdx];
        if (
          feasibleCount < bestFeasibleCount ||
          (feasibleCount === bestFeasibleCount &&
            (cur.session.startsAt < best.session.startsAt ||
              (cur.session.startsAt === best.session.startsAt && cur.role < best.role)))
        ) {
          bestSlotIdx = i;
          bestCandidates = candidates;
          bestFeasibleCount = feasibleCount;
        }
      }
      const slot = remaining.splice(bestSlotIdx, 1)[0];
      const feasible = bestCandidates
        .filter((c) => c.feasible)
        .sort((a, b) => a.load - b.load || b.alternatives - a.alternatives || a.actorId.localeCompare(b.actorId));

      if (feasible.length === 0) {
        unmet.push({
          sessionId: slot.session.id,
          kind: "role_unfilled",
          detail: {
            role: slot.role,
            missing: 1,
            rejectedCandidates: bestCandidates.map((c) => ({ actorId: c.actorId, violations: c.violations })),
            message: `岗位「${slot.role}」无可行人选`,
          },
        });
        continue;
      }

      const chosen = feasible[0];
      const checks = this.evaluator.evaluate(chosen.actorId, slot.role, slot.session);
      const reason = JSON.stringify({
        strategy: "most-constrained-slot-first + least-loaded-actor",
        chosen: {
          actorId: chosen.actorId,
          load: chosen.load,
          alternativesElsewhere: chosen.alternatives,
          why: "可行候选中当前负载最低；同负载下对其他空缺岗位的可替代性最高，把稀缺人选留给更紧缺的岗位，保留应急替补余量",
        },
        candidates: bestCandidates.map((c) => ({
          actorId: c.actorId,
          feasible: c.feasible,
          load: c.load,
          alternativesElsewhere: c.alternatives,
          violations: c.violations,
        })),
        checks,
      });
      const assignment = this.store.createAssignment({
        sessionId: slot.session.id,
        role: slot.role,
        actorId: chosen.actorId,
        reason,
        createdAt: now,
      });
      created.push(assignment);
    }

    // 4. 替补余量评估（基于最终分配状态）
    const slack: SlackInfo[] = [];
    for (const session of plannable) {
      for (const tr of this.store.templateRoles(session.templateId)) {
        const info = this.computeSlack(session, tr.role);
        slack.push(info);
        if (!info.ok) {
          unmet.push({
            sessionId: session.id,
            kind: "backup_slack_shortage",
            detail: {
              role: tr.role,
              backups: info.backupActorIds.length,
              required: info.requiredBackup,
              backupActorIds: info.backupActorIds,
              message: `岗位「${tr.role}」应急替补仅 ${info.backupActorIds.length} 人，低于要求的 ${info.requiredBackup} 人`,
            },
          });
        }
      }
    }

    // 5. 未满足需求与审计落库
    for (const u of unmet) this.store.insertUnmet(runId, u.sessionId, u.kind, u.detail, now);
    this.store.audit(now, operator ?? null, "plan.generate", {
      runId,
      from: fromIso,
      to: toIso,
      created: created.length,
      kept: keptAssignmentIds.length,
      lockedSessions: lockedSessionIds,
      blockedStarted: blockedStartedIds,
      unmet: unmet.length,
    });

    return {
      runId,
      from: fromIso,
      to: toIso,
      createdAssignments: created,
      keptAssignmentIds,
      lockedSessionIds,
      blockedStartedIds,
      slack,
      unmet: this.store.unmetOfRun(runId),
    };
  }
}
