import { Prisma } from "./prisma.js";
import { ConflictError } from "../domain/errors.js";

// Translates Postgres's "unique constraint violated" (Prisma error P2002) into
// the domain's ConflictError, so the API answers 409 instead of 500. This is
// the backstop for two registrations with the same email that both pass the
// use case's findByEmail check at the same moment: only one INSERT can win.
// (events-service has the same helper; services never import each other.)
export async function rethrowUniqueViolation<T>(write: Promise<T>, message: string): Promise<T> {
  try {
    return await write;
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw new ConflictError(message);
    }
    throw err;
  }
}
