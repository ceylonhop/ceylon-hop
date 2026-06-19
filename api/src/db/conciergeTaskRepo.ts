import { randomUUID } from 'node:crypto';

export type ConciergeTaskType = 'confirm_pickup' | 'collect_details' | 'follow_up';
export type ConciergeTaskStatus = 'open' | 'done';

export interface ConciergeTask {
  id: string;
  bookingId: string;
  type: ConciergeTaskType;
  status: ConciergeTaskStatus;
  createdAt: string;
}

export interface ConciergeTaskRepo {
  create(t: { bookingId: string; type: ConciergeTaskType }): Promise<ConciergeTask>;
  listByBooking(bookingId: string): Promise<ConciergeTask[]>;
  list(): Promise<ConciergeTask[]>;
}

export class InMemoryConciergeTaskRepo implements ConciergeTaskRepo {
  private tasks: ConciergeTask[] = [];

  async create(t: { bookingId: string; type: ConciergeTaskType }): Promise<ConciergeTask> {
    const task: ConciergeTask = {
      id: randomUUID(),
      bookingId: t.bookingId,
      type: t.type,
      status: 'open',
      createdAt: new Date().toISOString(),
    };
    this.tasks.push(task);
    return task;
  }

  async listByBooking(bookingId: string): Promise<ConciergeTask[]> {
    return this.tasks.filter((t) => t.bookingId === bookingId);
  }

  async list(): Promise<ConciergeTask[]> {
    return [...this.tasks];
  }
}
