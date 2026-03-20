pub trait Positioned {
    fn pos(&self) -> (f64, f64);
}

pub struct SpatialGrid<T> {
    cells: Vec<Vec<T>>,
    cell_size: f64,
    cols: usize,
    rows: usize,
}

impl<T: Clone + Positioned> SpatialGrid<T> {
    pub fn new(map_width: f64, map_height: f64, cell_size: f64) -> Self {
        let cols = (map_width / cell_size).ceil() as usize;
        let rows = (map_height / cell_size).ceil() as usize;
        let cells = vec![Vec::new(); cols * rows];
        Self {
            cells,
            cell_size,
            cols,
            rows,
        }
    }

    fn key(&self, x: f64, y: f64) -> usize {
        let col = ((x / self.cell_size) as usize).min(self.cols - 1);
        let row = ((y / self.cell_size) as usize).min(self.rows - 1);
        row * self.cols + col
    }

    pub fn insert(&mut self, entity: T) {
        let (x, y) = entity.pos();
        let k = self.key(x, y);
        self.cells[k].push(entity);
    }

    pub fn insert_all(&mut self, entities: impl IntoIterator<Item = T>) {
        for entity in entities {
            self.insert(entity);
        }
    }

    pub fn clear(&mut self) {
        for cell in &mut self.cells {
            cell.clear();
        }
    }

    pub fn query(&self, x: f64, y: f64, radius: f64) -> Vec<&T> {
        self.query_rect(x - radius, y - radius, radius * 2.0, radius * 2.0)
    }

    pub fn query_rect(&self, x: f64, y: f64, w: f64, h: f64) -> Vec<&T> {
        let min_col = (x / self.cell_size).floor().max(0.0) as usize;
        let max_col = ((x + w) / self.cell_size)
            .floor()
            .max(0.0)
            .min((self.cols - 1) as f64) as usize;
        let min_row = (y / self.cell_size).floor().max(0.0) as usize;
        let max_row = ((y + h) / self.cell_size)
            .floor()
            .max(0.0)
            .min((self.rows - 1) as f64) as usize;

        let mut results = Vec::new();
        for row in min_row..=max_row {
            for col in min_col..=max_col {
                let k = row * self.cols + col;
                for entity in &self.cells[k] {
                    results.push(entity);
                }
            }
        }
        results
    }
}
