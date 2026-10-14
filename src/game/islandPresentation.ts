import { BOARD_SIZE, REGIONS, type Cell } from './types';
import { healthyAt, orthogonalNeighbors } from './rules';

export interface BoardBounds {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Resident {
  id: string;
  name: string;
  kind: 'animal' | 'villager' | 'spirit';
  x: number;
  y: number;
}

export function characterPresentationClasses(
  residentId: string,
  walking: boolean,
  facingLeft: boolean,
): string[] {
  return [
    `resident--${residentId}`,
    walking ? 'resident--walking' : 'resident--idle',
    ...(facingLeft ? ['resident--facing-left'] : []),
  ];
}

const cast: Array<
  Omit<Resident, 'x' | 'y'> & { x: number; y: number; healthy: number; forests: number }
> = [
  { id: 'pip', name: 'Pip the woodland scout', kind: 'animal', x: 1, y: 1, healthy: 0, forests: 0 },
  { id: 'moss', name: 'Moss the little slime', kind: 'animal', x: 2, y: 3, healthy: 3, forests: 0 },
  { id: 'tavi', name: 'Tavi the explorer', kind: 'villager', x: 1, y: 4, healthy: 4, forests: 0 },
  {
    id: 'luma',
    name: 'Luma the forest spirit',
    kind: 'spirit',
    x: 2,
    y: 5,
    healthy: 0,
    forests: 1,
  },
  {
    id: 'rowan',
    name: 'Rowan the caretaker',
    kind: 'villager',
    x: 4,
    y: 4,
    healthy: 7,
    forests: 1,
  },
];

export function visibleResidents(healthy: number, forests: number): Resident[] {
  return cast
    .filter((resident) => healthy >= resident.healthy && forests >= resident.forests)
    .map(({ id, name, kind, x, y }) => ({ id, name, kind, x, y }));
}

export function residentsNearCell(residents: Resident[], index: number): Resident[] {
  if (index < 0 || index >= BOARD_SIZE * BOARD_SIZE) return [];
  const x = index % BOARD_SIZE;
  const y = Math.floor(index / BOARD_SIZE);
  return residents.filter((resident) => Math.abs(resident.x - x) + Math.abs(resident.y - y) <= 1);
}

export function stepResident(
  resident: Resident,
  cells: Cell[],
  unlockedThrough: number,
  random: () => number = Math.random,
): Resident {
  const currentIndex = resident.y * BOARD_SIZE + resident.x;
  const currentCell = cells[currentIndex];
  const currentWalkable = Boolean(
    currentCell &&
    currentCell.terrain !== 'rock' &&
    currentCell.terrain !== 'heart' &&
    currentCell.terrain !== 'shore' &&
    currentCell.habitat !== 'water' &&
    REGIONS.findIndex((region) => region.id === currentCell.region) <= unlockedThrough,
  );
  const destinations = orthogonalNeighbors(currentIndex).filter((index) => {
    const cell = cells[index];
    return Boolean(
      cell &&
      cell.terrain !== 'rock' &&
      cell.terrain !== 'heart' &&
      cell.terrain !== 'shore' &&
      cell.habitat !== 'water' &&
      REGIONS.findIndex((region) => region.id === cell.region) <= unlockedThrough,
    );
  });
  if (!destinations.length || (currentWalkable && random() < 0.24)) return resident;
  const habitatStops = destinations.filter((index) => {
    const cell = cells[index];
    if (!cell?.habitat || !healthyAt(cells, index)) return false;
    return resident.kind === 'spirit'
      ? cell.habitat === 'forest'
      : resident.kind === 'villager'
        ? cell.habitat === 'grass'
        : true;
  });
  const route = habitatStops.length && random() < 0.35 ? habitatStops : destinations;
  const next = route[Math.min(route.length - 1, Math.floor(random() * route.length))]!;
  return { ...resident, x: next % BOARD_SIZE, y: Math.floor(next / BOARD_SIZE) };
}

export function logicalTileAtPoint(
  clientX: number,
  clientY: number,
  bounds: BoardBounds,
  size = BOARD_SIZE,
): number | null {
  if (bounds.width <= 0 || bounds.height <= 0) return null;
  const column = Math.floor(((clientX - bounds.left) / bounds.width) * size);
  const row = Math.floor(((clientY - bounds.top) / bounds.height) * size);
  if (column < 0 || column >= size || row < 0 || row >= size) return null;
  return row * size + column;
}

export function clampCameraOffset(offset: number, boardPixels: number, zoom: number): number {
  const limit = Math.max(0, (boardPixels * (zoom - 1)) / 2);
  return Math.max(-limit, Math.min(limit, offset));
}
