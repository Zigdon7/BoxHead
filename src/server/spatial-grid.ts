export interface Positioned {
  pos: { x: number; y: number };
}

export class SpatialGrid<T extends Positioned> {
  private cells: Map<number, T[]> = new Map();
  private cols: number;
  private rows: number;

  constructor(
    mapWidth: number,
    mapHeight: number,
    private cellSize: number
  ) {
    this.cols = Math.ceil(mapWidth / cellSize);
    this.rows = Math.ceil(mapHeight / cellSize);
  }

  clear(): void {
    this.cells.clear();
  }

  private getKey(x: number, y: number): number {
    const col = Math.max(0, Math.min(this.cols - 1, Math.floor(x / this.cellSize)));
    const row = Math.max(0, Math.min(this.rows - 1, Math.floor(y / this.cellSize)));
    return row * this.cols + col;
  }

  insert(entity: T): void {
    const key = this.getKey(entity.pos.x, entity.pos.y);
    let cell = this.cells.get(key);
    if (!cell) {
      cell = [];
      this.cells.set(key, cell);
    }
    cell.push(entity);
  }

  insertAll(entities: T[]): void {
    for (const e of entities) {
      this.insert(e);
    }
  }

  /** Query all entities within a radius of (x, y). */
  query(x: number, y: number, radius: number): T[] {
    const results: T[] = [];
    const minCol = Math.max(0, Math.floor((x - radius) / this.cellSize));
    const maxCol = Math.min(this.cols - 1, Math.floor((x + radius) / this.cellSize));
    const minRow = Math.max(0, Math.floor((y - radius) / this.cellSize));
    const maxRow = Math.min(this.rows - 1, Math.floor((y + radius) / this.cellSize));

    for (let row = minRow; row <= maxRow; row++) {
      for (let col = minCol; col <= maxCol; col++) {
        const cell = this.cells.get(row * this.cols + col);
        if (cell) {
          for (const e of cell) {
            results.push(e);
          }
        }
      }
    }
    return results;
  }

  /** Query all entities within a rectangle. */
  queryRect(x: number, y: number, w: number, h: number): T[] {
    const results: T[] = [];
    const minCol = Math.max(0, Math.floor(x / this.cellSize));
    const maxCol = Math.min(this.cols - 1, Math.floor((x + w) / this.cellSize));
    const minRow = Math.max(0, Math.floor(y / this.cellSize));
    const maxRow = Math.min(this.rows - 1, Math.floor((y + h) / this.cellSize));

    for (let row = minRow; row <= maxRow; row++) {
      for (let col = minCol; col <= maxCol; col++) {
        const cell = this.cells.get(row * this.cols + col);
        if (cell) {
          for (const e of cell) {
            results.push(e);
          }
        }
      }
    }
    return results;
  }
}
