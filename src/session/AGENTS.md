# Session

The repository [Agent guide](../../AGENTS.md) applies here. This directory owns the JSONL record format, recovery, listing, branching, checkpoints, and compaction. The [architecture guide](../../docs/development/architecture.en.md) describes how these pieces fit together.

## Record and recovery

- The optional first-line header is metadata, not an event; event sequence numbers start at zero.
- Readers report an incomplete final line without changing the file. The writable recovery path repairs the tail while holding the lock, then continues after the last complete sequence number.
- Reject unsupported record versions and unknown non-ignorable event kinds. New informational events must be explicitly ignorable so older readers can skip them without dropping events required to rebuild a model request.
- Reopening a session repairs dispatched calls that lack results with `tool_outcome_unknown`. Never replay an unresolved call. Read-only listing and rendering paths must not modify records.
- A specified branch point must be a completed turn. Branch creation preserves the parent, its project attribution, and the record prefix needed by the new session.

## Projection and derived files

- `modelView()` is the only record-to-model projection. Keep display-only events out of model messages and checkpoint input unless the projection contract explicitly includes them.
- A checkpoint is a derived sidecar. Validate its format, range, and digest against the canonical event fields before using it; on failure, rebuild from the JSONL record. Compaction writes a checkpoint and never rewrites or truncates the source record.
- Spill files hold oversized tool results or summaries. Keep their references in the record or checkpoint and validate a referenced filename before opening it. Export must restore the complete content when the file is available.
- Compaction stays disabled when the model context window is unknown. A summary is written only when the resulting projection is smaller; cancellation and provider failures must preserve the source record.

## Listing and storage

- The default record directory is under `dataRoot()`; explicit `host.sessionDirectory` overrides it. Project-root filters use normalized workspace identity. Headerless records in a shared data directory have no inferred project attribution.
- Legacy adoption copies records and their sidecars under the source and destination locks and preserves the originals. Do not treat a read/list operation as a migration write.
- Listing and search are derived from the record files. Keep their errors visible; do not turn unreadable records into empty sessions.

## Verification

Run `npm test`; for changes here, cover record parsing, lock ownership, recovery, checkpoint validation, branch eligibility, listing, or compaction in the existing tests under `test/`.

