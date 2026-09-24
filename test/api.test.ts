import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { at, makeService, seedBase, type Seed } from "./helpers.js";

let seed: Seed;
let server: Server;
let base: string;

beforeEach(async () => {
  seed = makeService();
  seedBase(seed.service);
  const app = createApp(seed.service);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
  seed.db.close();
});

async function req(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

describe("HTTP API", () => {
  it("健康检查", async () => {
    const { status, json } = await req("GET", "/healthz");
    expect(status).toBe(200);
    expect(json.status).toBe("ok");
  });

  it("生成方案并通过解释接口查看约束与未满足需求", async () => {
    const s = seed.service.store;
    s.createSession("S1", "T1", at("10:00"));
    s.createSession("S2", "T2", at("11:00"));
    s.createReservation("S1", 20);

    const gen = await req("POST", "/plan/generate", { from: at("00:00"), to: at("23:59"), operator: "dispatcher-1" });
    expect(gen.status).toBe(200);
    expect(gen.json.createdAssignments).toHaveLength(4);
    expect(gen.json.lockedSessionIds).toEqual(["S1"]);

    const explain = await req("GET", `/plan/explain?from=${encodeURIComponent(at("00:00"))}&to=${encodeURIComponent(at("23:59"))}`);
    expect(explain.status).toBe(200);
    const s1 = explain.json.sessions.find((x: any) => x.id === "S1");
    expect(s1.reservationLocked).toBe(true);
    expect(s1.confirmedSeats).toBe(20);
    expect(s1.zoneCapacity).toBe(100);
    expect(s1.assignments.length).toBe(3);
    // 每次分配都带约束检查明细
    const lead = s1.assignments.find((a: any) => a.role === "主角");
    expect(lead.reason.checks.length).toBeGreaterThan(0);
    expect(lead.reason.checks.every((c: any) => c.ok)).toBe(true);
    // 替补余量可解释
    expect(s1.slack.length).toBe(2);
    expect(s1.slack.every((x: any) => x.ok)).toBe(true);

    const unmet = await req("GET", "/demands/unmet");
    expect(unmet.status).toBe(200);
    expect(unmet.json).toEqual([]);
  });

  it("并发调整同一演员：版本冲突返回 409", async () => {
    const quals = { qualifications: [{ role: "主角", validFrom: "2026-01-01T00:00:00.000Z", validUntil: "2027-01-01T00:00:00.000Z" }] };
    const first = await req("PUT", "/actors/A1/qualifications", { ...quals, expectedVersion: 1 });
    expect(first.status).toBe(200);
    expect(first.json.version).toBe(2);

    // 另一调度员基于旧版本的修改被拒绝
    const stale = await req("PUT", "/actors/A1/qualifications", { ...quals, expectedVersion: 1 });
    expect(stale.status).toBe(409);
    expect(stale.json).toMatchObject({ error: "version_conflict", entity: "actor", id: "A1", currentVersion: 2 });
  });

  it("并发调整同一场次：版本冲突返回 409", async () => {
    const s = seed.service.store;
    s.createSession("S1", "T1", at("10:00"));
    seed.service.generatePlan(at("00:00"), at("23:59"));
    const version = s.getSession("S1").version;

    // 调度员甲移除一个分配（成功，场次版本 +1）
    const target = s.activeAssignmentsOfSession("S1")[0];
    const removed = await req("POST", `/assignments/${target.id}/remove`, { expectedVersion: version, operator: "甲" });
    expect(removed.status).toBe(204);

    // 调度员乙基于旧版本手工加人 → 冲突
    const stale = await req("POST", "/sessions/S1/assignments", {
      actorId: "A5",
      role: "群演",
      expectedVersion: version,
      operator: "乙",
    });
    expect(stale.status).toBe(409);
    expect(stale.json.error).toBe("version_conflict");
    expect(stale.json.entity).toBe("session");
  });

  it("手工分配违反约束时返回 422 与约束明细，force 可显式覆盖", async () => {
    const s = seed.service.store;
    s.createSession("S1", "T1", at("10:00"));
    // A3 只有群演资质
    const rejected = await req("POST", "/sessions/S1/assignments", { actorId: "A3", role: "主角", expectedVersion: 1 });
    expect(rejected.status).toBe(422);
    expect(rejected.json.error).toBe("constraint_violation");
    expect(rejected.json.checks.find((c: any) => c.constraint === "qualification").ok).toBe(false);

    const forced = await req("POST", "/sessions/S1/assignments", { actorId: "A3", role: "主角", expectedVersion: 1, force: true });
    expect(forced.status).toBe(201);
    expect(JSON.parse(forced.json.reason).forced).toBe(true);
  });

  it("已开始的场次不能被取消或改写", async () => {
    const s = seed.service.store;
    s.createSession("S1", "T1", at("10:00"));
    seed.service.generatePlan(at("00:00"), at("23:59"));
    const started = await req("POST", "/sessions/S1/start", { expectedVersion: 1 });
    expect(started.status).toBe(200);
    expect(started.json.status).toBe("started");

    const cancel = await req("POST", "/sessions/S1/cancel", { expectedVersion: 2, reason: "想取消" });
    expect(cancel.status).toBe(409);
    expect(cancel.json.error).toBe("session_already_started");

    const assignment = s.activeAssignmentsOfSession("S1")[0];
    const remove = await req("POST", `/assignments/${assignment.id}/remove`, { expectedVersion: 2 });
    expect(remove.status).toBe(409);
    expect(remove.json.error).toBe("session_already_started");
  });

  it("通知确认与待确认列表", async () => {
    const s = seed.service.store;
    s.createSession("S1", "T1", at("10:00"));
    seed.service.generatePlan(at("00:00"), at("23:59"));

    const pending = await req("GET", "/notifications/pending");
    expect(pending.json).toHaveLength(3);

    const target = pending.json[0];
    const confirmed = await req("POST", `/notifications/${target.id}/confirm`, { actorId: target.actorId });
    expect(confirmed.status).toBe(200);
    expect(confirmed.json.status).toBe("confirmed");

    const after = await req("GET", "/notifications/pending");
    expect(after.json).toHaveLength(2);
  });

  it("设施故障事件接口返回局部重算结果", async () => {
    const s = seed.service.store;
    s.createSession("S1", "T1", at("10:00"));
    s.createReservation("S1", 10);
    seed.service.generatePlan(at("00:00"), at("23:59"));

    const res = await req("POST", "/incidents/facility-outage", {
      zoneId: "Z1",
      from: at("09:30"),
      to: at("10:30"),
      reason: "电力故障",
      operator: "dispatcher-2",
    });
    expect(res.status).toBe(200);
    expect(res.json.cancelledSessionIds).toEqual(["S1"]);
    expect(res.json.unmet.some((u: any) => u.kind === "reservation_orphaned")).toBe(true);

    const unmet = await req("GET", "/demands/unmet");
    expect(unmet.json.length).toBeGreaterThan(0);
  });
});
