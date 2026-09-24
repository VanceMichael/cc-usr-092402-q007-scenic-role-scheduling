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

describe("变更通知的确认与升级", () => {
  it("演员确认分配后，解释接口显示已确认", async () => {
    const w = await seedWorld(app.api);
    const s = await makeSession(app.api, w.tplA, `${DAY}T10:00:00Z`);
    await app.api("POST", "/plans/generate", RANGE);

    const pending = await app.api("GET", "/notifications?status=pending");
    expect(pending.body).toHaveLength(1);
    const notice = pending.body[0];
    expect(notice.kind).toBe("assigned");
    expect(notice.deadlineTs > notice.createdTs).toBe(true);

    const confirmed = await app.api("POST", `/notifications/${notice.id}/confirm`, {
      actorId: notice.actorId,
    });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.status).toBe("confirmed");

    const explain = await app.api("GET", `/sessions/${s.id}/explain`);
    expect(explain.body.assignments[0].confirmStatus).toBe("confirmed");
    void w;
  });

  it("非本人不能确认，重复确认返回 409", async () => {
    const w = await seedWorld(app.api);
    await makeSession(app.api, w.tplA, `${DAY}T10:00:00Z`);
    await app.api("POST", "/plans/generate", RANGE);
    const notice = (await app.api("GET", "/notifications?status=pending")).body[0];

    const other = notice.actorId === w.a1 ? w.a2 : w.a1;
    const wrong = await app.api("POST", `/notifications/${notice.id}/confirm`, { actorId: other });
    expect(wrong.status).toBe(422);

    const ok = await app.api("POST", `/notifications/${notice.id}/confirm`, {
      actorId: notice.actorId,
    });
    expect(ok.status).toBe(200);
    const again = await app.api("POST", `/notifications/${notice.id}/confirm`, {
      actorId: notice.actorId,
    });
    expect(again.status).toBe(409);
  });

  it("超时未确认升级给值班主管", async () => {
    const w = await seedWorld(app.api);
    await app.api("PUT", "/rules", { confirmTimeoutSec: 60, dutySupervisor: "值班主管-王敏" });
    await makeSession(app.api, w.tplA, `${DAY}T10:00:00Z`);
    await app.api("POST", "/plans/generate", RANGE);

    app.advanceSec(120);
    const result = app.handle.sweep();
    expect(result.escalated).toHaveLength(1);

    const escalations = await app.api("GET", "/escalations");
    expect(escalations.body).toHaveLength(1);
    expect(escalations.body[0].supervisor).toBe("值班主管-王敏");
    expect(escalations.body[0].reason).toContain("超时");

    const pending = await app.api("GET", "/notifications?status=pending");
    expect(pending.body).toHaveLength(0);
    const escalated = await app.api("GET", "/notifications?status=escalated");
    expect(escalated.body).toHaveLength(1);
  });

  it("服务重启后，重启前未确认的通知仍可查询并会被超时升级", async () => {
    const w = await seedWorld(app.api);
    await app.api("PUT", "/rules", { confirmTimeoutSec: 60 });
    await makeSession(app.api, w.tplA, `${DAY}T10:00:00Z`);
    await app.api("POST", "/plans/generate", RANGE);
    const dbPath = app.dbPath;
    const noticeId = (await app.api("GET", "/notifications?status=pending")).body[0].id;

    // 模拟服务重启：关闭进程（保留数据库文件），用同一数据库文件重新启动
    await app.shutdown();
    const restarted = await startTestApp({ dbPath });
    try {
      expect(restarted.handle.recoveredPending).toBe(1);
      const pending = await restarted.api("GET", "/notifications?status=pending");
      expect(pending.body).toHaveLength(1);
      expect(pending.body[0].id).toBe(noticeId);

      restarted.advanceSec(120);
      const result = restarted.handle.sweep();
      expect(result.escalated).toHaveLength(1);
      const escalations = await restarted.api("GET", "/escalations");
      expect(escalations.body).toHaveLength(1);
    } finally {
      await restarted.close();
    }
    // 旧实例已 shutdown，afterEach 不应再清理：换一个由它清理的实例
    app = await startTestApp({ dbPath: `${dbPath}-gone` });
  });

  it("手动撤销分配同样向演员发送待确认取消通知，超时一样升级", async () => {
    const w = await seedWorld(app.api);
    await app.api("PUT", "/rules", { confirmTimeoutSec: 60 });
    await makeSession(app.api, w.tplA, `${DAY}T10:00:00Z`);
    const gen = await app.api("POST", "/plans/generate", RANGE);
    const assignment = gen.body.createdAssignments[0];
    const actorId = assignment.actorId;

    const del = await app.api("DELETE", `/assignments/${assignment.id}`, { expectedVersion: 1 });
    expect(del.status).toBe(200);
    const pending = await app.api(`GET`, `/notifications?actorId=${actorId}&status=pending`);
    expect(pending.body.some((n: any) => n.kind === "cancelled")).toBe(true);

    app.advanceSec(120);
    app.handle.sweep();
    const escalations = await app.api("GET", "/escalations");
    expect(escalations.body.length).toBeGreaterThan(0);
  });
});
