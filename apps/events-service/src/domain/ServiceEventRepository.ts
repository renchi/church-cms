import type { ServiceEvent } from "./ServiceEvent.js";

// One repository per aggregate root: you load and save a whole aggregate,
// never a part of one. The interface lives in the domain; the Prisma
// implementation lives in infrastructure/ (dependency inversion, study-guide §3.4).
export interface ServiceEventRepository {
  findById(id: string): Promise<ServiceEvent | null>;
  // Events that haven't started yet and aren't cancelled, soonest first.
  listUpcoming(params: {
    from: Date;
    skip: number;
    take: number;
  }): Promise<{ events: ServiceEvent[]; total: number }>;
  save(event: ServiceEvent): Promise<void>;
}
