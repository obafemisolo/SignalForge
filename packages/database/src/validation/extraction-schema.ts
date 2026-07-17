import type { JsonObject } from "@signalforge/schemas";
import {
  Ajv2020,
  type AnySchema,
  type ErrorObject,
  type ValidateFunction,
} from "ajv/dist/2020.js";

import { PersistenceValidationError } from "../errors.js";

const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  validateFormats: false,
});

function formatIssues(errors: ErrorObject[] | null | undefined): string[] {
  return (errors ?? []).map((error) => {
    const location = error.instancePath.length > 0 ? error.instancePath : "/";
    return `${location}: ${error.message ?? error.keyword}`;
  });
}

function compileSchema(schema: JsonObject): ValidateFunction {
  try {
    return ajv.compile(schema as AnySchema);
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : "Unknown JSON Schema error";
    throw new PersistenceValidationError("Invalid extraction schema", [
      message,
    ]);
  }
}

export function assertValidExtractionSchema(schema: JsonObject): void {
  compileSchema(schema);
}

export function assertStructuredDataMatchesSchema(
  schema: JsonObject,
  structuredData: JsonObject,
): void {
  const validate = compileSchema(schema);

  if (!validate(structuredData)) {
    throw new PersistenceValidationError(
      "Extracted record does not match the research job extraction schema",
      formatIssues(validate.errors),
    );
  }
}
