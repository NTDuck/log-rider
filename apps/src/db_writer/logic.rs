use crate::normalization::models::NormalizedLog;
use std::time::{Duration, Instant};

pub struct BatchAccumulator {
    buffer: Vec<NormalizedLog>,
    row_threshold: usize,
    flush_interval: Duration,
    last_flush: Instant,
}

impl BatchAccumulator {
    pub fn new(row_threshold: usize, flush_interval: Duration) -> Self {
        Self {
            buffer: Vec::with_capacity(row_threshold),
            row_threshold,
            flush_interval,
            last_flush: Instant::now(),
        }
    }

    pub fn push(&mut self, log: NormalizedLog) -> Option<Vec<NormalizedLog>> {
        self.buffer.push(log);
        if self.buffer.len() >= self.row_threshold {
            let mut batch = Vec::with_capacity(self.row_threshold);
            std::mem::swap(&mut self.buffer, &mut batch);
            Some(batch)
        } else {
            None
        }
    }

    pub fn try_flush_by_timer(&mut self) -> Option<Vec<NormalizedLog>> {
        if !self.buffer.is_empty() && self.last_flush.elapsed() >= self.flush_interval {
            let mut batch = Vec::with_capacity(self.row_threshold);
            std::mem::swap(&mut self.buffer, &mut batch);
            Some(batch)
        } else {
            None
        }
    }

    pub fn try_flush_all(&mut self) -> Option<Vec<NormalizedLog>> {
        if !self.buffer.is_empty() {
            let mut batch = Vec::with_capacity(self.row_threshold);
            std::mem::swap(&mut self.buffer, &mut batch);
            Some(batch)
        } else {
            None
        }
    }

    pub fn reset_timer(&mut self) {
        self.last_flush = Instant::now();
    }
}
