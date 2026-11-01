# Session

The [repository guide](../../../AGENTS.md) applies. This directory owns JSONL records, locks, recovery, branching, listing, compaction, and derived files.

- The optional header is not an event; sequence numbers start at zero. Read incomplete final lines without modifying the record; only locked writable recovery repairs a partial tail.
- Reject unsupported record versions and unknown required event kinds. Only explicitly ignorable informational events may be skipped by older readers. Recovery writes `tool_outcome_unknown` for unresolved calls and **never replays** them.
- A branch point must be a completed turn. Preserve the parent, project attribution, and required event prefix. Listing, search, and rendering are read-only.
- `modelView()` is the model-message projection. Do not include display-only data in model context by accident. Checkpoints, compaction summaries, and spill files are derived: validate version, event range, digest, and paths; on invalid checkpoints rebuild from JSONL. Never truncate or rewrite source records during compaction.
- Preserve session directory overrides and project identity. Do not infer a project for headerless legacy records. Migrate an explicitly opened legacy record under source/destination locks, retain the original, and reject conflicts or locked sources.
- Treat unreadable records as errors rather than empty sessions. Cancelled compaction and provider failures must retain the original record.

Use existing record, recovery, locking, branching, paging, and compaction tests; run `pnpm test` for the full suite.
