use thiserror::Error;

/// Errors that can occur when applying an operation to a [`crate::TextCrdt`].
#[derive(Debug, Error, PartialEq, Eq)]
pub enum ApplyError {
    /// Insert or delete refers to an index outside the visible text.
    #[error("index {index} is outside document length {length}")]
    OutOfRange { index: usize, length: usize },

    /// Negative or otherwise malformed counts passed to local edit helpers.
    #[error("delete count must be positive (got {0})")]
    InvalidCount(i64),
}

/// Public error type re-exported from [`crate`].
pub type CrdtError = ApplyError;
