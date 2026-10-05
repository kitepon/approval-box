# Connector routing after session replacement

Connector 0.1.13 uses these additive `/connector/v1` changes. Existing clients may omit route in amend. No app/Web API changes.

- `POST /decisions/:id/amend`: optional `route: {channel_id, harness}`. Updates route atomically with a successful version-checked amendment; rejected amendments leave route unchanged.
- `POST /decisions/:id/resume`: body `{channel_id, harness}`. Restricted to the original connection. Pending/held requests transfer their route and increment version, recording history. Answered requests return the answer and mark delivery fetched. Cancelled requests are rejected. Unrelated requests remain unchanged.
- The local MCP exposes `resume_decision({decision_id})`, resolves the calling parent, and includes `steer_channel` plus receive instructions when necessary. `amend_decision` resolves the calling parent too. Both are dispatch tools in hook registration.
- The daemon reconciles queued entries against server waiting deliveries. Removed requests have unclaimed messages withdrawn; changed routes only resend if withdrawing the old message succeeds. Emitted messages report delivered; claimed/ambiguous messages report unknown and are not resent.

Devices shared by several sessions must select requests explicitly. Listing all requests does not transfer ownership. Restarting a launcher does not automatically migrate routes.
