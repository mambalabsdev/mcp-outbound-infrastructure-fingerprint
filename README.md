# Outbound Infrastructure Fingerprint MCP Server

[![npm](https://img.shields.io/npm/v/@mambalabsdev/mcp-outbound-infrastructure-fingerprint)](https://www.npmjs.com/package/@mambalabsdev/mcp-outbound-infrastructure-fingerprint)
[![MCP](https://img.shields.io/badge/MCP-server-blue)](https://modelcontextprotocol.io)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

MCP server for the Mamba Labs [Outbound Infrastructure Fingerprint](https://apify.com/mambalabs/outbound-infrastructure-fingerprint) actor on Apify.

Give it a company domain. It tells your agent whether that company runs cold email outbound, and on what stack.

## Tool

### `fingerprint_outbound_infrastructure`

| Input | Type | Notes |
|---|---|---|
| `domain` | string | One company domain. |
| `domains` | string[] | Batch. Takes precedence over `domain`. |
| `scan_sending_domains` | boolean | Default true. The strongest signal and the slowest step. |
| `sending_domain_depth` | `deep` \| `standard` | Default `deep` (.com .co .io .net .org). |
| `check_deliverability` | boolean | Default false. Adds a separately billed blacklist check and health score. |
| `skipCache` | boolean | Ignore the 7 day result cache. |

Returns a flat row per domain: `runs_outbound` (`program`, `light`, `none`, `unknown`), `confidence`, `sending_domains[]`, `registration_clusters[]`, `sending_platforms[]`, `inbox_provider`, `warmup_detected`, `infrastructure_vendors[]`, `spf_status`, `dkim_status`, `dmarc_policy`, and an `evidence[]` array of quotable strings.

## What it actually detects

A real outbound program does not send from the domain the business runs on. It buys lookalikes (`getcompany.com`, `company-mail.com`, `trycompany.co`), gives them their own mail tenant, and redirects their web root at the real site. That redirect is the attribution handle, and finding those domains is the part nobody else does.

Measured on nine live domains: 6 of 6 detected on companies that demonstrably run outbound, 0 false positives of 3 on controls.

**Two honest limits.** When the brand token is an ordinary English word (Gong, Clay, Ramp), lookalike patterns collide with unrelated businesses that legitimately own them; the actor sets `brand_is_common_word` and caps confidence rather than reporting a confident `none`. And sending-platform recall is partial by design: Instantly, Smartlead, Lemlist, Apollo and Salesloft connect over OAuth to a customer's own mailbox and publish no SPF include host at all, so an empty `sending_platforms` tells you little while a populated one is solid.

## Setup

```json
{
  "mcpServers": {
    "mamba-outbound-infrastructure-fingerprint": {
      "command": "npx",
      "args": ["-y", "@mambalabsdev/mcp-outbound-infrastructure-fingerprint"],
      "env": { "APIFY_TOKEN": "your-apify-token" }
    }
  }
}
```

Get a token at [console.apify.com/account/integrations](https://console.apify.com/account/integrations). Read-only; consumes Apify credits per domain analyzed.

## Also available

This tool is also exposed by the [GTM Suite](https://www.npmjs.com/package/@mambalabsdev/mcp-gtm-suite) umbrella server, alongside the rest of the Mamba Labs GTM actors, if you would rather run one server than many.

Built by [Mamba Labs](https://apify.com/mambalabs).
