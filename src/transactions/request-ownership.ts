import type { SipRequestMessage } from '../messages/message.js';
import { clientKey, type TransactionLayer } from './coordinator.js';
import type { TransactionKey, TransactionLayerEvent } from './types.js';

/**
 * Send a client request and install a subscription for the exact transaction
 * key returned by `sendRequest`. A temporary client-direction listener buffers
 * events emitted synchronously by `sendRequest`; once the returned key is known,
 * the same client-only subscription owns the operation.
 *
 * `install` runs before buffered events are replayed so a synchronous terminal
 * response can tear down the keyed listener without leaking it.
 */
export function sendOwnedRequest(
  layer: TransactionLayer,
  request: SipRequestMessage,
  install: (unsubscribe: () => void, key: TransactionKey) => void,
  listener: (event: TransactionLayerEvent) => void,
): void {
  const buffered: TransactionLayerEvent[] = [];
  const anticipatedKey = clientKey(request);
  const unsubscribeBuffer = layer.subscribeClient(anticipatedKey, (event) => buffered.push(event));

  let key = anticipatedKey;
  try {
    const transaction = layer.sendRequest(request);
    key = transaction.key;
  } catch (error) {
    unsubscribeBuffer();
    throw error;
  }

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
  const unsubscribe = (): void => {
    if (!active) return;
    active = false;
    unsubscribeKeyed();
  };

  unsubscribeBuffer();
  install(unsubscribe, key);
  for (const event of buffered) {
    deliver(event);
    if (!active) break;
  }
}
