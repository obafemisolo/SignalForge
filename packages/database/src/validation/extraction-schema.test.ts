import { describe, expect, it } from "vitest";

import { PersistenceValidationError } from "../errors.js";
import {
  assertStructuredDataMatchesSchema,
  assertValidExtractionSchema,
} from "./extraction-schema.js";

const extractionSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    title: { type: "string" },
    count: { type: "integer", minimum: 0 },
  },
  required: ["title"],
  additionalProperties: false,
};

describe("extraction schema validation", () => {
  it("accepts a valid schema and matching record", () => {
    expect(() => assertValidExtractionSchema(extractionSchema)).not.toThrow();
    expect(() =>
      assertStructuredDataMatchesSchema(extractionSchema, {
        title: "SignalForge",
        count: 1,
      }),
    ).not.toThrow();
  });

  it("rejects a structured record that violates the schema", () => {
    expect(() =>
      assertStructuredDataMatchesSchema(extractionSchema, {
        title: 42,
      }),
    ).toThrow(PersistenceValidationError);
  });

  it("rejects invalid and unresolved JSON Schemas", () => {
    expect(() =>
      assertValidExtractionSchema({
        type: "not-a-json-schema-type",
      }),
    ).toThrow(PersistenceValidationError);

    expect(() =>
      assertValidExtractionSchema({
        $ref: "https://untrusted.example/schema.json",
      }),
    ).toThrow(PersistenceValidationError);
  });
});
