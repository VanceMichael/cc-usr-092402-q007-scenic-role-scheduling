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

describe("并发调整的版本冲突检测", () => {
  it("两个调度员同时调整同一演员：后到者收到 409", async () => {
    const w = await seedWorld(app.api);
    const actor = (await app.api("GET", `/actors/${w.a1}`)).body;
    const first = await app.api("PATCH", `/actors/${w.a1}`, {
      expectedVersion: actor.version,
      name: "张三丰",
    });
    expect(first.status).toBe(200);
    const second = await app.api("PATCH", `/actors/${w.a1}`, {
      expectedVersion: actor.version, // 已过期
      active: false,
    });
    expect(second.status).toBe(409);
    expect(second.body.error).toContain("版本冲突");
  });

  it("两个调度员同时向同一场次加人：后到者收到 409", async () => {
    const w = await seedWorld(app.api);
    const s = await makeSession(app.api, w.tplA, `${DAY}T10:00:00Z`);
    const first = await app.api("POST", `/sessions/${s.id}/assignments`, {
      actorId: w.a1,
      role: "骑士",
      expectedVersion: s.version,
    });
    expect(first.status).toBe(201);
    const second = await app.api("POST", `/sessions/${s.id}/assignments`, {
      actorId: w.a2,
      role: "骑士",
      expectedVersion: s.version, // 场次版本已因第一次调整递增
    });
    expect(second.status).toBe(409);
    expect(second.body.error).toContain("版本冲突");
  });

  it("两个调度员同时取消同一分配：后到者收到 409", async () => {
    const w = await seedWorld(app.api);
    const s = await makeSession(app.api, w.tplA, `${DAY}T10:00:00Z`);
    const gen = await app.api("POST", "/plans/generate", RANGE);
    const assignment = gen.body.createdAssignments[0];
    const first = await app.api("DELETE", `/assignments/${assignment.id}`, {
      expectedVersion: assignment.version,
    });
    expect(first.status).toBe(200);
    const second = await app.api("DELETE", `/assignments/${assignment.id}`, {
      expectedVersion: assignment.version,
    });
    expect(second.status).toBe(409);
    void s;
  });

  it("缺少 expectedVersion 的写操作被拒绝", async () => {
    const w = await seedWorld(app.api);
    const res = await app.api("PATCH", `/actors/${w.a1}`, { active: false });
    expect(res.status).toBe(400);
  });
});

describe("已开始的场次不能被静默改写", () => {
  it("开始后的场次：生成方案跳过、人工调整拒绝、停演需显式 force", async () => {
    const w = await seedWorld(app.api);
    const s = await makeSession(app.api, w.tplA, `${DAY}T10:00:00Z`);
    const gen = await app.api("POST", "/plans/generate", RANGE);
    const assignment = gen.body.createdAssignments[0];

    const started = await app.api("POST", `/sessions/${s.id}/start`, {
      expectedVersion: s.version,
    });
    expect(started.status).toBe(200);
    expect(started.body.status).toBe("started");

    // 重新生成方案不得改动已开始场次的分配
    const gen2 = await app.api("POST", "/plans/generate", RANGE);
    expect(gen2.body.createdAssignments).toHaveLength(0);
    const detail = await app.api("GET", `/sessions/${s.id}`);
    expect(detail.body.assignments[0].id).toBe(assignment.id);
    expect(detail.body.assignments[0].version).toBe(1);

    // 人工加人、改期、撤销分配都被拒绝
    const manual = await app.api("POST", `/sessions/${s.id}/assignments`, {
      actorId: w.a2,
      role: "骑士",
      expectedVersion: started.body.version,
    });
    expect(manual.status).toBe(422);
    expect(manual.body.error).toContain("已开始");
    const resched = await app.api("PATCH", `/sessions/${s.id}`, {
      expectedVersion: started.body.version,
      startTs: `${DAY}T12:00:00Z`,
    });
    expect(resched.status).toBe(422);
    const cancelAssign = await app.api("DELETE", `/assignments/${assignment.id}`, {
      expectedVersion: 1,
    });
    expect(cancelAssign.status).toBe(422);

    // 停演必须显式 force
    const cancel = await app.api("POST", `/sessions/${s.id}/cancel`, {
      expectedVersion: started.body.version,
      reason: "设备故障",
    });
    expect(cancel.status).toBe(422);
    expect(cancel.body.error).toContain("force");
    const forced = await app.api("POST", `/sessions/${s.id}/cancel`, {
      expectedVersion: started.body.version,
      reason: "设备故障，演出中断",
      force: true,
    });
    expect(forced.status).toBe(200);
    const after = await app.api("GET", `/sessions/${s.id}`);
    expect(after.body.status).toBe("cancelled");
    expect(after.body.assignments).toHaveLength(0);
  });

  it("按时间已开始的场次（未来得及标记）同样被冻结", async () => {
    const w = await seedWorld(app.api);
    // 当前时间 08:00，场次 07:30 已开始但未标记 started
    const s = await makeSession(app.api, w.tplA, `${DAY}T07:30:00Z`);
    const gen = await app.api("POST", "/plans/generate", RANGE);
    expect(gen.body.skippedStartedSessionIds).toContain(s.id);
    expect(gen.body.createdAssignments).toHaveLength(0);
    const manual = await app.api("POST", `/sessions/${s.id}/assignments`, {
      actorId: w.a1,
      role: "骑士",
      expectedVersion: s.version,
    });
    expect(manual.status).toBe(422);
  });
});

describe("人工强制分配的可解释性", () => {
  it("违反约束的人工分配被拒绝并列出违规项；force 后违规项记入轨迹", async () => {
    const w = await seedWorld(app.api);
    const s = await makeSession(app.api, w.tplA, `${DAY}T10:00:00Z`);
    // 王五的骑士资质已过期
    const rejected = await app.api("POST", `/sessions/${s.id}/assignments`, {
      actorId: w.a3,
      role: "骑士",
      expectedVersion: s.version,
    });
    expect(rejected.status).toBe(422);
    expect(rejected.body.details.violations.length).toBeGreaterThan(0);
    expect(rejected.body.details.violations[0].detail).toContain("资质");

    const forced = await app.api("POST", `/sessions/${s.id}/assignments`, {
      actorId: w.a3,
      role: "骑士",
      expectedVersion: s.version,
      force: true,
    });
    expect(forced.status).toBe(201);
    const overridden = forced.body.trace.filter((t: any) => t.overridden);
    expect(overridden.length).toBeGreaterThan(0);
    // 解释接口能回放这次强制分配
    const explain = await app.api("GET", `/sessions/${s.id}/explain`);
    expect(explain.body.assignments[0].trace.some((t: any) => t.overridden)).toBe(true);
  });
});
