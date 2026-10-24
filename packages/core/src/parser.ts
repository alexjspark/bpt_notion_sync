import { DateTime } from 'luxon';
import type { FixedSlot, Issue } from './types.js';

const weekdays = ['\uc6d4\uc694\uc77c', '\ud654\uc694\uc77c', '\uc218\uc694\uc77c', '\ubaa9\uc694\uc77c', '\uae08\uc694\uc77c', '\ud1a0\uc694\uc77c', '\uc77c\uc694\uc77c'];
const weekdayPattern = weekdays.join('|');
const fixedPattern = new RegExp(`^(${weekdayPattern})\\s*(\\d{1,2})(?::(\\d{2}))?\\s*(?:\uc2dc)?(?:\\s*(?:~|-|\u2013)\\s*(\\d{1,2})(?::(\\d{2}))?\\s*(?:\uc2dc)?)?$`);

export function parseFixedSlot(memo: string): { slot: FixedSlot | null; issues: Issue[] } {
  const text = memo.trim();
  if (!text) return { slot: null, issues: [] };
  const match = text.match(fixedPattern);
  if (!match) return { slot: null, issues: [{ code: 'AMBIGUOUS_FIXED_SLOT', message: 'Only an explicit single weekday and 24-hour time are accepted. Confirm this memo.' }] };
  const weekday = weekdays.indexOf(match[1]!) + 1;
  const hour = Number(match[2]);
  const minute = Number(match[3] ?? 0);
  if (hour > 23 || minute > 59 || hour < 0 || minute < 0) {
    return { slot: null, issues: [{ code: 'INVALID_FIXED_TIME', message: 'The fixed time must be a valid 24-hour time.' }] };
  }
  if (match[4] !== undefined) {
    const endHour = Number(match[4]);
    const endMinute = Number(match[5] ?? 0);
    // Do not silently interpret midnight rollover or a non-one-hour session.
    if (endHour > 23 || endMinute > 59 || endHour * 60 + endMinute - (hour * 60 + minute) !== 60) {
      return { slot: null, issues: [{ code: 'AMBIGUOUS_FIXED_DURATION', message: 'Confirm a single one-hour slot without an ambiguous overnight range.' }] };
    }
  }
  return { slot: { weekday, hour, minute, durationMinutes: 60 }, issues: [] };
}

export function validateExplicitDate(value: string | null): { date: string | null; issues: Issue[] } {
  if (value === null || value === '') return { date: null, issues: [] };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return { date: null, issues: [{ code: 'AMBIGUOUS_DATE', message: 'Confirm the full year, month and day as YYYY-MM-DD. No year is inferred.' }] };
  const parsed = DateTime.fromISO(value, { zone: 'UTC' });
  if (!parsed.isValid || parsed.toISODate() !== value) return { date: null, issues: [{ code: 'INVALID_DATE', message: 'The explicit training date is not a valid calendar date.' }] };
  return { date: value, issues: [] };
}

export function validFixedSlot(slot: FixedSlot): boolean {
  return Number.isInteger(slot.weekday) && slot.weekday >= 1 && slot.weekday <= 7 &&
    Number.isInteger(slot.hour) && slot.hour >= 0 && slot.hour <= 23 &&
    Number.isInteger(slot.minute) && slot.minute >= 0 && slot.minute <= 59 && slot.durationMinutes === 60;
}
