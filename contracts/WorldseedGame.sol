// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Contest MVP ledger. Each bounded action batch is replayed onchain.
contract WorldseedGame {
    uint256 public constant MAX_BATCH = 20;
    uint256 public constant WEEK = 7 days;
    uint8 public constant GENERATOR_VERSION = 1;
    uint8 public constant PUZZLE_VERSION = 1;
    uint8 public constant MAX_STAMINA = 5;
    uint16 public constant MAX_PUZZLE_MOVES = 200;
    uint16 public constant PUZZLE_BATCH = 20;
    uint64 public constant STAMINA_INTERVAL = 30 minutes;

    struct PuzzleRound {
        bool active;
        uint8 mode;
        uint16 moves;
        uint32 score;
        uint32 seed;
        uint32 rngState;
        uint8[16] board;
    }

    struct PlayerEconomy {
        uint8 stamina;
        uint64 staminaUpdatedAt;
        uint32 roundNonce;
    }

    struct Island {
        bool started;
        bool complete;
        uint8 unlockedThrough;
        uint64 cursor;
        uint32 seed;
        uint8[49] habitats; // 0 empty, 1 water, 2 grass, 3 forest
        uint16[3] inventory;
        bool[5] claimed;
    }

    mapping(address => Island) private islands;
    mapping(address => bool) public starterClaimed;
    mapping(uint256 => uint32) public weeklyContributions;
    mapping(uint256 => uint32) public weeklyCompletions;
    mapping(address => PuzzleRound) private puzzleRounds;
    mapping(address => PlayerEconomy) private playerEconomies;
    mapping(address => uint256) public goldBalances;

    event IslandStarted(address indexed player, uint32 indexed seed, uint8 generatorVersion);
    event ProgressSaved(address indexed player, uint64 cursor, uint8 unlockedThrough, uint8 actionCount);
    event RegionUnlocked(address indexed player, uint8 indexed region, uint256 indexed week);
    event IslandFinished(address indexed player, uint32 indexed seed, bytes32 snapshotHash, uint256 indexed week);
    event PuzzleRoundStarted(address indexed player, uint32 indexed seed, uint8 mode, uint8[16] board, uint32 rngState);
    event PuzzleProgress(address indexed player, uint16 moves, uint32 score, uint8[16] board, uint32 rngState, bool active);
    event PuzzleRoundSettled(address indexed player, uint32 indexed seed, uint8 mode, uint16 moves, uint32 score, uint256 goldEarned, bool cashedOut);
    event HabitatPurchased(address indexed player, uint8 habitat, uint16 quantity, uint256 goldSpent);

    error AlreadyStarted();
    error NotStarted();
    error InvalidBatch();
    error CursorMismatch(uint64 expected, uint64 actual);
    error InvalidAction(uint8 action);
    error LockedRegion();
    error Occupied();
    error EmptyCell();
    error InsufficientResource(uint8 habitat);
    error NotCompleteable();
    error AlreadyComplete();
    error PuzzleAlreadyActive();
    error PuzzleNotActive();
    error InvalidPuzzleMode();
    error InvalidPuzzleDirection();
    error InvalidPuzzleBatch();
    error PuzzleCursorMismatch(uint16 expected, uint16 actual);
    error PuzzleCashOutTooEarly();
    error PuzzleNoValidMoves();
    error NoStamina();
    error InvalidShopPurchase();
    error InsufficientGold();

    function startIsland(uint32 seed) external {
        Island storage game = islands[msg.sender];
        if (game.started || starterClaimed[msg.sender]) revert AlreadyStarted();
        game.started = true;
        game.seed = seed;
        game.inventory[0] = 1;
        game.inventory[1] = 1;
        game.claimed[0] = true;
        starterClaimed[msg.sender] = true;
        emit IslandStarted(msg.sender, seed, GENERATOR_VERSION);
    }

    /// @dev action = cellIndex * 4 + habitat; 0 removes, 1 water, 2 grass, 3 forest.
    function saveProgress(uint64 expectedCursor, uint8[] calldata actions) external {
        Island storage game = islands[msg.sender];
        if (!game.started) revert NotStarted();
        if (game.complete) revert AlreadyComplete();
        _checkBatch(expectedCursor, actions.length, game.cursor);
        for (uint256 i; i < actions.length; ++i) _apply(game, actions[i]);
        emit ProgressSaved(msg.sender, game.cursor, game.unlockedThrough, uint8(actions.length));
    }

    function finishIsland(
        uint64 expectedCursor,
        uint8[] calldata actions,
        bytes32 snapshotHash
    ) external {
        Island storage game = islands[msg.sender];
        if (!game.started) revert NotStarted();
        if (game.complete) revert AlreadyComplete();
        if (expectedCursor != game.cursor) revert CursorMismatch(expectedCursor, game.cursor);
        if (actions.length > MAX_BATCH) revert InvalidBatch();
        for (uint256 i; i < actions.length; ++i) _apply(game, actions[i]);
        if (game.unlockedThrough != 4 || _healthyCount(game, 4) < 12 || _healthyForestCount(game) < 3 || !_heartPath(game)) {
            revert NotCompleteable();
        }
        game.complete = true;
        uint256 week = currentWeek();
        weeklyContributions[week] += 2;
        weeklyCompletions[week] += 1;
        emit IslandFinished(msg.sender, game.seed, snapshotHash, week);
    }

    function currentWeek() public view returns (uint256) {
        return (block.timestamp + 3 days) / WEEK;
    }

    function islandState(address player)
        external view returns (
            bool started,
            bool complete,
            uint8 unlockedThrough,
            uint64 cursor,
            uint32 seed,
            uint8[49] memory habitats,
            uint16[3] memory inventory,
            bool[5] memory claimed
        )
    {
        Island storage game = islands[player];
        return (game.started, game.complete, game.unlockedThrough, game.cursor, game.seed,
            game.habitats, game.inventory, game.claimed);
    }

    function puzzleState(address player)
        external view returns (
            bool active,
            uint8 mode,
            uint16 moves,
            uint32 score,
            uint32 seed,
            uint32 rngState,
            uint8[16] memory board
        )
    {
        PuzzleRound storage round = puzzleRounds[player];
        return (round.active, round.mode, round.moves, round.score, round.seed, round.rngState, round.board);
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

    /// @notice Starts one resumable, wallet-bound rewarded round using chain-derived entropy.
    function startPuzzleRound(uint8 mode) external returns (uint32 seed) {
        if (mode > 2) revert InvalidPuzzleMode();
        PuzzleRound storage round = puzzleRounds[msg.sender];
        if (round.active) revert PuzzleAlreadyActive();

        PlayerEconomy storage economy = playerEconomies[msg.sender];
        _regenerateStamina(economy);
        if (economy.stamina == 0) revert NoStamina();
        economy.stamina -= 1;
        economy.roundNonce += 1;

        seed = uint32(uint256(keccak256(abi.encodePacked(
            block.chainid, blockhash(block.number - 1), msg.sender, economy.roundNonce
        ))));
        if (seed == 0) seed = 0x6d2b79f5;

        round.active = true;
        round.mode = mode;
        round.moves = 0;
        round.score = 0;
        round.seed = seed;
        round.rngState = seed;
        for (uint256 i; i < 16; ++i) round.board[i] = 0;
        _spawnPuzzleTile(round);
        _spawnPuzzleTile(round);
        emit PuzzleRoundStarted(msg.sender, seed, mode, round.board, round.rngState);
    }

    /// @notice Replays up to 20 ordered directions and commits a resumable checkpoint.
    /// @dev Directions are left=0, right=1, up=2, down=3. Invalid moves do not count.
    function savePuzzleMoves(uint16 expectedMoves, uint8[] calldata directions, bool cashOut) external {
        PuzzleRound storage round = puzzleRounds[msg.sender];
        if (!round.active) revert PuzzleNotActive();
        if (expectedMoves != round.moves) revert PuzzleCursorMismatch(expectedMoves, round.moves);
        if (directions.length > PUZZLE_BATCH || (directions.length == 0 && !cashOut)) revert InvalidPuzzleBatch();

        uint16 startMoves = round.moves;
        bool ended;
        for (uint256 i; i < directions.length; ++i) {
            if (directions[i] > 3) revert InvalidPuzzleDirection();
            (uint8[16] memory nextBoard, bool moved, uint32 scoreIncrease) = _applyPuzzleMove(round.board, directions[i]);
            if (!moved) continue;

            round.board = nextBoard;
            round.moves += 1;
            round.score += scoreIncrease;
            _spawnPuzzleTile(round);

            if (round.moves == MAX_PUZZLE_MOVES || _puzzleOver(round.board)) {
                if (i + 1 != directions.length) revert InvalidPuzzleBatch();
                ended = true;
                break;
            }
        }

        if (round.moves == startMoves && !cashOut) revert PuzzleNoValidMoves();
        if (cashOut && round.moves < 20 && !ended) revert PuzzleCashOutTooEarly();

        uint256 goldEarned;
        if (ended || cashOut) {
            goldEarned = _settlePuzzle(msg.sender, round, cashOut && !ended);
        }
        emit PuzzleProgress(msg.sender, round.moves, round.score, round.board, round.rngState, round.active);
    }

    /// @notice Atomically spends committed Gold and credits the island's existing resource inventory.
    /// @dev Habitat values are Water=1, Grass=2, Forest=3; prices are provisional.
    function buyHabitat(uint8 habitat, uint16 quantity) external {
        Island storage game = islands[msg.sender];
        if (!game.started || quantity == 0 || habitat < 1 || habitat > 3) revert InvalidShopPurchase();
        uint256 unitPrice = habitat == 1 ? 2_000 : habitat == 2 ? 1_000 : 3_000;
        uint256 cost = unitPrice * quantity;
        if (goldBalances[msg.sender] < cost) revert InsufficientGold();
        uint256 updatedInventory = uint256(game.inventory[habitat - 1]) + quantity;
        if (updatedInventory > type(uint16).max) revert InvalidShopPurchase();
        goldBalances[msg.sender] -= cost;
        game.inventory[habitat - 1] = uint16(updatedInventory);
        emit HabitatPurchased(msg.sender, habitat, quantity, cost);
    }

    function _regenerateStamina(PlayerEconomy storage economy) private {
        if (economy.staminaUpdatedAt == 0) {
            economy.stamina = MAX_STAMINA;
            economy.staminaUpdatedAt = uint64(block.timestamp);
            return;
        }
        if (economy.stamina >= MAX_STAMINA) {
            economy.staminaUpdatedAt = uint64(block.timestamp);
            return;
        }
        uint256 intervals = (block.timestamp - economy.staminaUpdatedAt) / STAMINA_INTERVAL;
        if (intervals == 0) return;
        uint256 regenerated = uint256(economy.stamina) + intervals;
        economy.stamina = uint8(regenerated > MAX_STAMINA ? MAX_STAMINA : regenerated);
        economy.staminaUpdatedAt = economy.stamina == MAX_STAMINA
            ? uint64(block.timestamp)
            : uint64(uint256(economy.staminaUpdatedAt) + intervals * STAMINA_INTERVAL);
    }

    function _spawnPuzzleTile(PuzzleRound storage round) private {
        uint8 emptyCount;
        for (uint8 i; i < 16; ++i) if (round.board[i] == 0) emptyCount += 1;
        if (emptyCount == 0) return;

        round.rngState = _nextPuzzleRandom(round.rngState);
        uint8 chosenEmpty = uint8(round.rngState % emptyCount);
        round.rngState = _nextPuzzleRandom(round.rngState);
        uint8 tile = round.rngState % 100 < (round.mode == 0 ? 5 : round.mode == 1 ? 10 : 25) ? 2 : 1;
        for (uint8 i; i < 16; ++i) {
            if (round.board[i] == 0) {
                if (chosenEmpty == 0) {
                    round.board[i] = tile;
                    return;
                }
                chosenEmpty -= 1;
            }
        }
    }

    function _nextPuzzleRandom(uint32 state) private pure returns (uint32) {
        if (state == 0) state = 0x6d2b79f5;
        state ^= state << 13;
        state ^= state >> 17;
        state ^= state << 5;
        return state;
    }

    function _applyPuzzleMove(uint8[16] memory board, uint8 direction)
        private pure returns (uint8[16] memory nextBoard, bool moved, uint32 scoreIncrease)
    {
        for (uint8 line; line < 4; ++line) {
            uint8[4] memory values;
            uint8 count;
            for (uint8 offset; offset < 4; ++offset) {
                uint8 index = _puzzleIndex(line, offset, direction);
                if (board[index] != 0) values[count++] = board[index];
            }

            uint8[4] memory compacted;
            uint8 outputCount;
            for (uint8 i; i < count; ++i) {
                uint8 value = values[i];
                if (i + 1 < count && values[i + 1] == value) {
                    value += 1;
                    scoreIncrease += uint32(1) << value;
                    i += 1;
                }
                compacted[outputCount++] = value;
            }

            for (uint8 offset; offset < 4; ++offset) {
                uint8 index = _puzzleIndex(line, offset, direction);
                nextBoard[index] = compacted[offset];
                if (nextBoard[index] != board[index]) moved = true;
            }
        }
    }

    function _puzzleIndex(uint8 line, uint8 offset, uint8 direction) private pure returns (uint8) {
        if (direction == 0) return line * 4 + offset;
        if (direction == 1) return line * 4 + (3 - offset);
        if (direction == 2) return offset * 4 + line;
        return (3 - offset) * 4 + line;
    }

    function _puzzleOver(uint8[16] memory board) private pure returns (bool) {
        for (uint8 row; row < 4; ++row) {
            for (uint8 column; column < 4; ++column) {
                uint8 index = row * 4 + column;
                if (board[index] == 0) return false;
                if (column < 3 && board[index] == board[index + 1]) return false;
                if (row < 3 && board[index] == board[index + 4]) return false;
            }
        }
        return true;
    }

    function _settlePuzzle(address player, PuzzleRound storage round, bool cashedOut)
        private returns (uint256 goldEarned)
    {
        uint256 numerator = round.mode == 0 ? 3 : round.mode == 1 ? 1 : 5;
        uint256 denominator = round.mode == 0 ? 8 : round.mode == 1 ? 2 : 8;
        goldEarned = uint256(round.score) * numerator / denominator;
        round.active = false;
        goldBalances[player] += goldEarned;
        emit PuzzleRoundSettled(player, round.seed, round.mode, round.moves, round.score, goldEarned, cashedOut);
    }

    function _checkBatch(uint64 expected, uint256 length, uint64 actual) private pure {
        if (expected != actual) revert CursorMismatch(expected, actual);
        if (length == 0 || length > MAX_BATCH) revert InvalidBatch();
    }

    function _apply(Island storage game, uint8 action) private {
        uint8 index = action / 4;
        uint8 habitat = action % 4;
        if (index >= 49 || !_placeable(index)) revert InvalidAction(action);
        uint8 region = index % 7 <= 1 ? 0 : index % 7 == 2 ? 1 : index % 7 == 3 ? 2 : index % 7 <= 5 ? 3 : 4;
        if (region > game.unlockedThrough) revert LockedRegion();
        uint8 current = game.habitats[index];
        if (habitat == 0) {
            if (current == 0) revert EmptyCell();
            game.inventory[current - 1] += 1;
            game.habitats[index] = 0;
        } else {
            if (current != 0) revert Occupied();
            if (game.inventory[habitat - 1] == 0) revert InsufficientResource(habitat);
            game.inventory[habitat - 1] -= 1;
            game.habitats[index] = habitat;
        }
        game.cursor += 1;
        _unlock(game);
    }

    function _unlock(Island storage game) private {
        uint8[5] memory threshold = [uint8(0), 2, 4, 7, 10];
        while (game.unlockedThrough < 4 && _healthyCount(game, game.unlockedThrough) >= threshold[game.unlockedThrough + 1]) {
            uint8 region = game.unlockedThrough + 1;
            game.unlockedThrough = region;
            if (!game.claimed[region]) {
                game.claimed[region] = true;
                if (region == 1) { game.inventory[0] += 1; game.inventory[1] += 2; }
                else if (region == 2) { game.inventory[1] += 1; game.inventory[2] += 2; }
                else if (region == 3) { game.inventory[0] += 1; game.inventory[1] += 2; }
                else { game.inventory[0] += 1; game.inventory[2] += 1; }
                uint256 week = currentWeek();
                weeklyContributions[week] += 1;
                emit RegionUnlocked(msg.sender, region, week);
            }
        }
    }

    function _placeable(uint8 index) private pure returns (bool) {
        uint8 x = index % 7;
        uint8 y = index / 7;
        if (x >= 1 && x <= 5 && y >= 1 && y <= 5) return true;
        return (y == 0 && (x == 1 || x == 2 || x == 4)) || (x == 0 && y == 1);
    }

    function _healthy(Island storage game, uint8 index) private view returns (bool) {
        uint8 habitat = game.habitats[index];
        if (habitat == 0 || habitat == 1) return habitat == 1;
        bool water;
        bool grass;
        uint8 x = index % 7;
        uint8 y = index / 7;
        if (x > 0) { uint8 n = index - 1; water = water || game.habitats[n] == 1; grass = grass || (game.habitats[n] == 2 && _grassHealthy(game, n)); }
        if (x < 6) { uint8 n = index + 1; water = water || game.habitats[n] == 1; grass = grass || (game.habitats[n] == 2 && _grassHealthy(game, n)); }
        if (y > 0) { uint8 n = index - 7; water = water || game.habitats[n] == 1; grass = grass || (game.habitats[n] == 2 && _grassHealthy(game, n)); }
        if (y < 6) { uint8 n = index + 7; water = water || game.habitats[n] == 1; grass = grass || (game.habitats[n] == 2 && _grassHealthy(game, n)); }
        return habitat == 2 ? water : water && grass;
    }

    function _grassHealthy(Island storage game, uint8 index) private view returns (bool) {
        uint8 x = index % 7;
        uint8 y = index / 7;
        return (x > 0 && game.habitats[index - 1] == 1) || (x < 6 && game.habitats[index + 1] == 1)
            || (y > 0 && game.habitats[index - 7] == 1) || (y < 6 && game.habitats[index + 7] == 1);
    }

    function _healthyCount(Island storage game, uint8 through) private view returns (uint8 total) {
        for (uint8 i; i < 49; ++i) if (i % 7 <= (through == 0 ? 1 : through == 1 ? 2 : through == 2 ? 3 : through == 3 ? 5 : 6) && _healthy(game, i)) ++total;
    }

    function _healthyForestCount(Island storage game) private view returns (uint8 total) {
        for (uint8 i; i < 49; ++i) if (game.habitats[i] == 3 && _healthy(game, i)) ++total;
    }

    function _heartPath(Island storage game) private view returns (bool) {
        // A healthy forest must be adjacent to the fixed Heart at row 3, column 6.
        return game.habitats[26] == 3 && _healthy(game, 26);
    }
}
