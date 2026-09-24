/** 可注入时钟，测试用可变时钟，生产用系统时钟。 */
export type Clock = () => Date;

export const systemClock: Clock = () => new Date();

export function iso(d: Date): string {
  return d.toISOString();
}

export function parseIso(s: string): number {
  const t = Date.parse(s);
  if (Number.isNaN(t)) throw new Error(`非法时间格式: ${s}`);
  return t;
}

export const MINUTE = 60_000;
