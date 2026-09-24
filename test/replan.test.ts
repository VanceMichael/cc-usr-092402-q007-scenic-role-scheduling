import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TestApp, makeSession, seedWorld, startTestApp } from "./helpers.js";

let app: TestApp;
beforeEach(async () => {
  app = await startTestApp();
});
afterEach(async () => {
  await app.close();
});

const DAY = "2026-09-24";
const RANGE = { from: `${DAY}T00:00:00Z`, to: `${DAY}T23:59:59Z` };

describe("设施故障停演：只重算受影响区间", () => {
  it("故障窗口内的未开始场次停演并通知演员，窗口外与其他区域不受影响", async () => {
    const w = await seedWorld(app.api);
    await app.api("PUT", "/rules", { reservePerRole: 0 });
    const s1 = await makeSession(app.api, w.tplA, `${DAY}T10:00:00Z`); // 区域A 10:00-10:30
    const s2 = await makeSession(app.api, w.tplA, `${DAY}T12:00:00Z`); // 区域A 12:00-12:30
    const s3 = await makeSession(app.api, w.tplB, `${DAY}T10:00:00Z`); // 区域B 同时段
    const gen = await app.api("POST", "/plans/generate", RANGE);
    expect(gen.body.createdAssignments).toHaveLength(3);
    const before = await app.api("GET", `/sessions/${s2.id}`);

    const outage = await app.api("POST", `/zones/${w.zoneA}/outage`, {
      from: `${DAY}T09:30:00Z`,
      to: `${DAY}T10:45:00Z`,
      reason: "喷泉设备漏水",
    });
    expect(outage.status).toBe(200);
    expect(outage.body.affectedWindow).toEqual({
      from: `${DAY}T09:30:00.000Z`,
      to: `${DAY}T10:45:00.000Z`,
    });
    // 只有 s1 在窗口内
    expect(outage.body.changes.map((c: any) => c.sessionId)).toEqual([s1.id]);

    const after1 = await app.api("GET", `/sessions/${s1.id}`);
    expect(after1.body.status).toBe("cancelled");
    expect(after1.body.assignments).toHaveLength(0);
    // 窗口外的 s2 与其他区域的 s3 完全未动（版本仍为 1）
    const after2 = await app.api("GET", `/sessions/${s2.id}`);
    expect(after2.body.status).toBe("scheduled");
    expect(after2.body.assignments[0].version).toBe(before.body.assignments[0].version);
    const after3 = await app.api("GET", `/sessions/${s3.id}`);
    expect(after3.body.assignments).toHaveLength(1);

    // 被停演场次的演员收到待确认的取消通知
    const cancelledActor = gen.body.createdAssignments.find(
      (a: any) => a.sessionId === s1.id,
    ).actorId;
    const notices = await app.api("GET", `/notifications?actorId=${cancelledActor}&status=pending`);
    expect(notices.body.some((n: any) => n.kind === "cancelled")).toBe(true);
  });

  it("故障窗口内已开始的场次不被改写，只列入跳过清单", async () => {
    const w = await seedWorld(app.api);
    const s = await makeSession(app.api, w.tplA, `${DAY}T10:00:00Z`);
    await app.api("POST", "/plans/generate", RANGE);
    const started = await app.api("POST", `/sessions/${s.id}/start`, {
      expectedVersion: s.version,
    });
    expect(started.status).toBe(200);

    const outage = await app.api("POST", `/zones/${w.zoneA}/outage`, {
      from: `${DAY}T09:30:00Z`,
      to: `${DAY}T11:00:00Z`,
      reason: "舞台机械故障",
    });
    expect(outage.body.skippedStartedSessionIds).toEqual([s.id]);
    expect(outage.body.changes).toHaveLength(0);
    const after = await app.api("GET", `/sessions/${s.id}`);
    expect(after.body.status).toBe("started");
    expect(after.body.assignments).toHaveLength(1);
  });

  it("区域停用期间不为该区域新场次排班，恢复开放后正常", async () => {
    const w = await seedWorld(app.api);
    await app.api("POST", `/zones/${w.zoneA}/outage`, {
      from: `${DAY}T09:00:00Z`,
      to: `${DAY}T11:00:00Z`,
      reason: "电力检修",
    });
    // 停用期间新建的窗口外场次也不予排班
    const s = await makeSession(app.api, w.tplA, `${DAY}T15:00:00Z`);
    const gen1 = await app.api("POST", "/plans/generate", RANGE);
    expect(gen1.body.createdAssignments).toHaveLength(0);
    expect(gen1.body.unmet[0].reason).toBe("zone_down");

    await app.api("POST", `/zones/${w.zoneA}/reopen`);
    const gen2 = await app.api("POST", "/plans/generate", RANGE);
    expect(gen2.body.createdAssignments).toHaveLength(1);
    expect(gen2.body.createdAssignments[0].sessionId).toBe(s.id);
  });

  it("停演场次的已确认预约转为未满足需求，提示改签或退款", async () => {
    const w = await seedWorld(app.api);
    const s = await makeSession(app.api, w.tplA, `${DAY}T10:00:00Z`);
    await app.api("POST", `/sessions/${s.id}/reservations`, { visitorGroup: "旅行团", size: 30 });
    await app.api("POST", "/plans/generate", RANGE);

    const outage = await app.api("POST", `/zones/${w.zoneA}/outage`, {
      from: `${DAY}T09:00:00Z`,
      to: `${DAY}T11:00:00Z`,
      reason: "电力检修",
    });
    expect(outage.status).toBe(200);
    const explain = await app.api("GET", `/sessions/${s.id}/explain`);
    expect(explain.body.unmet).toHaveLength(1);
    expect(explain.body.unmet[0].reason).toBe("session_cancelled");
    expect(explain.body.unmet[0].detail).toContain("30");
  });
});

describe("迟到打卡：只重算受影响区间", () => {
  it("迟到演员的受影响场次由替补顶上，到岗后的场次原样保留", async () => {
    const w = await seedWorld(app.api);
    const s1 = await makeSession(app.api, w.tplA, `${DAY}T10:00:00Z`);
    const s2 = await makeSession(app.api, w.tplA, `${DAY}T11:00:00Z`);
    const gen = await app.api("POST", "/plans/generate", RANGE);
    expect(gen.body.createdAssignments).toHaveLength(2);
    const s1Assign = gen.body.createdAssignments.find((a: any) => a.sessionId === s1.id);
    const s2Assign = gen.body.createdAssignments.find((a: any) => a.sessionId === s2.id);

    // 当前 08:00，10:00 场的演员迟到 150 分钟 → 10:30 才能到岗，影响 10:00 场，不影响 11:00 场
    const late = await app.api("POST", `/actors/${s1Assign.actorId}/checkin`, {
      status: "late",
      lateMinutes: 150,
    });
    expect(late.status).toBe(200);
    expect(late.body.kind).toBe("late_checkin");
    expect(late.body.affectedWindow.to).toBe(`${DAY}T10:30:00.000Z`);
    expect(late.body.changes).toHaveLength(1);
    expect(late.body.changes[0].sessionId).toBe(s1.id);
    expect(late.body.changes[0].substituteActorId).toBeDefined();
    expect(late.body.changes[0].substituteActorId).not.toBe(s1Assign.actorId);

    // 10:00 场换上替补，11:00 场分配版本未变（未被重算）
    const after1 = await app.api("GET", `/sessions/${s1.id}`);
    expect(after1.body.assignments[0].actorId).toBe(late.body.changes[0].substituteActorId);
    const after2 = await app.api("GET", `/sessions/${s2.id}`);
    expect(after2.body.assignments[0].id).toBe(s2Assign.id);
    expect(after2.body.assignments[0].version).toBe(1);

    // 替补分配的轨迹注明了迟到应急场景
    const explain = await app.api("GET", `/sessions/${s1.id}/explain`);
    const trace = explain.body.assignments[0].trace;
    expect(
      trace.some((t: any) => t.constraint === "emergency_reserve" && t.detail.includes("迟到")),
    ).toBe(true);
  });

  it("没有合格替补时记为未满足需求", async () => {
    const w = await seedWorld(app.api);
    const s1 = await makeSession(app.api, w.tplA, `${DAY}T10:00:00Z`);
    const gen = await app.api("POST", "/plans/generate", RANGE);
    const assign = gen.body.createdAssignments[0];
    // 另一名骑士停用，替补池清空
    const otherId = assign.actorId === w.a1 ? w.a2 : w.a1;
    const other = (await app.api("GET", `/actors/${otherId}`)).body;
    await app.api("PATCH", `/actors/${otherId}`, { expectedVersion: other.version, active: false });

    const late = await app.api("POST", `/actors/${assign.actorId}/checkin`, {
      status: "late",
      lateMinutes: 150,
    });
    expect(late.body.unmet).toHaveLength(1);
    expect(late.body.unmet[0].reason).toBe("no_substitute");
    const explain = await app.api("GET", `/sessions/${s1.id}/explain`);
    expect(explain.body.unmet[0].reason).toBe("no_substitute");
    expect(explain.body.assignments).toHaveLength(0);
  });

  it("已开始场次中的迟到演员不被静默替换", async () => {
    const w = await seedWorld(app.api);
    const s = await makeSession(app.api, w.tplA, `${DAY}T10:00:00Z`);
    const gen = await app.api("POST", "/plans/generate", RANGE);
    const assign = gen.body.createdAssignments[0];
    await app.api("POST", `/sessions/${s.id}/start`, { expectedVersion: s.version });

    const late = await app.api("POST", `/actors/${assign.actorId}/checkin`, {
      status: "late",
      lateMinutes: 150,
    });
    expect(late.body.skippedStartedSessionIds).toEqual([s.id]);
    expect(late.body.changes).toHaveLength(0);
    const after = await app.api("GET", `/sessions/${s.id}`);
    expect(after.body.assignments[0].actorId).toBe(assign.actorId);
  });
});
