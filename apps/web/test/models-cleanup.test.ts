import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

/**
 * Regression coverage for the session-cleanup DELETE contract
 * (app/api/models/route.ts).
 *
 * The bug this guards against: cleanup used to delete EVERY unattached model in
 * the session, so an on-screen model uploaded alongside older stranded ones got
 * wiped too — leaving the UI showing a model whose row/file is gone, which then
 * broke slicing/checkout. The fix has the client send `keep` (its on-screen
 * server ids) and the route excludes them. These tests fail if that exclusion is
 * ever dropped.
 *
 * Dependencies are mocked with an in-memory table whose findMany/deleteMany
 * honour the exact `where` features the route uses — `sessionId`, the
 * `items: { none: {} }` (unattached) filter, and `id` equality / `id.notIn` —
 * so the assertions exercise real deletion behaviour rather than call shapes.
 */

interface Row {
  id: string;
  sessionId: string;
  storedPath: string;
  thumbPath: string | null;
  attached: boolean; // true = referenced by a submitted quotation (has items)
}

const SESSION = "sess-1";

const mocks = vi.hoisted(() => {
  const state: { table: Row[] } = { table: [] };
  const removeQuietly = vi.fn(async (_path: string) => {});

  // Faithful subset of the Prisma `where` semantics the route relies on.
  const matches = (r: Row, where: Record<string, any>): boolean => {
    if (where.sessionId !== undefined && r.sessionId !== where.sessionId) return false;
    if (where.items?.none && r.attached) return false;
    if (typeof where.id === "string" && r.id !== where.id) return false;
    if (where.id?.notIn && where.id.notIn.includes(r.id)) return false;
    return true;
  };

  return { state, removeQuietly, matches };
});

vi.mock("@print/db", () => ({
  prisma: {
    uploadedModel: {
      findMany: vi.fn(async ({ where }: { where: Record<string, any> }) =>
        mocks.state.table.filter((r) => mocks.matches(r, where)),
      ),
      deleteMany: vi.fn(async ({ where }: { where: Record<string, any> }) => {
        const del = mocks.state.table.filter((r) => mocks.matches(r, where));
        mocks.state.table = mocks.state.table.filter((r) => !del.includes(r));
        return { count: del.length };
      }),
      count: vi.fn(async ({ where }: { where: Record<string, any> }) =>
        mocks.state.table.filter((r) => mocks.matches(r, where)).length,
      ),
    },
  },
}));
vi.mock("@/lib/session", () => ({ getQuoteSessionId: vi.fn(async () => SESSION) }));
vi.mock("@/lib/security", () => ({ assertSameOrigin: vi.fn(() => true) }));
vi.mock("@/lib/storage", () => ({ removeQuietly: mocks.removeQuietly }));

// The mocked Prisma client, for per-test `mockImplementationOnce` overrides.
import { prisma } from "@print/db";

// Imported after the mocks are registered.
const { DELETE, GET } = await import("@/app/api/models/route");

/** Minimal stand-in for the parts of NextRequest the route touches (`.json()`).
 *  `throws` reproduces an absent/invalid body. */
const req = (body: unknown, throws = false): NextRequest =>
  ({
    json: async () => {
      if (throws) throw new Error("no body");
      return body;
    },
  }) as unknown as NextRequest;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("DELETE /api/models — session cleanup", () => {
  it("deletes stranded orphans but preserves on-screen, quoted, and other-session models", async () => {
    mocks.state.table = [
      { id: "A", sessionId: "sess-1", storedPath: "/u/A.stl", thumbPath: "/t/A.png", attached: false }, // old orphan
      { id: "B", sessionId: "sess-1", storedPath: "/u/B.stl", thumbPath: "/t/B.png", attached: false }, // fresh, on screen
      { id: "C", sessionId: "sess-1", storedPath: "/u/C.stl", thumbPath: null, attached: true }, // quoted
      { id: "D", sessionId: "sess-2", storedPath: "/u/D.stl", thumbPath: null, attached: false }, // other session
    ];

    // The client still has model B on screen, so it asks to keep it.
    const res = await DELETE(req({ keep: ["B"] }));

    expect(await res.json()).toEqual({ cleared: 1 });
    // Only the stranded orphan A is gone; B, C, D all survive.
    expect(mocks.state.table.map((r) => r.id).sort()).toEqual(["B", "C", "D"]);
    // Files unlinked for A only — never for the still-active model B.
    expect(mocks.removeQuietly).toHaveBeenCalledWith("/u/A.stl");
    expect(mocks.removeQuietly).toHaveBeenCalledWith("/t/A.png");
    expect(mocks.removeQuietly).not.toHaveBeenCalledWith("/u/B.stl");
    expect(mocks.removeQuietly).not.toHaveBeenCalledWith("/t/B.png");
  });

  it("clears every unattached model when no keep list is sent (post-reload cleanup)", async () => {
    mocks.state.table = [
      { id: "A", sessionId: "sess-1", storedPath: "/u/A.stl", thumbPath: null, attached: false },
      { id: "B", sessionId: "sess-1", storedPath: "/u/B.stl", thumbPath: null, attached: false },
      { id: "C", sessionId: "sess-1", storedPath: "/u/C.stl", thumbPath: null, attached: true }, // quoted, keep
    ];

    // Absent/invalid body → keep nothing.
    const res = await DELETE(req(null, true));

    expect(await res.json()).toEqual({ cleared: 2 });
    expect(mocks.state.table.map((r) => r.id)).toEqual(["C"]);
  });

  it("preserves files when a model is attached in the findMany→delete race window", async () => {
    // Codex high finding: the row must be deleted BEFORE its files are unlinked,
    // re-asserting `items:{none:{}}` atomically, so a checkout that attaches the
    // model between the batch select and the per-row delete keeps its artefacts.
    mocks.state.table = [
      { id: "A", sessionId: "sess-1", storedPath: "/u/A.stl", thumbPath: "/t/A.png", attached: false }, // wins the race
      { id: "B", sessionId: "sess-1", storedPath: "/u/B.stl", thumbPath: "/t/B.png", attached: false }, // genuine orphan
    ];

    // Reproduce the race: findMany returns the unattached snapshot [A, B], then a
    // concurrent checkout attaches A before the route's atomic deleteMany runs.
    vi.mocked(prisma.uploadedModel.findMany).mockImplementationOnce((({
      where,
    }: {
      where: Record<string, any>;
    }) => {
      const snapshot = mocks.state.table.filter((r) => mocks.matches(r, where));
      const a = mocks.state.table.find((r) => r.id === "A");
      if (a) a.attached = true; // checkout lands in the window
      return Promise.resolve(snapshot);
    }) as unknown as typeof prisma.uploadedModel.findMany);

    const res = await DELETE(req({ keep: [] }));

    // A survived the atomic delete (its deleteMany matched 0), only B was cleared.
    expect(await res.json()).toEqual({ cleared: 1 });
    expect(mocks.state.table.map((r) => r.id).sort()).toEqual(["A"]);
    // A's files must remain on disk — the whole point of delete-before-unlink.
    expect(mocks.removeQuietly).not.toHaveBeenCalledWith("/u/A.stl");
    expect(mocks.removeQuietly).not.toHaveBeenCalledWith("/t/A.png");
    // B, genuinely orphaned, is removed.
    expect(mocks.removeQuietly).toHaveBeenCalledWith("/u/B.stl");
    expect(mocks.removeQuietly).toHaveBeenCalledWith("/t/B.png");
  });
});

describe("GET /api/models — session model count", () => {
  it("counts only unattached models, so a submitted quote can't wedge the session", async () => {
    // Codex medium finding: the count (and the upload cap in uploads/route.ts,
    // which reuses this exact `items:{none:{}}` filter — "Mirrors GET/DELETE in
    // api/models") must exclude models already attached to a submitted quotation.
    // Otherwise a session that once submitted a cap's worth of models stays
    // permanently unable to start a new quote.
    mocks.state.table = [
      { id: "A", sessionId: "sess-1", storedPath: "/u/A.stl", thumbPath: null, attached: false }, // counts
      { id: "B", sessionId: "sess-1", storedPath: "/u/B.stl", thumbPath: null, attached: false }, // counts
      { id: "C", sessionId: "sess-1", storedPath: "/u/C.stl", thumbPath: null, attached: true }, // submitted, excluded
      { id: "D", sessionId: "sess-1", storedPath: "/u/D.stl", thumbPath: null, attached: true }, // submitted, excluded
      { id: "E", sessionId: "sess-2", storedPath: "/u/E.stl", thumbPath: null, attached: false }, // other session
    ];

    const res = await GET();

    expect(await res.json()).toEqual({ count: 2 });
  });
});
