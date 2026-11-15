//! Static navigation shared by monsters in a raid. Routes are cached by each
//! monster; the grid is built once, and searches have a fixed work budget.
use std::cmp::Reverse;
use std::collections::BinaryHeap;

use crate::map::Wall;

const CELL: f64 = 32.0;
pub const CLEARANCE: f64 = 16.0;

pub struct Navigation {
    cols: usize,
    rows: usize,
    blocked: Vec<bool>,
}

/// Segment against expanded wall rectangles (also used for sight and melee).
pub fn clear_path(walls: &[Wall], from: (f64, f64), to: (f64, f64), radius: f64) -> bool {
    !walls.iter().any(|w| {
        let mut near: f64 = 0.0;
        let mut far: f64 = 1.0;
        for (start, end, low, high) in [
            (from.0, to.0, w.x - radius, w.x + w.w + radius),
            (from.1, to.1, w.y - radius, w.y + w.h + radius),
        ] {
            let delta = end - start;
            if delta.abs() < 1e-9 {
                if start < low || start > high { return false; }
            } else {
                let a = (low - start) / delta;
                let b = (high - start) / delta;
                near = near.max(a.min(b));
                far = far.min(a.max(b));
                if near > far { return false; }
            }
        }
        true
    })
}

impl Navigation {
    pub fn new(width: f64, height: f64, walls: &[Wall]) -> Self {
        let cols = (width / CELL).ceil() as usize;
        let rows = (height / CELL).ceil() as usize;
        let mut nav = Self { cols, rows, blocked: vec![false; cols * rows] };
        for w in walls {
            let min_x = ((w.x - CLEARANCE) / CELL).floor().max(0.0) as usize;
            let max_x = ((w.x + w.w + CLEARANCE) / CELL).floor().max(0.0) as usize;
            let min_y = ((w.y - CLEARANCE) / CELL).floor().max(0.0) as usize;
            let max_y = ((w.y + w.h + CLEARANCE) / CELL).floor().max(0.0) as usize;
            for y in min_y..=max_y.min(rows - 1) {
                for x in min_x..=max_x.min(cols - 1) {
                    let p = nav.point(y * cols + x);
                    if p.0 >= w.x - CLEARANCE && p.0 <= w.x + w.w + CLEARANCE
                        && p.1 >= w.y - CLEARANCE && p.1 <= w.y + w.h + CLEARANCE {
                        nav.blocked[y * cols + x] = true;
                    }
                }
            }
        }
        for y in 0..rows {
            for x in 0..cols {
                let p = nav.point(y * cols + x);
                if p.0 < CLEARANCE || p.1 < CLEARANCE || p.0 > width - CLEARANCE || p.1 > height - CLEARANCE {
                    nav.blocked[y * cols + x] = true;
                }
            }
        }
        nav
    }

    fn point(&self, i: usize) -> (f64, f64) {
        (((i % self.cols) as f64 + 0.5) * CELL, ((i / self.cols) as f64 + 0.5) * CELL)
    }

    fn cell(&self, p: (f64, f64), walls: &[Wall], require_clear: bool) -> Option<usize> {
        let cx = (p.0 / CELL) as isize;
        let cy = (p.1 / CELL) as isize;
        // A destination can be a solid nest core. Stop at its nearest free cell.
        let mut best = None;
        let mut distance = f64::INFINITY;
        for dy in -3..=3 {
            for dx in -3..=3 {
                let (x, y) = (cx + dx, cy + dy);
                if x < 0 || y < 0 || x >= self.cols as isize || y >= self.rows as isize { continue; }
                let i = y as usize * self.cols + x as usize;
                let q = self.point(i);
                let d = f64::hypot(q.0 - p.0, q.1 - p.1);
                if !self.blocked[i] && d < distance && (!require_clear || clear_path(walls, p, q, CLEARANCE)) {
                    distance = d;
                    best = Some(i);
                }
            }
        }
        best
    }

    /// Waypoints in reverse order so the next step can be popped cheaply.
    pub fn route(&self, from: (f64, f64), to: (f64, f64), walls: &[Wall]) -> Vec<(f64, f64)> {
        let Some(start) = self.cell(from, walls, true) else { return Vec::new() };
        let Some(goal) = self.cell(to, walls, false) else { return Vec::new() };
        let mut costs = vec![usize::MAX; self.blocked.len()];
        let mut parent = vec![usize::MAX; self.blocked.len()];
        let heuristic = |i: usize| (i % self.cols).abs_diff(goal % self.cols) + (i / self.cols).abs_diff(goal / self.cols);
        let mut open = BinaryHeap::new();
        costs[start] = 0;
        open.push(Reverse((heuristic(start), 0, start)));
        let mut visited = 0;
        while let Some(Reverse((_, cost, i))) = open.pop() {
            if cost != costs[i] { continue; }
            if i == goal {
                let mut path = if clear_path(walls, self.point(goal), to, CLEARANCE) { vec![to] } else { Vec::new() };
                let mut step = goal;
                while step != start {
                    path.push(self.point(step));
                    step = parent[step];
                }
                path.push(self.point(start));
                return path;
            }
            visited += 1;
            if visited > 4096 { break; }
            let (x, y) = (i % self.cols, i / self.cols);
            for (nx, ny) in [(x.wrapping_sub(1), y), (x + 1, y), (x, y.wrapping_sub(1)), (x, y + 1)] {
                if nx >= self.cols || ny >= self.rows { continue; }
                let next = ny * self.cols + nx;
                if self.blocked[next] || cost + 1 >= costs[next] { continue; }
                costs[next] = cost + 1;
                parent[next] = i;
                open.push(Reverse((cost + 1 + heuristic(next), cost + 1, next)));
            }
        }
        Vec::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sight_is_blocked_by_walls_but_passes_doorways() {
        let walls = vec![Wall::new(200.0, 0.0, 20.0, 180.0), Wall::new(200.0, 270.0, 20.0, 200.0)];
        assert!(!clear_path(&walls, (100.0, 100.0), (300.0, 100.0), 0.0));
        assert!(clear_path(&walls, (100.0, 220.0), (300.0, 220.0), CLEARANCE));
    }

    #[test]
    fn routes_go_through_a_door_and_never_cross_walls() {
        let walls = vec![Wall::new(200.0, 0.0, 20.0, 180.0), Wall::new(200.0, 270.0, 20.0, 210.0)];
        let nav = Navigation::new(480.0, 480.0, &walls);
        let start = (100.0, 100.0);
        let mut path = nav.route(start, (300.0, 100.0), &walls);
        assert!(!path.is_empty());
        let mut last = start;
        while let Some(next) = path.pop() {
            assert!(clear_path(&walls, last, next, CLEARANCE), "route crosses a wall: {last:?} -> {next:?}");
            last = next;
        }
        assert_eq!(last, (300.0, 100.0));
    }
}
