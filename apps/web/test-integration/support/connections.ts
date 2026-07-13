export interface IntegrationConnection {
  url: string;
  username: string;
  database: string;
  endpoint: string;
}

export function integrationConnection(
  name: string,
  expectedUsername: string,
): IntegrationConnection {
  const raw = process.env[name];
  if (!raw) throw new Error(`${name} is required for integration tests`);

  const parsed = new URL(raw);
  const username = decodeURIComponent(parsed.username);
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
    throw new Error(`${name} must be a PostgreSQL URL`);
  }
  if (username !== expectedUsername) {
    throw new Error(`${name} must use the ${expectedUsername} role`);
  }
  // Task 0.3 teardown is intentionally destructive. Refuse production-shaped
  // databases even if a developer copies an integration command by mistake.
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

export function assertSameDatabaseEndpoint(
  ...connections: IntegrationConnection[]
): void {
  const [first, ...rest] = connections;
  if (!first || rest.some((connection) => connection.endpoint !== first.endpoint)) {
    throw new Error("Integration database URLs must target the same endpoint");
  }
}
