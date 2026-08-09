import type { SipRequestMessage } from '../messages/message.js';
import { clientKey, type TransactionLayer } from './coordinator.js';
import type { TransactionKey, TransactionLayerEvent } from './types.js';

/**
 * Send a client request and install a subscription for the exact transaction
 * key returned by `sendRequest`. A temporary client-direction listener buffers
 * events emitted synchronously by `sendRequest`; once the returned key is known,
 * the same client-only subscription owns the operation.
 *
 * The installed disposer detaches the listener and terminates the underlying
 * client transaction, stopping transaction-owned timers and retransmissions.
 * It is installed before buffered events replay so synchronous teardown is safe.
 */
export function sendOwnedRequest(
  layer: TransactionLayer,
  request: SipRequestMessage,
  install: (dispose: () => void, key: TransactionKey) => void,
  listener: (event: TransactionLayerEvent) => void,
): void {
  const buffered: TransactionLayerEvent[] = [];
  const anticipatedKey = clientKey(request);
  const unsubscribeBuffer = layer.subscribeClient(anticipatedKey, (event) => buffered.push(event));

  let transaction: ReturnType<TransactionLayer['sendRequest']>;
  try {
    transaction = layer.sendRequest(request);
  } catch (error) {
    unsubscribeBuffer();
    throw error;
  }

  const key = transaction.key;
  let active = true;
  const deliver = (event: TransactionLayerEvent): void => {
    if (!active) return;
    try {
      listener(event);
    } catch {
      // Match TransactionLayer subscriber isolation during buffered replay.
    }
  };
  const unsubscribeKeyed = layer.subscribeClient(key, deliver);
  const dispose = (): void => {
    if (active) {
      active = false;
      unsubscribeKeyed();
    }
    transaction.terminate();
  };

  unsubscribeBuffer();
  install(dispose, key);
  for (const event of buffered) {
    deliver(event);
    if (!active) break;
  }
}
