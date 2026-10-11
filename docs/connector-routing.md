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

Up to 0.1.21 one case stayed uncovered: an answer that arrives after a restart while the conversation makes no new Approval Box request. No channel of that session was bound to a live process until the next request, so the waiter ended and the answer waited in the inbox.

## Answers that arrive after a restart without a new request (connector 0.1.22)

Connector 0.1.22 uses `aiterm-steer-delivery` 0.4.4. The waiter now stays alive as long as the Claude Code process that started the hook is alive, and emits pending answers from every open channel of the same `session_id` into that process, in arrival order. It still takes nothing from channels of other conversations, and it takes nothing when the process that started the hook is gone.

`setup` additionally registers a `SessionStart` hook (`asyncRewake`). A resumed conversation is woken by answers that arrived while it was stopped, before it runs a turn. Without re-running `setup` the existing registration keeps working: the resumed conversation receives such answers at the end of its first turn.

Still not delivered: after `/clear` the conversation has a new `session_id` (use `list_my_decisions` / `resume_decision`). When two processes hold the same conversation, only one waiter exists and the first one receives the answer.

Scope: Claude Code on macOS, Linux and Windows. Codex (Aiterm delivery), Cursor and Grok do not use this binding.

## Sending the same delivery to the same channel again (connector 0.1.22)

The daemon sends each delivery to a channel once and follows it through its journal. It sends the same delivery ID to the same channel a second time only when that record is missing: the journal was lost while the server still lists the delivery, or two daemons picked up the same delivery at the same time.

`aiterm-steer-delivery` 0.4.4 rejects such a send with `CHANNEL_DELIVERY_DUPLICATE` and adds no second message, also while the first one is still in the inbox (up to 0.4.3 the second message was accepted there and the conversation showed the answer twice). The connector does not report this rejection as a failed delivery. It reads the state of the message that is already in the channel and follows it: `emitted` is reported as delivered, an unclaimed message stays queued. A delivery ID that was withdrawn from that channel is still rejected and reported as failed.
