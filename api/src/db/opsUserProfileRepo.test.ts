import { describe, it, expect } from 'vitest';
import { InMemoryOpsUserProfileRepo } from './opsUserProfileRepo';

describe('InMemoryOpsUserProfileRepo', () => {
  it('stores a name against an email and reads it back', async () => {
    const repo = new InMemoryOpsUserProfileRepo();
    await repo.upsert('roshen@ceylonhop.com', 'Roshen Wijesinghe');
    expect(await repo.namesByEmail()).toEqual(new Map([['roshen@ceylonhop.com', 'Roshen Wijesinghe']]));
  });

  // Staff change their Google profile name; the roster should follow rather than pin the
  // first name we ever saw.
  it('overwrites the stored name on a later sign-in', async () => {
    const repo = new InMemoryOpsUserProfileRepo();
    await repo.upsert('roshen@ceylonhop.com', 'Roshen W');
    await repo.upsert('roshen@ceylonhop.com', 'Roshen Wijesinghe');
    expect((await repo.namesByEmail()).get('roshen@ceylonhop.com')).toBe('Roshen Wijesinghe');
  });

  // Identity is matched case-insensitively everywhere else (parseOpsUsers lowercases), so a
  // 'Roshen@…' token must not create a second, invisible profile row.
  it('keys emails case-insensitively', async () => {
    const repo = new InMemoryOpsUserProfileRepo();
    await repo.upsert('Roshen@CeylonHop.com', 'Roshen Wijesinghe');
    expect((await repo.namesByEmail()).get('roshen@ceylonhop.com')).toBe('Roshen Wijesinghe');
  });

  it('ignores a blank name rather than storing an empty label', async () => {
    const repo = new InMemoryOpsUserProfileRepo();
    await repo.upsert('roshen@ceylonhop.com', '   ');
    expect(await repo.namesByEmail()).toEqual(new Map());
  });

  it('starts empty', async () => {
    expect(await new InMemoryOpsUserProfileRepo().namesByEmail()).toEqual(new Map());
  });
});
