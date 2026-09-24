import { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createApp, AppHandle } from "../src/app.js";

export interface ApiResponse {
  status: number;
  body: any;
}

export interface TestApp {
  api: (method: string, url: string, body?: unknown) => Promise<ApiResponse>;
  handle: AppHandle;
  dbPath: string;
  setNow: (iso: string) => void;
  advanceSec: (sec: number) => void;
  /** 关闭服务但保留数据库文件（模拟服务重启） */
  shutdown: () => Promise<void>;
  close: () => Promise<void>;
}

export async function startTestApp(options: { dbPath?: string } = {}): Promise<TestApp> {
  const dbPath =
    options.dbPath ?? path.join(os.tmpdir(), `npc-test-${randomUUID()}.sqlite`);
  let now = new Date("2026-09-24T08:00:00.000Z");
  const handle = createApp({
    dbPath,
    clock: () => now,
    sweepIntervalMs: 0,
    logger: () => {},
  });
  const server = handle.app.listen(0);
  await new Promise<void>((resolve) => server.on("listening", resolve));
  const port = (server.address() as AddressInfo).port;

  const api = async (method: string, url: string, body?: unknown): Promise<ApiResponse> => {
    const res = await fetch(`http://127.0.0.1:${port}${url}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };

  return {
    api,
    handle,
    dbPath,
    setNow: (iso: string) => {
      now = new Date(iso);
    },
    advanceSec: (sec: number) => {
      now = new Date(now.getTime() + sec * 1000);
    },
    shutdown: async () => {
      handle.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
    close: async () => {
      handle.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      for (const suffix of ["", "-wal", "-shm"]) {
        fs.rmSync(dbPath + suffix, { force: true });
      }
    },
  };
}

/** 标准世界：区域 A/B、双向步行 10 分钟、模板与演员资质。 */
export interface World {
  zoneA: string;
  zoneB: string;
  tplA: string; // 区域A 30 分钟，需 1 名「骑士」
  tplB: string; // 区域B 30 分钟，需 1 名「骑士」
  a1: string; // 张三：骑士（全年有效）
  a2: string; // 李四：骑士（全年有效）
  a3: string; // 王五：骑士（已过期）
  a4: string; // 赵六：侍从（全年有效）
}

export async function seedWorld(api: TestApp["api"]): Promise<World> {
  const zoneA = (await api("POST", "/zones", { name: "古堡广场", capacity: 100 })).body.id;
  const zoneB = (await api("POST", "/zones", { name: "湖畔剧场", capacity: 50 })).body.id;
  await api("POST", "/transfers", { fromZone: zoneA, toZone: zoneB, minutes: 10 });
  await api("POST", "/transfers", { fromZone: zoneB, toZone: zoneA, minutes: 10 });

  const tplA = (
    await api("POST", "/templates", {
      name: "骑士巡游",
      zoneId: zoneA,
      durationMinutes: 30,
      requirements: [{ role: "骑士", count: 1 }],
    })
  ).body.id;
  const tplB = (
    await api("POST", "/templates", {
      name: "湖畔决斗",
      zoneId: zoneB,
      durationMinutes: 30,
      requirements: [{ role: "骑士", count: 1 }],
    })
  ).body.id;

  const a1 = (await api("POST", "/actors", { name: "张三" })).body.id;
  const a2 = (await api("POST", "/actors", { name: "李四" })).body.id;
  const a3 = (await api("POST", "/actors", { name: "王五" })).body.id;
  const a4 = (await api("POST", "/actors", { name: "赵六" })).body.id;
  for (const [actorId, role, validUntil] of [
    [a1, "骑士", "2026-12-31T23:59:59Z"],
    [a2, "骑士", "2026-12-31T23:59:59Z"],
    [a3, "骑士", "2026-06-01T00:00:00Z"], // 已过期
    [a4, "侍从", "2026-12-31T23:59:59Z"],
  ] as const) {
    await api("POST", `/actors/${actorId}/qualifications`, {
      role,
      validFrom: "2026-01-01T00:00:00Z",
      validUntil,
    });
  }
  return { zoneA, zoneB, tplA, tplB, a1, a2, a3, a4 };
}

export async function makeSession(
  api: TestApp["api"],
  templateId: string,
  startTs: string,
): Promise<any> {
  const res = await api("POST", "/sessions", { templateId, startTs });
  if (res.status !== 201) throw new Error(`建场次失败: ${JSON.stringify(res.body)}`);
  return res.body;
}
