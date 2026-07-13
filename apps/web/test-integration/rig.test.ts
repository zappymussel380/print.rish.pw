import { afterAll, describe, expect, it } from "vitest";
import { PrismaClient, prisma } from "@print/db";
import { redis } from "@/lib/redis";
import {
  assertSameDatabaseEndpoint,
  integrationConnection,
} from "./support/connections";

const webConnection = integrationConnection("DATABASE_URL", "print_web");
const workerConnection = integrationConnection("WORKER_DATABASE_URL", "print_worker");
assertSameDatabaseEndpoint(webConnection, workerConnection);

const workerPrisma = new PrismaClient({ datasourceUrl: workerConnection.url });

afterAll(async () => {
  await Promise.all([prisma.$disconnect(), workerPrisma.$disconnect(), redis.quit()]);
  delete (globalThis as { prisma?: unknown; redis?: unknown }).prisma;
  delete (globalThis as { prisma?: unknown; redis?: unknown }).redis;
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
  quotationUpdate: boolean;
  quotationDelete: boolean;
  quotationItemSelect: boolean;
  quotationItemDelete: boolean;
  statusHistoryDelete: boolean;
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
          AS "quotationInsert",
        has_table_privilege(current_user, '"Quotation"', 'UPDATE')
          AS "quotationUpdate",
        has_table_privilege(current_user, '"Quotation"', 'DELETE')
          AS "quotationDelete",
        has_table_privilege(current_user, '"QuotationItem"', 'SELECT')
          AS "quotationItemSelect",
        has_table_privilege(current_user, '"QuotationItem"', 'DELETE')
          AS "quotationItemDelete",
        has_table_privilege(current_user, '"StatusHistory"', 'DELETE')
          AS "statusHistoryDelete"
    `;

    expect(privileges).toEqual({
      uploadedModelSelect: true,
      uploadedModelInsert: false,
      uploadedModelUpdate: true,
      uploadedModelDelete: true,
      sliceMeasurementUpdate: true,
      quotationSelect: true,
      quotationInsert: false,
      quotationUpdate: false,
      quotationDelete: true,
      quotationItemSelect: true,
      quotationItemDelete: false,
      statusHistoryDelete: false,
    });
  });

  it("connects to the isolated Redis service", async () => {
    await expect(redis.ping()).resolves.toBe("PONG");
  });
});
