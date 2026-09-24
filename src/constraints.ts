import { parseIso } from "./clock.js";
import type { SessionView, Store } from "./store.js";

/** 单条约束的检查结果，ok=false 即违反；detail 面向调度员可解释。 */
export interface ConstraintCheck {
  constraint: "qualification" | "same_session" | "overlap" | "rest_transfer_prev" | "rest_transfer_next";
  ok: boolean;
  detail: string;
  data?: Record<string, unknown>;
}

export interface EvalContext {
  /** 计划过程中尚未落库的拟新增分配，参与转场/休息/重叠判断。 */
  tentative?: { actorId: string; session: SessionView }[];
  /** 重新评估既有分配时排除其自身。 */
  excludeAssignmentId?: string;
}

interface NeighborInfo {
  sessionId: string;
  startsAt: string;
  endsAt: string;
  zoneId: string;
}

export class ConstraintEvaluator {
  constructor(private store: Store) {}

  private transferMinutes(fromZone: string, toZone: string): { minutes: number; assumed: boolean } {
    const configured = this.store.configuredTransferMinutes(fromZone, toZone);
    if (configured !== null) return { minutes: configured, assumed: false };
    return { minutes: this.store.configNumber("default_transfer_minutes"), assumed: true };
  }

  /** 汇总演员既有 + 拟新增的相邻场次。 */
  private neighbors(actorId: string, target: SessionView, ctx: EvalContext): { prev: NeighborInfo | null; next: NeighborInfo | null; overlapping: NeighborInfo[] } {
    const startMs = parseIso(target.startsAt);
    const endMs = parseIso(target.endsAt);
    const existing = this.store
      .activeAssignmentsOfActor(actorId)
      .filter((a) => a.id !== ctx.excludeAssignmentId)
      .map((a) => ({ sessionId: a.sessionId, startsAt: a.session.startsAt, endsAt: a.session.endsAt, zoneId: a.session.zoneId }));
    const tentative = (ctx.tentative ?? [])
      .filter((t) => t.actorId === actorId)
      .map((t) => ({ sessionId: t.session.id, startsAt: t.session.startsAt, endsAt: t.session.endsAt, zoneId: t.session.zoneId }));
    const all = [...existing, ...tentative].filter((n) => n.sessionId !== target.id);

    let prev: NeighborInfo | null = null;
    let next: NeighborInfo | null = null;
    const overlapping: NeighborInfo[] = [];
    for (const n of all) {
      const ns = parseIso(n.startsAt);
      const ne = parseIso(n.endsAt);
      if (ns < endMs && ne > startMs) overlapping.push(n);
      if (ne <= startMs && (!prev || ne > parseIso(prev.endsAt))) prev = n;
      if (ns >= endMs && (!next || ns < parseIso(next.startsAt))) next = n;
    }
    return { prev, next, overlapping };
  }

  /**
   * 评估“把 actor 分配到 session 演 role”涉及的全部约束。
   * 无论通过与否都返回完整检查清单，供分配原因与解释接口使用。
   */
  evaluate(actorId: string, role: string, session: SessionView, ctx: EvalContext = {}): ConstraintCheck[] {
    const checks: ConstraintCheck[] = [];
    const restMinutes = this.store.configNumber("rest_minutes");

    // 1. 资质与有效期：资质须覆盖整场演出
    const quals = this.store.qualificationsOf(actorId).filter((q) => q.role === role);
    const covering = quals.find((q) => q.validFrom <= session.startsAt && q.validUntil >= session.endsAt);
    checks.push({
      constraint: "qualification",
      ok: !!covering,
      detail: covering
        ? `持有「${role}」资质，有效期 ${covering.validFrom} ~ ${covering.validUntil}，覆盖本场`
        : quals.length
          ? `「${role}」资质有效期不覆盖 ${session.startsAt} ~ ${session.endsAt}`
          : `未持有「${role}」资质`,
      data: covering ? { validFrom: covering.validFrom, validUntil: covering.validUntil } : undefined,
    });

    // 2. 同场不重复
    const sameSession = this.store.hasActiveAssignmentOn(session.id, actorId);
    checks.push({
      constraint: "same_session",
      ok: !sameSession,
      detail: sameSession ? "已在该场次持有其他岗位" : "未在该场次重复上岗",
    });

    const { prev, next, overlapping } = this.neighbors(actorId, session, ctx);

    // 3. 时间不重叠
    checks.push({
      constraint: "overlap",
      ok: overlapping.length === 0,
      detail:
        overlapping.length === 0
          ? "与既有安排时间不重叠"
          : `与 ${overlapping.length} 个场次时间重叠：${overlapping.map((o) => o.sessionId).join("、")}`,
      data: overlapping.length ? { conflicts: overlapping.map((o) => o.sessionId) } : undefined,
    });

    // 4/5. 与前/后场次的休息 + 步行转场
    const gapCheck = (
      constraint: "rest_transfer_prev" | "rest_transfer_next",
      neighbor: NeighborInfo | null,
      fromZone: string,
      toZone: string,
      gapMs: number,
      label: string,
    ): ConstraintCheck => {
      if (!neighbor) return { constraint, ok: true, detail: `${label}无相邻场次，无需转场` };
      const t = this.transferMinutes(fromZone, toZone);
      const needMs = (t.minutes + restMinutes) * 60_000;
      const gapMin = Math.floor(gapMs / 60_000);
      const ok = gapMs >= needMs;
      return {
        constraint,
        ok,
        detail: ok
          ? `${label}间隔 ${gapMin} 分钟 ≥ 步行 ${t.minutes} 分钟${t.assumed ? "（缺省估计）" : ""} + 休息 ${restMinutes} 分钟`
          : `${label}间隔仅 ${gapMin} 分钟，不足步行 ${t.minutes} 分钟${t.assumed ? "（缺省估计）" : ""} + 休息 ${restMinutes} 分钟（赶场冲突）`,
        data: { neighborSessionId: neighbor.sessionId, gapMinutes: gapMin, transferMinutes: t.minutes, restMinutes, transferAssumed: t.assumed },
      };
    };

    checks.push(
      prev
        ? gapCheck("rest_transfer_prev", prev, prev.zoneId, session.zoneId, parseIso(session.startsAt) - parseIso(prev.endsAt), "与上一场次")
        : gapCheck("rest_transfer_prev", null, "", "", 0, "向前"),
    );
    checks.push(
      next
        ? gapCheck("rest_transfer_next", next, session.zoneId, next.zoneId, parseIso(next.startsAt) - parseIso(session.endsAt), "与下一场次")
        : gapCheck("rest_transfer_next", null, "", "", 0, "向后"),
    );

    return checks;
  }

  isFeasible(actorId: string, role: string, session: SessionView, ctx: EvalContext = {}): { feasible: boolean; checks: ConstraintCheck[] } {
    const checks = this.evaluate(actorId, role, session, ctx);
    return { feasible: checks.every((c) => c.ok), checks };
  }
}
