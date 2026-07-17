export class DatabaseConfigurationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "DatabaseConfigurationError";
  }
}

export class EntityNotFoundError extends Error {
  public readonly entityName: string;
  public readonly entityId: string;

  public constructor(entityName: string, entityId: string) {
    super(`${entityName} ${entityId} was not found`);
    this.name = "EntityNotFoundError";
    this.entityName = entityName;
    this.entityId = entityId;
  }
}

export class PersistenceConflictError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "PersistenceConflictError";
  }
}

export class PersistenceValidationError extends Error {
  public readonly issues: readonly string[];

  public constructor(message: string, issues: readonly string[] = []) {
    super(message);
    this.name = "PersistenceValidationError";
    this.issues = [...issues];
  }
}
