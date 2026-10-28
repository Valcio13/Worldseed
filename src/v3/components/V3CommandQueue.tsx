/**
 * V3 Command Queue Component
 *
 * Displays pending, confirmed, uncertain, and failed commands.
 */

import type { V3CommandQueueState, V3Command } from '../types';

interface V3CommandQueueProps {
  queueState: V3CommandQueueState;
  onRetry?: (commandId: string) => void;
  onRecover?: () => void;
  onClear?: () => void;
  onDiscardQueuedHeartClicks?: () => void;
}

const COMMAND_TYPE_LABELS: Record<string, string> = {
  'heart-click': 'Heart Click',
  sync: 'Sync',
  'buy-habitat': 'Buy Habitat',
  'buy-temporary-upgrade': 'Buy Upgrade',
};

function formatTime(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;

  if (diff < 60000) return 'Just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return new Date(timestamp).toLocaleDateString();
}

function getCommandTypeLabel(payload: V3Command['payload']): string {
  const label = COMMAND_TYPE_LABELS[payload.type];
  if (payload.type === 'heart-click' && payload.quantity && payload.quantity > 1)
    return `${label} ×${payload.quantity}`;
  return label || payload.type;
}

export function V3CommandQueue({
  queueState,
  onRetry,
  onRecover,
  onClear,
  onDiscardQueuedHeartClicks,
}: V3CommandQueueProps) {
  const {
    commands,
    isSubmitting,
    pendingCount = 0,
    confirmedCount = 0,
    failedCount = 0,
  } = queueState;

  if (commands.length === 0 && queueState.queuedHeartClicks === 0) {
    return (
      <div className="v3-command-queue v3-command-queue--empty" aria-label="Command queue">
        <div className="v3-queue-empty">
          <span>No commands in queue</span>
          <small>Your gameplay actions will appear here</small>
        </div>
        {queueState.recoveryError && (
          <p className="v3-error-text" role="alert">
            {queueState.recoveryError}
          </p>
        )}
        {onRecover && (
          <button
            type="button"
            className="v3-queue-clear"
            onClick={onRecover}
            disabled={queueState.recoveringCursor}
          >
            {queueState.recoveringCursor ? 'Recovering run…' : 'Recover run cursor'}
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="v3-command-queue" aria-label="Command queue">
      <div className="v3-queue-header">
        <h3>Command Queue</h3>
        <div className="v3-queue-stats">
          {pendingCount > 0 && (
            <span className="v3-stat v3-stat--pending">{pendingCount} pending</span>
          )}
          {confirmedCount > 0 && (
            <span className="v3-stat v3-stat--confirmed">{confirmedCount} confirmed</span>
          )}
          {failedCount > 0 && <span className="v3-stat v3-stat--failed">{failedCount} failed</span>}
        </div>
      </div>

      {queueState.recoveryError && (
        <p className="v3-error-text" role="alert">
          {queueState.recoveryError}
        </p>
      )}
      {queueState.queuedHeartClicks > 0 && (
        <div className="v3-queue-heart-backlog" role="status">
          {queueState.heartQueueBlocked
            ? `${queueState.queuedHeartClicks} Heart click${queueState.queuedHeartClicks === 1 ? '' : 's'} remain queued after a rejected command.`
            : `Sending ${queueState.queuedHeartClicks} queued Heart click${queueState.queuedHeartClicks === 1 ? '' : 's'} in order.`}
          {queueState.heartQueueBlocked && onDiscardQueuedHeartClicks && (
            <button type="button" onClick={onDiscardQueuedHeartClicks}>
              Discard queued clicks
            </button>
          )}
        </div>
      )}
      {onRecover && (
        <button
          type="button"
          className="v3-queue-clear"
          onClick={onRecover}
          disabled={queueState.recoveringCursor}
        >
          {queueState.recoveringCursor ? 'Recovering run…' : 'Recover run cursor'}
        </button>
      )}

      {isSubmitting && (
        <div className="v3-queue-submitting">
          <span className="v3-spinner" aria-hidden="true" />
          <span>Submitting command...</span>
        </div>
      )}

      <ul className="v3-queue-list" role="list">
        {commands.map((command) => (
          <CommandItem key={command.commandId} command={command} onRetry={onRetry} />
        ))}
      </ul>

      {(confirmedCount > 0 || failedCount > 0) && onClear && (
        <button type="button" className="v3-queue-clear" onClick={onClear}>
          Clear completed
        </button>
      )}
    </div>
  );
}

interface CommandItemProps {
  command: V3Command;
  onRetry?: (commandId: string) => void;
}

function CommandItem({ command, onRetry }: CommandItemProps) {
  const statusClass = `v3-command-item--${command.status}`;

  return (
    <li className={`v3-command-item ${statusClass}`}>
      <div className="v3-command-status">
        <span
          className={`v3-status-pip v3-status-pip--${command.status}`}
          aria-label={command.status}
        />
      </div>

      <div className="v3-command-info">
        <span className="v3-command-type">{getCommandTypeLabel(command.payload)}</span>
        <span className="v3-command-time">{formatTime(command.submittedAt)}</span>
      </div>

      {command.status === 'pending' && (
        <span className="v3-command-badge v3-command-badge--pending">Pending</span>
      )}

      {command.status === 'confirmed' && (
        <span className="v3-command-badge v3-command-badge--confirmed">✓ Confirmed</span>
      )}

      {command.status === 'uncertain' && (
        <div className="v3-command-error">
          <span className="v3-command-badge v3-command-badge--pending">Needs retry</span>
          {command.error && <span className="v3-error-text">{command.error}</span>}
          {onRetry && (
            <button
              type="button"
              className="v3-retry-button"
              onClick={() => onRetry(command.commandId)}
            >
              Retry same command
            </button>
          )}
        </div>
      )}

      {command.status === 'failed' && (
        <div className="v3-command-error">
          <span className="v3-command-badge v3-command-badge--failed">✗ Failed</span>
          {command.error && <span className="v3-error-text">{command.error}</span>}
        </div>
      )}
    </li>
  );
}
