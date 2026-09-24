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

describe("方案生成：资质、转场、休息、容量", () => {
  it("只把角色排给资质在有效期内的演员，并在解释中给出约束轨迹", async () => {
    const w = await seedWorld(app.api);
    const s = await makeSession(app.api, w.tplA, `${DAY}T10:00:00Z`);

    const gen = await app.api("POST", "/plans/generate", {
      from: `${DAY}T00:00:00Z`,
      to: `${DAY}T23:59:59Z`,
    });
    expect(gen.status).toBe(200);
    expect(gen.body.createdAssignments).toHaveLength(1);
    const assigned = gen.body.createdAssignments[0];
    expect([w.a1, w.a2]).toContain(assigned.actorId);
    expect(assigned.actorId).not.toBe(w.a3); // 王五资质已过期

    const explain = await app.api("GET", `/sessions/${s.id}/explain`);
    expect(explain.status).toBe(200);
    const a = explain.body.assignments[0];
    const constraints = a.trace.map((t: any) => t.constraint);
    expect(constraints).toContain("actor_active");
    expect(constraints).toContain("qualification_validity");
    expect(constraints).toContain("emergency_reserve");
    expect(a.trace.every((t: any) => t.ok)).toBe(true);
    // 应急替补余量快照：还剩另一名持证演员可调用
    const reserve = explain.body.reserve.find((r: any) => r.role === "骑士");
    expect(reserve.qualified).toBe(2);
    expect(reserve.requiredReserve).toBe(1);
  });

  it("无人持有有效资质时记为未满足需求", async () => {
    const w = await seedWorld(app.api);
    const tpl = (
      await app.api("POST", "/templates", {
        name: "舞狮",
        zoneId: w.zoneA,
        durationMinutes: 30,
        requirements: [{ role: "舞狮", count: 1 }],
      })
    ).body.id;
    const s = await makeSession(app.api, tpl, `${DAY}T10:00:00Z`);
    const gen = await app.api("POST", "/plans/generate", {
      from: `${DAY}T00:00:00Z`,
      to: `${DAY}T23:59:59Z`,
    });
    expect(gen.body.unmet).toHaveLength(1);
    expect(gen.body.unmet[0]).toMatchObject({ sessionId: s.id, role: "舞狮", reason: "no_qualified_candidate" });
    const explain = await app.api("GET", `/sessions/${s.id}/explain`);
    expect(explain.body.unmet[0].detail).toContain("舞狮");
  });

  it("转场步行时间不足时不会把同一演员排进相邻场次（赶场冲突）", async () => {
    const w = await seedWorld(app.api);
    // 10:00-10:30 区域A，10:35-11:05 区域B：间隔 5 分钟 < 步行 10 分钟
    const s1 = await makeSession(app.api, w.tplA, `${DAY}T10:00:00Z`);
    const s2 = await makeSession(app.api, w.tplB, `${DAY}T10:35:00Z`);
    const gen = await app.api("POST", "/plans/generate", {
      from: `${DAY}T00:00:00Z`,
      to: `${DAY}T23:59:59Z`,
    });
    expect(gen.body.createdAssignments).toHaveLength(2);
    const a1of = (sid: string) =>
      gen.body.createdAssignments.find((x: any) => x.sessionId === sid).actorId;
    expect(a1of(s1.id)).not.toBe(a1of(s2.id)); // 同一演员赶场被禁止，由另一名演员顶上
  });

  it("转场不可行且无替补时记为未满足，并说明原因", async () => {
    const w = await seedWorld(app.api);
    await app.api("PUT", "/rules", { reservePerRole: 0 });
    // 只留张三一名可用骑士
    const a2 = (await app.api("GET", `/actors/${w.a2}`)).body;
    await app.api("PATCH", `/actors/${w.a2}`, { expectedVersion: a2.version, active: false });
    const s1 = await makeSession(app.api, w.tplA, `${DAY}T10:00:00Z`);
    const s2 = await makeSession(app.api, w.tplB, `${DAY}T10:35:00Z`);
    const gen = await app.api("POST", "/plans/generate", {
      from: `${DAY}T00:00:00Z`,
      to: `${DAY}T23:59:59Z`,
    });
    expect(gen.body.createdAssignments).toHaveLength(1);
    expect(gen.body.createdAssignments[0].sessionId).toBe(s1.id);
    expect(gen.body.unmet).toHaveLength(1);
    expect(gen.body.unmet[0].sessionId).toBe(s2.id);
    expect(gen.body.unmet[0].detail).toContain("转场");
  });

  it("相邻场次间隔小于最小休息时间时触发休息约束", async () => {
    const w = await seedWorld(app.api);
    await app.api("PUT", "/rules", { minRestMinutes: 20, reservePerRole: 0 });
    // 同区域 10:00-10:30 与 10:40-11:10：间隔 10 分钟 < 休息 20 分钟
    const s1 = await makeSession(app.api, w.tplA, `${DAY}T10:00:00Z`);
    const s2 = await makeSession(app.api, w.tplA, `${DAY}T10:40:00Z`);
    const gen = await app.api("POST", "/plans/generate", {
      from: `${DAY}T00:00:00Z`,
      to: `${DAY}T23:59:59Z`,
    });
    expect(gen.body.createdAssignments).toHaveLength(2);
    const actorOf = (sid: string) =>
      gen.body.createdAssignments.find((x: any) => x.sessionId === sid).actorId;
    expect(actorOf(s1.id)).not.toBe(actorOf(s2.id));
  });

  it("已确认预约超出区域容量时记为未满足需求", async () => {
    const w = await seedWorld(app.api);
    const s = await makeSession(app.api, w.tplA, `${DAY}T10:00:00Z`);
    await app.api("POST", `/sessions/${s.id}/reservations`, { visitorGroup: "旅行团甲", size: 150 });
    const gen = await app.api("POST", "/plans/generate", {
      from: `${DAY}T00:00:00Z`,
      to: `${DAY}T23:59:59Z`,
    });
    const cap = gen.body.unmet.find((u: any) => u.reason === "zone_capacity");
    expect(cap).toBeDefined();
    expect(cap.needed).toBe(50);
    expect(cap.detail).toContain("100");
    const explain = await app.api("GET", `/sessions/${s.id}/explain`);
    expect(explain.body.capacityOk).toBe(false);
    expect(explain.body.confirmedVisitors).toBe(150);
  });

  it("重复生成不会重复排人", async () => {
    const w = await seedWorld(app.api);
    await makeSession(app.api, w.tplA, `${DAY}T10:00:00Z`);
    const first = await app.api("POST", "/plans/generate", {
      from: `${DAY}T00:00:00Z`,
      to: `${DAY}T23:59:59Z`,
    });
    expect(first.body.createdAssignments).toHaveLength(1);
    const second = await app.api("POST", "/plans/generate", {
      from: `${DAY}T00:00:00Z`,
      to: `${DAY}T23:59:59Z`,
    });
    expect(second.body.createdAssignments).toHaveLength(0);
  });
});

describe("预约锁定与应急替补余量", () => {
  it("无预约场次为保留应急余量宁可空缺；有已确认预约的场次允许动用余量并锁定", async () => {
    const w = await seedWorld(app.api);
    // 同一时刻两场都需要骑士，持证演员只有张三、李四，reservePerRole=1
    const s1 = await makeSession(app.api, w.tplA, `${DAY}T10:00:00Z`);
    const s2 = await makeSession(app.api, w.tplB, `${DAY}T10:00:00Z`);

    const gen1 = await app.api("POST", "/plans/generate", {
      from: `${DAY}T00:00:00Z`,
      to: `${DAY}T23:59:59Z`,
    });
    // 第一场排上（余量还剩 1），第二场若再排则应急余量归零 → 保留余量，记为未满足
    expect(gen1.body.createdAssignments).toHaveLength(1);
    expect(gen1.body.unmet).toHaveLength(1);
    expect(gen1.body.unmet[0].reason).toBe("reserve_preserved");
    expect(gen1.body.unmet[0].detail).toContain("应急替补");

    // 给空缺的场次加上已确认预约 → 锁定游客预约优先，允许动用应急余量
    const unmetSessionId = gen1.body.unmet[0].sessionId;
    await app.api("POST", `/sessions/${unmetSessionId}/reservations`, {
      visitorGroup: "旅行团乙",
      size: 20,
    });
    const gen2 = await app.api("POST", "/plans/generate", {
      from: `${DAY}T00:00:00Z`,
      to: `${DAY}T23:59:59Z`,
    });
    expect(gen2.body.createdAssignments).toHaveLength(1);
    const created = gen2.body.createdAssignments[0];
    expect(created.sessionId).toBe(unmetSessionId);
    expect(created.locked).toBe(1); // 锁定已确认预约
    const trace = JSON.parse(created.trace);
    const reserveTrace = trace.find((t: any) => t.constraint === "emergency_reserve");
    expect(reserveTrace.detail).toContain("动用应急替补余量");

    // 解释接口：两场次的未满足需求已随最新计算清空
    const explain = await app.api("GET", `/sessions/${unmetSessionId}/explain`);
    expect(explain.body.unmet).toHaveLength(0);
    expect(explain.body.assignments[0].locked).toBe(true);
    // 另一场（s1/s2 中先排的那场）依旧只有一名演员
    void s1;
    void s2;
  });

  it("解释接口汇总每场约束、未满足需求与替补余量", async () => {
    const w = await seedWorld(app.api);
    await makeSession(app.api, w.tplA, `${DAY}T10:00:00Z`);
    await makeSession(app.api, w.tplB, `${DAY}T10:00:00Z`);
    await app.api("POST", "/plans/generate", {
      from: `${DAY}T00:00:00Z`,
      to: `${DAY}T23:59:59Z`,
    });
    const explain = await app.api(
      "GET",
      `/plans/explain?from=${DAY}T00:00:00Z&to=${DAY}T23:59:59Z`,
    );
    expect(explain.status).toBe(200);
    expect(explain.body.sessions).toHaveLength(2);
    expect(explain.body.unmetTotal).toBe(1);
    const withAssign = explain.body.sessions.find((s: any) => s.assignments.length === 1);
    expect(withAssign.assignments[0].trace.length).toBeGreaterThan(0);
    expect(withAssign.reserve[0]).toMatchObject({ role: "骑士", requiredReserve: 1 });
    const withUnmet = explain.body.sessions.find((s: any) => s.unmet.length === 1);
    expect(withUnmet.unmet[0].reason).toBe("reserve_preserved");
  });
});
