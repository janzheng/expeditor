/**
 * Unit tests for validateWebhookUrl — SSRF protection on EXPO_WEBHOOK_URL.
 *
 * Run:  deno run --allow-all tests/test-ssrf-validator.ts
 */

import { validateWebhookUrl } from "../src/notify.ts";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, predicate: boolean, detail?: string): void {
  if (predicate) {
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
    passed++;
  } else {
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ""}`);
    failed++;
    failures.push(name);
  }
}

console.log("\nvalidateWebhookUrl — reject cases:");
{
  check("empty string rejected", validateWebhookUrl("") !== null);
  check("malformed URL rejected", validateWebhookUrl("not a url at all") !== null);
  check("file:// rejected", validateWebhookUrl("file:///etc/passwd") !== null);
  check("ftp:// rejected", validateWebhookUrl("ftp://example.com") !== null);
  check("dict:// rejected", validateWebhookUrl("dict://attacker.com") !== null);
  check("localhost rejected", validateWebhookUrl("http://localhost/hook") !== null);
  check("127.0.0.1 rejected", validateWebhookUrl("http://127.0.0.1/hook") !== null);
  check("127.anything rejected", validateWebhookUrl("http://127.99.99.99/") !== null);
  check("0.0.0.0 rejected", validateWebhookUrl("http://0.0.0.0:8080/") !== null);
  check("169.254.169.254 (GCP/AWS metadata) rejected", validateWebhookUrl("http://169.254.169.254/") !== null);
  check("metadata.google.internal rejected", validateWebhookUrl("http://metadata.google.internal/") !== null);
  check("10.x rejected", validateWebhookUrl("http://10.0.0.1/") !== null);
  check("172.16 rejected", validateWebhookUrl("http://172.16.0.1/") !== null);
  check("172.17 rejected (common Docker default)", validateWebhookUrl("http://172.17.0.1/") !== null);
  check("172.32 NOT rejected (outside RFC1918)", validateWebhookUrl("http://172.32.0.1/") === null);
  check("192.168 rejected", validateWebhookUrl("http://192.168.1.1/") !== null);
  check("224.x multicast rejected", validateWebhookUrl("http://224.0.0.1/") !== null);
  check("::1 IPv6 loopback rejected", validateWebhookUrl("http://[::1]/") !== null);
  check("fe80:: link-local rejected", validateWebhookUrl("http://[fe80::1]/") !== null);
  check("fc00:: unique-local rejected", validateWebhookUrl("http://[fc00::1]/") !== null);
}

console.log("\nvalidateWebhookUrl — allow cases:");
{
  check("public https accepted", validateWebhookUrl("https://hooks.slack.com/services/xxx") === null);
  check("public http accepted", validateWebhookUrl("http://hooks.example.com/webhook") === null);
  check("public IPv4 accepted", validateWebhookUrl("https://8.8.8.8/") === null);
  check("public IPv6 accepted", validateWebhookUrl("https://[2001:db8::1]/") === null);
}

console.log("\nvalidateWebhookUrl — allowPrivate override:");
{
  check("localhost accepted with allowPrivate", validateWebhookUrl("http://localhost/", { allowPrivate: true }) === null);
  check("127.0.0.1 accepted with allowPrivate", validateWebhookUrl("http://127.0.0.1/", { allowPrivate: true }) === null);
  check("169.254.169.254 accepted with allowPrivate", validateWebhookUrl("http://169.254.169.254/", { allowPrivate: true }) === null);
  // Scheme still enforced even with allowPrivate
  check("file:// still rejected with allowPrivate", validateWebhookUrl("file:///etc/passwd", { allowPrivate: true }) !== null);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const f of failures) console.log(`  - ${f}`);
  Deno.exit(1);
}
