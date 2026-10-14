import { describe, expect, it, vi } from 'vitest';
import {
  ReplacedTransactionError,
  RevertedTransactionError,
  requireSuccessfulReceipt,
  transactionFailureMessage,
  withGasSafetyMargin,
} from './transactions';

describe('gas estimate safety margin', () => {
  it('adds a ceiling-rounded 10% buffer without changing units', () => {
    expect(withGasSafetyMargin(100_000n)).toBe(110_000n);
    expect(withGasSafetyMargin(101n)).toBe(112n);
  });

  it('rejects missing or invalid estimates', () => {
    expect(() => withGasSafetyMargin(0n)).toThrow(/positive/);
    expect(() => withGasSafetyMargin(-1n)).toThrow(/positive/);
  });
});

describe('transaction receipt validation', () => {
  it('accepts only successful receipts', async () => {
    const wait = vi.fn(async () => ({ status: 'success' }));

    await expect(requireSuccessfulReceipt(() => wait())).resolves.toEqual({ status: 'success' });
    expect(wait).toHaveBeenCalledOnce();
  });

  it('rejects reverted receipts so callers cannot commit local state', async () => {
    const clearQueuedActions = vi.fn();
    await expect(
      requireSuccessfulReceipt(async () => ({ status: 'reverted' })).then(clearQueuedActions),
    ).rejects.toBeInstanceOf(RevertedTransactionError);
    expect(clearQueuedActions).not.toHaveBeenCalled();
    expect(transactionFailureMessage(new RevertedTransactionError(), 'Save Progress')).toMatch(
      /reverted onchain.*local progress is preserved/i,
    );
  });

  it('treats user rejection as unconfirmed and retryable', async () => {
    const rejected = Object.assign(new Error('User rejected request'), {
      name: 'UserRejectedRequestError',
    });
    await expect(requireSuccessfulReceipt(async () => Promise.reject(rejected))).rejects.toBe(
      rejected,
    );
    expect(transactionFailureMessage(rejected, 'Island start')).toMatch(
      /rejected in your wallet.*nothing was confirmed/i,
    );
  });

  it('preserves uncertainty on an interrupted receipt wait', async () => {
    const timeout = Object.assign(new Error('Receipt wait timed out'), { name: 'TimeoutError' });
    await expect(requireSuccessfulReceipt(async () => Promise.reject(timeout))).rejects.toBe(
      timeout,
    );
    expect(transactionFailureMessage(timeout, 'Puzzle save')).toMatch(
      /may still be pending.*before retrying/i,
    );
  });

  it.each(['cancelled', 'replaced'] as const)(
    'does not confirm a transaction replaced as %s',
    async (reason) => {
      await expect(
        requireSuccessfulReceipt(async (onReplaced) => {
          onReplaced(reason);
          return { status: 'success' };
        }),
      ).rejects.toMatchObject<Partial<ReplacedTransactionError>>({ reason });
    },
  );

  it('accepts a repriced replacement only when its receipt succeeds', async () => {
    await expect(
      requireSuccessfulReceipt(async (onReplaced) => {
        onReplaced('repriced');
        return { status: 'success' };
      }),
    ).resolves.toEqual({ status: 'success' });
    await expect(
      requireSuccessfulReceipt(async (onReplaced) => {
        onReplaced('repriced');
        return { status: 'reverted' };
      }),
    ).rejects.toBeInstanceOf(RevertedTransactionError);
  });
});
