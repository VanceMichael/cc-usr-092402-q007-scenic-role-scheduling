import { randomUUID } from "node:crypto";
import { DB, getRules } from "./db.js";
import { checkAssignment, violationsOf } from "./constraints.js";
import { createNotification } from "./notify.js";
import {
  activeAssignmentsOfActor,
  confirmedVisitorCount,
  loadTransfers,
  logEvent,
  transferMinutesLookup,
} from "./store.js";
import {
  ActorRow,
  AssignmentRow,
  Clock,
  QualificationRow,
  Requirement,
  Rules,
  SessionRow,
  TemplateRow,
  TraceEntry,
  ZoneRow,
} from "./types.js";

export interface UnmetRecord {
  sessionId: string;
  role: string | null;
  needed: number;
  reason: string;
  detail: string;
}

export interface PlanResult {
  runId: string;
  scope: { from: string; to: string };
  createdAssignments: AssignmentRow[];
  unmet: UnmetRecord[];
  skippedStartedSessionIds: string[];
}

export type PickResult =
  | { kind: "assigned"; actor: ActorRow; trace: TraceEntry[] }
  | { kind: "unmet"; reason: string; detail: string };

export interface PickOptions {
  excludeActorIds?: Set<string>;
  /**
   * strict：不得动用应急替补余量，宁可记为未满足；
   * dip：允许动用余量（已确认预约锁定场次、迟到替补等应急场景），轨迹中注明。
   */
  reserveMode: "strict" | "dip";
  reserveNote?: string;
}

/**
 * 为某场次的某个角色空缺挑选演员。
 * 候选排序：当日已排场次少者优先（均衡负荷），其次按 id 保证确定性。
 */
export function pickCandidate(
  db: DB,
  rules: Rules,
  session: SessionRow,
  template: TemplateRow,
  role: string,
  opts: PickOptions,
): PickResult {
  const exclude = opts.excludeActorIds ?? new Set<string>();
  const transfers = loadTransfers(db);
  const transferMinutes = transferMinutesLookup(transfers);

  const actors = db.prepare("SELECT * FROM actors WHERE active = 1").all() as ActorRow[];
  const quals = db
    .prepare("SELECT * FROM qualifications WHERE role = ?")
    .all(role) as QualificationRow[];
  const qualByActor = new Map(quals.map((q) => [q.actorId, q]));

  // 应急替补余量池：资质在场次期间有效、且时段不与现有分配重叠的演员
  const poolFree = new Set<string>();
  for (const a of actors) {
    const q = qualByActor.get(a.id);
    if (!q) continue;
    if (!(q.validFrom <= session.startTs && q.validUntil >= session.endTs)) continue;
    const overlap = db
      .prepare(
        `SELECT COUNT(*) AS c FROM assignments x JOIN sessions s ON x.sessionId = s.id
         WHERE x.actorId = ? AND x.status = 'active' AND s.status != 'cancelled'
           AND s.startTs < ? AND ? < s.endTs`,
      )
      .get(a.id, session.endTs, session.startTs) as { c: number };
    if (overlap.c === 0) poolFree.add(a.id);
  }

  const day = session.startTs.slice(0, 10);
  const candidates = actors
    .filter((a) => !exclude.has(a.id) && qualByActor.has(a.id))
    .map((a) => ({
      actor: a,
      load: activeAssignmentsOfActor(db, a.id).filter((x) => x.sessionStart.slice(0, 10) === day)
        .length,
    }))
    .sort((x, y) => x.load - y.load || x.actor.id.localeCompare(y.actor.id));

  const failedReasons: string[] = [];
  let reserveBlocked = 0;
  for (const { actor } of candidates) {
    const trace = checkAssignment({
      role,
      actor,
      qualifications: quals.filter((q) => q.actorId === actor.id),
      session,
      zoneId: template.zoneId,
      actorAssignments: activeAssignmentsOfActor(db, actor.id),
      transferMinutes,
      rules,
    });
    const violations = violationsOf(trace);
    if (violations.length > 0) {
      if (failedReasons.length < 3) {
        failedReasons.push(`${actor.name}: ${violations[0].detail}`);
      }
      continue;
    }
    const poolAfter = poolFree.size - (poolFree.has(actor.id) ? 1 : 0);
    if (poolAfter < rules.reservePerRole && opts.reserveMode === "strict") {
      reserveBlocked += 1;
      continue;
    }
    if (poolAfter < rules.reservePerRole) {
      trace.push({
        constraint: "emergency_reserve",
        ok: true,
        detail: `${opts.reserveNote ?? "应急场景"}，动用应急替补余量（分配后余量 ${poolAfter} 名，低于保留线 ${rules.reservePerRole} 名）`,
      });
    } else if (opts.reserveMode === "dip" && opts.reserveNote) {
      trace.push({
        constraint: "emergency_reserve",
        ok: true,
        detail: `${opts.reserveNote}（分配后应急替补余量 ${poolAfter} 名，满足保留线 ${rules.reservePerRole} 名）`,
      });
    } else {
      trace.push({
        constraint: "emergency_reserve",
        ok: true,
        detail: `分配后应急替补余量 ${poolAfter} 名，满足保留线 ${rules.reservePerRole} 名`,
      });
    }
    return { kind: "assigned", actor, trace };
  }

  if (reserveBlocked > 0) {
    // 有候选人通过了全部约束，仅因应急余量保留线而未上岗
    const extra =
      failedReasons.length > 0 ? `；另有候选人因约束不可用：${failedReasons.join("；")}` : "";
    return {
      kind: "unmet",
      reason: "reserve_preserved",
      detail: `可为角色「${role}」上岗的 ${reserveBlocked} 名演员是最后的应急替补，为保留 ${rules.reservePerRole} 名应急余量未予分配${extra}`,
    };
  }
  return {
    kind: "unmet",
    reason: "no_qualified_candidate",
    detail:
      failedReasons.length > 0
        ? `角色「${role}」无可用候选人：${failedReasons.join("；")}`
        : `没有演员持有角色「${role}」的有效资质`,
  };
}

/** 创建分配并发送待确认通知。 */
export function insertAssignment(
  db: DB,
  clock: Clock,
  rules: Rules,
  input: {
    sessionId: string;
    actorId: string;
    role: string;
    locked: boolean;
    trace: TraceEntry[];
  },
): AssignmentRow {
  const row: AssignmentRow = {
    id: randomUUID(),
    sessionId: input.sessionId,
    actorId: input.actorId,
    role: input.role,
    status: "active",
    locked: input.locked ? 1 : 0,
    trace: JSON.stringify(input.trace),
    createdTs: clock().toISOString(),
    version: 1,
  };
  db.prepare(
    `INSERT INTO assignments (id, sessionId, actorId, role, status, locked, trace, createdTs, version)
     VALUES (@id, @sessionId, @actorId, @role, @status, @locked, @trace, @createdTs, @version)`,
  ).run(row);
  createNotification(db, clock, rules, {
    assignmentId: row.id,
    actorId: row.actorId,
    kind: "assigned",
    payload: { sessionId: row.sessionId, role: row.role },
  });
  logEvent(db, clock, "assignment_created", "assignment", row.id, {
    sessionId: row.sessionId,
    actorId: row.actorId,
    role: row.role,
    locked: row.locked,
  });
  return row;
}

/**
 * 生成排班方案：填充 [from, to] 内未开始场次的角色空缺。
 * - 有已确认预约的场次优先排满（锁定游客预约），允许动用应急余量；
 * - 无预约场次严格保留应急替补余量，排不出就记为未满足需求；
 * - 已开始的场次一律跳过，绝不在生成中静默改写。
 */
export function generatePlan(db: DB, clock: Clock, scope: { from: string; to: string }): PlanResult {
  const rules = getRules(db);
  const nowIso = clock().toISOString();
  const runId = randomUUID();

  const sessions = db
    .prepare(
      "SELECT * FROM sessions WHERE status = 'scheduled' AND startTs >= ? AND startTs <= ? ORDER BY startTs",
    )
    .all(scope.from, scope.to) as SessionRow[];

  const created: AssignmentRow[] = [];
  const unmet: UnmetRecord[] = [];
  const skippedStarted: string[] = [];

  const tx = db.transaction(() => {
    // 有已确认预约的场次优先，保证锁定预约的需求先被满足
    const decorated = sessions.map((s) => ({ s, confirmed: confirmedVisitorCount(db, s.id) }));
    decorated.sort((a, b) => b.confirmed - a.confirmed || a.s.startTs.localeCompare(b.s.startTs));

    const touchedSessionIds: string[] = [];
    for (const { s: session, confirmed } of decorated) {
      if (session.startTs <= nowIso) {
        skippedStarted.push(session.id);
        continue;
      }
      const template = db
        .prepare("SELECT * FROM templates WHERE id = ?")
        .get(session.templateId) as TemplateRow;
      const zone = db.prepare("SELECT * FROM zones WHERE id = ?").get(template.zoneId) as ZoneRow;
      touchedSessionIds.push(session.id);

      if (zone.status === "down") {
        unmet.push({
          sessionId: session.id,
          role: null,
          needed: 1,
          reason: "zone_down",
          detail: `区域「${zone.name}」设施故障停用中，恢复开放前不予排班`,
        });
        continue;
      }

      if (confirmed > zone.capacity) {
        unmet.push({
          sessionId: session.id,
          role: null,
          needed: confirmed - zone.capacity,
          reason: "zone_capacity",
          detail: `已确认预约 ${confirmed} 人，超出区域「${zone.name}」容量 ${zone.capacity} 人，需分流或扩容`,
        });
      }

      const lockedSession = confirmed > 0;
      const requirements = JSON.parse(template.requirements) as Requirement[];
      for (const req of requirements) {
        const filled = (
          db
            .prepare(
              "SELECT COUNT(*) AS c FROM assignments WHERE sessionId = ? AND role = ? AND status = 'active'",
            )
            .get(session.id, req.role) as { c: number }
        ).c;
        let open = req.count - filled;
        while (open > 0) {
          const pick = pickCandidate(db, rules, session, template, req.role, {
            reserveMode: lockedSession ? "dip" : "strict",
            reserveNote: "场次存在已确认预约，优先保障开演",
          });
          if (pick.kind === "unmet") {
            unmet.push({
              sessionId: session.id,
              role: req.role,
              needed: open,
              reason: pick.reason,
              detail: pick.detail,
            });
            break;
          }
          created.push(
            insertAssignment(db, clock, rules, {
              sessionId: session.id,
              actorId: pick.actor.id,
              role: req.role,
              locked: lockedSession,
              trace: pick.trace,
            }),
          );
          open -= 1;
        }
      }
    }

    // 未满足需求只保留最新一次计算结果，解释接口读取的即是当前状态
    if (touchedSessionIds.length > 0) {
      const del = db.prepare(
        `DELETE FROM unmet_requirements WHERE sessionId IN (${touchedSessionIds.map(() => "?").join(",")})`,
      );
      del.run(...touchedSessionIds);
    }
    const insertUnmet = db.prepare(
      "INSERT INTO unmet_requirements (id, runId, sessionId, role, needed, reason, detail, createdTs) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (const u of unmet) {
      insertUnmet.run(randomUUID(), runId, u.sessionId, u.role, u.needed, u.reason, u.detail, nowIso);
    }
    db.prepare("INSERT INTO plan_runs (id, kind, scope, createdTs) VALUES (?, ?, ?, ?)").run(
      runId,
      "generate",
      JSON.stringify(scope),
      nowIso,
    );
    logEvent(db, clock, "plan_generated", "plan_run", runId, {
      scope,
      created: created.length,
      unmet: unmet.length,
      skippedStarted: skippedStarted.length,
    });
  });
  tx();

  return { runId, scope, createdAssignments: created, unmet, skippedStartedSessionIds: skippedStarted };
}
