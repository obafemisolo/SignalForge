import { PrismaPg } from "@prisma/adapter-pg";

import {
  PrismaClient,
  ResearchJobStatus,
} from "../src/generated/prisma/client.js";

const databaseUrl = process.env.DATABASE_URL;

if (databaseUrl === undefined || databaseUrl.length === 0) {
  throw new Error("DATABASE_URL is required to seed SignalForge");
}

const adapter = new PrismaPg({
  connectionString: databaseUrl,
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 30_000,
  max: 2,
});
const prisma = new PrismaClient({ adapter });

const sampleJobId = "00000000-0000-4000-8000-000000000001";

async function seed(): Promise<void> {
  await prisma.researchJob.upsert({
    where: { id: sampleJobId },
    update: {},
    create: {
      id: sampleJobId,
      query: "Find companies with public backend engineering hiring signals.",
      status: ResearchJobStatus.QUEUED,
      requestedSources: ["https://example.com/"],
      extractionSchema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        title: "companyHiringSignal",
        type: "object",
        properties: {
          company: {},
          website: {},
          role: {},
          location: {},
          signal: {},
          sourceUrl: {},
          evidence: {},
        },
        required: [
          "company",
          "website",
          "role",
          "location",
          "signal",
          "sourceUrl",
          "evidence",
        ],
        additionalProperties: false,
      },
      totalSources: 1,
    },
  });
}

try {
  await seed();
} finally {
  await prisma.$disconnect();
}
