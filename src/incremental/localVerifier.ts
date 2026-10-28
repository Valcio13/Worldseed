import {
  applyCanonicalCommand,
  createCanonicalRun,
  deserializeCanonicalRun,
  getCanonicalRulesVersion,
  scoreTierFromEarnedNature,
  seasonIdAtMilliseconds,
  serializeCanonicalRun,
  type CanonicalRunInput,
  type CanonicalRunState,
  type GameplayCommand,
  type RulesResult,
} from './versionedRules';
import { RULES_VERSION as V1_RULES_VERSION } from './rulesV1';
import {
  VerifierError,
  type AuthenticatedWalletSession,
  type CommandReceipt,
  type CommandRequest,
  type CommandReceiptWire,
  type RunCursor,
} from './verifierProtocol';

export interface WalletSessionAuthenticator {
  authenticate(sessionToken: string): Promise<AuthenticatedWalletSession | null>;
}

/** Must be backed by authoritative chain/run reads in a wallet-linked deployment. */
export interface RunAuthorityReader {
  getRunContext(
    session: AuthenticatedWalletSession,
    runId: string,
  ): Promise<{
    player: string;
    chainId: bigint;
    verifyingContract: string;
    active: boolean;
    currentSeasonId: number;
    /** Defaults to V1 for legacy/local authorities. */
    rulesVersion?: number;
    input: CanonicalRunInput;
  } | null>;
}

export interface VerifierClock {
  nowMilliseconds(): number;
}

export interface AcceptedCommandEvent {
  commandId: string;
  expectedSequence: number;
  sequence: number;
  command: GameplayCommand;
  serverTimeMs: number;
  stateAfter: string;
  creditedAtoms: string;
  spentAtoms: string;
}

export interface RunJournal {
  initialState: string;
  snapshotSequence: number;
  snapshotState: string;
  events: AcceptedCommandEvent[];
  headSequence: number;
}

/** Keep verifier CPU and D1 row reads bounded to at most this many commands per request. */
export const JOURNAL_SNAPSHOT_INTERVAL = 128;
export const MAX_JOURNAL_REPLAY_EVENTS = JOURNAL_SNAPSHOT_INTERVAL - 1;

export interface VerifierPersistence {
  read(runKey: string): Promise<RunJournal | null>;
  findCommand(runKey: string, commandId: string): Promise<AcceptedCommandEvent | null>;
  initializeIfAbsent(runKey: string, initialState: string): Promise<void>;
  /** Atomic unique constraints are required for sequence and commandId in a durable adapter. */
  appendIfCurrentSequence(
    runKey: string,
    expectedSequence: number,
    event: AcceptedCommandEvent,
  ): Promise<'appended' | 'conflict'>;
}

export class MemoryVerifierPersistence implements VerifierPersistence {
  private readonly journals = new Map<string, RunJournal>();
  private readonly commandIndex = new Map<string, Map<string, AcceptedCommandEvent>>();

  async read(runKey: string): Promise<RunJournal | null> {
    const journal = this.journals.get(runKey);
    if (!journal) return null;
    return JSON.parse(JSON.stringify(journal)) as RunJournal;
  }

  async initializeIfAbsent(runKey: string, initialState: string): Promise<void> {
    if (!this.journals.has(runKey)) {
      this.journals.set(runKey, {
        initialState,
        snapshotSequence: 0,
        snapshotState: initialState,
        events: [],
        headSequence: 0,
      });
      this.commandIndex.set(runKey, new Map());
    }
  }

  async findCommand(runKey: string, commandId: string): Promise<AcceptedCommandEvent | null> {
    const event = this.commandIndex.get(runKey)?.get(commandId);
    return event ? (JSON.parse(JSON.stringify(event)) as AcceptedCommandEvent) : null;
  }

  async appendIfCurrentSequence(
    runKey: string,
    expectedSequence: number,
    event: AcceptedCommandEvent,
  ): Promise<'appended' | 'conflict'> {
    const journal = this.journals.get(runKey);
    if (
      !journal ||
      journal.headSequence !== expectedSequence ||
      event.sequence !== expectedSequence + 1
    )
      return 'conflict';
    if (
      journal.events.some(
        (item) => item.commandId === event.commandId || item.sequence === event.sequence,
      )
    )
      return 'conflict';
    const persisted = JSON.parse(JSON.stringify(event)) as AcceptedCommandEvent;
    journal.events.push(persisted);
    this.commandIndex.get(runKey)?.set(event.commandId, persisted);
    journal.headSequence = event.sequence;
    if (event.sequence % JOURNAL_SNAPSHOT_INTERVAL === 0) {
      journal.snapshotSequence = event.sequence;
      journal.snapshotState = event.stateAfter;
      journal.events = [];
    }
    return 'appended';
  }
}

export interface RecoveredRun {
  cursor: RunCursor;
  state: CanonicalRunState;
  scoreTier: number;
}

export function commandReceiptToWire(receipt: CommandReceipt): CommandReceiptWire {
  return {
    accepted: true,
    commandId: receipt.commandId,
    cursor: receipt.cursor,
    serverTimeMs: receipt.serverTimeMs,
    canonicalState: serializeCanonicalRun(receipt.state),
    creditedAtoms: receipt.creditedAtoms.toString(),
    spentAtoms: receipt.spentAtoms.toString(),
    scoreTier: receipt.scoreTier,
  };
}

function runKey(session: AuthenticatedWalletSession, runId: string): string {
  return `${session.chainId}:${session.verifyingContract.toLowerCase()}:${session.wallet.toLowerCase()}:${runId}`;
}

function sameCommand(left: GameplayCommand, right: GameplayCommand): boolean {
  const normalize = (command: GameplayCommand): string => {
    switch (command.type) {
      case 'heart-click':
      case 'sync':
        return JSON.stringify([command.type]);
      case 'buy-habitat':
        return JSON.stringify([command.type, command.habitat, command.quantity]);
      case 'buy-habitat-production-upgrade':
        return JSON.stringify([command.type, command.habitat, command.milestone]);
      case 'buy-temporary-upgrade':
        return JSON.stringify([command.type, command.upgrade]);
      default:
        return JSON.stringify(command);
    }
  };
  return normalize(left) === normalize(right);
}

function canonicalCommand(command: GameplayCommand): GameplayCommand {
  switch (command.type) {
    case 'heart-click':
    case 'sync':
      return { type: command.type };
    case 'buy-habitat':
      return { type: command.type, habitat: command.habitat, quantity: command.quantity };
    case 'buy-habitat-production-upgrade':
      return { type: command.type, habitat: command.habitat, milestone: command.milestone };
    case 'buy-temporary-upgrade':
      return { type: command.type, upgrade: command.upgrade };
    default:
      return command;
  }
}

/** Local-only verifier foundation. No signing, wallet transaction, or network server is included. */
export class LocalVerifier {
  constructor(
    private readonly auth: WalletSessionAuthenticator,
    private readonly authority: RunAuthorityReader,
    private readonly persistence: VerifierPersistence,
    private readonly clock: VerifierClock,
  ) {}

  async recover(sessionToken: string, runId: string): Promise<RecoveredRun> {
    const { session, authority, input } = await this.context(sessionToken, runId);
    const key = runKey(session, runId);
    const expectedInitial = serializeCanonicalRun(
      createCanonicalRun(this.rulesVersion(authority), input),
    );
    await this.persistence.initializeIfAbsent(key, expectedInitial);
    const { state } = await this.replay(key, expectedInitial);
    return {
      cursor: this.cursor(state),
      state,
      scoreTier: scoreTierFromEarnedNature(state.earnedNatureAtoms),
    };
  }

  async submit(request: CommandRequest): Promise<CommandReceipt> {
    this.validateRequest(request);
    const { session, authority } = await this.context(request.sessionToken, request.runId);
    const now = this.clock.nowMilliseconds();
    if (!Number.isSafeInteger(now) || now < 0)
      throw new VerifierError('RECOVERY_FAILED', 'Verifier clock is unavailable or invalid.');

    const key = runKey(session, request.runId);
    const expectedInitial = serializeCanonicalRun(
      createCanonicalRun(this.rulesVersion(authority), authority.input),
    );
    await this.persistence.initializeIfAbsent(key, expectedInitial);
    // CAS retry handles concurrent commands without trusting caller timing or sequence claims.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const { state } = await this.replay(key, expectedInitial);
      const prior = await this.persistence.findCommand(key, request.commandId);
      if (prior) {
        if (
          prior.expectedSequence !== request.expectedSequence ||
          !sameCommand(prior.command, request.command)
        )
          throw new VerifierError(
            'COMMAND_ID_CONFLICT',
            'This command ID was already used for different content.',
          );
        return this.receipt(prior, deserializeCanonicalRun(prior.stateAfter));
      }
      if (request.expectedSequence < state.sequence)
        throw new VerifierError(
          'STALE_CURSOR',
          'The command cursor is stale; recover the latest canonical state.',
          state.sequence,
          { cursor: this.cursor(state), canonicalState: serializeCanonicalRun(state) },
        );
      if (request.expectedSequence > state.sequence)
        throw new VerifierError(
          'SEQUENCE_GAP',
          'A command is missing; submit the next expected sequence.',
          state.sequence,
        );
      if (
        authority.currentSeasonId !== authority.input.seasonId ||
        seasonIdAtMilliseconds(now) !== authority.currentSeasonId
      )
        throw new VerifierError(
          'SEASON_EXPIRED',
          'The run season has ended or the verifier clock is outside the authoritative season.',
        );
      if (!authority.active)
        throw new VerifierError('RUN_NOT_ACTIVE', 'The on-chain run is not active.');

      let applied: RulesResult;
      try {
        applied = applyCanonicalCommand(state, request.command, now);
      } catch (error) {
        throw new VerifierError(
          error instanceof Error && error.name === 'RulesError'
            ? 'RULES_REJECTED'
            : 'RECOVERY_FAILED',
          error instanceof Error ? error.message : 'Canonical rules rejected the command.',
        );
      }
      const event: AcceptedCommandEvent = {
        commandId: request.commandId,
        expectedSequence: state.sequence,
        sequence: applied.state.sequence,
        command: canonicalCommand(request.command),
        serverTimeMs: now,
        stateAfter: serializeCanonicalRun(applied.state),
        creditedAtoms: applied.creditedAtoms.toString(),
        spentAtoms: applied.spentAtoms.toString(),
      };
      if (
        (await this.persistence.appendIfCurrentSequence(key, state.sequence, event)) === 'appended'
      )
        return this.receipt(event, applied.state);
    }
    throw new VerifierError(
      'PERSISTENCE_CONFLICT',
      'Concurrent updates prevented this command from being committed. Retry with the same command ID.',
    );
  }

  private async context(sessionToken: string, runId: string) {
    if (!sessionToken) throw new VerifierError('UNAUTHENTICATED', 'A wallet session is required.');
    const session = await this.auth.authenticate(sessionToken);
    if (!session)
      throw new VerifierError('UNAUTHENTICATED', 'Wallet session is invalid or expired.');
    if (!runId) throw new VerifierError('INVALID_REQUEST', 'Run ID is required.');
    if (session.runId !== runId)
      throw new VerifierError('WRONG_WALLET', 'Wallet session is scoped to a different run.');
    const authority = await this.authority.getRunContext(session, runId);
    if (!authority)
      throw new VerifierError('RUN_NOT_FOUND', 'No run exists for this authenticated wallet.');
    if (authority.player.toLowerCase() !== session.wallet.toLowerCase())
      throw new VerifierError('WRONG_WALLET', 'Run is not owned by the authenticated wallet.');
    if (
      authority.chainId !== session.chainId ||
      authority.verifyingContract.toLowerCase() !== session.verifyingContract.toLowerCase()
    )
      throw new VerifierError('WRONG_WALLET', 'Run belongs to a different chain or contract.');
    if (authority.input.runId !== runId)
      throw new VerifierError('WRONG_WALLET', 'Run context does not match the requested run.');
    if (
      authority.input.startedAtMs < 0 ||
      authority.input.seasonId !== seasonIdAtMilliseconds(authority.input.startedAtMs)
    )
      throw new VerifierError(
        'RECOVERY_FAILED',
        'The authoritative run start time and season ID disagree.',
      );
    return { session, authority, input: authority.input };
  }

  private async replay(
    runKeyValue: string,
    expectedInitial: string,
  ): Promise<{ journal: RunJournal; state: CanonicalRunState }> {
    const journal = await this.persistence.read(runKeyValue);
    if (!journal) throw new VerifierError('RECOVERY_FAILED', 'Run journal is missing.');
    let state: CanonicalRunState;
    try {
      if (journal.initialState !== expectedInitial)
        throw new Error('Initial state differs from authoritative run data.');
      if (
        !Number.isSafeInteger(journal.snapshotSequence) ||
        journal.snapshotSequence < 0 ||
        journal.snapshotSequence > journal.headSequence ||
        journal.events.length > MAX_JOURNAL_REPLAY_EVENTS
      )
        throw new Error('Journal snapshot or replay bound is invalid.');
      state = deserializeCanonicalRun(journal.snapshotState);
      if (state.sequence !== journal.snapshotSequence)
        throw new Error('Journal snapshot sequence does not match its state.');
      const seenCommandIds = new Set<string>();
      for (const event of journal.events) {
        if (
          !event.commandId ||
          seenCommandIds.has(event.commandId) ||
          event.sequence !== state.sequence + 1 ||
          event.expectedSequence !== state.sequence
        )
          throw new Error('Journal sequence is incomplete.');
        seenCommandIds.add(event.commandId);
        const result = applyCanonicalCommand(state, event.command, event.serverTimeMs);
        if (
          serializeCanonicalRun(result.state) !== event.stateAfter ||
          result.creditedAtoms.toString() !== event.creditedAtoms ||
          result.spentAtoms.toString() !== event.spentAtoms
        )
          throw new Error('Journal result does not match deterministic replay.');
        state = result.state;
      }
      if (journal.headSequence !== state.sequence)
        throw new Error('Journal head does not match replayed sequence.');
    } catch {
      throw new VerifierError(
        'RECOVERY_FAILED',
        'The command journal cannot be replayed; wallet-linked rewards are disabled for this run.',
      );
    }
    return { journal, state };
  }

  private receipt(event: AcceptedCommandEvent, state: CanonicalRunState): CommandReceipt {
    return {
      accepted: true,
      commandId: event.commandId,
      cursor: this.cursor(state),
      serverTimeMs: event.serverTimeMs,
      state,
      creditedAtoms: BigInt(event.creditedAtoms),
      spentAtoms: BigInt(event.spentAtoms),
      scoreTier: scoreTierFromEarnedNature(state.earnedNatureAtoms),
    };
  }

  private cursor(state: CanonicalRunState): RunCursor {
    return {
      runId: state.runId,
      sequence: state.sequence,
      rulesVersion: getCanonicalRulesVersion(state),
    };
  }

  private rulesVersion(authority: { rulesVersion?: number; input: CanonicalRunInput }): number {
    return authority.rulesVersion ?? V1_RULES_VERSION;
  }

  private validateRequest(request: CommandRequest): void {
    if (
      !request ||
      typeof request.sessionToken !== 'string' ||
      typeof request.runId !== 'string' ||
      typeof request.commandId !== 'string' ||
      request.commandId.length < 1 ||
      request.commandId.length > 128 ||
      !Number.isSafeInteger(request.expectedSequence) ||
      request.expectedSequence < 0
    )
      throw new VerifierError('INVALID_REQUEST', 'Command envelope is malformed.');
    // Deliberately ignore clientTimestampMs; it is not an authoritative input.
  }
}
