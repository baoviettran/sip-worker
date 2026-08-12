import { defineTransportContract } from '../../../test/compatibility/transport-contract.js';
import { createBrowserTransportHarness } from './support/browser-transport-harness.js';

defineTransportContract('browser WebSocket', createBrowserTransportHarness);