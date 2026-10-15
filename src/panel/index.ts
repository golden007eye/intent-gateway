// The read-only local web panel on 127.0.0.1: chain status, disclosures, pending approvals, the approver pin.
export { CSP, type Panel, PANEL_HOST, PanelError, type PanelOptions, startPanel } from "./server.ts";
export { buildView, type Fingerprint, type PendingApproval, type Row, type View } from "./view.ts";
