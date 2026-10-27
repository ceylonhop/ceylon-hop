import { describe, it, expect, beforeAll } from 'vitest';
import { createApp } from '../app';
import { SCHEDULE_PROBLEMS } from '../domain/bookingSchedule';

let body = '';

// Lift `const NAME = …;` out of the ops shell (same idea as opsUi.dates.test.ts's lift).
function lift(name: string): string {
  const m = new RegExp(`const ${name}\\s*=`).exec(body);
  expect(m, `${name} not found in the ops shell`).toBeTruthy();
  let depth = 0;
  for (let i = m!.index; i < body.length; i++) {
    const ch = body[i];
    if (ch === '{' || ch === '(' || ch === '[') depth++;
    else if (ch === '}' || ch === ')' || ch === ']') depth--;
    else if (ch === ';' && depth === 0) return body.slice(m!.index, i + 1);
  }
  throw new Error(`${name} never terminated`);
}

beforeAll(async () => {
  body = await (await createApp().request('/ops')).text();
});

describe('ops sheet — set pickup date/time', () => {
  it('has the form and posts to the schedule route with the expected value', () => {
    expect(body).toContain('data-act="schedopen"');
    expect(body).toContain('data-act="schedsave"');
    expect(body).toContain('/schedule`');
    expect(body).toMatch(/expected:\{date:/);
  });

  it('has a message for every refusal the server can send', () => {
    const errs = new Function(`${lift('SCHED_ERR')}; return SCHED_ERR;`)() as Record<string, string>;
    for (const code of [...SCHEDULE_PROBLEMS, 'conflict', 'not_editable']) {
      expect(errs[code], `no message for ${code}`).toBeTruthy();
    }
  });

  it('warns before saving when a driver already has the job', () => {
    expect(body).toContain('data-testid="sched-driver-warn"');
  });

  it('lists details reminders in the activity feed (Phase 2)', () => {
    expect(body).toContain('(d?.reminders||[]).forEach(');
    expect(body).toContain('still need pickup date/time');
  });

  // After a save the operator must know whether the customer was told — including when the
  // driver line also shows, which used to hide the email result entirely.
  it('says plainly when the customer was NOT emailed, even alongside the driver line', () => {
    const saved = new Function(`${lift('SCHED_SAVED')}; return SCHED_SAVED;`)() as
      (res: { emailed?: boolean; driverNotified?: boolean }, asked: boolean) => [string, string | undefined];
    const failed = saved({ emailed: false, driverNotified: true }, true);
    expect(failed[0]).toMatch(/NOT emailed/);
    expect(failed[0]).toMatch(/WhatsApp/);
    expect(failed[0]).toMatch(/driver/);
    expect(failed[1]).toBe('error');
    const ok = saved({ emailed: true, driverNotified: true }, true);
    expect(ok[0]).toMatch(/customer emailed/);
    expect(ok[0]).toMatch(/driver/);
    expect(ok[1]).toBeUndefined();
    expect(saved({ emailed: false, driverNotified: false }, false)).toEqual(['Saved', undefined]); // not asked to email
  });

  it('guards the save against a double press', () => {
    expect(lift('MUTATES')).toContain("'schedsave'");
  });
});
