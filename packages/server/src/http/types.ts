import type { Accounts } from "../accounts.ts";
import type { AppStore } from "../appstore.ts";
import type { Attachments } from "../attachments.ts";
import type { Db } from "../db.ts";
import type { Decisions } from "../decisions.ts";
import type { EventHub } from "../events.ts";
import type { KeySource } from "../oidc.ts";
import type { RemoteMcpOptions } from "../remote-mcp.ts";

export type Services = { db: Db; accounts: Accounts; decisions: Decisions; events: EventHub; publicUrl: string; diagnosticsAdminToken?: string; attachments?: Attachments; appStore?: AppStore; appleAudiences?: string[]; googleAudiences?: string[]; idKeys?: KeySource; webLogin?: { google_client_id?: string; apple_services_id?: string }; remoteMcp?: RemoteMcpOptions; shutdown?: AbortSignal };
