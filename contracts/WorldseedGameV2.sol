// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Fresh-state expedition ledger. V1 remains a separate reference contract.
/// @dev CandidateSet is byte-for-byte aligned with src/expeditions/model.ts.
contract WorldseedGameV2 {
    uint256 public constant HEMI_SEPOLIA_CHAIN_ID = 743111;
    uint256 public constant MAX_BATCH = 20;
    uint256 public constant WEEK = 7 days;
    uint64 public constant ATTESTATION_MAX_AGE = 7 days;
    uint8 public constant MAX_STAMINA = 5;
    uint16 public constant MAX_PUZZLE_MOVES = 200;
    uint16 public constant PUZZLE_BATCH = 20;
    uint64 public constant STAMINA_INTERVAL = 30 minutes;
    bytes32 private constant DOMAIN_TYPEHASH = keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant NAME_HASH = keccak256("Worldseed Candidate Set");
    bytes32 private constant VERSION_HASH = keccak256("2");
    bytes32 private constant CANDIDATE_TYPEHASH = keccak256("CandidateSet(address player,uint64 expeditionNumber,bytes32 sourceCommitment,bytes32[3] candidateSeeds,bytes32 combinedCharacterSeed,uint32 islandGeneratorVersion,uint32 characterGeneratorVersion,uint32 sourceSelectionPolicyVersion,uint64 issuedAt,uint64 expiresAt)");
    uint8 public constant GENERATOR_VERSION = 2;

    enum Lifecycle { None, Active, Completed, Abandoned }
    struct CandidateSet {
        address player;
        uint64 expeditionNumber;
        bytes32 sourceCommitment;
        bytes32[3] candidateSeeds;
        bytes32 combinedCharacterSeed;
        uint32 islandGeneratorVersion;
        uint32 characterGeneratorVersion;
        uint32 sourceSelectionPolicyVersion;
        uint64 issuedAt;
        uint64 expiresAt;
    }
    struct Expedition {
        Lifecycle lifecycle;
        uint8 selectedIndex;
        uint8 unlockedThrough;
        uint64 cursor;
        uint64 startedAt;
        bytes32 seed;
        bytes32 sourceCommitment;
        bytes32 combinedCharacterSeed;
        uint32 islandGeneratorVersion;
        uint32 characterGeneratorVersion;
        uint32 sourceSelectionPolicyVersion;
        uint8[49] habitats;
        uint16[3] inventory;
        bool[5] claimed;
    }
    struct PuzzleRound {
        bool active;
        uint8 mode;
        uint16 moves;
        uint32 score;
        uint32 seed;
        uint32 rngState;
        uint64 expeditionId;
        uint8[16] board;
    }
    struct PlayerEconomy { uint8 stamina; uint64 staminaUpdatedAt; uint32 roundNonce; }

    address public owner;
    address public pendingOwner;
    address public attester;
    address public pendingAttester;
    bool public paused;
    mapping(address => uint64) public nextExpeditionNumber;
    mapping(address => uint64) public nextExpeditionId;
    mapping(address => uint64) public activeExpeditionId;
    mapping(address => uint256) public goldBalances;
    mapping(address => mapping(uint64 => Expedition)) private expeditions;
    mapping(bytes32 => bool) public usedCandidateSetDigests;
    mapping(bytes32 => bool) public usedWorldTreeContributionIds;
    mapping(uint256 => uint32) public weeklyContributions;
    mapping(address => uint64) public worldTreeContributionNonce;
    mapping(address => mapping(uint64 => bool)) public expeditionContributionClaimed;
    mapping(address => PuzzleRound) private puzzleRounds;
    mapping(address => PlayerEconomy) private playerEconomies;

    event AttesterProposed(address indexed previous, address indexed proposed);
    event AttesterChanged(address indexed previous, address indexed current);
    event OwnershipTransferStarted(address indexed previous, address indexed pending);
    event OwnershipTransferred(address indexed previous, address indexed current);
    event PauseChanged(bool paused);
    event ExpeditionStarted(address indexed player, uint64 indexed expeditionId, uint64 indexed expeditionNumber, bytes32 seed, uint8 selectedIndex, bytes32 sourceCommitment, bytes32 combinedCharacterSeed);
    event ProgressSaved(address indexed player, uint64 indexed expeditionId, uint64 cursor, uint8 unlockedThrough, uint8 actionCount);
    event RegionUnlocked(address indexed player, uint64 indexed expeditionId, uint8 region, uint256 week);
    event ExpeditionCompleted(address indexed player, uint64 indexed expeditionId, bytes32 snapshotHash, uint256 week);
    event ExpeditionAbandoned(address indexed player, uint64 indexed expeditionId, uint64 nextEligibleExpeditionNumber);
    event HabitatPurchased(address indexed player, uint64 indexed expeditionId, uint8 habitat, uint16 quantity, uint256 goldSpent);
    event WorldTreeContribution(address indexed player, uint64 indexed expeditionId, bytes32 indexed contributionId, uint256 week, uint32 amount);
    event PuzzleRoundStarted(address indexed player, uint64 indexed expeditionId, uint32 indexed seed, uint8 mode, uint8[16] board, uint32 rngState);
    event PuzzleProgress(address indexed player, uint64 indexed expeditionId, uint16 moves, uint32 score, uint8[16] board, uint32 rngState, bool active);
    event PuzzleRoundSettled(address indexed player, uint64 indexed expeditionId, uint32 indexed seed, uint8 mode, uint16 moves, uint32 score, uint256 goldEarned, bool cashedOut);

    error Unauthorized();
    error Paused();
    error WrongChain();
    error InvalidAttestation();
    error InvalidSignature();
    error InvalidCandidate();
    error CandidateAlreadyUsed();
    error NoActiveExpedition();
    error InvalidExpedition();
    error InvalidLifecycle();
    error InvalidBatch();
    error CursorMismatch(uint64 expected, uint64 actual);
    error InvalidAction(uint8 action);
    error LockedRegion();
    error Occupied();
    error EmptyCell();
    error InsufficientResource(uint8 habitat);
    error NotCompleteable();
    error InvalidShopPurchase();
    error InsufficientGold();
    error DuplicateContribution();
    error ContributionLimitReached();
    error PuzzleAlreadyActive();
    error PuzzleNotActive();
    error InvalidPuzzleMode();
    error InvalidPuzzleDirection();
    error InvalidPuzzleBatch();
    error PuzzleCursorMismatch(uint16 expected, uint16 actual);
    error PuzzleCashOutTooEarly();
    error PuzzleNoValidMoves();
    error NoStamina();

    constructor(address initialOwner, address initialAttester) {
        if (initialOwner == address(0) || initialAttester == address(0)) revert Unauthorized();
        owner = initialOwner;
        attester = initialAttester;
        emit OwnershipTransferred(address(0), initialOwner);
        emit AttesterChanged(address(0), initialAttester);
    }

    modifier onlyOwner() { if (msg.sender != owner) revert Unauthorized(); _; }
    modifier whenNotPaused() { if (paused) revert Paused(); _; }

    function transferOwnership(address proposed) external onlyOwner {
        if (proposed == address(0)) revert Unauthorized();
        pendingOwner = proposed;
        emit OwnershipTransferStarted(owner, proposed);
    }
    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert Unauthorized();
        address previous = owner;
        owner = msg.sender;
        pendingOwner = address(0);
        emit OwnershipTransferred(previous, msg.sender);
    }
    function proposeAttester(address proposed) external onlyOwner {
        if (proposed == address(0)) revert Unauthorized();
        pendingAttester = proposed;
        emit AttesterProposed(attester, proposed);
    }
    function acceptAttester() external {
        if (msg.sender != pendingAttester) revert Unauthorized();
        address previous = attester;
        attester = msg.sender;
        pendingAttester = address(0);
        emit AttesterChanged(previous, msg.sender);
    }
    function setPaused(bool value) external onlyOwner {
        paused = value;
        emit PauseChanged(value);
    }

    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, HEMI_SEPOLIA_CHAIN_ID, address(this)));
    }
    function candidateSetDigest(CandidateSet calldata set) public view returns (bytes32) {
        // EIP-712 hashes array members before encoding the enclosing struct.
        bytes32 candidatesHash = keccak256(abi.encodePacked(set.candidateSeeds));
        bytes32 structHash = keccak256(abi.encode(CANDIDATE_TYPEHASH, set.player, set.expeditionNumber,
            set.sourceCommitment, candidatesHash, set.combinedCharacterSeed, set.islandGeneratorVersion,
            set.characterGeneratorVersion, set.sourceSelectionPolicyVersion, set.issuedAt, set.expiresAt));
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    function startExpedition(CandidateSet calldata set, uint8 selectedIndex, bytes calldata signature)
        external whenNotPaused returns (uint64 expeditionId)
    {
        if (block.chainid != HEMI_SEPOLIA_CHAIN_ID && block.chainid != 31337) revert WrongChain();
        if (set.player != msg.sender || set.expeditionNumber != _nextNumber(msg.sender) || activeExpeditionId[msg.sender] != 0) revert InvalidAttestation();
        if (selectedIndex > 2 || set.candidateSeeds[selectedIndex] == bytes32(0) || set.sourceCommitment == bytes32(0)) revert InvalidCandidate();
        if (set.islandGeneratorVersion != GENERATOR_VERSION || set.characterGeneratorVersion == 0 || set.sourceSelectionPolicyVersion == 0) revert InvalidAttestation();
        if (set.issuedAt > block.timestamp || set.expiresAt <= block.timestamp || set.expiresAt <= set.issuedAt || set.expiresAt - set.issuedAt > ATTESTATION_MAX_AGE) revert InvalidAttestation();
        bytes32 digest = candidateSetDigest(set);
        if (usedCandidateSetDigests[digest]) revert CandidateAlreadyUsed();
        if (_recover(digest, signature) != attester) revert InvalidSignature();

        usedCandidateSetDigests[digest] = true;
        expeditionId = ++nextExpeditionId[msg.sender];
        nextExpeditionNumber[msg.sender] = set.expeditionNumber;
        activeExpeditionId[msg.sender] = expeditionId;
        Expedition storage game = expeditions[msg.sender][expeditionId];
        game.lifecycle = Lifecycle.Active;
        game.selectedIndex = selectedIndex;
        game.seed = set.candidateSeeds[selectedIndex];
        game.sourceCommitment = set.sourceCommitment;
        game.combinedCharacterSeed = set.combinedCharacterSeed;
        game.islandGeneratorVersion = set.islandGeneratorVersion;
        game.characterGeneratorVersion = set.characterGeneratorVersion;
        game.sourceSelectionPolicyVersion = set.sourceSelectionPolicyVersion;
        game.startedAt = uint64(block.timestamp);
        game.inventory[0] = 1;
        game.inventory[1] = 1;
        game.claimed[0] = true;
        emit ExpeditionStarted(msg.sender, expeditionId, set.expeditionNumber, game.seed, selectedIndex, set.sourceCommitment, set.combinedCharacterSeed);
    }

    /// @dev Same action encoding and ecology rules as V1: cellIndex*4 + habitat (0 gather, 1 water, 2 grass, 3 forest).
    function saveProgress(uint64 expeditionId, uint64 expectedCursor, uint8[] calldata actions) external whenNotPaused {
        Expedition storage game = _active(msg.sender, expeditionId);
        if (expectedCursor != game.cursor) revert CursorMismatch(expectedCursor, game.cursor);
        if (actions.length == 0 || actions.length > MAX_BATCH) revert InvalidBatch();
        for (uint256 i; i < actions.length; ++i) _apply(game, actions[i]);
        emit ProgressSaved(msg.sender, expeditionId, game.cursor, game.unlockedThrough, uint8(actions.length));
    }

    function finishExpedition(uint64 expeditionId, uint64 expectedCursor, uint8[] calldata actions, bytes32 snapshotHash) external whenNotPaused {
        Expedition storage game = _active(msg.sender, expeditionId);
        if (expectedCursor != game.cursor) revert CursorMismatch(expectedCursor, game.cursor);
        if (actions.length > MAX_BATCH) revert InvalidBatch();
        for (uint256 i; i < actions.length; ++i) _apply(game, actions[i]);
        if (game.unlockedThrough != 4 || _healthyCount(game, 4) < 12 || _healthyForestCount(game) < 3 || game.habitats[26] != 3 || !_healthy(game, 26)) revert NotCompleteable();
        game.lifecycle = Lifecycle.Completed;
        activeExpeditionId[msg.sender] = 0;
        _forfeitPuzzle(msg.sender, expeditionId);
        uint256 week = currentWeek();
        weeklyContributions[week] += 2;
        emit ExpeditionCompleted(msg.sender, expeditionId, snapshotHash, week);
    }

    // Abandonment only closes and forfeits an active run; it grants no resources or rewards.
    // Keep this escape hatch available during an emergency pause so players are not trapped.
    function abandonExpedition(uint64 expeditionId) external {
        Expedition storage game = _active(msg.sender, expeditionId);
        game.lifecycle = Lifecycle.Abandoned;
        activeExpeditionId[msg.sender] = 0;
        _forfeitPuzzle(msg.sender, expeditionId);
        emit ExpeditionAbandoned(msg.sender, expeditionId, _nextNumber(msg.sender));
    }

    function buyHabitat(uint64 expeditionId, uint8 habitat, uint16 quantity) external whenNotPaused {
        Expedition storage game = _active(msg.sender, expeditionId);
        if (quantity == 0 || habitat < 1 || habitat > 3) revert InvalidShopPurchase();
        uint256 unitPrice = habitat == 1 ? 2_000 : habitat == 2 ? 1_000 : 3_000;
        uint256 cost = unitPrice * quantity;
        if (goldBalances[msg.sender] < cost) revert InsufficientGold();
        uint256 updated = uint256(game.inventory[habitat - 1]) + quantity;
        if (updated > type(uint16).max) revert InvalidShopPurchase();
        goldBalances[msg.sender] -= cost;
        game.inventory[habitat - 1] = uint16(updated);
        emit HabitatPurchased(msg.sender, expeditionId, habitat, quantity, cost);
    }

    /// @notice Records a confirmed contribution and returns a deterministic, per-player event ID.
    /// Contributions remain valid after abandonment; replay is impossible because the nonce advances atomically.
    function contributeWorldTree(uint64 expeditionId, uint32 amount) external whenNotPaused returns (bytes32 contributionId) {
        _active(msg.sender, expeditionId);
        if (amount != 1 || expeditionContributionClaimed[msg.sender][expeditionId]) revert ContributionLimitReached();
        expeditionContributionClaimed[msg.sender][expeditionId] = true;
        uint64 nonce = ++worldTreeContributionNonce[msg.sender];
        contributionId = keccak256(abi.encode(address(this), block.chainid, msg.sender, expeditionId, nonce));
        if (usedWorldTreeContributionIds[contributionId]) revert DuplicateContribution();
        usedWorldTreeContributionIds[contributionId] = true;
        uint256 week = currentWeek();
        weeklyContributions[week] += amount;
        emit WorldTreeContribution(msg.sender, expeditionId, contributionId, week, amount);
    }

    /// @notice V1-equivalent rewarded 2048 rules, with settlement credited to persistent account Gold.
    function startPuzzleRound(uint64 expeditionId, uint8 mode) external whenNotPaused returns (uint32 seed) {
        _active(msg.sender, expeditionId);
        if (mode > 2) revert InvalidPuzzleMode();
        PuzzleRound storage round = puzzleRounds[msg.sender];
        if (round.active) revert PuzzleAlreadyActive();
        PlayerEconomy storage economy = playerEconomies[msg.sender];
        _regenerateStamina(economy);
        if (economy.stamina == 0) revert NoStamina();
        economy.stamina -= 1;
        economy.roundNonce += 1;
        seed = uint32(uint256(keccak256(abi.encodePacked(block.chainid, blockhash(block.number - 1), msg.sender, economy.roundNonce))));
        if (seed == 0) seed = 0x6d2b79f5;
        round.active = true; round.mode = mode; round.moves = 0; round.score = 0;
        round.seed = seed; round.rngState = seed; round.expeditionId = expeditionId;
        for (uint256 i; i < 16; ++i) round.board[i] = 0;
        _spawnPuzzleTile(round); _spawnPuzzleTile(round);
        emit PuzzleRoundStarted(msg.sender, expeditionId, seed, mode, round.board, round.rngState);
    }

    function savePuzzleMoves(uint16 expectedMoves, uint8[] calldata directions, bool cashOut) external whenNotPaused {
        PuzzleRound storage round = puzzleRounds[msg.sender];
        if (!round.active) revert PuzzleNotActive();
        if (activeExpeditionId[msg.sender] != round.expeditionId) revert InvalidLifecycle();
        if (expectedMoves != round.moves) revert PuzzleCursorMismatch(expectedMoves, round.moves);
        if (directions.length > PUZZLE_BATCH || (directions.length == 0 && !cashOut)) revert InvalidPuzzleBatch();
        uint16 startMoves = round.moves; bool ended;
        for (uint256 i; i < directions.length; ++i) {
            if (directions[i] > 3) revert InvalidPuzzleDirection();
            (uint8[16] memory nextBoard, bool moved, uint32 scoreIncrease) = _applyPuzzleMove(round.board, directions[i]);
            if (!moved) continue;
            round.board = nextBoard; ++round.moves; round.score += scoreIncrease; _spawnPuzzleTile(round);
            if (round.moves == MAX_PUZZLE_MOVES || _puzzleOver(round.board)) {
                if (i + 1 != directions.length) revert InvalidPuzzleBatch();
                ended = true; break;
            }
        }
        if (round.moves == startMoves && !cashOut) revert PuzzleNoValidMoves();
        if (cashOut && round.moves < 20 && !ended) revert PuzzleCashOutTooEarly();
        if (ended || cashOut) _settlePuzzle(msg.sender, round, cashOut && !ended);
        emit PuzzleProgress(msg.sender, round.expeditionId, round.moves, round.score, round.board, round.rngState, round.active);
    }

    function puzzleState(address player) external view returns (
        bool active, uint8 mode, uint16 moves, uint32 score, uint32 seed, uint32 rngState, uint64 expeditionId, uint8[16] memory board
    ) {
        PuzzleRound storage round = puzzleRounds[player];
        return (round.active, round.mode, round.moves, round.score, round.seed, round.rngState, round.expeditionId, round.board);
    }
    function staminaState(address player) external view returns (uint8 available, uint64 nextRegenerationAt) {
        PlayerEconomy storage economy = playerEconomies[player];
        if (economy.staminaUpdatedAt == 0 || economy.stamina >= MAX_STAMINA) return (MAX_STAMINA, 0);
        uint256 intervals = (block.timestamp - economy.staminaUpdatedAt) / STAMINA_INTERVAL;
        uint256 regenerated = uint256(economy.stamina) + intervals;
        if (regenerated >= MAX_STAMINA) return (MAX_STAMINA, 0);
        available = uint8(regenerated);
        nextRegenerationAt = uint64(uint256(economy.staminaUpdatedAt) + (intervals + 1) * STAMINA_INTERVAL);
    }

    function currentWeek() public view returns (uint256) { return (block.timestamp + 3 days) / WEEK; }
    function expeditionState(address player, uint64 id) external view returns (
        Lifecycle lifecycle, uint8 selectedIndex, uint8 unlockedThrough, uint64 cursor,
        bytes32 seed, bytes32 sourceCommitment, bytes32 combinedCharacterSeed, uint64 startedAt,
        uint32[3] memory generatorVersions
    ) {
        Expedition storage game = expeditions[player][id];
        generatorVersions = [game.islandGeneratorVersion, game.characterGeneratorVersion, game.sourceSelectionPolicyVersion];
        return (game.lifecycle, game.selectedIndex, game.unlockedThrough, game.cursor, game.seed,
            game.sourceCommitment, game.combinedCharacterSeed, game.startedAt, generatorVersions);
    }
    function expeditionBoard(address player, uint64 id) external view returns (
        uint8[49] memory habitats, uint16[3] memory inventory, bool[5] memory claimed
    ) {
        Expedition storage game = expeditions[player][id];
        return (game.habitats, game.inventory, game.claimed);
    }

    function _nextNumber(address player) private view returns (uint64) { return nextExpeditionNumber[player] + 1; }
    function _active(address player, uint64 id) private view returns (Expedition storage game) {
        if (id == 0 || activeExpeditionId[player] != id) revert NoActiveExpedition();
        game = expeditions[player][id];
        if (game.lifecycle != Lifecycle.Active) revert InvalidLifecycle();
    }
    function _recover(bytes32 digest, bytes calldata signature) private pure returns (address signer) {
        if (signature.length != 65) revert InvalidSignature();
        bytes32 r; bytes32 s; uint8 v;
        assembly { r := calldataload(signature.offset) s := calldataload(add(signature.offset, 32)) v := byte(0, calldataload(add(signature.offset, 64))) }
        if (uint256(s) > 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0 || (v != 27 && v != 28)) revert InvalidSignature();
        signer = ecrecover(digest, v, r, s);
        if (signer == address(0)) revert InvalidSignature();
    }
    function _regenerateStamina(PlayerEconomy storage economy) private {
        if (economy.staminaUpdatedAt == 0) { economy.stamina = MAX_STAMINA; economy.staminaUpdatedAt = uint64(block.timestamp); return; }
        if (economy.stamina >= MAX_STAMINA) { economy.staminaUpdatedAt = uint64(block.timestamp); return; }
        uint256 intervals = (block.timestamp - economy.staminaUpdatedAt) / STAMINA_INTERVAL;
        if (intervals == 0) return;
        uint256 regenerated = uint256(economy.stamina) + intervals;
        economy.stamina = uint8(regenerated > MAX_STAMINA ? MAX_STAMINA : regenerated);
        economy.staminaUpdatedAt = economy.stamina == MAX_STAMINA
            ? uint64(block.timestamp) : uint64(uint256(economy.staminaUpdatedAt) + intervals * STAMINA_INTERVAL);
    }
    function _spawnPuzzleTile(PuzzleRound storage round) private {
        uint8 emptyCount;
        for (uint8 i; i < 16; ++i) if (round.board[i] == 0) ++emptyCount;
        if (emptyCount == 0) return;
        round.rngState = _nextPuzzleRandom(round.rngState);
        uint8 chosenEmpty = uint8(round.rngState % emptyCount);
        round.rngState = _nextPuzzleRandom(round.rngState);
        uint8 tile = round.rngState % 100 < (round.mode == 0 ? 5 : round.mode == 1 ? 10 : 25) ? 2 : 1;
        for (uint8 i; i < 16; ++i) if (round.board[i] == 0) {
            if (chosenEmpty == 0) { round.board[i] = tile; return; }
            --chosenEmpty;
        }
    }
    function _nextPuzzleRandom(uint32 state) private pure returns (uint32) {
        if (state == 0) state = 0x6d2b79f5;
        state ^= state << 13; state ^= state >> 17; state ^= state << 5;
        return state;
    }
    function _applyPuzzleMove(uint8[16] memory board, uint8 direction)
        private pure returns (uint8[16] memory nextBoard, bool moved, uint32 scoreIncrease)
    {
        for (uint8 line; line < 4; ++line) {
            uint8[4] memory values; uint8 count;
            for (uint8 offset; offset < 4; ++offset) { uint8 index = _puzzleIndex(line, offset, direction); if (board[index] != 0) values[count++] = board[index]; }
            uint8[4] memory compacted; uint8 outputCount;
            for (uint8 i; i < count; ++i) {
                uint8 value = values[i];
                if (i + 1 < count && values[i + 1] == value) { value += 1; scoreIncrease += uint32(1) << value; ++i; }
                compacted[outputCount++] = value;
            }
            for (uint8 offset; offset < 4; ++offset) { uint8 index = _puzzleIndex(line, offset, direction); nextBoard[index] = compacted[offset]; if (nextBoard[index] != board[index]) moved = true; }
        }
    }
    function _puzzleIndex(uint8 line, uint8 offset, uint8 direction) private pure returns (uint8) {
        if (direction == 0) return line * 4 + offset;
        if (direction == 1) return line * 4 + (3 - offset);
        if (direction == 2) return offset * 4 + line;
        return (3 - offset) * 4 + line;
    }
    function _puzzleOver(uint8[16] memory board) private pure returns (bool) {
        for (uint8 row; row < 4; ++row) for (uint8 column; column < 4; ++column) {
            uint8 index = row * 4 + column;
            if (board[index] == 0) return false;
            if (column < 3 && board[index] == board[index + 1]) return false;
            if (row < 3 && board[index] == board[index + 4]) return false;
        }
        return true;
    }
    function _settlePuzzle(address player, PuzzleRound storage round, bool cashedOut) private {
        uint256 numerator = round.mode == 0 ? 3 : round.mode == 1 ? 1 : 5;
        uint256 denominator = round.mode == 0 ? 8 : round.mode == 1 ? 2 : 8;
        uint256 goldEarned = uint256(round.score) * numerator / denominator;
        round.active = false; goldBalances[player] += goldEarned;
        emit PuzzleRoundSettled(player, round.expeditionId, round.seed, round.mode, round.moves, round.score, goldEarned, cashedOut);
    }
    function _forfeitPuzzle(address player, uint64 expeditionId) private {
        PuzzleRound storage round = puzzleRounds[player];
        if (round.active && round.expeditionId == expeditionId) {
            round.active = false;
            round.seed = 0;
            round.expeditionId = 0;
            emit PuzzleProgress(player, expeditionId, round.moves, round.score, round.board, round.rngState, false);
        }
    }
    function _apply(Expedition storage game, uint8 action) private {
        uint8 index = action / 4; uint8 habitat = action % 4;
        if (index >= 49 || !_placeable(index)) revert InvalidAction(action);
        uint8 region = index % 7 <= 1 ? 0 : index % 7 == 2 ? 1 : index % 7 == 3 ? 2 : index % 7 <= 5 ? 3 : 4;
        if (region > game.unlockedThrough) revert LockedRegion();
        uint8 current = game.habitats[index];
        if (habitat == 0) { if (current == 0) revert EmptyCell(); game.inventory[current - 1] += 1; game.habitats[index] = 0; }
        else { if (current != 0) revert Occupied(); if (game.inventory[habitat - 1] == 0) revert InsufficientResource(habitat); game.inventory[habitat - 1] -= 1; game.habitats[index] = habitat; }
        ++game.cursor; _unlock(game);
    }
    function _unlock(Expedition storage game) private {
        uint8[5] memory threshold = [uint8(0), 2, 4, 7, 10];
        while (game.unlockedThrough < 4 && _healthyCount(game, game.unlockedThrough) >= threshold[game.unlockedThrough + 1]) {
            uint8 region = game.unlockedThrough + 1; game.unlockedThrough = region;
            if (!game.claimed[region]) {
                game.claimed[region] = true;
                if (region == 1) { game.inventory[0] += 1; game.inventory[1] += 2; }
                else if (region == 2) { game.inventory[1] += 1; game.inventory[2] += 2; }
                else if (region == 3) { game.inventory[0] += 1; game.inventory[1] += 2; }
                else { game.inventory[0] += 1; game.inventory[2] += 1; }
                uint256 week = currentWeek(); weeklyContributions[week] += 1;
                emit RegionUnlocked(msg.sender, activeExpeditionId[msg.sender], region, week);
            }
        }
    }
    function _placeable(uint8 index) private pure returns (bool) {
        uint8 x = index % 7; uint8 y = index / 7;
        if (x >= 1 && x <= 5 && y >= 1 && y <= 5) return true;
        return (y == 0 && (x == 1 || x == 2 || x == 4)) || (x == 0 && y == 1);
    }
    function _healthy(Expedition storage game, uint8 index) private view returns (bool) {
        uint8 habitat = game.habitats[index]; if (habitat == 0 || habitat == 1) return habitat == 1;
        bool water; bool grass; uint8 x = index % 7; uint8 y = index / 7;
        if (x > 0) { uint8 n = index - 1; water = water || game.habitats[n] == 1; grass = grass || (game.habitats[n] == 2 && _grassHealthy(game, n)); }
        if (x < 6) { uint8 n = index + 1; water = water || game.habitats[n] == 1; grass = grass || (game.habitats[n] == 2 && _grassHealthy(game, n)); }
        if (y > 0) { uint8 n = index - 7; water = water || game.habitats[n] == 1; grass = grass || (game.habitats[n] == 2 && _grassHealthy(game, n)); }
        if (y < 6) { uint8 n = index + 7; water = water || game.habitats[n] == 1; grass = grass || (game.habitats[n] == 2 && _grassHealthy(game, n)); }
        return habitat == 2 ? water : water && grass;
    }
    function _grassHealthy(Expedition storage game, uint8 index) private view returns (bool) {
        uint8 x = index % 7; uint8 y = index / 7;
        return (x > 0 && game.habitats[index - 1] == 1) || (x < 6 && game.habitats[index + 1] == 1) || (y > 0 && game.habitats[index - 7] == 1) || (y < 6 && game.habitats[index + 7] == 1);
    }
    function _healthyCount(Expedition storage game, uint8 through) private view returns (uint8 total) {
        uint8 maxX = through == 0 ? 1 : through == 1 ? 2 : through == 2 ? 3 : through == 3 ? 5 : 6;
        for (uint8 i; i < 49; ++i) if (i % 7 <= maxX && _healthy(game, i)) ++total;
    }
    function _healthyForestCount(Expedition storage game) private view returns (uint8 total) {
        for (uint8 i; i < 49; ++i) if (game.habitats[i] == 3 && _healthy(game, i)) ++total;
    }
}
