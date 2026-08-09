import type { SipRequestMessage } from '../messages/message.js';
import type { TransactionLayer } from './coordinator.js';
import type { TransactionKey, TransactionLayerEvent } from './types.js';

function eventKey(event: TransactionLayerEvent): TransactionKey | undefined {
  switch (event.type) {
    case 'response':
    case 'request':
      return event.transaction.key;
    case 'timeout':
    case 'transportError':
    case 'terminated':
      return event.key;
    default:
      return undefined;
  }
}

/**
 * Send a client request and install a subscription for the exact transaction
 * key returned by `sendRequest`. A temporary global listener buffers events
 * emitted synchronously by `sendRequest`; once the returned key is known, only
 * events carrying that key are replayed to the operation listener.
 *
 * `install` runs before buffered events are replayed so a synchronous terminal
 * response can tear down the keyed listener without leaking it.
 */
export function sendOwnedRequest(
  layer: TransactionLayer,
  request: SipRequestMessage,
  install: (unsubscribe: () => void) => void,
  listener: (event: TransactionLayerEvent) => void,
): void {
  const buffered: TransactionLayerEvent[] = [];
  const unsubscribeBuffer = layer.subscribe((event) => buffered.push(event));

  let key: TransactionKey;
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
  const unsubscribeKeyed = layer.subscribe(key, deliver);
  const unsubscribe = (): void => {
    if (!active) return;
    active = false;
    unsubscribeKeyed();
  };

  unsubscribeBuffer();
  install(unsubscribe);
  for (const event of buffered) {
    if (eventKey(event) !== key) continue;
    deliver(event);
    if (!active) break;
  }
}
