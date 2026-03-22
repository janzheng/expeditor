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

/** Subscribe to bus and fire webhooks */
export function notifyHook(bus: SignalBus, opts: NotifyOptions): () => void {
  const events = new Set(opts.events ?? ["done", "failed"]);
  const format = opts.format ?? "generic";

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
