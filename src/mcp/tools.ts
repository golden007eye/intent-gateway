// The three agent tools over MCP. The input schemas listed to agents are the gateway's own zod schemas, converted to
// JSON Schema, so what an agent is told it may send is exactly what the gateway accepts (AC-R1). Arguments reach the
// gateway as the agent sent them: the gateway scans the raw input for buyer identity (invariant 3) before it parses,
// so an extra `email` field is logged as blocked instead of being dropped unseen by a schema check here.
//
// Every result's text ends with the gateway's "Sent: … / Blocked: …" line (AC-D1, invariant 5): what left the
// machine on this call, in the gateway's words.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema, type CallToolResult, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Money, Offer } from "../contract/index.ts";
import {
  ApprovalStatusInput,
  type ApprovalStatusResult,
  CreateCartInput,
  type CreateCartResult,
  FindOffersInput,
  type FindOffersResult,
  type Gateway,
} from "../gateway/index.ts";

const LIMITS = "US delivery only.";

/** The tools in the order they are listed, with descriptions an agent reads to decide what to pass. */
export const TOOLS = {
  find_offers: {
    schema: FindOffersInput,
    description:
      "Find physical products that ship to a US address. Pass only what the user said: an exact product or a kind of " +
      "product, any must-haves, their budget in US dollars and their 5-digit US ZIP code. Never guess a ZIP code or a " +
      "budget. If the result lists missing details, ask the user only for those, then call again. " +
      `${LIMITS} The result ends with what this gateway sent to Intent Cloud and what it blocked.`,
  },
  create_cart: {
    schema: CreateCartInput,
    description:
      "Prepare a cart for the offer the user picked, using its offer_handle from find_offers. This does not buy " +
      "anything: every purchase needs a person to approve it with their passkey on their phone, through the link or " +
      "QR code in the result. Pass a quantity only if the user asked for one. " +
      `${LIMITS} The result ends with what this gateway sent to Intent Cloud and what it blocked.`,
  },
  get_approval_status: {
    schema: ApprovalStatusInput,
    description:
      "Check whether the person approved a purchase with their passkey, using the approval_handle from create_cart. " +
      "Only a passkey approval the gateway verified counts as approved; tell the user what the result says. " +
      "The result ends with what this gateway sent to Intent Cloud and what it blocked.",
  },
} as const;

type ToolName = keyof typeof TOOLS;

/** The JSON Schema an agent sees for a tool's input. */
export function inputJsonSchema(name: ToolName): Tool["inputSchema"] {
  return z.toJSONSchema(TOOLS[name].schema, { io: "input" }) as Tool["inputSchema"];
}

/**
 * Adds the three tools to an MCP server. Call before the server connects to a transport. The handlers go on the
 * protocol layer rather than through McpServer.registerTool, which would parse the arguments with the schema first
 * and so drop an identity field before the gateway could see and log it.
 */
export function registerTools(mcp: McpServer, gateway: Gateway, options: { banner?: string } = {}): void {
  const { banner } = options;
  const marked = (result: CallToolResult): CallToolResult =>
    banner === undefined ? result : { ...result, content: [{ type: "text", text: banner }, ...result.content] };
  const server = mcp.server;
  server.registerCapabilities({ tools: {} });
  const tools: Tool[] = (Object.keys(TOOLS) as ToolName[]).map((name) => ({
    name,
    description: TOOLS[name].description,
    inputSchema: inputJsonSchema(name),
  }));
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => marked(await call(request.params.name, request.params.arguments ?? {})));

  async function call(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    try {
      switch (name) {
        case "find_offers":
          return findOffersResult(await gateway.findOffers(args));
        case "create_cart":
          return createCartResult(await gateway.createCart(args));
        case "get_approval_status":
          return approvalStatusResult(await gateway.getApprovalStatus(args));
        default:
          return failure(`Unknown tool ${JSON.stringify(name)}. Tools: ${Object.keys(TOOLS).join(", ")}.`);
      }
    } catch (error) {
      // The gateway reports refusals as results; a throw means it could not run (not started, store failure).
      return failure(`The gateway could not run this tool: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function failure(text: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text }] };
}

/** The result text: the gateway's message, any details, then the Sent/Blocked line last. */
function told(result: { status: string; message: string; summary: string }, details: readonly string[] = []): CallToolResult {
  const text = [result.message, ...details, result.summary].filter((part) => part !== "").join("\n\n");
  return { isError: result.status === "invalid" || result.status === "error", content: [{ type: "text", text }] };
}

function findOffersResult(result: FindOffersResult): CallToolResult {
  if (result.status === "offers") return told(result, result.offers.length === 0 ? [] : [result.offers.map(offerLine).join("\n")]);
  return told(result);
}

function createCartResult(result: CreateCartResult): CallToolResult {
  if (result.status !== "approval_needed") return told(result);
  const { cart } = result;
  const details = [
    `Cart: ${String(cart.quantity)} × ${cart.item.title} (${cart.item.variant}) from ${cart.merchant.name}, ` +
      `total ${totalText(cart.total, cart.total_kind)}.`,
    `approval_handle: ${result.approval_handle}\nApproval link: ${result.approval_url}\nCheck code: ${result.check_code}`,
    `QR code for the approval link:\n${result.qr.text}`,
  ];
  const text = told(result, details);
  // The QR as an image for clients that show one; the text stays last so the result still ends with the summary.
  const gif = /^data:image\/gif;base64,(.+)$/.exec(result.qr.data_url)?.[1];
  return gif === undefined ? text : { ...text, content: [{ type: "image", data: gif, mimeType: "image/gif" }, ...text.content] };
}

function approvalStatusResult(result: ApprovalStatusResult): CallToolResult {
  if (result.status === "approved") {
    return told(result, [`Approver passkey fingerprint: ${result.fingerprint}`]);
  }
  return told(result);
}

function offerLine(offer: Offer): string {
  return (
    `- ${offer.title} (${offer.variant}) from ${offer.merchant.name}: ${money(offer.price)} + ${money(offer.shipping)} ` +
    `shipping${offer.total_kind === "max" ? " (at most)" : ""}, ${offer.availability.replace("_", " ")}. ` +
    `offer_handle: ${offer.offer_handle}`
  );
}

function totalText(total: Money, kind: "exact" | "max"): string {
  return kind === "max" ? `at most ${money(total)}` : money(total);
}

function money(value: Money): string {
  const cents = value.amount_minor % 100;
  return `$${String(Math.floor(value.amount_minor / 100))}.${String(cents).padStart(2, "0")}`;
}
