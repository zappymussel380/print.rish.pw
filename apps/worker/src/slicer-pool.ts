import { config } from "./config.js";
import type { SlicerIdentity } from "./orca.js";

/** The uid/gid pairs Orca runs under, one per concurrent slice. Slice jobs and
 *  advanced mode's profile tests share them, so an Orca run never shares a uid
 *  — and with it a sandbox — with another; a caller waits for a free one. */
export class SlicerIdentityPool {
  private readonly free: SlicerIdentity[];
  private readonly waiters: ((identity: SlicerIdentity) => void)[] = [];

  constructor(identities: SlicerIdentity[]) {
    this.free = [...identities];
  }

  acquire(): Promise<SlicerIdentity> {
    const identity = this.free.pop();
    if (identity) return Promise.resolve(identity);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  release(identity: SlicerIdentity): void {
    const next = this.waiters.shift();
    if (next) next(identity);
    else this.free.push(identity);
  }
}

export const slicerPool = new SlicerIdentityPool(
  Array.from({ length: config.concurrency }, (_, index) => ({
    uid: config.slicerUid + index,
    gid: config.slicerGid + index,
  })),
);
