#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(join(here, "..", "package.json"), "utf8"),
) as { version: string; name: string };

// Distinctive UA so Apify run meta.userAgent marks MCP-originated runs.
const USER_AGENT = `mambalabs-mcp ${pkg.name}@${pkg.version}`;

const APIFY_TOKEN = process.env.APIFY_TOKEN;

type ToolResult = {
  isError?: boolean;
  content: Array<{ type: "text"; text: string }>;
};

// Drop undefined values so optional inputs are not sent to the actor.
function compact(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

// Shared caller. actorPath is the actor's immutable Apify actor ID (a stable key
// that survives Store renames). The /v2/acts/{id} endpoint accepts it directly,
// so a Store rename never breaks these calls.
async function runActor(
  actorPath: string,
  actorLabel: string,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  if (!APIFY_TOKEN) {
    return { isError: true, content: [{ type: "text", text: "APIFY_TOKEN is not set. Create a token at https://console.apify.com/account/integrations and set it as the APIFY_TOKEN environment variable." }] };
  }

  const url = `https://api.apify.com/v2/acts/${actorPath}/run-sync-get-dataset-items?timeout=300`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${APIFY_TOKEN}`,
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
      },
      body: JSON.stringify(input),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: "text", text: `Could not reach the Apify API: ${message}` }] };
  }

  if (!response.ok) {
    let detail = "";
    try {
      const body = (await response.json()) as { error?: { message?: string } };
      if (body?.error?.message) detail = ` ${body.error.message}`;
    } catch {
      detail = "";
    }

    let message: string;
    switch (response.status) {
      case 401:
        message = "Invalid Apify token. Check your APIFY_TOKEN environment variable.";
        break;
      case 402:
        message =
          "Insufficient Apify credits. Check your account balance at https://console.apify.com/billing";
        break;
      case 408:
        message = `The ${actorLabel} run timed out after 300 seconds. Try a smaller batch, or run the actor on Apify directly for longer jobs.`;
        break;
      default:
        message = `Apify request to ${actorLabel} failed with status ${response.status}.${detail}`;
    }
    return { isError: true, content: [{ type: "text", text: message }] };
  }

  const items = await response.json();
  return { content: [{ type: "text", text: JSON.stringify(items, null, 2) }] };
}

const server = new McpServer({
  name: "mamba-outbound-infrastructure-fingerprint",
  version: pkg.version,
});

// Outbound Infrastructure Fingerprint (immutable actor ID v43UJC8r7qW7cBSTG)
server.registerTool(
  "fingerprint_outbound_infrastructure",
  {
    title: "Fingerprint Outbound Infrastructure",
    description:
      "Given a company domain, determine whether that company runs cold email outbound and on what stack. Returns a runs_outbound verdict of program (a deliberate cold outbound setup), light (one weak signal), none, or unknown, plus the evidence behind it. The strongest signal is the lookalike sending domains a real outbound program leaves behind: domains like getcompany.com or company-mail.com that carry their own mail and redirect back to the primary site. Also returns the inbox provider (Google Workspace, Microsoft 365 and others) for the primary domain and each sending domain, any detected sending platform (Outreach, Salesloft, Lemlist, Instantly, Smartlead, Apollo and more), registration clusters showing sending domains bought on the same day, cold email infrastructure vendors, and deliverability posture (SPF, DKIM, DMARC). Note that sending platform recall is partial by design: sequencers that connect over OAuth to a customer's own mailbox leave no DNS trace, so an empty sending_platforms means little while a populated one is solid. Public DNS and HTTP redirects only, no login, no mailbox access. Returns flat Clay-ready JSON. Read-only; requires an APIFY_TOKEN and consumes Apify credits per domain analyzed.",
    annotations: {
      title: "Fingerprint Outbound Infrastructure",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      domain: z
        .string()
        .optional()
        .describe("A single company domain, e.g. smartlead.ai. Provide either domain or domains."),
      domains: z
        .array(z.string())
        .optional()
        .describe("Batch mode: several company domains analyzed in one call. Takes precedence over domain."),
      scan_sending_domains: z
        .boolean()
        .optional()
        .describe("Scan for lookalike sending domains. Default true. This is the strongest signal and the slowest step; turning it off makes runs fast but caps the verdict at what platform and deliverability signals alone can prove."),
      sending_domain_depth: z
        .enum(["deep", "standard"])
        .optional()
        .describe("deep (default) checks .com, .co, .io, .net and .org. standard drops .net and .org for slightly fewer DNS lookups, at the cost of missing sending domains on those TLDs."),
      check_deliverability: z
        .boolean()
        .optional()
        .describe("Add a blacklist check and a 0-100 health score by running the separate Domain Deliverability Checker actor, which bills its own per-domain rate on top of this one. Default false. SPF, DKIM and DMARC are read from DNS either way."),
      skipCache: z
        .boolean()
        .optional()
        .describe("Force a fresh analysis and ignore the 7 day result cache."),
      max_sending_domain_probes: z
        .number()
        .int()
        .optional()
        .describe("Cap on how many candidate sending domains are probed per company. Lower it to bound run time and cost on companies with many lookalike domains."),
      request_timeout_ms: z
        .number()
        .int()
        .optional()
        .describe("Per-HTTP-request timeout in milliseconds."),
      dns_timeout_ms: z
        .number()
        .int()
        .optional()
        .describe("Per-DNS-lookup timeout in milliseconds."),
    },
  },
  async ({ domain, domains, scan_sending_domains, sending_domain_depth, check_deliverability, skipCache, max_sending_domain_probes, request_timeout_ms, dns_timeout_ms }) => {
    const hasSingle = domain !== undefined && domain !== "";
    const hasBatch = Array.isArray(domains) && domains.length > 0;
    if (!hasSingle && !hasBatch) {
      return {
        isError: true,
        content: [{ type: "text", text: "Provide either domain (a single company domain) or domains (an array)." }],
      };
    }
    return runActor(
      "v43UJC8r7qW7cBSTG",
      "Outbound Infrastructure Fingerprint",
      compact({
        domain: hasBatch ? undefined : domain,
        domains: hasBatch ? domains : undefined,
        scan_sending_domains,
        sending_domain_depth,
        check_deliverability,
        skipCache,
        max_sending_domain_probes,
        request_timeout_ms,
        dns_timeout_ms,
      }),
    );
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
