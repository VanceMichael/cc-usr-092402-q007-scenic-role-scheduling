import { describe, expect, it } from "vitest";
import { at, makeService, seedBase } from "./helpers.js";

const DAY_FROM = at("00:00");
const DAY_TO = at("23:59");

function seedWithSessions() {
  const seed = makeService();
  seedBase(seed.service);
  const s = seed.service.store;
  s.createSession("S1", "T1", at("10:00")); // Z1 10:00-10:45
  s.createSession("S2", "T2", at("11:00")); // Z2 11:00-11:30
  return seed;
}

describe("方案生成器", () => {
  it("生成满足全部约束的分配，赶场冲突的演员不会连排", () => {
    const { service } = seedWithSessions();
    const result = service.generatePlan(DAY_FROM, DAY_TO);

    expect(result.createdAssignments).toHaveLength(4); // S1: 主角1+群演2，S2: 主角1
    expect(result.unmet).toHaveLength(0);

    const s1Lead = result.createdAssignments.find((a) => a.sessionId === "S1" && a.role === "主角")!;
    const s2Lead = result.createdAssignments.find((a) => a.sessionId === "S2" && a.role === "主角")!;
    // S1 结束 10:45 → S2 开始 11:00 仅 15 分钟 < 步行12+休息15，必须不同演员
    expect(s1Lead.actorId).not.toBe(s2Lead.actorId);

    // 每个分配都生成待确认通知
    const pending = service.store.listNotifications({ status: "pending" });
    expect(pending).toHaveLength(4);
    expect(pending.every((n) => n.kind === "assignment_offered" && n.deadline)).toBe(true);
  });

  it("分配原因可解释：包含采用的约束检查与候选评估", () => {
    const { service } = seedWithSessions();
    service.generatePlan(DAY_FROM, DAY_TO);
    const a = service.store.activeAssignmentsOfSession("S1").find((x) => x.role === "主角")!;
    const reason = JSON.parse(a.reason);
    expect(reason.strategy).toContain("most-constrained");
    expect(reason.chosen.why).toContain("应急替补余量");
    const constraintNames = reason.checks.map((c: { constraint: string }) => c.constraint);
    expect(constraintNames).toEqual(
      expect.arrayContaining(["qualification", "same_session", "overlap", "rest_transfer_prev", "rest_transfer_next"]),
    );
    expect(reason.checks.every((c: { ok: boolean }) => c.ok)).toBe(true);
    expect(Array.isArray(reason.candidates)).toBe(true);
  });

  it("锁定已确认预约的场次：重排不改写、不重复分配", () => {
    const { service } = seedWithSessions();
    const s = service.store;
    s.createReservation("S1", 20);

    const first = service.generatePlan(DAY_FROM, DAY_TO);
    expect(first.lockedSessionIds).toEqual(["S1"]);
    const s1Assignments = s.activeAssignmentsOfSession("S1").map((a) => a.id).sort();

    // 演员确认其中一个分配后重跑：既有分配全部保留，不新增
    const notif = s.listNotifications({ status: "pending" })[0];
    service.confirmNotification(notif.id, notif.actorId);

    const second = service.generatePlan(DAY_FROM, DAY_TO);
    expect(second.createdAssignments).toHaveLength(0);
    expect(second.keptAssignmentIds).toHaveLength(4);
    expect(s.activeAssignmentsOfSession("S1").map((a) => a.id).sort()).toEqual(s1Assignments);
    expect(s.getSession("S1").status).toBe("scheduled");
  });

  it("预约量超出区域容量时输出未满足需求", () => {
    const { service } = seedWithSessions();
    service.store.createReservation("S1", 150); // Z1 容量 100
    const result = service.generatePlan(DAY_FROM, DAY_TO);
    const overflow = result.unmet.find((u) => u.kind === "capacity_overflow");
    expect(overflow).toBeDefined();
    expect(JSON.parse(overflow!.detail)).toMatchObject({ seats: 150, capacity: 100, over: 50 });
  });

  it("应急替补余量不足时输出可解释的未满足需求", () => {
    const { service } = seedWithSessions();
    const s = service.store;
    // 让 A5 失去主角资质：S1/S2 主角占掉 A1/A2 后无人可替补
    s.replaceQualifications("A5", []);
    const result = service.generatePlan(DAY_FROM, DAY_TO);
    const shortage = result.unmet.filter((u) => u.kind === "backup_slack_shortage" && JSON.parse(u.detail).role === "主角");
    expect(shortage.length).toBeGreaterThan(0);
    const detail = JSON.parse(shortage[0].detail);
    expect(detail.required).toBe(1);
    expect(detail.backups).toBe(0);
    expect(detail.message).toContain("应急替补");
  });

  it("无人持有资质的角色进入未满足需求并说明原因", () => {
    const { service } = seedWithSessions();
    const s = service.store;
    s.createTemplate({ id: "T9", name: "灯光秀", zoneId: "Z1", durationMinutes: 30 }, [
      { role: "灯光师", requiredCount: 1, isKey: true },
    ]);
    s.createSession("S9", "T9", at("16:00"));
    const result = service.generatePlan(DAY_FROM, DAY_TO);
    const unfilled = result.unmet.find((u) => u.kind === "role_unfilled" && u.sessionId === "S9");
    expect(unfilled).toBeDefined();
    expect(JSON.parse(unfilled!.detail).role).toBe("灯光师");
  });

  it("已开始的场次不被重算改写", () => {
    const { service } = seedWithSessions();
    service.generatePlan(DAY_FROM, DAY_TO);
    const before = service.store.activeAssignmentsOfSession("S1").map((a) => a.id);
    service.startSession("S1", 1);

    const result = service.generatePlan(DAY_FROM, DAY_TO);
    expect(result.blockedStartedIds).toEqual(["S1"]);
    expect(service.store.activeAssignmentsOfSession("S1").map((a) => a.id)).toEqual(before);
    expect(service.store.getSession("S1").status).toBe("started");
  });

  it("资质过期导致既有分配失效时只报告不静默改写", () => {
    const { service } = seedWithSessions();
    service.generatePlan(DAY_FROM, DAY_TO);
    const s1Lead = service.store.activeAssignmentsOfSession("S1").find((a) => a.role === "主角")!;
    // 让该演员主角资质在演出前过期
    service.store.replaceQualifications(s1Lead.actorId, [
      { role: "主角", validFrom: "2026-01-01T00:00:00.000Z", validUntil: at("09:00") },
      { role: "群演", validFrom: "2026-01-01T00:00:00.000Z", validUntil: at("09:00") },
    ]);
    const result = service.generatePlan(DAY_FROM, DAY_TO);
    const violation = result.unmet.find((u) => u.kind === "existing_assignment_violates");
    expect(violation).toBeDefined();
    expect(JSON.parse(violation!.detail).assignmentId).toBe(s1Lead.id);
    // 未静默改写：原分配仍然有效在岗
    expect(service.store.getAssignment(s1Lead.id).state).toBe("notified");
  });
});
