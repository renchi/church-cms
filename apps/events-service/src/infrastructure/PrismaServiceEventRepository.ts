import type { PrismaClient, ServiceEventRow } from "./prisma.js";
import { ConflictError } from "../domain/errors.js";
import { ServiceEvent, type EventStatus, type EventType } from "../domain/ServiceEvent.js";
import type { ServiceEventRepository } from "../domain/ServiceEventRepository.js";
import { prisma as defaultPrisma } from "./prisma.js";

// Rows store the Venue value object as three flat columns (see schema.prisma);
// these two functions are the only place that knows about that mapping.
function toServiceEvent(row: ServiceEventRow): ServiceEvent {
  return ServiceEvent.reconstitute({
    id: row.id,
    title: row.title,
    eventType: row.eventType as EventType,
    venue: { name: row.venueName, address: row.venueAddress, isOnline: row.venueIsOnline },
    ministerId: row.ministerId,
    scheduledAt: row.scheduledAt,
    durationMinutes: row.durationMinutes,
    status: row.status as EventStatus,
    description: row.description,
    createdById: row.createdById,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    version: row.version,
  });
}

function toRow(event: ServiceEvent): ServiceEventRow {
  const { venue, ...rest } = event.toSnapshot();
  return {
    ...rest,
    venueName: venue.name,
    venueAddress: venue.address,
    venueIsOnline: venue.isOnline,
  };
}

export class PrismaServiceEventRepository implements ServiceEventRepository {
  // Injectable so integration tests can point it at a throwaway database.
  constructor(private readonly prisma: PrismaClient = defaultPrisma) {}

  async findById(id: string): Promise<ServiceEvent | null> {
    const row = await this.prisma.serviceEvent.findUnique({ where: { id } });
    return row ? toServiceEvent(row) : null;
  }

  async listUpcoming(params: {
    from: Date;
    skip: number;
    take: number;
  }): Promise<{ events: ServiceEvent[]; total: number }> {
    const where = { scheduledAt: { gte: params.from }, status: { not: "cancelled" } };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.serviceEvent.findMany({
        where,
        skip: params.skip,
        take: params.take,
        orderBy: { scheduledAt: "asc" },
      }),
      this.prisma.serviceEvent.count({ where }),
    ]);
    return { events: rows.map(toServiceEvent), total };
  }

  // Optimistic locking. A new event (version 0) is inserted. An existing one is
  // updated only WHERE its version is still the one we loaded, and the version
  // goes up by one. If another request saved in between, the WHERE matches no
  // row, and we report a conflict instead of overwriting their change. No row
  // is locked while the request runs; we only check at the moment of writing.
  async save(event: ServiceEvent): Promise<void> {
    const row = toRow(event);
    if (row.version === 0) {
      await this.prisma.serviceEvent.create({ data: { ...row, version: 1 } });
      return;
    }
    const { count } = await this.prisma.serviceEvent.updateMany({
      where: { id: row.id, version: row.version },
      // Everything except id, createdAt and createdById, which never change.
      data: {
        title: row.title,
        eventType: row.eventType,
        venueName: row.venueName,
        venueAddress: row.venueAddress,
        venueIsOnline: row.venueIsOnline,
        ministerId: row.ministerId,
        scheduledAt: row.scheduledAt,
        durationMinutes: row.durationMinutes,
        status: row.status,
        description: row.description,
        updatedAt: row.updatedAt,
        version: { increment: 1 },
      },
    });
    if (count === 0) {
      throw new ConflictError("The event was changed by another request; reload it and try again");
    }
  }
}
