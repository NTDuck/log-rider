use crate::ai_tag_db::models::AITagMessage;

pub struct AITagBatchAccumulator {
    pub buffer: Vec<AITagMessage>,
    pub limit: usize,
}

impl AITagBatchAccumulator {
    pub fn new(limit: usize) -> Self {
        Self {
            buffer: Vec::with_capacity(limit),
            limit,
        }
    }

    pub fn push(&mut self, tag: AITagMessage) -> Option<Vec<AITagMessage>> {
        self.buffer.push(tag);
        if self.buffer.len() >= self.limit {
            let flush_batch = std::mem::replace(&mut self.buffer, Vec::with_capacity(self.limit));
            Some(flush_batch)
        } else {
            None
        }
    }

    pub fn flush_remaining(&mut self) -> Option<Vec<AITagMessage>> {
        if !self.buffer.is_empty() {
            let flush_batch = std::mem::replace(&mut self.buffer, Vec::with_capacity(self.limit));
            Some(flush_batch)
        } else {
            None
        }
    }
}
