import { BOARD_SIZE, REGIONS, type Cell } from './types';
import { healthyAt, orthogonalNeighbors } from './rules';
import { CHARACTER_REGISTRY } from './characterRegistry';

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

export function visibleResidents(healthy: number, forests: number): Resident[] {
  return CHARACTER_REGISTRY.filter(
    (resident) => healthy >= resident.unlockHealthy && forests >= resident.unlockForests,
  ).map(({ id, name, kind, home }) => ({ id, name, kind, x: home.x, y: home.y }));
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
