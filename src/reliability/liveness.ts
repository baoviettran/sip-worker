/**
 * Environment-neutral liveness lifecycle shared by every deployment strategy.
 *
 * A strategy is started at the composition root once a transport is connected
 * and stopped before the transport is torn down. Concrete strategies (native
 * Node WebSocket Ping/Pong, SIP OPTIONS) implement how liveness is proven.
 */
export interface LivenessStrategy {
  start(): void;
  stop(): void;
}
