/** 领域类型与 HTTP 错误。 */

export type Clock = () => Date;

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export const badRequest = (msg: string, details?: unknown) => new HttpError(400, msg, details);
export const notFound = (msg: string, details?: unknown) => new HttpError(404, msg, details);
export const conflict = (msg: string, details?: unknown) => new HttpError(409, msg, details);
export const unprocessable = (msg: string, details?: unknown) => new HttpError(422, msg, details);

/** 调度规则（存于 settings 表，可经 /rules 调整）。 */
export interface Rules {
  /** 同一演员相邻两场之间的最小休息分钟数 */
  minRestMinutes: number;
  /** 同一演员单日最大场次数 */
  maxSessionsPerDay: number;
  /** 每个角色在每个时段至少保留的应急替补人数 */
  reservePerRole: number;
  /** 演员确认变更的超时秒数，超时升级值班主管 */
  confirmTimeoutSec: number;
  /** 值班主管标识，升级时记录 */
  dutySupervisor: string;
}

export const DEFAULT_RULES: Rules = {
  minRestMinutes: 15,
  maxSessionsPerDay: 6,
  reservePerRole: 1,
  confirmTimeoutSec: 300,
  dutySupervisor: "值班主管",
};

export interface ActorRow {
  id: string;
  name: string;
  active: number;
  version: number;
}

export interface QualificationRow {
  id: string;
  actorId: string;
  role: string;
  validFrom: string;
  validUntil: string;
  version: number;
}

export interface ZoneRow {
  id: string;
  name: string;
  capacity: number;
  status: string; // open | down
  version: number;
}

export interface TransferRow {
  fromZone: string;
  toZone: string;
  minutes: number;
}

export interface Requirement {
  role: string;
  count: number;
}

export interface TemplateRow {
  id: string;
  name: string;
  zoneId: string;
  durationMinutes: number;
  requirements: string; // JSON: Requirement[]
  version: number;
}

export interface SessionRow {
  id: string;
  templateId: string;
  startTs: string;
  endTs: string;
  status: string; // scheduled | started | finished | cancelled
  version: number;
}

export interface ReservationRow {
  id: string;
  sessionId: string;
  visitorGroup: string;
  size: number;
  status: string; // confirmed | cancelled
  version: number;
}

export interface AssignmentRow {
  id: string;
  sessionId: string;
  actorId: string;
  role: string;
  status: string; // active | cancelled
  locked: number; // 1 = 已确认预约/人工指定，自动重算不得改动
  trace: string; // JSON: TraceEntry[]
  createdTs: string;
  version: number;
}

export interface NotificationRow {
  id: string;
  assignmentId: string;
  actorId: string;
  kind: string; // assigned | cancelled
  status: string; // pending | confirmed | escalated | expired
  payload: string; // JSON
  deadlineTs: string;
  createdTs: string;
  resolvedTs: string | null;
  version: number;
}

export interface EscalationRow {
  id: string;
  notificationId: string;
  supervisor: string;
  reason: string;
  createdTs: string;
}

export interface UnmetRow {
  id: string;
  runId: string;
  sessionId: string;
  role: string | null;
  needed: number;
  reason: string;
  detail: string;
  createdTs: string;
}

/** 一次分配的约束判定轨迹，随分配持久化，供解释接口返回。 */
export interface TraceEntry {
  constraint: string;
  ok: boolean;
  detail: string;
  /** 人工强制分配时被覆盖的违规 */
  overridden?: boolean;
}

export const minutesBetween = (fromIso: string, toIso: string): number =>
  (Date.parse(toIso) - Date.parse(fromIso)) / 60000;

export const isoAfter = (iso: string, minutes: number): string =>
  new Date(Date.parse(iso) + minutes * 60000).toISOString();
