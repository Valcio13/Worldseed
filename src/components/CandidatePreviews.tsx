import type { CandidateSet, IslandCandidate } from '../expeditions/model';
import { getCandidatePreview } from '../expeditions/preview';

export function CandidatePreviews({
  candidateSet,
  onSelect,
  selectedSource,
  busy,
  contractReady = false,
}: {
  candidateSet: CandidateSet;
  onSelect: (candidate: IslandCandidate) => void;
  selectedSource?: string | null;
  busy?: boolean;
  contractReady?: boolean;
}) {
  return (
    <section className="candidate-set" aria-labelledby="candidate-set-title">
      <p className="eyebrow">THREE SOURCE TRANSACTIONS · NO FREE REROLLS</p>
      <h2 id="candidate-set-title">Choose your expedition island</h2>
      <p className="candidate-set__notice">
        Previews use island generator {candidateSet.islandGeneratorVersion}. Your selection is saved
        in D1
        {contractReady
          ? ' and then locked by the V2 expedition transaction'
          : '. Configure the V2 contract address to start an onchain expedition'}
        .
      </p>
      <div className="candidate-set__grid">
        {candidateSet.candidates.map((candidate) => {
          const preview = getCandidatePreview(candidate);
          return (
            <article className="candidate-card" key={candidate.source}>
              <div
                className="candidate-card__island"
                aria-label={`${candidate.sourceName} island preview`}
              >
                {preview.cells.map((cell, index) => (
                  <span
                    className={`candidate-cell candidate-cell--${cell.terrain}${cell.placeable ? ' is-placeable' : ''}${cell.witnessCell ? ' is-witness' : ''}`}
                    key={index}
                  />
                ))}
              </div>
              <h3>{candidate.sourceName}</h3>
              <p>{candidate.description}</p>
              <small>
                Block {candidate.transaction.blockNumber} · {candidate.transaction.confirmations}/
                {candidate.transaction.requiredConfirmations} confirmations
              </small>
              <button
                type="button"
                disabled={
                  busy ||
                  (Boolean(selectedSource) && selectedSource !== candidate.source) ||
                  (Boolean(selectedSource) && !contractReady)
                }
                onClick={() => onSelect(candidate)}
              >
                {selectedSource === candidate.source
                  ? contractReady
                    ? 'Start selected island'
                    : 'Selected for this expedition'
                  : selectedSource
                    ? 'Selection locked for this expedition'
                    : 'Choose this island'}
              </button>
            </article>
          );
        })}
      </div>
    </section>
  );
}
