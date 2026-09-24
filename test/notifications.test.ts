import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/db.js";
import { ScheduleService } from "../src/service.js";
import { at, makeService, mutableClock, seedBase } from "./helpers.js";

const DAY_FROM = at("00:00");
const DAY_TO = at("23:59");

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

function tmpDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "schedule-test-"));
  tmpDirs.push(dir);
  return join(dir, "schedule.db");
}

describe("通知确认与超时升级", () => {
  it("演员确认后分配生效；他人不能代确认", () => {
    const { service } = makeService();
    seedBase(service);
    service.store.createSession("S1", "T1", at("10:00"));
    service.generatePlan(DAY_FROM, DAY_TO);

    const notif = service.store.listNotifications({ status: "pending" })[0];
    const confirmed = service.confirmNotification(notif.id, notif.actorId);
    expect(confirmed.status).toBe("confirmed");
    expect(confirmed.confirmedAt).not.toBeNull();
    expect(service.store.getAssignment(notif.assignmentId!).state).toBe("confirmed");

    const other = service.store.listNotifications({ status: "pending" })[0];
    expect(() => service.confirmNotification(other.id, "someone-else")).toThrowError(/actor_mismatch/);
  });

  it("超时未确认升级为值班主管", () => {
    const { service, clock } = makeService();
    seedBase(service);
    service.store.createSession("S1", "T1", at("10:00"));
    service.generatePlan(DAY_FROM, DAY_TO);
    const pending = service.store.listNotifications({ status: "pending" });
    expect(pending.length).toBe(3); // 主角1 + 群演2

    clock.advanceMinutes(6); // 超过 confirm_timeout_seconds = 300s
    const { escalated } = service.sweepNotifications();
    expect(escalated).toHaveLength(3);
    expect(service.store.listNotifications({ status: "escalated" })).toHaveLength(3);

    // 值班主管收到升级通知（pending，等待主管处置）
    const supervisorNotices = service.store
      .listNotifications({ status: "pending" })
      .filter((n) => n.kind === "escalation" && n.actorId === "duty-supervisor");
    expect(supervisorNotices).toHaveLength(3);

    // 升级后演员仍可确认（补救）
    const target = escalated[0];
    expect(service.confirmNotification(target.id, target.actorId).status).toBe("confirmed");
  });

  it("服务重启后恢复未确认通知，过期的一并升级", () => {
    const path = tmpDbPath();

    // 第一次启动：生成方案，产生 3 条待确认通知
    const first = makeService(path);
    seedBase(first.service);
    first.service.store.createSession("S1", "T1", at("10:00"));
    first.service.generatePlan(DAY_FROM, DAY_TO);
    expect(first.service.store.listNotifications({ status: "pending" })).toHaveLength(3);
    first.db.close();

    // 模拟重启：同一数据文件，新服务实例；时钟已走过确认超时
    const db = openDatabase(path);
    const second = new ScheduleService(db, mutableClock(at("08:06"))); // 距创建已 6 分钟 > 300s 超时

    const recovery = second.recoverNotifications();
    // 重启前未确认的通知被恢复识别；其中过期的在恢复清扫中升级
    expect(recovery.escalatedOnBoot).toBe(3);
    expect(second.store.listNotifications({ status: "escalated" })).toHaveLength(3);
    expect(second.store.listNotifications({}).filter((n) => n.kind === "escalation")).toHaveLength(3);
    db.close();
  });

  it("重启后未过期的待确认通知保持 pending 可继续确认", () => {
    const path = tmpDbPath();
    const first = makeService(path);
    seedBase(first.service);
    first.service.store.createSession("S1", "T1", at("10:00"));
    first.service.generatePlan(DAY_FROM, DAY_TO);
    first.db.close();

    // 重启时仅过了 1 分钟，未超时
    const db = openDatabase(path);
    const second = new ScheduleService(db, mutableClock(at("08:01")));
    const recovery = second.recoverNotifications();
    expect(recovery.escalatedOnBoot).toBe(0);
    expect(recovery.recoveredPending).toHaveLength(3);

    const notif = recovery.recoveredPending[0];
    expect(second.confirmNotification(notif.id, notif.actorId).status).toBe("confirmed");
    db.close();
  });
});
