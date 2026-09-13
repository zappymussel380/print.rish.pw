import { describe, expect, it } from "vitest";
import { SlicerIdentityPool } from "./slicer-pool";

describe("SlicerIdentityPool", () => {
  it("hands each identity to one holder at a time, waiters in order", async () => {
    const a = { uid: 1002, gid: 3000 };
    const pool = new SlicerIdentityPool([a]);
    const first = await pool.acquire();
    const order: number[] = [];
    const second = pool.acquire().then((id) => (order.push(2), id));
    const third = pool.acquire().then((id) => (order.push(3), id));
    await Promise.resolve();
    expect(order).toEqual([]);
    pool.release(first);
    expect(await second).toBe(a);
    pool.release(a);
    expect(await third).toBe(a);
    expect(order).toEqual([2, 3]);
  });
});
