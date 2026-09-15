// Promo code storage contract (spec 2026-09-14 §8.2). Exported so postgres.test.ts runs the SAME
// assertions against the real database — a fake that accepts what Postgres refuses is worse than none.
import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  InMemoryPromoCodeRepo,
  PromoCodeTakenError,
  type NewPromoCode,
  type PromoCodeRepo,
} from './promoCodeRepo';

const HOUR = 3_600_000;
export const uniqueCode = () => `T-${randomUUID().slice(0, 8).toUpperCase()}`;

export function makePromoCode(over: Partial<NewPromoCode> = {}): NewPromoCode {
  return {
    code: uniqueCode(),
    method: 'percentage',
    value: 1000,
    startsAt: null,
    expiresAt: new Date(Date.now() + 30 * 24 * HOUR),
    maxUses: 5,
    createdBy: 'founder@ceylonhop.com',
    ...over,
  };
}

export function promoCodeRepoContract(name: string, make: () => Promise<PromoCodeRepo>): void {
  describe(name, () => {
    it('creates a code and reads it back by id and by code', async () => {
      const repo = await make();
      const now = new Date(Math.floor(Date.now() / 1000) * 1000);
      const input = makePromoCode({ startsAt: now });
      const created = await repo.create(input, now);
      expect(created).toMatchObject({
        code: input.code, method: 'percentage', value: 1000, maxUses: 5, active: true,
        createdBy: 'founder@ceylonhop.com', updatedBy: null, updatedAt: null,
      });
      expect(created.startsAt?.getTime()).toBe(now.getTime());
      expect(created.createdAt.getTime()).toBe(now.getTime());
      expect((await repo.get(created.id))?.code).toBe(input.code);
      expect((await repo.getByCode(input.code))?.id).toBe(created.id);
      expect(await repo.getByCode(uniqueCode())).toBeNull();
      expect(await repo.get(randomUUID())).toBeNull();
    });

    it('keeps a code name unique forever, even once switched off', async () => {
      const repo = await make();
      const input = makePromoCode();
      const first = await repo.create(input, new Date());
      await repo.update(first.id, { active: false, updatedBy: 'founder@ceylonhop.com' }, new Date());
      await expect(repo.create(makePromoCode({ code: input.code }), new Date())).rejects.toBeInstanceOf(PromoCodeTakenError);
    });

    it('lists newest first', async () => {
      const repo = await make();
      const t = Date.now();
      const older = await repo.create(makePromoCode(), new Date(t));
      const newer = await repo.create(makePromoCode(), new Date(t + 1000));
      const ids = (await repo.list()).map((c) => c.id).filter((id) => id === older.id || id === newer.id);
      expect(ids).toEqual([newer.id, older.id]);
    });

    it('changes only expiry, max uses and on/off, stamping who and when', async () => {
      const repo = await make();
      const created = await repo.create(makePromoCode(), new Date());
      const at = new Date(Math.floor(Date.now() / 1000) * 1000);
      const expiresAt = new Date(at.getTime() + 60 * 24 * HOUR);
      const updated = await repo.update(created.id, { maxUses: 9, active: false, expiresAt, updatedBy: 'f@x.com' }, at);
      expect(updated).toMatchObject({ maxUses: 9, active: false, updatedBy: 'f@x.com', code: created.code, value: 1000 });
      expect(updated?.expiresAt.getTime()).toBe(expiresAt.getTime());
      expect(updated?.updatedAt?.getTime()).toBe(at.getTime());
      expect(await repo.update(randomUUID(), { maxUses: 2, updatedBy: 'f@x.com' }, at)).toBeNull();
    });

    it('refuses the rows the database refuses', async () => {
      const repo = await make();
      await expect(repo.create(makePromoCode({ value: 3001 }), new Date())).rejects.toThrow();
      await expect(repo.create(makePromoCode({ method: 'fixed', value: 0 }), new Date())).rejects.toThrow();
      await expect(repo.create(makePromoCode({ maxUses: 0 }), new Date())).rejects.toThrow();
      const exp = new Date(Date.now() + HOUR);
      await expect(repo.create(makePromoCode({ startsAt: exp, expiresAt: exp }), new Date())).rejects.toThrow();
    });
  });
}

promoCodeRepoContract('InMemoryPromoCodeRepo', async () => new InMemoryPromoCodeRepo());
