export type TransactionReplacementReason = 'repriced' | 'cancelled' | 'replaced';

export class RevertedTransactionError extends Error {
  constructor() {
    super('The transaction receipt has reverted status.');
    this.name = 'RevertedTransactionError';
  }
}

export class ReplacedTransactionError extends Error {
  constructor(readonly reason: Exclude<TransactionReplacementReason, 'repriced'>) {
    super(`The transaction was ${reason} before confirmation.`);
    this.name = 'ReplacedTransactionError';
  }
}

/** Adds a 10% ceiling-rounded buffer to RPC gas estimates before passing them to an injected wallet.
 * Hemi Sepolia's rewarded-round estimate was 1.92% below measured gas on one seeded execution.
 * The modest buffer covers observed variation while keeping wallet prompts close to the estimate.
 */
export function withGasSafetyMargin(estimate: bigint): bigint {
  if (estimate <= 0n) throw new RangeError('Gas estimate must be positive.');
  return (estimate * 110n + 99n) / 100n;
}

/** Waits for a receipt and only resolves when the intended operation succeeded. */
export async function requireSuccessfulReceipt<T extends { status: string }>(
  waitForReceipt: (onReplaced: (reason: TransactionReplacementReason) => void) => Promise<T>,
): Promise<T> {
  let replacementReason: TransactionReplacementReason | undefined;
  const receipt = await waitForReceipt((reason) => {
    replacementReason = reason;
  });

  if (replacementReason === 'cancelled' || replacementReason === 'replaced') {
    throw new ReplacedTransactionError(replacementReason);
  }
  if (receipt.status !== 'success') throw new RevertedTransactionError();

  return receipt;
}

function hasError(error: unknown, predicate: (candidate: Error) => boolean): boolean {
  let current = error;
  for (let depth = 0; depth < 5; depth += 1) {
    if (!(current instanceof Error)) return false;
    if (predicate(current)) return true;
    current = 'cause' in current ? current.cause : undefined;
  }
  return false;
}

export function transactionFailureMessage(error: unknown, operation: string): string {
  if (error instanceof RevertedTransactionError) {
    return `${operation} reverted onchain. Your local progress is preserved; check the cause before retrying.`;
  }
  if (error instanceof ReplacedTransactionError) {
    return `${operation} was ${error.reason} before confirmation. Your local progress is preserved.`;
  }
  if (
    hasError(
      error,
      (candidate) =>
        candidate.name === 'UserRejectedRequestError' ||
        ('code' in candidate && candidate.code === 4001) ||
        /user rejected|user denied/i.test(candidate.message),
    )
  ) {
    return `${operation} was rejected in your wallet. Nothing was confirmed; your local progress is preserved.`;
  }
  if (hasError(error, (candidate) => /timeout/i.test(candidate.name))) {
    return `${operation} confirmation timed out. It may still be pending; check your wallet or the explorer before retrying. Your local progress is preserved.`;
  }
  return `Could not confirm ${operation}. Check your wallet and network, then check transaction status before retrying. Your local progress is preserved.`;
}
