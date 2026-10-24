import test from "node:test";
import assert from "node:assert/strict";
import { assertSameOrigin, InputError, parseJob, parseSettings } from "../lib/validation.js";

const settings = {
  dailyTime: null,
  timezone: "Asia/Seoul",
  horizonMonths: 3,
  notionPollMinutes: 5,
  mockScheduleEnabled: false,
};

test("settings retain the disabled operational defaults", () => {
  assert.deepEqual(parseSettings(settings), settings);
});

test("settings accept an explicitly timed mock-only schedule", () => {
  const input = { ...settings, dailyTime: "23:59", mockScheduleEnabled: true };
  assert.deepEqual(parseSettings(input), input);
  assert.equal(parseSettings({ ...settings, dailyTime: "00:00" }).dailyTime, "00:00");
});

test("settings cannot change the server-selected trainer or enable connections", () => {
  for (const key of ["trainerId", "ACTIVE_TRAINER_ID", "companyAccountId", "externalEnabled"]) {
    assert.throws(() => parseSettings({ ...settings, [key]: "trainer-other" }), InputError);
  }
});

test("settings reject incomplete and non-object requests", () => {
  for (const value of [null, [], "settings", 5, {}, { ...settings, dailyTime: undefined }]) {
    assert.throws(() => parseSettings(value), InputError);
  }
});

test("daily time is a strict 24-hour HH:mm without an inferred date", () => {
  for (const dailyTime of ["", "9:00", "24:00", "12:60", "12", "2026-10-22T09:00:00Z", 900]) {
    assert.throws(() => parseSettings({ ...settings, dailyTime }), InputError);
  }
});

test("a mock daily schedule cannot be enabled without a time", () => {
  assert.throws(() => parseSettings({ ...settings, mockScheduleEnabled: true }), InputError);
});

test("timezone names must resolve and timezone boundaries are not silently converted", () => {
  assert.equal(parseSettings({ ...settings, timezone: "Pacific/Kiritimati" }).timezone, "Pacific/Kiritimati");
  assert.equal(parseSettings({ ...settings, timezone: "America/New_York" }).timezone, "America/New_York");
  assert.equal(parseSettings({ ...settings, timezone: "UTC" }).timezone, "UTC");
  for (const timezone of ["", "not/a-zone", null, 9]) {
    assert.throws(() => parseSettings({ ...settings, timezone }), InputError);
  }
});

test("the future-month window is finite and integral", () => {
  assert.equal(parseSettings({ ...settings, horizonMonths: 1 }).horizonMonths, 1);
  assert.equal(parseSettings({ ...settings, horizonMonths: 12 }).horizonMonths, 12);
  for (const horizonMonths of [0, 13, 1.5, "3", null, NaN, Infinity]) {
    assert.throws(() => parseSettings({ ...settings, horizonMonths }), InputError);
  }
});

test("polling cannot accidentally become aggressive or unbounded", () => {
  assert.equal(parseSettings({ ...settings, notionPollMinutes: 1440 }).notionPollMinutes, 1440);
  for (const notionPollMinutes of [0, 1, 4, 1441, 5.5, "5", NaN, Infinity]) {
    assert.throws(() => parseSettings({ ...settings, notionPollMinutes }), InputError);
  }
});

test("schedule enablement requires a real boolean", () => {
  for (const mockScheduleEnabled of ["false", "true", 0, 1, null]) {
    assert.throws(() => parseSettings({ ...settings, mockScheduleEnabled }), InputError);
  }
});

test("manual jobs accept only the two registered mock operations", () => {
  assert.deepEqual(parseJob({ kind: "company_sync" }), { kind: "company_sync" });
  assert.deepEqual(parseJob({ kind: "notion_poll" }), { kind: "notion_poll" });
  for (const value of [null, [], {}, { kind: "external_sync" }, { kind: "company_sync", trainerId: "trainer-other" }]) {
    assert.throws(() => parseJob(value), InputError);
  }
});

test("same origin accepts a request from the local management screen", () => {
  assert.doesNotThrow(() => assertSameOrigin(new Headers({ origin: "http://127.0.0.1:4310" }), "http://127.0.0.1:4310/api/jobs"));
});

test("a configured public origin works behind Docker without trusting forwarded hosts", () => {
  assert.doesNotThrow(() => assertSameOrigin(
    new Headers({ origin: "http://127.0.0.1:4310", host: "malicious.invalid", "x-forwarded-host": "malicious.invalid" }),
    "http://web:3000/api/jobs", "http://127.0.0.1:4310",
  ));
});

test("same origin rejects absent, opaque, other ports, hosts, and schemes", () => {
  for (const origin of [undefined, "null", "https://127.0.0.1:4310", "http://127.0.0.1:4311", "http://localhost:4310", "https://attacker.invalid"]) {
    const headers = new Headers(origin ? { origin } : {});
    assert.throws(() => assertSameOrigin(headers, "http://127.0.0.1:4310/api/settings"),
      (error) => error instanceof InputError && error.status === 403);
  }
});

test("same origin rejects malformed origins, credentials, paths, and non-http schemes", () => {
  for (const origin of ["not-a-url", "http://user:pass@127.0.0.1:4310", "http://127.0.0.1:4310/", "http://127.0.0.1:4310/path", "http://127.0.0.1:4310?q=1", "file:///tmp/test"]) {
    assert.throws(() => assertSameOrigin(new Headers({ origin }), "http://127.0.0.1:4310/api/jobs"), InputError);
  }
});

test("an unsafe public-origin configuration fails closed", () => {
  for (const allowedOrigin of ["invalid", "http://user:pass@127.0.0.1:4310", "http://127.0.0.1:4310/path", "http://127.0.0.1:4310?q=1"]) {
    assert.throws(() => assertSameOrigin(new Headers({ origin: "http://127.0.0.1:4310" }), "http://web:3000/api/jobs", allowedOrigin), InputError);
  }
});
