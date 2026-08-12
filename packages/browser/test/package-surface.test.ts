import { expect, it } from 'vitest';
import { SipError as BrowserError, BrowserWebSocketTransport } from '../src/index.js';
import { SipError as CoreError } from '@sip-worker/core';

it('re-exports the shared core class and owns the browser adapter', () => {
  expect(BrowserError).toBe(CoreError);
  expect(BrowserWebSocketTransport).toBeTypeOf('function');
});