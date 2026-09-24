import { describe, expect, it } from "vitest";
import { at, makeService, seedBase } from "./helpers.js";

describe("约束评估器", () => {
  it("资质须覆盖整场演出，过期即不可行", () => {
    const { service } = makeService();
    seedBase(service);
    const s = service.store;
    s.createSession("S1", "T1", at("10:00"));
    const view = s.getSessionView("S1");

    // A3 只有群演资质
    const noQual = service.evaluator.isFeasible("A3", "主角", view);
    expect(noQual.feasible).toBe(false);
    expect(noQual.checks.find((c) => c.constraint === "qualification")?.detail).toContain("未持有");

    // A1 主角资质有效
    expect(service.evaluator.isFeasible("A1", "主角", view).feasible).toBe(true);

    // 把 A1 的主角资质有效期截短到演出结束前 → 不可行
    s.replaceQualifications("A1", [{ role: "主角", validFrom: "2026-01-01T00:00:00.000Z", validUntil: at("10:30") }]);
    const expired = service.evaluator.isFeasible("A1", "主角", view);
    expect(expired.feasible).toBe(false);
    expect(expired.checks.find((c) => c.constraint === "qualification")?.detail).toContain("不覆盖");
  });

  it("赶场冲突：间隔不足步行+休息时间时不可行，并给出可解释明细", () => {
    const { service } = makeService();
    seedBase(service);
    const s = service.store;
    // S1：Z1 10:00-10:45；S2：Z2 11:00-11:30，间隔 15 分钟 < 步行 12 + 休息 15
    s.createSession("S1", "T1", at("10:00"));
    s.createSession("S2", "T2", at("11:00"));
    s.createAssignment({ sessionId: "S1", role: "主角", actorId: "A1", reason: "{}", createdAt: at("08:00") });

    const view2 = s.getSessionView("S2");
    const r = service.evaluator.isFeasible("A1", "主角", view2);
    expect(r.feasible).toBe(false);
    const check = r.checks.find((c) => c.constraint === "rest_transfer_prev");
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain("赶场冲突");
    expect(check?.detail).toContain("步行 12 分钟");
    expect(check?.data).toMatchObject({ gapMinutes: 15, transferMinutes: 12, restMinutes: 15 });

    // 间隔足够时可行：S3 在 Z2 12:00
    s.createSession("S3", "T2", at("12:00"));
    expect(service.evaluator.isFeasible("A1", "主角", s.getSessionView("S3")).feasible).toBe(true);
  });

  it("时间重叠与同场重复上岗不可行", () => {
    const { service } = makeService();
    seedBase(service);
    const s = service.store;
    s.createSession("S1", "T1", at("10:00"));
    s.createSession("S2", "T2", at("10:30")); // 与 S1 重叠
    s.createAssignment({ sessionId: "S1", role: "主角", actorId: "A1", reason: "{}", createdAt: at("08:00") });

    const overlap = service.evaluator.isFeasible("A1", "主角", s.getSessionView("S2"));
    expect(overlap.feasible).toBe(false);
    expect(overlap.checks.find((c) => c.constraint === "overlap")?.detail).toContain("重叠");

    const sameSession = service.evaluator.isFeasible("A1", "群演", s.getSessionView("S1"));
    expect(sameSession.feasible).toBe(false);
    expect(sameSession.checks.find((c) => c.constraint === "same_session")?.ok).toBe(false);
  });

  it("未配置转场关系时使用缺省估计并在明细中标注", () => {
    const { service } = makeService();
    seedBase(service);
    const s = service.store;
    s.upsertZone("Z3", "山顶舞台", 30);
    s.createTemplate({ id: "T3", name: "山顶秀", zoneId: "Z3", durationMinutes: 30 }, [
      { role: "主角", requiredCount: 1, isKey: true },
    ]);
    s.createSession("S1", "T1", at("10:00"));
    s.createSession("S9", "T3", at("11:30")); // Z1→Z3 未配置，缺省 10 分钟 + 休息 15 = 25，间隔 45 分钟可行
    s.createAssignment({ sessionId: "S1", role: "主角", actorId: "A1", reason: "{}", createdAt: at("08:00") });

    const r = service.evaluator.isFeasible("A1", "主角", s.getSessionView("S9"));
    expect(r.feasible).toBe(true);
    const check = r.checks.find((c) => c.constraint === "rest_transfer_prev");
    expect(check?.detail).toContain("缺省估计");
    expect(check?.data).toMatchObject({ transferAssumed: true });
  });
});
