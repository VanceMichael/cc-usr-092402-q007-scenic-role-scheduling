import {
  ActorRow,
  QualificationRow,
  Rules,
  SessionRow,
  TraceEntry,
  minutesBetween,
} from "./types.js";
import { AssignmentWithSession } from "./store.js";

export interface CheckInput {
  role: string;
  actor: ActorRow;
  qualifications: QualificationRow[];
  session: SessionRow;
  zoneId: string;
  actorAssignments: AssignmentWithSession[];
  transferMinutes: (fromZone: string, toZone: string) => number;
  rules: Rules;
}

/**
 * 对“把某演员按某角色排进某场次”做全量约束判定。
 * 不抛异常，返回完整轨迹：每一项约束的判定结果都写入 trace，
 * 既用于拒绝分配，也随成功分配持久化，供解释接口回放。
 */
export function checkAssignment(input: CheckInput): TraceEntry[] {
  const { role, actor, qualifications, session, zoneId, actorAssignments, rules } = input;
  const trace: TraceEntry[] = [];

  trace.push(
    actor.active
      ? { constraint: "actor_active", ok: true, detail: `演员「${actor.name}」在岗` }
      : { constraint: "actor_active", ok: false, detail: `演员「${actor.name}」已停用` },
  );

  const qual = qualifications.find((q) => q.role === role);
  if (!qual) {
    trace.push({
      constraint: "qualification",
      ok: false,
      detail: `演员「${actor.name}」不具备角色「${role}」资质`,
    });
  } else if (!(qual.validFrom <= session.startTs && qual.validUntil >= session.endTs)) {
    trace.push({
      constraint: "qualification_validity",
      ok: false,
      detail: `角色「${role}」资质有效期 ${qual.validFrom} ~ ${qual.validUntil}，不能覆盖场次 ${session.startTs} ~ ${session.endTs}`,
    });
  } else {
    trace.push({
      constraint: "qualification_validity",
      ok: true,
      detail: `角色「${role}」资质有效（${qual.validFrom} ~ ${qual.validUntil}）`,
    });
  }

  for (const other of actorAssignments) {
    const overlaps = other.sessionStart < session.endTs && session.startTs < other.sessionEnd;
    if (overlaps) {
      trace.push({
        constraint: "overlap",
        ok: false,
        detail: `与已排场次 ${other.sessionStart} ~ ${other.sessionEnd} 时间重叠`,
      });
      continue;
    }
    // 相邻场次：检查步行转场与休息间隔
    const before = other.sessionEnd <= session.startTs;
    const [fromZone, toZone, gap] = before
      ? [other.zoneId, zoneId, minutesBetween(other.sessionEnd, session.startTs)]
      : [zoneId, other.zoneId, minutesBetween(session.endTs, other.sessionStart)];
    const need = input.transferMinutes(fromZone, toZone);
    trace.push(
      gap >= need
        ? {
            constraint: "transfer",
            ok: true,
            detail: `与相邻场次间隔 ${gap} 分钟，满足转场步行 ${need} 分钟`,
          }
        : {
            constraint: "transfer_infeasible",
            ok: false,
            detail: `转场赶场冲突：与相邻场次间隔 ${gap} 分钟，小于区域间步行 ${need} 分钟`,
          },
    );
    trace.push(
      gap >= rules.minRestMinutes
        ? {
            constraint: "rest",
            ok: true,
            detail: `与相邻场次间隔 ${gap} 分钟，满足最小休息 ${rules.minRestMinutes} 分钟`,
          }
        : {
            constraint: "rest_violation",
            ok: false,
            detail: `休息不足：与相邻场次间隔 ${gap} 分钟，小于最小休息 ${rules.minRestMinutes} 分钟`,
          },
    );
  }

  const day = session.startTs.slice(0, 10);
  const sameDay = actorAssignments.filter((a) => a.sessionStart.slice(0, 10) === day).length;
  trace.push(
    sameDay < rules.maxSessionsPerDay
      ? {
          constraint: "daily_limit",
          ok: true,
          detail: `当日已排 ${sameDay} 场，上限 ${rules.maxSessionsPerDay} 场`,
        }
      : {
          constraint: "daily_limit",
          ok: false,
          detail: `当日已排 ${sameDay} 场，达到上限 ${rules.maxSessionsPerDay} 场`,
        },
  );

  return trace;
}

export const violationsOf = (trace: TraceEntry[]): TraceEntry[] => trace.filter((e) => !e.ok);
