/** The browser cannot select a trainer or enable an external integration. */
export interface SettingsInput {
  dailyTime: string | null;
  timezone: string;
  horizonMonths: number;
  notionPollMinutes: number;
  mockScheduleEnabled: boolean;
}

export interface JobInput {
  kind: "company_sync" | "notion_poll";
}

export class InputError extends Error {
  constructor(message: string, readonly status: 400 | 403 = 400) {
    super(message);
    this.name = "InputError";
  }
}

function exactObject(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new InputError("요청 형식이 올바르지 않습니다.");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.some((key) => !fields.includes(key)) || fields.some((key) => !Object.hasOwn(record, key))) {
    throw new InputError("허용되지 않았거나 누락된 설정 항목이 있습니다.");
  }
  return record;
}

export function parseJob(value: unknown): JobInput {
  const input = exactObject(value, ["kind"]);
  if (input.kind !== "company_sync" && input.kind !== "notion_poll") {
    throw new InputError("실행할 작업 종류를 확인해 주세요.");
  }
  return { kind: input.kind };
}

export function parseSettings(value: unknown): SettingsInput {
  const input = exactObject(value, [
    "dailyTime", "timezone", "horizonMonths", "notionPollMinutes", "mockScheduleEnabled",
  ]);
  if (input.dailyTime !== null &&
    (typeof input.dailyTime !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(input.dailyTime))) {
    throw new InputError("매일 실행 시간은 24시간 형식 HH:mm으로 입력해 주세요.");
  }
  if (typeof input.timezone !== "string" || input.timezone.length === 0 || input.timezone.length > 100) {
    throw new InputError("유효한 시간대를 선택해 주세요.");
  }
  try {
    new Intl.DateTimeFormat("ko-KR", { timeZone: input.timezone }).format(0);
  } catch {
    throw new InputError("유효한 시간대를 선택해 주세요.");
  }
  if (typeof input.horizonMonths !== "number" || !Number.isInteger(input.horizonMonths) ||
    input.horizonMonths < 1 || input.horizonMonths > 12) {
    throw new InputError("일정 생성 범위는 1~12개월의 정수로 입력해 주세요.");
  }
  if (typeof input.notionPollMinutes !== "number" || !Number.isInteger(input.notionPollMinutes) ||
    input.notionPollMinutes < 5 || input.notionPollMinutes > 1440) {
    throw new InputError("폴링 간격은 5~1440분의 정수로 입력해 주세요.");
  }
  if (typeof input.mockScheduleEnabled !== "boolean") {
    throw new InputError("합성 작업 예약 여부를 확인해 주세요.");
  }
  if (input.mockScheduleEnabled && input.dailyTime === null) {
    throw new InputError("합성 작업 예약을 켜려면 실행 시간을 지정해 주세요.");
  }
  return {
    dailyTime: input.dailyTime,
    timezone: input.timezone,
    horizonMonths: input.horizonMonths,
    notionPollMinutes: input.notionPollMinutes,
    mockScheduleEnabled: input.mockScheduleEnabled,
  };
}

/**
 * A fixed PUBLIC_ORIGIN may be supplied behind Docker/reverse proxies. Host and
 * forwarded headers deliberately cannot expand the allowed origin list.
 */
export function assertSameOrigin(headers: Headers, requestUrl: string, allowedOrigin?: string): void {
  const value = headers.get("origin");
  if (!value) throw new InputError("같은 관리 화면에서 요청해 주세요.", 403);
  try {
    const actual = new URL(value);
    const request = new URL(requestUrl);
    const expected = allowedOrigin === undefined ? request : new URL(allowedOrigin);
    const validProtocol = (url: URL) => url.protocol === "http:" || url.protocol === "https:";
    if (!validProtocol(actual) || !validProtocol(expected) || actual.username || actual.password ||
      expected.username || expected.password || value !== actual.origin ||
      (allowedOrigin !== undefined && (expected.pathname !== "/" || expected.search || expected.hash)) ||
      actual.origin !== expected.origin) {
      throw new InputError("같은 관리 화면에서 요청해 주세요.", 403);
    }
  } catch (error) {
    if (error instanceof InputError) throw error;
    throw new InputError("같은 관리 화면에서 요청해 주세요.", 403);
  }
}
