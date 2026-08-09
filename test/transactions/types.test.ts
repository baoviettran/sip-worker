import { describe, expect, it } from 'vitest';
import type { TransactionKey } from '../../src/transactions/types.js';

const validTransactionKey: TransactionKey = 'branch|example.com:5060|INVITE';

// @ts-expect-error TransactionKey requires branch, sent-by, and method components.
const invalidTransactionKey: TransactionKey = 'branch|INVITE';

describe('TransactionKey type', () => {
  it('represents the current three-component runtime shape', () => {
    expect(validTransactionKey.split('|')).toHaveLength(3);
    expect(invalidTransactionKey.split('|')).toHaveLength(2);
  });
});
