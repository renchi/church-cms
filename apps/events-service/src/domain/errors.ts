// Same three error types as members-service. Each service owns its own copy:
// sharing them through a package would couple the two contexts' code for the
// sake of ~20 lines. The API layer maps them to 400 / 404 / 409.
export class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DomainError";
  }
}

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}
