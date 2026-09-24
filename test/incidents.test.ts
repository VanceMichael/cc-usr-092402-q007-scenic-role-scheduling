import { describe, expect, it } from "vitest";
import { at, makeService, seedBase } from "./helpers.js";

const DAY_FROM = at("00:00");
const DAY_TO = at("23:59");

function seedWithDay() {
  const seed = makeService();
  seedBase(seed.service);
  const s = seed.service.store;
  s.createSession("S1", "T1", at("10:00")); // Z1
  s.createSession("S2", "T2", at("11:00")); // Z2
  s.createSession("S3", "T1", at("14:00")); // Z1
  seed.service.generatePlan(DAY_FROM, DAY_TO);
  return seed;
}

describe("设施故障停演（局部重算）", () => {
  it("只取消受影响区间内该区域的场次，其余保持不动", () => {
    const { service } = seedWithDay();
    const s = service.store;
    s.createReservation("S1", 30);

    const result = service.store.transaction(() =>
      service.incidents.facilityOutage("Z1", at("09:30"), at("10:30"), "音响故障", "dispatcher-1"),
    );

    // S1 被取消，S2（其他区域）、S3（区间外）不受影响
    expect(result.cancelledSessionIds).toEqual(["S1"]);
    expect(s.getSession("S1").status).toBe("cancelled");
    expect(s.getSession("S2").status).toBe("scheduled");
    expect(s.getSession("S3").status).toBe("scheduled");
    expect(s.activeAssignmentsOfSession("S2").length).toBeGreaterThan(0);
    expect(s.activeAssignmentsOfSession("S3").length).toBeGreaterThan(0);

    // S1 的分配被取消并通知演员确认
    expect(s.activeAssignmentsOfSession("S1")).toHaveLength(0);
    const cancelNotices = s
      .listNotifications({ status: "pending" })
      .filter((n) => n.kind === "assignment_cancelled");
    expect(cancelNotices.length).toBeGreaterThan(0);

    // 30 个已确认预约成为孤儿需求
    const orphan = result.unmet.find((u) => u.kind === "reservation_orphaned");
    expect(orphan).toBeDefined();
    expect(JSON.parse(orphan!.detail).seats).toBe(30);
  });

  it("已开始的场次不被停演改写，进入 blocked 清单", () => {
    const { service } = seedWithDay();
    const s = service.store;
    service.startSession("S3", s.getSession("S3").version);
    const assignmentsBefore = s.activeAssignmentsOfSession("S3").map((a) => a.id);

    const result = service.store.transaction(() =>
      service.incidents.facilityOutage("Z1", at("13:30"), at("14:30"), "舞台机械故障"),
    );

    expect(result.cancelledSessionIds).toEqual([]);
    expect(result.blockedStarted).toEqual([{ sessionId: "S3", startsAt: at("14:00") }]);
    expect(s.getSession("S3").status).toBe("started");
    expect(s.activeAssignmentsOfSession("S3").map((a) => a.id)).toEqual(assignmentsBefore);
    expect(result.unmet.some((u) => u.kind === "outage_started_session")).toBe(true);
  });
});

describe("迟到打卡（局部重算）", () => {
  it("只顶替受影响区间内的分配并选派替补，区间外不动", () => {
    const { service } = seedWithDay();
    const s = service.store;
    const s1Lead = s.activeAssignmentsOfSession("S1").find((a) => a.role === "主角")!;
    const s3Assignments = s.activeAssignmentsOfSession("S3").map((a) => a.id);

    const result = service.store.transaction(() =>
      service.incidents.lateCheckin(s1Lead.actorId, at("10:20")),
    );

    // S1 主角被顶替，替补上岗（S1 10:00 开始 < 10:20 可到时间）
    expect(result.replacedAssignments).toHaveLength(1);
    const replaced = result.replacedAssignments[0];
    expect(replaced.sessionId).toBe("S1");
    expect(replaced.lateActorId).toBe(s1Lead.actorId);
    expect(replaced.substitute).not.toBeNull();
    expect(replaced.substitute!.actorId).not.toBe(s1Lead.actorId);
    expect(s.getAssignment(s1Lead.id).state).toBe("superseded");

    // 替补收到待确认通知
    const offer = s.listNotifications({ status: "pending" }).find((n) => n.assignmentId === replaced.substitute!.id);
    expect(offer?.kind).toBe("assignment_offered");

    // 区间外（14:00 的 S3）分配不变
    expect(s.activeAssignmentsOfSession("S3").map((a) => a.id)).toEqual(s3Assignments);
  });

  it("迟到涉及已开始场次时不静默改写，报告岗位空缺", () => {
    const { service, clock } = seedWithDay();
    const s = service.store;
    clock.set(at("11:05"));
    service.startSession("S2", s.getSession("S2").version);
    const s2Lead = s.activeAssignmentsOfSession("S2").find((a) => a.role === "主角")!;

    const result = service.store.transaction(() =>
      service.incidents.lateCheckin(s2Lead.actorId, at("11:20")),
    );

    expect(result.blockedStarted).toEqual([{ sessionId: "S2", startsAt: at("11:00"), role: "主角" }]);
    expect(result.replacedAssignments).toHaveLength(0);
    // 原分配保持，未被改写
    expect(s.getAssignment(s2Lead.id).state).toBe("notified");
    expect(result.unmet.some((u) => u.kind === "started_session_uncovered")).toBe(true);
  });

  it("无人可替补时输出未满足需求", () => {
    const { service } = makeService();
    seedBase(service);
    const s = service.store;
    // 只留 A1 一个主角，其余主角演员资质清空
    s.replaceQualifications("A2", [{ role: "群演", validFrom: "2026-01-01T00:00:00.000Z", validUntil: "2027-01-01T00:00:00.000Z" }]);
    s.replaceQualifications("A5", []);
    s.createSession("S1", "T1", at("10:00"));
    service.generatePlan(DAY_FROM, DAY_TO);
    const s1Lead = s.activeAssignmentsOfSession("S1").find((a) => a.role === "主角")!;
    expect(s1Lead.actorId).toBe("A1");

    const result = service.store.transaction(() => service.incidents.lateCheckin("A1", at("10:20")));
    expect(result.replacedAssignments[0].substitute).toBeNull();
    expect(result.unmet.some((u) => u.kind === "role_unfilled")).toBe(true);
  });
});
