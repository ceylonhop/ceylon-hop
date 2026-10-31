// THROWAWAY (never merge): proves a failing shard turns the required e2e check red.
import { test, expect } from '@playwright/test';
test('ci gate canary fails on purpose', () => { expect(1).toBe(2); });
