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

// START AND POLL, NOT RUN-SYNC. Apify's synchronous endpoint carries a platform
// ceiling of 300 seconds on the HTTP wait and answers 408 past it while the run
// keeps going and keeps billing. Starting the run, polling it to a terminal
// status, and then reading the dataset waits as long as the actor needs.
//
// How long the actor run itself may take, in seconds: long enough for a large
// batch, short enough that a hung run cannot bill indefinitely.
const ACTOR_RUN_TIMEOUT_SECS = 1800;
// How long this wrapper waits: the run's own timeout plus two minutes, so the
// run's TIMED-OUT status is what the caller sees.
const WRAPPER_WAIT_MS = (ACTOR_RUN_TIMEOUT_SECS + 120) * 1000;
const POLL_INTERVAL_MS = Number(process.env.MAMBA_POLL_INTERVAL_MS ?? 3000);
const TERMINAL = new Set(["SUCCEEDED", "FAILED", "TIMED-OUT", "ABORTED", "ABORTING"]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

  const headers = {
    Authorization: `Bearer ${APIFY_TOKEN}`,
    "Content-Type": "application/json",
    "User-Agent": USER_AGENT,
  };

  const httpError = async (response: Response): Promise<string> => {
    let detail = "";
    try {
      const body = (await response.json()) as { error?: { message?: string } };
      if (body?.error?.message) detail = ` ${body.error.message}`;
    } catch {
      detail = "";
    }
    switch (response.status) {
      case 400:
        return `The ${actorLabel} run was rejected as invalid input.${detail}`;
      case 401:
        return "Invalid Apify token. Check your APIFY_TOKEN environment variable.";
      case 402:
        return "Insufficient Apify credits. Check your account balance at https://console.apify.com/billing";
      default:
        return `Apify request to ${actorLabel} failed with status ${response.status}.${detail}`;
    }
  };

  // 1. Start the run.
  let started: Response;
  try {
    started = await fetch(
      `https://api.apify.com/v2/acts/${actorPath}/runs?timeout=${ACTOR_RUN_TIMEOUT_SECS}`,
      { method: "POST", headers, body: JSON.stringify(input) },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: "text", text: `Could not reach the Apify API: ${message}` }] };
  }
  if (!started.ok) {
    return { isError: true, content: [{ type: "text", text: await httpError(started) }] };
  }

  let run: { id?: string; status?: string; defaultDatasetId?: string };
  try {
    run = ((await started.json()) as { data?: typeof run }).data ?? {};
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: "text", text: `The ${actorLabel} run start returned a response that could not be parsed: ${message}` }] };
  }
  const runId = run.id;
  if (!runId) {
    return { isError: true, content: [{ type: "text", text: `The ${actorLabel} run start returned no run id, so there is nothing to wait for.` }] };
  }

  // 2. Poll to a terminal status.
  const deadline = Date.now() + WRAPPER_WAIT_MS;
  let status = run.status ?? "READY";
  let datasetId = run.defaultDatasetId;
  while (!TERMINAL.has(status)) {
    if (Date.now() >= deadline) {
      return {
        isError: true,
        content: [{ type: "text", text: `The ${actorLabel} run ${runId} was still ${status} after ${Math.round(WRAPPER_WAIT_MS / 1000)} seconds and this call stopped waiting. The run itself is still on Apify: read it at https://console.apify.com/actors/runs/${runId}` }],
      };
    }
    await sleep(POLL_INTERVAL_MS);
    let poll: Response;
    try {
      poll = await fetch(`https://api.apify.com/v2/actor-runs/${runId}`, { headers });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { isError: true, content: [{ type: "text", text: `Lost contact with the Apify API while waiting for ${actorLabel} run ${runId}: ${message}` }] };
    }
    if (!poll.ok) {
      return { isError: true, content: [{ type: "text", text: await httpError(poll) }] };
    }
    const body = (await poll.json()) as { data?: { status?: string; defaultDatasetId?: string } };
    status = body.data?.status ?? status;
    datasetId = body.data?.defaultDatasetId ?? datasetId;
  }

  // 3. A run that did not succeed is a failure the caller must see, never an
  // empty success.
  if (status !== "SUCCEEDED") {
    return {
      isError: true,
      content: [{ type: "text", text: `The ${actorLabel} run did not succeed (run ID: ${runId}, status: ${status}).` }],
    };
  }
  if (!datasetId) {
    return { isError: true, content: [{ type: "text", text: `The ${actorLabel} run ${runId} succeeded but reported no dataset, so there is nothing to return.` }] };
  }

  // 4. Read the dataset. Pass actor output through unchanged: the wrapper never
  // reinterprets a status field.
  let ds: Response;
  try {
    ds = await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items?format=json`, { headers });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: "text", text: `Could not read the ${actorLabel} dataset: ${message}` }] };
  }
  if (!ds.ok) {
    return { isError: true, content: [{ type: "text", text: await httpError(ds) }] };
  }

  let items: unknown;
  try {
    items = await ds.json();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: "text", text: `The ${actorLabel} run returned a response that could not be parsed: ${message}` }] };
  }

  if (!Array.isArray(items)) {
    const asObj = items as { error?: { type?: string; message?: string } };
    const detail = asObj?.error?.message ? `${asObj.error.message}` : JSON.stringify(items);
    return { isError: true, content: [{ type: "text", text: `The ${actorLabel} run did not return a dataset. ${detail}` }] };
  }

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
        .min(10)
        .max(300)
        .optional()
        .describe("Cap on how many candidate sending domains are probed per company, 10 to 300, default 80. Lower it to bound run time and cost on companies with many lookalike domains."),
      request_timeout_ms: z
        .number()
        .int()
        .min(3000)
        .max(20000)
        .optional()
        .describe("Per HTTP request timeout in milliseconds, 3000 to 20000, default 9000."),
      dns_timeout_ms: z
        .number()
        .int()
        .min(1000)
        .max(15000)
        .optional()
        .describe("Per DNS lookup timeout in milliseconds, 1000 to 15000, default 4000."),
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
