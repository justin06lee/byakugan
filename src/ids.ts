/**
 * Manifest IDs must be stable across steps: if [17] was the Qty spinner in the
 * last observation, it is still [17] now — that's what keeps diffs small and
 * lets the agent refer to elements it saw earlier. Keyed by CDP backendNodeId,
 * which is stable for the lifetime of a DOM node. Cleared on navigation so IDs
 * stay short.
 */
export class IdAllocator {
  private map = new Map<number, number>();
  private next = 1;

  idFor(backendNodeId: number): number {
    let id = this.map.get(backendNodeId);
    if (id === undefined) {
      id = this.next++;
      this.map.set(backendNodeId, id);
    }
    return id;
  }

  clear(): void {
    this.map.clear();
    this.next = 1;
  }
}
