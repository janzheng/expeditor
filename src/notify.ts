/**
 * Notification hooks — Send alerts on agent events
 *
 * Subscribes to the signal bus and fires webhooks on done/failed/escalated.
 * Supports generic webhooks (Slack, Discord, etc.) via POST with JSON body.
 */

import type { SignalBus } from "./bus.ts";
import type { AgentSignal } from "./types.ts";

export interface NotifyOptions {
  /** Webhook URL to POST to */
  webhookUrl: string;
  /** Which events to notify on (default: ["done", "failed"]) */
  events?: string[];
  /** Optional filter: only notify for specific agent IDs (glob pattern) */
  agentFilter?: string;
  /** Format: "slack" uses Slack block kit, "generic" sends raw signal */
  format?: "slack" | "discord" | "generic";
  /** Opt-in to allow webhook URLs pointing at private networks (loopback,
   *  link-local, RFC1918, cloud metadata IPs). Default false — prevents
   *  SSRF where a rogue agent sets EXPO_WEBHOOK_URL=http://169.254.169.254
   *  to exfiltrate cloud credentials via signal payloads. */
  allowPrivate?: boolean;
}

/** Validate a webhook URL for SSRF safety. Rejects non-http(s) schemes,
 *  refuses to block on file:// / ftp:// / dict:// URIs. When allowPrivate
 *  is false (default), also rejects loopback, link-local, RFC1918, and
 *  cloud-metadata IPs. Hostname-based resolution intentionally NOT done
 *  here — DNS rebinding would defeat it; we just check the literal host.
 *
 *  Returns null on OK, or a human-readable reason string on reject. */
export function validateWebhookUrl(
  rawUrl: string,
  opts: { allowPrivate?: boolean } = {},
): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return `not a valid URL: ${rawUrl.slice(0, 80)}`;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return `only http/https webhooks supported (got ${url.protocol})`;
  }

  if (opts.allowPrivate) return null;

  const host = url.hostname.toLowerCase();

  // Explicit DNS-style hostnames we never allow
  if (host === "localhost" || host.endsWith(".localhost") || host === "metadata.google.internal") {
    return `private host ${host} rejected (set allowPrivate:true to override)`;
  }

  // IPv4 literal detection
  const ipv4Match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const [a, b] = ipv4Match.slice(1).map((x) => parseInt(x, 10));
    // Loopback (127/8), link-local (169.254/16), RFC1918 (10/8, 172.16/12,
    // 192.168/16), 0.0.0.0, multicast (224-239), reserved (240+).
    const isLoopback = a === 127;
    const isLinkLocal = a === 169 && b === 254;
    const isRfc1918 = a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
    const isUnspecified = a === 0;
    const isMulticastOrReserved = a >= 224;
    if (isLoopback || isLinkLocal || isRfc1918 || isUnspecified || isMulticastOrReserved) {
      return `private IPv4 ${host} rejected (set allowPrivate:true to override)`;
    }
  }

  // IPv6 literal detection — URL.hostname strips the [brackets]
  // ::1 loopback, fe80::/10 link-local, fc00::/7 unique-local
  if (host === "::1" || host.startsWith("fe80:") || host.startsWith("fc") || host.startsWith("fd")) {
    return `private IPv6 ${host} rejected (set allowPrivate:true to override)`;
  }

  return null;
}

/** Format a signal as a Slack message */
function formatSlack(signal: AgentSignal): Record<string, unknown> {
  const p = signal.payload as Record<string, unknown>;
  const emoji = signal.type === "done" ? ":white_check_mark:" :
    signal.type === "failed" ? ":x:" : ":bell:";
  const cost = p.totalCostUsd as number | undefined;
  const dur = p.durationMs as number | undefined;

  const text = signal.type === "done"
    ? `${emoji} *${signal.agentId}* completed${dur ? ` in ${(dur/1000).toFixed(1)}s` : ""}${cost ? ` ($${cost.toFixed(4)})` : ""}`
    : signal.type === "failed"
      ? `${emoji} *${signal.agentId}* failed: ${p.error ?? "unknown error"}`
      : `${emoji} *${signal.agentId}* — ${signal.type}`;

  return { text };
}

/** Format a signal as a Discord embed */
function formatDiscord(signal: AgentSignal): Record<string, unknown> {
  const p = signal.payload as Record<string, unknown>;
  const color = signal.type === "done" ? 0x3fb950 : signal.type === "failed" ? 0xf85149 : 0xd29922;

  return {
    embeds: [{
      title: `${signal.agentId} — ${signal.type}`,
      color,
      fields: [
        ...(p.error ? [{ name: "Error", value: String(p.error).slice(0, 200) }] : []),
        ...(p.durationMs ? [{ name: "Duration", value: `${(Number(p.durationMs)/1000).toFixed(1)}s`, inline: true }] : []),
        ...(p.totalCostUsd ? [{ name: "Cost", value: `$${Number(p.totalCostUsd).toFixed(4)}`, inline: true }] : []),
      ],
      timestamp: new Date(signal.timestamp).toISOString(),
    }],
  };
}

/** Format a signal based on the configured format */
function formatSignal(signal: AgentSignal, format: string): Record<string, unknown> {
  switch (format) {
    case "slack": return formatSlack(signal);
    case "discord": return formatDiscord(signal);
    default: return { signal };
  }
}

/** Subscribe to bus and fire webhooks. Throws during setup if the URL
 *  fails SSRF validation — a bad URL at install-time is better than
 *  leaking signal payloads to an attacker's chosen host at run-time. */
export function notifyHook(bus: SignalBus, opts: NotifyOptions): () => void {
  const events = new Set(opts.events ?? ["done", "failed"]);
  const format = opts.format ?? "generic";

  const urlReject = validateWebhookUrl(opts.webhookUrl, { allowPrivate: opts.allowPrivate });
  if (urlReject) {
    throw new Error(`[notify] webhook URL rejected: ${urlReject}`);
  }

  return bus.subscribe(async (signal: AgentSignal) => {
    if (!events.has(signal.type)) return;

    // Agent filter
    if (opts.agentFilter) {
      const pattern = opts.agentFilter.replace(/\*/g, ".*");
      if (!new RegExp(`^${pattern}$`).test(signal.agentId)) return;
    }

    const body = formatSignal(signal, format);

    try {
      await fetch(opts.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (err) {
      console.error(`[notify] webhook failed: ${String(err).slice(0, 200)}`);
    }
  });
}
