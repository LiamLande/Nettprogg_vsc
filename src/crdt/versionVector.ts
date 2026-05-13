import { ElementId, ReplicaId } from "./types";

export class VersionVector {
  private readonly counters = new Map<ReplicaId, number>();

  observe(id: ElementId): void {
    this.counters.set(id.replicaId, Math.max(this.get(id.replicaId), id.counter));
  }

  get(replicaId: ReplicaId): number {
    return this.counters.get(replicaId) ?? 0;
  }

  includes(id: ElementId): boolean {
    return this.get(id.replicaId) >= id.counter;
  }

  toJSON(): Record<ReplicaId, number> {
    return Object.fromEntries(Array.from(this.counters.entries()).sort(([a], [b]) => a.localeCompare(b)));
  }
}
