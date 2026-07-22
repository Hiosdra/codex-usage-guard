export interface CivilDate {
  year: number;
  month: number;
  day: number;
}
export interface CivilDateTime extends CivilDate {
  hour: number;
  minute: number;
  second: number;
}

const partsFormatterCache = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string): Intl.DateTimeFormat {
  let value = partsFormatterCache.get(timeZone);
  if (!value) {
    value = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    partsFormatterCache.set(timeZone, value);
  }
  return value;
}

export function instantFromUnixSeconds(seconds: number | string): Date {
  const value = typeof seconds === "string" ? Number(seconds) : seconds;
  if (!Number.isFinite(value)) throw new Error("Invalid Unix timestamp");
  const date = new Date(value * 1000);
  if (Number.isNaN(date.getTime())) throw new Error("Invalid Unix timestamp");
  return date;
}

export function localDateTime(instant: Date, timeZone: string): CivilDateTime {
  const values = formatter(timeZone)
    .formatToParts(instant)
    .reduce<Record<string, number>>((out, part) => {
      if (
        ["year", "month", "day", "hour", "minute", "second"].includes(part.type)
      )
        out[part.type] = Number(part.value);
      return out;
    }, {});
  return {
    year: values.year!,
    month: values.month!,
    day: values.day!,
    hour: values.hour!,
    minute: values.minute!,
    second: values.second!,
  };
}

export function timeZoneOffsetMinutes(instant: Date, timeZone: string): number {
  const p = localDateTime(instant, timeZone);
  const asUtc = Date.UTC(
    p.year,
    p.month - 1,
    p.day,
    p.hour,
    p.minute,
    p.second,
  );
  return Math.round((asUtc - instant.getTime()) / 60000);
}

export function localMidnight(date: CivilDate, timeZone: string): Date {
  let result = new Date(Date.UTC(date.year, date.month - 1, date.day));
  for (let i = 0; i < 3; i += 1)
    result = new Date(
      Date.UTC(date.year, date.month - 1, date.day) -
        timeZoneOffsetMinutes(result, timeZone) * 60000,
    );
  return result;
}

export function civilDateKey(date: CivilDate): string {
  return `${date.year.toString().padStart(4, "0")}-${date.month.toString().padStart(2, "0")}-${date.day.toString().padStart(2, "0")}`;
}
export function civilDateFromKey(key: string): CivilDate {
  const [year, month, day] = key.split("-").map(Number);
  return { year: year!, month: month!, day: day! };
}
export function weekday(date: CivilDate): number {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
}
export function isWeekday(date: CivilDate): boolean {
  const day = weekday(date);
  return day >= 1 && day <= 5;
}
export function addCivilDays(date: CivilDate, days: number): CivilDate {
  const value = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return {
    year: value.getUTCFullYear(),
    month: value.getUTCMonth() + 1,
    day: value.getUTCDate(),
  };
}

export function addUtcCalendarMonths(instant: Date, months: number): Date {
  const year = instant.getUTCFullYear();
  const month = instant.getUTCMonth();
  const day = instant.getUTCDate();
  const target = new Date(Date.UTC(year, month + months + 1, 0));
  const maxDay = target.getUTCDate();
  return new Date(
    Date.UTC(
      year,
      month + months,
      Math.min(day, maxDay),
      instant.getUTCHours(),
      instant.getUTCMinutes(),
      instant.getUTCSeconds(),
      instant.getUTCMilliseconds(),
    ),
  );
}

export function workdayMidnightsBetween(
  start: Date,
  end: Date,
  timeZone: string,
  allowedWeekdays = [1, 2, 3, 4, 5],
): Date[] {
  const cursor = localDateTime(start, timeZone);
  let date: CivilDate = {
    year: cursor.year,
    month: cursor.month,
    day: cursor.day,
  };
  const result: Date[] = [];
  for (let guard = 0; guard < 5000; guard += 1) {
    const midnight = localMidnight(date, timeZone);
    if (midnight >= end) break;
    if (midnight >= start && allowedWeekdays.includes(weekday(date)))
      result.push(midnight);
    date = addCivilDays(date, 1);
  }
  return result;
}

export function nextWorkdayMidnight(
  after: Date,
  end: Date,
  timeZone: string,
  allowedWeekdays = [1, 2, 3, 4, 5],
): Date | undefined {
  const local = localDateTime(after, timeZone);
  let date: CivilDate = {
    year: local.year,
    month: local.month,
    day: local.day,
  };
  for (let guard = 0; guard < 5000; guard += 1) {
    date = addCivilDays(date, 1);
    const midnight = localMidnight(date, timeZone);
    if (midnight >= end) return undefined;
    if (allowedWeekdays.includes(weekday(date))) return midnight;
  }
  return undefined;
}

export function formatLocal(
  instant: Date | undefined,
  timeZone: string,
): string {
  if (!instant) return "n/a";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(instant);
}

export function durationLabel(seconds: number): string {
  const sign = seconds < 0 ? "-" : "";
  let remaining = Math.abs(Math.round(seconds));
  const days = Math.floor(remaining / 86400);
  remaining %= 86400;
  const hours = Math.floor(remaining / 3600);
  remaining %= 3600;
  const minutes = Math.floor(remaining / 60);
  const parts: string[] = [];
  if (days) parts.push(`${days}d`);
  if (hours || days) parts.push(`${hours}h`);
  parts.push(`${minutes}m`);
  return `${sign}${parts.join(" ")}`;
}

export function validateTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format();
    return true;
  } catch {
    return false;
  }
}
