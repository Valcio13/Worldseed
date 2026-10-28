// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Standalone V3 settlement contract. V1 and V2 are intentionally untouched.
/// @dev Rewards are provisional rules version 1, not approved game balancing.
contract WorldseedGameV3 {
    uint64 public constant WEEK_SECONDS = 604_800;
    uint64 public constant EPOCH_MONDAY_SECONDS = 345_600;
    uint64 public constant MAX_ATTESTATION_LIFETIME = 300;
    uint64 public constant ADMIN_DELAY = 2 days;
    uint16 public constant MAX_SCORE_TIER = type(uint16).max;
    uint16 public constant MAX_UPGRADE_LEVEL = 100;
    uint16 public constant V1_REBIRTH_THRESHOLD_TIER = 35;
    uint16 public constant V2_REBIRTH_THRESHOLD_TIER = 42;
    uint16 public constant CP_MILESTONE_STEP = 7;
    uint256 public constant MAX_SEASON_POINTS = 1_000_000;

    bytes32 private constant DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );
    bytes32 private constant NAME_HASH = keccak256("Worldseed V3");
    bytes32 private constant VERSION_HASH = keccak256("1");
    bytes32 private constant ATTESTATION_TYPEHASH = keccak256(
        "ScoreAttestation(address player,uint64 runId,uint64 seasonId,uint256 chainId,address verifyingContract,uint16 scoreTier,uint256 natureCollectedAtoms,uint64 nonce,uint64 issuedAt,uint64 expiresAt,uint32 rulesVersion,uint32 signerEpoch,bytes32 upgradeChoicesHash,uint8 actionType)"
    );
    // secp256k1n / 2; rejects malleable signatures.
    uint256 private constant SECP256K1_HALF_N =
        0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;

    enum ActionType {
        NONE,
        START_RUN,
        RECORD_POINTS,
        REBIRTH
    }

    // Values 0..4 are consumed by the verifier reader; Active is 1.
    enum RunStatus {
        NONE,
        ACTIVE,
        REBORN,
        EXPIRED,
        ABANDONED
    }

    struct ScoreAttestation {
        address player;
        uint64 runId;
        uint64 seasonId;
        uint256 chainId;
        address verifyingContract;
        uint16 scoreTier;
        uint256 natureCollectedAtoms;
        uint64 nonce;
        uint64 issuedAt;
        uint64 expiresAt;
        uint32 rulesVersion;
        uint32 signerEpoch;
        bytes32 upgradeChoicesHash;
        ActionType actionType;
    }

    struct UpgradeChoice {
        uint8 upgradeId;
        uint16 quantity;
    }

    // Append-only reward configuration. CP is awarded at seasonal score milestones.
    struct RewardRules {
        uint16 rebirthThresholdTier;
        uint16 ppStep;
        uint16 ppPerRebirthCap;
        uint32 ppBase;
        uint32 seasonPPCap;
        uint32 seasonCPCap;
        uint16 maxUpgradeLevel;
        uint16 cpMilestoneStep;
    }

    // Field order intentionally matches V3_READ_ABI.runs.
    struct Run {
        uint64 seasonId;
        RunStatus status;
        uint64 startedAt;
        uint16 lastRecordedScoreTier;
        uint32 rulesVersion;
        bytes32 upgradeChoicesHash;
    }

    struct PendingRules {
        RewardRules rules;
        uint64 activatesAt;
    }

    address public owner;
    address public pendingOwner;
    address public attester;
    address public pendingAttester;
    uint64 public pendingAttesterActivationTime;
    uint32 public signerEpoch = 1;
    bool public paused;

    uint32 public activeRulesVersion = 3;
    mapping(uint32 => RewardRules) public rewardRules;
    mapping(uint32 => PendingRules) private pendingRules;

    mapping(address => uint64) public nextRunId;
    mapping(address => uint64) public activeRunId;
    mapping(address => mapping(uint64 => Run)) public runs;
    mapping(address => uint64) public attestationNonce;
    mapping(address => mapping(uint64 => uint256)) public seasonalPP;
    mapping(address => mapping(uint64 => uint256)) public seasonalCP;
    mapping(address => mapping(uint64 => uint16)) public seasonalHighScoreTier;
    mapping(address => uint256) public lifetimeCP;
    mapping(address => uint256) public lifetimeNatureCollectedAtoms;
    mapping(address => uint256) public totalAccumulatedRebirthScore;
    mapping(address => mapping(uint64 => uint256)) public seasonalAccumulatedRebirthScore;
    mapping(uint64 => uint256) public totalSeasonCP;
    mapping(address => mapping(uint64 => uint32)) public seasonalRebirths;
    mapping(address => mapping(uint64 => mapping(uint8 => uint16))) public seasonalUpgradeLevel;

    event OwnershipTransferStarted(address indexed owner, address indexed pendingOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event AttesterProposed(address indexed previousAttester, address indexed proposedAttester, uint64 activatesAt);
    event AttesterProposalCancelled(address indexed cancelledAttester);
    event AttesterChanged(address indexed previousAttester, address indexed newAttester, uint32 signerEpoch);
    event PauseChanged(bool paused);
    event RewardRulesProposed(uint32 indexed rulesVersion, uint64 activatesAt);
    event RewardRulesActivated(uint32 indexed rulesVersion);
    event RunStarted(
        address indexed player,
        uint64 indexed runId,
        uint64 indexed seasonId,
        uint32 rulesVersion,
        bytes32 upgradeChoicesHash,
        uint64 startedAt,
        UpgradeChoice[] upgradeChoices
    );
    event PointsRecorded(address indexed player, uint64 indexed runId, uint16 scoreTier, uint64 nonce);
    event RebirthSettled(
        address indexed player,
        uint64 indexed runId,
        uint64 indexed seasonId,
        uint16 scoreTier,
        uint256 ppAwarded,
        uint256 cpAwarded,
        uint64 nonce,
        uint32 rulesVersion,
        uint256 natureCollectedAtoms
    );
    event RunAbandoned(address indexed player, uint64 indexed runId, uint64 indexed seasonId);
    event RunExpired(address indexed player, uint64 indexed runId, uint64 indexed seasonId);

    error Unauthorized();
    error InvalidAddress();
    error Paused();
    error InvalidAttestation();
    error InvalidSignature();
    error InvalidRun();
    error InvalidRunStatus();
    error SeasonExpired();
    error InvalidSeasonTimestamp();
    error NonceMismatch();
    error ScoreNotIncreasing();
    error ScoreBelowThreshold();
    error InvalidUpgradeChoices();
    error InsufficientPP();
    error UpgradeLevelExceeded();
    error CounterOverflow();
    error RulesVersionInvalid();
    error DelayNotElapsed();

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    constructor(address owner_, address attester_) {
        if (owner_ == address(0) || attester_ == address(0) || owner_ == attester_)
            revert InvalidAddress();
        owner = owner_;
        attester = attester_;
        // Contest rules v1: tier 35 unlocks Rebirth; PP retains its existing score formula.
        rewardRules[1] = RewardRules({
            rebirthThresholdTier: V1_REBIRTH_THRESHOLD_TIER,
            ppStep: 10,
            ppPerRebirthCap: 1_000,
            ppBase: 1,
            seasonPPCap: 100_000,
            seasonCPCap: 100_000,
            maxUpgradeLevel: MAX_UPGRADE_LEVEL,
            cpMilestoneStep: CP_MILESTONE_STEP
        });
        rewardRules[3] = RewardRules({
            rebirthThresholdTier: V2_REBIRTH_THRESHOLD_TIER,
            ppStep: 10,
            ppPerRebirthCap: 1_000,
            ppBase: 1,
            seasonPPCap: 100_000,
            seasonCPCap: 100_000,
            maxUpgradeLevel: MAX_UPGRADE_LEVEL,
            cpMilestoneStep: CP_MILESTONE_STEP
        });
    }

    function currentSeasonId() public view returns (uint64) {
        return _seasonId(block.timestamp);
    }

    function seasonStart(uint64 seasonId) public pure returns (uint64) {
        uint256 value = uint256(EPOCH_MONDAY_SECONDS) + uint256(seasonId) * WEEK_SECONDS;
        if (value > type(uint64).max) revert CounterOverflow();
        return uint64(value);
    }

    function seasonEnd(uint64 seasonId) public pure returns (uint64) {
        uint256 value = uint256(EPOCH_MONDAY_SECONDS) + (uint256(seasonId) + 1) * WEEK_SECONDS;
        if (value > type(uint64).max) revert CounterOverflow();
        return uint64(value);
    }

    /// @notice Pure counterpart of the Monday-UTC season formula, exposed for shared vectors.
    function seasonIdAt(uint64 timestamp) external pure returns (uint64) {
        return _seasonId(timestamp);
    }

    /// @notice Exactly keccak256(abi.encode(UpgradeChoice[])) used by the TypeScript verifier.
    function hashUpgradeChoices(UpgradeChoice[] calldata choices) external pure returns (bytes32) {
        return keccak256(abi.encode(choices));
    }

    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this)));
    }

    function hashAttestation(ScoreAttestation calldata a) public view returns (bytes32) {
        // ScoreAttestation is a static tuple, so ABI-encoding it after the type hash
        // is byte-for-byte equivalent to encoding each field individually, with less
        // compiler stack pressure as the signed schema grows.
        bytes32 structHash = keccak256(abi.encode(ATTESTATION_TYPEHASH, a));
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    /// @notice Starts one run and atomically charges/apply the committed PP upgrade choices.
    function startRun(
        ScoreAttestation calldata a,
        UpgradeChoice[] calldata choices,
        bytes calldata signature
    ) external whenNotPaused {
        if (msg.sender != a.player) revert Unauthorized();
        uint64 seasonId = currentSeasonId();
        if (a.seasonId != seasonId || a.actionType != ActionType.START_RUN || a.scoreTier != 0)
            revert InvalidAttestation();
        if (activeRulesVersion == 0 || a.rulesVersion != activeRulesVersion) revert RulesVersionInvalid();
        if (nextRunId[msg.sender] == type(uint64).max) revert CounterOverflow();
        uint64 runId = nextRunId[msg.sender] + 1;
        if (a.runId != runId) revert InvalidRun();
        (bytes32 choicesHash, uint256 choiceCost) = _validateChoices(choices, a.seasonId, a.rulesVersion);
        if (a.upgradeChoicesHash != choicesHash) revert InvalidUpgradeChoices();
        _validateAttestation(a, ActionType.START_RUN, runId, seasonId, 0, choicesHash);
        _verifySignature(a, signature);

        uint64 previousId = activeRunId[msg.sender];
        if (previousId != 0) {
            Run storage previous = runs[msg.sender][previousId];
            if (previous.status != RunStatus.ACTIVE) revert InvalidRunStatus();
            if (previous.seasonId == seasonId) revert InvalidRunStatus();
            previous.status = RunStatus.EXPIRED;
            emit RunExpired(msg.sender, previousId, previous.seasonId);
            activeRunId[msg.sender] = 0;
        }

        _consumeNonce(msg.sender, a.nonce);
        seasonalPP[msg.sender][seasonId] -= choiceCost;
        for (uint256 i = 0; i < choices.length; i++) {
            UpgradeChoice calldata choice = choices[i];
            seasonalUpgradeLevel[msg.sender][seasonId][choice.upgradeId] += choice.quantity;
        }
        nextRunId[msg.sender] = runId;
        activeRunId[msg.sender] = runId;
        runs[msg.sender][runId] = Run({
            seasonId: seasonId,
            status: RunStatus.ACTIVE,
            startedAt: uint64(block.timestamp),
            lastRecordedScoreTier: 0,
            rulesVersion: a.rulesVersion,
            upgradeChoicesHash: choicesHash
        });
        emit RunStarted(msg.sender, runId, seasonId, a.rulesVersion, choicesHash, uint64(block.timestamp), choices);
    }

    /// @notice Monotonic checkpoint only; it never credits PP or CP.
    function recordPoints(ScoreAttestation calldata a, bytes calldata signature) external whenNotPaused {
        if (msg.sender != a.player) revert Unauthorized();
        Run storage run = _activeRun(msg.sender, a.runId);
        if (a.seasonId != run.seasonId || a.rulesVersion != run.rulesVersion) revert InvalidAttestation();
        if (a.scoreTier <= run.lastRecordedScoreTier) revert ScoreNotIncreasing();
        _validateAttestation(a, ActionType.RECORD_POINTS, a.runId, run.seasonId, a.scoreTier, bytes32(0));
        _verifySignature(a, signature);
        _consumeNonce(msg.sender, a.nonce);
        run.lastRecordedScoreTier = a.scoreTier;
        emit PointsRecorded(msg.sender, a.runId, a.scoreTier, a.nonce);
    }

    /// @notice Settles latest verifier score without requiring a prior checkpoint transaction.
    function rebirth(ScoreAttestation calldata a, bytes calldata signature) external whenNotPaused {
        if (msg.sender != a.player) revert Unauthorized();
        Run storage run = _activeRun(msg.sender, a.runId);
        if (a.seasonId != run.seasonId || a.rulesVersion != run.rulesVersion) revert InvalidAttestation();
        if (a.scoreTier < run.lastRecordedScoreTier) revert InvalidAttestation();
        RewardRules memory rules = rewardRules[run.rulesVersion];
        if (a.scoreTier < rules.rebirthThresholdTier) revert ScoreBelowThreshold();
        _validateAttestation(a, ActionType.REBIRTH, a.runId, run.seasonId, a.scoreTier, bytes32(0));
        _verifySignature(a, signature);

        _consumeNonce(msg.sender, a.nonce);
        run.status = RunStatus.REBORN;
        activeRunId[msg.sender] = 0;
        _settleRebirth(a, rules);
    }

    /// @notice Explicitly forfeits the active run. It remains available while paused.
    function abandonRun(uint64 runId) external {
        Run storage run = runs[msg.sender][runId];
        if (activeRunId[msg.sender] != runId || run.status != RunStatus.ACTIVE) revert InvalidRunStatus();
        activeRunId[msg.sender] = 0;
        if (run.seasonId == currentSeasonId()) {
            run.status = RunStatus.ABANDONED;
            emit RunAbandoned(msg.sender, runId, run.seasonId);
        } else {
            run.status = RunStatus.EXPIRED;
            emit RunExpired(msg.sender, runId, run.seasonId);
        }
    }

    function pause() external onlyOwner {
        if (!paused) {
            paused = true;
            emit PauseChanged(true);
        }
    }

    function unpause() external onlyOwner {
        if (paused) {
            paused = false;
            emit PauseChanged(false);
        }
    }

    function proposeAttester(address proposed) external onlyOwner {
        if (
            proposed == address(0) || proposed == owner || proposed == attester || proposed == pendingOwner
        ) revert InvalidAddress();
        if (block.timestamp + ADMIN_DELAY > type(uint64).max) revert CounterOverflow();
        pendingAttester = proposed;
        pendingAttesterActivationTime = uint64(block.timestamp + ADMIN_DELAY);
        emit AttesterProposed(attester, proposed, pendingAttesterActivationTime);
    }

    function cancelAttesterProposal() external onlyOwner {
        address cancelled = pendingAttester;
        pendingAttester = address(0);
        pendingAttesterActivationTime = 0;
        emit AttesterProposalCancelled(cancelled);
    }

    function acceptAttester() external {
        if (msg.sender != pendingAttester || msg.sender == owner) revert Unauthorized();
        if (block.timestamp < pendingAttesterActivationTime) revert DelayNotElapsed();
        if (signerEpoch == type(uint32).max) revert CounterOverflow();
        address old = attester;
        attester = msg.sender;
        pendingAttester = address(0);
        pendingAttesterActivationTime = 0;
        signerEpoch += 1;
        emit AttesterChanged(old, msg.sender, signerEpoch);
    }

    function proposeOwnershipTransfer(address proposed) external onlyOwner {
        if (proposed == address(0) || proposed == attester || proposed == pendingAttester) revert InvalidAddress();
        pendingOwner = proposed;
        emit OwnershipTransferStarted(owner, proposed);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner || msg.sender == attester) revert Unauthorized();
        address old = owner;
        owner = msg.sender;
        pendingOwner = address(0);
        emit OwnershipTransferred(old, msg.sender);
    }

    function proposeRewardRules(uint32 version, RewardRules calldata rules) external onlyOwner {
        if (
            version <= activeRulesVersion || version == 0 || pendingRules[version].activatesAt != 0 ||
            rules.rebirthThresholdTier == 0 || rules.ppStep == 0 ||
            rules.ppPerRebirthCap == 0 || rules.seasonPPCap == 0 ||
            rules.seasonCPCap == 0 || rules.maxUpgradeLevel > MAX_UPGRADE_LEVEL ||
            rules.cpMilestoneStep != CP_MILESTONE_STEP || rules.ppBase > rules.ppPerRebirthCap ||
            rules.seasonPPCap > MAX_SEASON_POINTS || rules.seasonCPCap > MAX_SEASON_POINTS ||
            rules.seasonPPCap > rewardRules[activeRulesVersion].seasonPPCap ||
            rules.seasonCPCap > rewardRules[activeRulesVersion].seasonCPCap ||
            (version == 2 && rules.rebirthThresholdTier != V2_REBIRTH_THRESHOLD_TIER)
        ) revert RulesVersionInvalid();
        if (block.timestamp + ADMIN_DELAY > type(uint64).max) revert CounterOverflow();
        pendingRules[version] = PendingRules(rules, uint64(block.timestamp + ADMIN_DELAY));
        emit RewardRulesProposed(version, uint64(block.timestamp + ADMIN_DELAY));
    }

    function activateRewardRules(uint32 version) external onlyOwner {
        PendingRules memory pending = pendingRules[version];
        if (pending.activatesAt == 0 || block.timestamp < pending.activatesAt || version <= activeRulesVersion)
            revert DelayNotElapsed();
        rewardRules[version] = pending.rules;
        activeRulesVersion = version;
        delete pendingRules[version];
        emit RewardRulesActivated(version);
    }

    function _seasonId(uint256 timestamp) private pure returns (uint64) {
        if (timestamp < EPOCH_MONDAY_SECONDS) revert InvalidSeasonTimestamp();
        uint256 id = (timestamp - EPOCH_MONDAY_SECONDS) / WEEK_SECONDS;
        if (id > type(uint64).max) revert CounterOverflow();
        return uint64(id);
    }

    function _activeRun(address player, uint64 runId) private view returns (Run storage run) {
        if (runId == 0 || activeRunId[player] != runId) revert InvalidRun();
        run = runs[player][runId];
        if (run.status != RunStatus.ACTIVE) revert InvalidRunStatus();
        if (run.seasonId != currentSeasonId()) revert SeasonExpired();
    }

    function _validateAttestation(
        ScoreAttestation calldata a,
        ActionType action,
        uint64 runId,
        uint64 seasonId,
        uint16 score,
        bytes32 commitment
    ) private view {
        if (
            a.player == address(0) || a.player != msg.sender || a.runId != runId || a.seasonId != seasonId ||
            a.chainId != block.chainid || a.verifyingContract != address(this) || a.scoreTier != score ||
            a.actionType != action || a.rulesVersion == 0 || a.signerEpoch != signerEpoch ||
            a.upgradeChoicesHash != commitment || seasonId != currentSeasonId() ||
            (action != ActionType.REBIRTH && a.natureCollectedAtoms != 0)
        ) revert InvalidAttestation();
        uint64 end = seasonEnd(seasonId);
        if (
            a.issuedAt < seasonStart(seasonId) || a.issuedAt > block.timestamp ||
            a.expiresAt <= block.timestamp || a.expiresAt <= a.issuedAt ||
            a.expiresAt > end || a.expiresAt - a.issuedAt > MAX_ATTESTATION_LIFETIME
        ) revert SeasonExpired();
        if (a.nonce != attestationNonce[msg.sender]) revert NonceMismatch();
    }

    function _verifySignature(ScoreAttestation calldata a, bytes calldata signature) private view {
        if (_recover(hashAttestation(a), signature) != attester) revert InvalidSignature();
    }

    function _recover(bytes32 digest, bytes calldata signature) private pure returns (address recovered) {
        if (signature.length != 65) revert InvalidSignature();
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        if (uint256(s) > SECP256K1_HALF_N || (v != 27 && v != 28)) revert InvalidSignature();
        recovered = ecrecover(digest, v, r, s);
        if (recovered == address(0)) revert InvalidSignature();
    }

    function _consumeNonce(address player, uint64 nonce) private {
        if (nonce != attestationNonce[player] || nonce == type(uint64).max) revert NonceMismatch();
        attestationNonce[player] = nonce + 1;
    }

    function _settleRebirth(ScoreAttestation calldata a, RewardRules memory rules) private {
        address player = a.player;
        uint64 runId = a.runId;
        uint64 seasonId = a.seasonId;
        uint16 scoreTier = a.scoreTier;
        uint32 rulesVersion = a.rulesVersion;
        uint64 nonce = a.nonce;
        uint16 previousHighScore = seasonalHighScoreTier[player][seasonId];
        uint256 ppReward = _reward(
            rules.ppBase,
            scoreTier - rules.rebirthThresholdTier,
            rules.ppStep,
            rules.ppPerRebirthCap
        );
        uint256 ppBalance = seasonalPP[player][seasonId];
        uint256 ppRemaining = ppBalance < rules.seasonPPCap ? rules.seasonPPCap - ppBalance : 0;
        if (ppReward > ppRemaining) ppReward = ppRemaining;

        uint256 milestoneBase = previousHighScore > rules.rebirthThresholdTier
            ? previousHighScore
            : rules.rebirthThresholdTier;
        uint256 cpReward;
        if (scoreTier > milestoneBase) {
            cpReward = uint256(scoreTier) / rules.cpMilestoneStep - milestoneBase / rules.cpMilestoneStep;
        }
        cpReward = _capCPReward(player, seasonId, cpReward, rules.seasonCPCap);

        uint32 rebirthCount = seasonalRebirths[player][seasonId];
        if (rebirthCount == type(uint32).max) revert CounterOverflow();
        seasonalRebirths[player][seasonId] = rebirthCount + 1;
        if (scoreTier > previousHighScore) seasonalHighScoreTier[player][seasonId] = scoreTier;
        seasonalPP[player][seasonId] += ppReward;
        seasonalCP[player][seasonId] += cpReward;
        totalSeasonCP[seasonId] += cpReward;
        lifetimeCP[player] += cpReward;
        lifetimeNatureCollectedAtoms[player] = _saturatingAdd(
            lifetimeNatureCollectedAtoms[player], a.natureCollectedAtoms
        );
        totalAccumulatedRebirthScore[player] += scoreTier;
        seasonalAccumulatedRebirthScore[player][seasonId] += scoreTier;
        emit RebirthSettled(
            player,
            runId,
            seasonId,
            scoreTier,
            ppReward,
            cpReward,
            nonce,
            rulesVersion,
            a.natureCollectedAtoms
        );
    }

    /// @dev Observational totals saturate instead of blocking a valid reward settlement.
    function _saturatingAdd(uint256 current, uint256 amount) private pure returns (uint256) {
        unchecked {
            uint256 next = current + amount;
            return next < current ? type(uint256).max : next;
        }
    }

    function _capCPReward(address player, uint64 seasonId, uint256 reward, uint32 playerSeasonCap)
        private
        view
        returns (uint256)
    {
        uint256 cpBalance = seasonalCP[player][seasonId];
        uint256 playerRemaining = cpBalance < playerSeasonCap ? playerSeasonCap - cpBalance : 0;
        uint256 seasonBalance = totalSeasonCP[seasonId];
        uint256 globalRemaining = seasonBalance < MAX_SEASON_POINTS
            ? MAX_SEASON_POINTS - seasonBalance
            : 0;
        uint256 lifetimeRemaining = type(uint256).max - lifetimeCP[player];
        if (reward > playerRemaining) reward = playerRemaining;
        if (reward > globalRemaining) reward = globalRemaining;
        if (reward > lifetimeRemaining) reward = lifetimeRemaining;
        return reward;
    }

    function _validateChoices(
        UpgradeChoice[] calldata choices,
        uint64 seasonId,
        uint32 version
    ) private view returns (bytes32 commitment, uint256 cost) {
        commitment = keccak256(abi.encode(choices));
        RewardRules memory rules = rewardRules[version];
        uint8 previousId;
        for (uint256 i = 0; i < choices.length; i++) {
            UpgradeChoice calldata choice = choices[i];
            if (choice.upgradeId > 2 || choice.quantity == 0 || (i != 0 && choice.upgradeId <= previousId))
                revert InvalidUpgradeChoices();
            previousId = choice.upgradeId;
            uint16 level = seasonalUpgradeLevel[msg.sender][seasonId][choice.upgradeId];
            if (uint256(level) + choice.quantity > rules.maxUpgradeLevel) revert UpgradeLevelExceeded();
            cost += (uint256(choice.quantity) * (2 * uint256(level) + choice.quantity + 1)) / 2;
        }
        if (cost > seasonalPP[msg.sender][seasonId]) revert InsufficientPP();
    }

    function _reward(uint256 base, uint256 delta, uint256 step, uint256 cap) private pure returns (uint256) {
        uint256 amount = base + delta / step;
        return amount < cap ? amount : cap;
    }
}
