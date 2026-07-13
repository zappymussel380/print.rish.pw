import { afterAll, describe, expect, it } from "vitest";
import { PrismaClient, prisma } from "@print/db";
import { redis } from "@/lib/redis";

interface IntegrationConnection {
  url: string;
  username: string;
  database: string;
  endpoint: string;
}

function integrationConnection(name: string, expectedUsername: string): IntegrationConnection {
  const raw = process.env[name];
  if (!raw) throw new Error(`${name} is required for integration tests`);

  const parsed = new URL(raw);
  const username = decodeURIComponent(parsed.username);
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
    throw new Error(`${name} must be a PostgreSQL URL`);
  }
  if (username !== expectedUsername) {
    throw new Error(`${name} must use the ${expectedUsername} runtime role`);
  }
  // This suite will become destructive when the Task 0.3 fixtures land. Refuse
  // production-shaped databases from day one so a copied command stays safe.
  if (!database.endsWith("_integration")) {
    throw new Error(`${name} must target a dedicated *_integration database`);
  }

  return {
    url: raw,
    username,
    database,
    endpoint: `${parsed.hostname}:${parsed.port || "5432"}/${database}`,
  };
}

const webConnection = integrationConnection("DATABASE_URL", "print_web");
const workerConnection = integrationConnection("WORKER_DATABASE_URL", "print_worker");
if (webConnection.endpoint !== workerConnection.endpoint) {
  throw new Error("Web and worker integration URLs must target the same database endpoint");
}

const workerPrisma = new PrismaClient({ datasourceUrl: workerConnection.url });

afterAll(async () => {
  await Promise.all([prisma.$disconnect(), workerPrisma.$disconnect(), redis.quit()]);
});

interface IdentityRow {
  role: string;
  database: string;
}

interface WebPrivileges {
  uploadedModelInsert: boolean;
  sliceResultSelect: boolean;
  sliceStatusInsert: boolean;
  sliceStatusUpdate: boolean;
  sliceMeasurementInsert: boolean;
  sliceMeasurementUpdate: boolean;
  sliceResultDelete: boolean;
}

interface WorkerPrivileges {
  uploadedModelSelect: boolean;
  uploadedModelInsert: boolean;
  uploadedModelUpdate: boolean;
  uploadedModelDelete: boolean;
  sliceMeasurementUpdate: boolean;
  quotationSelect: boolean;
  quotationInsert: boolean;
}

describe("integration service rig", () => {
  it("connects to the migrated database through both runtime roles", async () => {
    const [webIdentity] = await prisma.$queryRaw<IdentityRow[]>`
      SELECT current_user::text AS role, current_database() AS database
    `;
    const [workerIdentity] = await workerPrisma.$queryRaw<IdentityRow[]>`
      SELECT current_user::text AS role, current_database() AS database
    `;

    expect(webIdentity).toEqual({
      role: webConnection.username,
      database: webConnection.database,
    });
    expect(workerIdentity).toEqual({
      role: workerConnection.username,
      database: workerConnection.database,
    });
  });

  it("keeps trusted slice measurements outside the web role", async () => {
    const [privileges] = await prisma.$queryRaw<WebPrivileges[]>`
      SELECT
        has_table_privilege(current_user, '"UploadedModel"', 'INSERT')
          AS "uploadedModelInsert",
        has_table_privilege(current_user, '"SliceResult"', 'SELECT')
          AS "sliceResultSelect",
        has_column_privilege(current_user, '"SliceResult"', 'status', 'INSERT')
          AS "sliceStatusInsert",
        has_column_privilege(current_user, '"SliceResult"', 'status', 'UPDATE')
          AS "sliceStatusUpdate",
        has_column_privilege(current_user, '"SliceResult"', 'filamentGrams', 'INSERT')
          AS "sliceMeasurementInsert",
        has_column_privilege(current_user, '"SliceResult"', 'filamentGrams', 'UPDATE')
          AS "sliceMeasurementUpdate",
        has_table_privilege(current_user, '"SliceResult"', 'DELETE')
          AS "sliceResultDelete"
    `;

    expect(privileges).toEqual({
      uploadedModelInsert: true,
      sliceResultSelect: true,
      sliceStatusInsert: true,
      sliceStatusUpdate: true,
      sliceMeasurementInsert: false,
      sliceMeasurementUpdate: false,
      sliceResultDelete: false,
    });
  });

  it("gives the worker only its current processing and retention grants", async () => {
    const [privileges] = await workerPrisma.$queryRaw<WorkerPrivileges[]>`
      SELECT
        has_table_privilege(current_user, '"UploadedModel"', 'SELECT')
          AS "uploadedModelSelect",
        has_table_privilege(current_user, '"UploadedModel"', 'INSERT')
          AS "uploadedModelInsert",
        has_table_privilege(current_user, '"UploadedModel"', 'UPDATE')
          AS "uploadedModelUpdate",
        has_table_privilege(current_user, '"UploadedModel"', 'DELETE')
          AS "uploadedModelDelete",
        has_column_privilege(current_user, '"SliceResult"', 'filamentGrams', 'UPDATE')
          AS "sliceMeasurementUpdate",
        has_table_privilege(current_user, '"Quotation"', 'SELECT')
          AS "quotationSelect",
        has_table_privilege(current_user, '"Quotation"', 'INSERT')
          AS "quotationInsert"
    `;

    expect(privileges).toEqual({
      uploadedModelSelect: true,
      uploadedModelInsert: false,
      uploadedModelUpdate: true,
      uploadedModelDelete: true,
      sliceMeasurementUpdate: true,
      quotationSelect: true,
      quotationInsert: false,
    });
  });

  it("connects to the isolated Redis service", async () => {
    await expect(redis.ping()).resolves.toBe("PONG");
  });
});
