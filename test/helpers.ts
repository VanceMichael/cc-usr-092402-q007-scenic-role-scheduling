import { parseIso, type Clock } from "../src/clock.js";
import { openDatabase, type Db } from "../src/db.js";
import { ScheduleService } from "../src/service.js";

export interface MutableClock extends Clock {
  advanceMinutes(min: number): void;
  set(isoStr: string): void;
}

export function mutableClock(start = "2026-10-01T08:00:00.000Z"): MutableClock {
  let t = parseIso(start);
  const clock = (() => new Date(t)) as MutableClock;
  clock.advanceMinutes = (min: number) => {
    t += min * 60_000;
  };
  clock.set = (isoStr: string) => {
    t = parseIso(isoStr);
  };
  return clock;
}

export interface Seed {
  db: Db;
  service: ScheduleService;
  clock: MutableClock;
}

export function makeService(dbPath = ":memory:", clockStart = "2026-10-01T08:00:00.000Z"): Seed {
  const db = openDatabase(dbPath);
  const clock = mutableClock(clockStart);
  const service = new ScheduleService(db, clock);
  return { db, service, clock };
}

export const DAY = "2026-10-01";
export const VALID_FROM = "2026-01-01T00:00:00.000Z";
export const VALID_UNTIL = "2027-01-01T00:00:00.000Z";

/**
 * 基础场景：
 * - 区域 Z1（容量 100）、Z2（容量 50），双向步行 12 分钟
 * - 模板 T1：Z1，45 分钟，需 主角×1（关键）+ 群演×2；T2：Z2，30 分钟，需 主角×1
 * - 演员：A1(主角) A2(主角+群演) A3(群演) A4(群演) A5(主角) A6(群演)，资质全年有效
 */
export function seedBase(service: ScheduleService): void {
  const s = service.store;
  s.upsertZone("Z1", "中央广场", 100);
  s.upsertZone("Z2", "湖畔剧场", 50);
  s.upsertTransfer("Z1", "Z2", 12);
  s.upsertTransfer("Z2", "Z1", 12);
  s.createTemplate({ id: "T1", name: "广场巡游", zoneId: "Z1", durationMinutes: 45 }, [
    { role: "主角", requiredCount: 1, isKey: true },
    { role: "群演", requiredCount: 2, isKey: false },
  ]);
  s.createTemplate({ id: "T2", name: "湖畔秀", zoneId: "Z2", durationMinutes: 30 }, [
    { role: "主角", requiredCount: 1, isKey: true },
  ]);
  const quals: Record<string, string[]> = {
    A1: ["主角"],
    A2: ["主角", "群演"],
    A3: ["群演"],
    A4: ["群演"],
    A5: ["主角"],
    A6: ["群演"],
  };
  for (const [id, roles] of Object.entries(quals)) {
    s.createActor(id, `演员${id}`);
    s.replaceQualifications(id, roles.map((role) => ({ role, validFrom: VALID_FROM, validUntil: VALID_UNTIL })));
  }
}

export function at(time: string): string {
  return `${DAY}T${time}:00.000Z`;
}
