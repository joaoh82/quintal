/**
 * Orders reads that may overlap, so the newest one started is the only one
 * that lands.
 *
 * The board is read on a timer and again after every write, and nothing
 * stops the two from being in flight at once. A read that started before a
 * write committed can finish after the read that started after it. Without
 * an order, the older result overwrites the newer one and is broadcast as
 * the latest word: the note just written vanishes for everyone until the
 * next tick. Each read takes a ticket when it starts and checks it is still
 * the newest ticket before it keeps what it read.
 */
export class LatestRead {
  #issued = 0;

  /** A ticket for a read that is starting now. */
  start(): number {
    this.#issued += 1;
    return this.#issued;
  }

  /** May the read holding this ticket land? Only if nothing started after it. */
  isLatest(ticket: number): boolean {
    return ticket === this.#issued;
  }
}
