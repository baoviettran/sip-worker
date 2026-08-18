/**
 * State-transition assertion for the RFC 3261 transaction state machines.
 *
 * Each transaction routes every state change through `assertTransition` with
 * its RFC transition table (RFC 3261 figures 5-8, RFC 6026 sections 8.4-8.7),
 * so an illegal transition is a loud throw in development and in the test
 * suite instead of silent undefined behavior. The reentrancy guards in the
 * transactions make illegal transitions unreachable in normal operation.
 */

export type TransitionTable<S extends string> = Readonly<Record<S, readonly S[]>>;

/**
 * Assert `from -> to` is an allowed edge in `table`. A self-transition is
 * always allowed. Throws on an illegal edge.
 */
export function assertTransition<S extends string>(
  table: TransitionTable<S>,
  from: S,
  to: S,
): void {
  if (from === to) return;
  const allowed = table[from];
  if (allowed !== undefined && allowed.includes(to)) return;
  throw new Error(`invalid transaction state transition: ${from} -> ${to}`);
}
