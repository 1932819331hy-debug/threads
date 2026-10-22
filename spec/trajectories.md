# Trajectory JSONL v1

`exportTrajectories(store, { threads, since })` / `export_trajectories(store,
threads=..., since=...)` returns UTF-8 bytes in a Result. It reads the tenant view
of the supplied Store and never dispatches models, tools or sandbox operations.

One RFC 8785 canonical JSON object plus LF is emitted per `user_input` closed by
`turn_completed`. All completion reasons are retained, including failures; an
open, parked or interrupted tail without `turn_completed` contributes no line.
Completed earlier turns are retained even if the thread currently has an open turn.

A line has `format_version: 1`, `thread_id`, `branch_id` (the branch that recorded
the completion), `turn_id` (the opening user_input event id), `started_at`,
`completed_at` (Unix epoch milliseconds), `completion` (turn_completed data),
`messages`, `tool_calls` and `tool_results`. Every array entry carries `event_id`
and `seq`; sorting these entries by seq reconstructs their interleaving.

- `messages`: user_input/steer become role `user`, model_response and
  model_response_recovered become role `assistant`. Content parts are the log's
  ordered parts; plain input text becomes one text part. Assistant messages keep
  `completeness` and `stop_reason`. Summarizer/compaction responses are omitted.
- `tool_calls`: schema-admitted calls, with their original `data` (call_id, name,
  input and request_event_id), separate from proposed tool_use content parts.
- `tool_results`: original `type` and `data`, preserving error, completeness,
  deferred placeholders, late results and spill refs. A late result belongs to
  the turn during which it was recorded; an idle late result is not a new turn.

This is a provider-neutral turn format, not a provider's fine-tuning upload
schema. A training consumer can join tool calls/results on call_id, inspect the
completion reason and flatten messages to its target format. It does not promise
to reconstruct the full model request: system settings, prior-turn context,
hook/context edits and artifact bytes are not copied. Artifact references remain
references. Use the existing portable bundle when artifact bytes are needed.

## Selection and ordering

`threads` omitted selects all readable branches owned by the Store's tenant;
`threads: []` selects nothing. A specified thread not owned by the tenant is
`not_found`, indistinguishable from a missing thread. Duplicate IDs are ignored.
Fork ancestor turns are emitted only from the branch that recorded their
completion, avoiding duplicate training rows. An inherited open turn completed
on a child is emitted with that child's branch_id.

`since` is an optional non-negative safe integer, inclusive on the completion
event's timestamp. Clocks do not order records. Records sort by lowercase thread
UUID, branch UUID, then completion sequence; arrays preserve event sequence.
Invalid options are `ConfigError invalid_config`. A corrupt, unsupported or
unverified selected log aborts the whole export; partial bytes are never returned.

The exporter reads already-redacted logs and never resolves secrets or reads the
environment. Registered secrets in the resulting bytes fail closed with
`secret_in_stored_bytes`. Unregistered strings are not guessed to be secrets.

## CLI

`threadsai export --jsonl [--thread UUID]... [--since MILLISECONDS]`

Use the existing global `--store` and `--tenant` options (before `export` in
Python). `--jsonl` cannot be combined with a positional branch or `--bundle`.
Thread/since filters require `--jsonl`. With no --jsonl, raw branch and portable
bundle exports keep their current behavior.
