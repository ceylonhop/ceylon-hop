import { randomUUID } from 'node:crypto';

export interface Coordinator {
  id: string; name: string; whatsapp: string; regions: string; active: boolean; createdAt: string;
}
export interface NewCoordinator { name: string; whatsapp: string; regions?: string }

export interface CoordinatorRepo {
  create(c: NewCoordinator): Promise<Coordinator>;
  get(id: string): Promise<Coordinator | null>;
  list(opts?: { activeOnly?: boolean }): Promise<Coordinator[]>;
}

export class InMemoryCoordinatorRepo implements CoordinatorRepo {
  private items: Coordinator[] = [];
  async create(c: NewCoordinator): Promise<Coordinator> {
    const row: Coordinator = {
      id: randomUUID(), name: c.name, whatsapp: c.whatsapp, regions: c.regions ?? '',
      active: true, createdAt: new Date().toISOString(),
    };
    this.items.push(row);
    return row;
  }
  async get(id: string): Promise<Coordinator | null> {
    return this.items.find((c) => c.id === id) ?? null;
  }
  async list(opts?: { activeOnly?: boolean }): Promise<Coordinator[]> {
    const all = [...this.items].reverse(); // newest-first
    return opts?.activeOnly ? all.filter((c) => c.active) : all;
  }
}
