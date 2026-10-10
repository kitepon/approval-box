# Connector routing after session replacement

Connector 0.1.13 uses these additive `/connector/v1` changes. Existing clients may omit route in amend. No app/Web API changes.

- `POST /decisions/:id/amend`: optional `route: {channel_id, harness}`. Updates route atomically with a successful version-checked amendment; rejected amendments leave route unchanged.
- `POST /decisions/:id/resume`: body `{channel_id, harness}`. Restricted to the original connection. Pending/held requests transfer their route and increment version, recording history. Answered requests return the answer and mark delivery fetched. Cancelled requests are rejected. Unrelated requests remain unchanged.
- The local MCP exposes `resume_decision({decision_id})`, resolves the calling parent, and includes `steer_channel` plus receive instructions when necessary. `amend_decision` resolves the calling parent too. Both are dispatch tools in hook registration.
- The daemon reconciles queued entries against server waiting deliveries. Removed requests have unclaimed messages withdrawn; changed routes only resend if withdrawing the old message succeeds. Emitted messages report delivered; claimed/ambiguous messages report unknown and are not resent.

Devices shared by several sessions must select requests explicitly. Listing all requests does not transfer ownership. Restarting a launcher does not automatically migrate routes.

## Claude Code process restart with the same session (connector 0.1.21)

A Claude channel is bound to the Claude process that opened it (pid plus start time). The shared delivery module stops waiting for a session when none of its channels has a live bound process, so that an answer is never emitted into another conversation.

Restarting the Claude app resumes the same conversation (same `session_id`) in a new process. Up to 0.1.20 the MCP reused the saved channel by `session_id` only. New requests after the restart were then routed to a channel bound to the dead process: the answer reached the device inbox (`queued`) but no hook emitted it, and the server stayed at `fetched` until the AI fetched it by itself (observed on Windows, 2026-10-10: K-52EM7S, K-D8CEZK, K-V3G6ZN).

From 0.1.21 the MCP reuses a saved Claude channel only when it is bound to the process that issued the current request (read from the `PreToolUse` record of that request). Otherwise it opens a new channel and remembers it. The old channel stays open: the waiter of the same session claims pending answers from all open channels of that session once one of them has a live process.

Not covered: an answer that arrives after a restart while the conversation makes no new Approval Box request. No channel of that session is bound to a live process until the next request, so the waiter ends and the answer waits in the inbox. The AI can still obtain it with `list_my_decisions` / `resume_decision`. This applies to Claude Code on macOS, Linux and Windows. Codex (Aiterm delivery), Cursor and Grok do not use this binding.
