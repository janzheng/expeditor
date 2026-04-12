/**
 * Test: Domain filter hook — shell-injection hardening
 *
 * Verifies that allowedDomains entries are validated against a strict
 * hostname regex BEFORE being interpolated into the generated bash array.
 * An attacker-controlled value containing `"`, `` ` ``, `$`, `\`, whitespace,
 * `;`, `|`, or newlines must be rejected with a clear error — not emitted
 * into the hook where it would break out of the double-quoted array element
 * and inject shell commands.
 *
 * Locks in fix for .brief/agentic-audit.md finding:
 *   src/spawner.ts generateDomainFilterHook — bash injection via
 *   allowedDomains entries.
 */

import {
  AgentSpawner,
  assertValidAllowedDomains,
  isValidAllowedDomain,
  type SandboxConfig,
} from "../src/spawner.ts";
import { SignalBus } from "../src/bus.ts";
import { Registry } from "../src/registry.ts";

const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const BOLD = "\x1b[1m";

let passed = 0;
let failed = 0;

function pass(msg: string) { console.log(`  ${GREEN}PASS${RESET}: ${msg}`); passed++; }
function fail(msg: string) { console.log(`  ${RED}FAIL${RESET}: ${msg}`); failed++; }

console.log(`${BOLD}Test: Domain filter — shell injection hardening${RESET}`);
console.log("");

// ---------- Pure validator tests ----------

const validCases = [
  "api.github.com",
  "pubmed.ncbi.nlm.nih.gov",
  "example.com",
  "a.b",
  "sub-domain.example.co.uk",
  "1.1.1.1",
  "A-Z0.example",
];
for (const v of validCases) {
  if (isValidAllowedDomain(v)) pass(`accepts valid hostname: ${JSON.stringify(v)}`);
  else fail(`rejected valid hostname: ${JSON.stringify(v)}`);
}

// Each of these must be rejected — they contain shell metacharacters, control
// characters, leading/trailing hyphens, empty labels, or other malformed shapes.
const injectionCases: string[] = [
  `example.com"; rm -rf /; echo "`,              // closes quote, runs command
  "example.com`whoami`",                          // backtick command substitution
  "example.com$(id)",                             // dollar-paren substitution
  "example.com$USER",                             // variable expansion
  "example.com\\",                                // trailing backslash (escapes closing quote)
  "example.com\necho pwned",                      // newline injection
  "example.com echo pwned",                       // literal whitespace
  "example.com;pwd",                              // command separator
  "example.com|cat",                              // pipe
  "example.com&sleep 1",                          // background
  "example.com>/tmp/x",                           // redirect
  "example.com<(evil)",                           // process substitution
  "*.example.com",                                // wildcard glob
  "",                                             // empty string
  "-leading-hyphen.com",                          // leading hyphen on label
  "trailing-.com",                                // trailing hyphen on label
  ".leading-dot.com",                             // leading dot
  "trailing-dot.com.",                            // trailing dot (reject: no empty final label)
  "double..dot.com",                              // empty label
  "a".repeat(254),                                // too long
];
for (const bad of injectionCases) {
  if (!isValidAllowedDomain(bad)) pass(`rejects malicious/malformed: ${JSON.stringify(bad).slice(0, 60)}`);
  else fail(`ACCEPTED malicious/malformed input: ${JSON.stringify(bad)}`);
}

// Non-string inputs
for (const bad of [null, undefined, 42, {}, [], true]) {
  if (!isValidAllowedDomain(bad)) pass(`rejects non-string: ${String(bad)}`);
  else fail(`accepted non-string: ${String(bad)}`);
}

// ---------- assertValidAllowedDomains ----------

try {
  assertValidAllowedDomains(["api.github.com", "example.com"]);
  pass("assertValidAllowedDomains passes for all-valid list");
} catch (e) {
  fail(`threw on valid list: ${(e as Error).message}`);
}

try {
  assertValidAllowedDomains(["api.github.com", `evil.com"; rm -rf /; echo "`]);
  fail("assertValidAllowedDomains did NOT throw on injection attempt");
} catch (e) {
  const msg = (e as Error).message;
  if (msg.includes("Invalid allowedDomains") && msg.includes("rm -rf")) {
    pass("assertValidAllowedDomains throws clear error naming the bad entry");
  } else {
    fail(`error message didn't name the offender: ${msg}`);
  }
}

// ---------- End-to-end: generateSettingsFile must reject malicious domains ----------

const bus = new SignalBus();
const registry = new Registry();
const spawner = new AgentSpawner(bus, { registry });

const generateSettings = (spawner as unknown as {
  generateSettingsFile: (sandbox: SandboxConfig, agentId: string) => Promise<string>;
}).generateSettingsFile.bind(spawner);

// Malicious config must be rejected — no settings file, no hook, no interpolation.
let rejectedMalicious = false;
let rejectionMessage = "";
try {
  await generateSettings(
    { allow: ["Bash(curl:*)"], allowedDomains: [`example.com"; touch /tmp/expo-pwned; echo "`] },
    "test-injection-reject",
  );
} catch (e) {
  rejectedMalicious = true;
  rejectionMessage = (e as Error).message;
}
if (rejectedMalicious && rejectionMessage.includes("Invalid allowedDomains")) {
  pass("generateSettingsFile refuses malicious allowedDomains with clear error");
} else {
  fail(`generateSettingsFile accepted or misreported malicious domain (rejected=${rejectedMalicious}, msg=${rejectionMessage})`);
}

// Valid config still works, and the emitted hook contains exactly the domains
// as quoted array elements — nothing smuggled in.
{
  const settingsPath = await generateSettings(
    { allow: ["Read"], allowedDomains: ["api.github.com", "example.com"] },
    "test-injection-valid",
  );
  const settings = JSON.parse(await Deno.readTextFile(settingsPath));
  const hookPath = settings.hooks?.PreToolUse?.[0]?.command as string | undefined;
  if (!hookPath) {
    fail("no hook path generated for valid domains");
  } else {
    const hook = await Deno.readTextFile(hookPath);
    if (hook.includes(`ALLOWED_DOMAINS=("api.github.com" "example.com")`)) {
      pass("hook emits exactly-quoted array for valid domains");
    } else {
      fail(`unexpected ALLOWED_DOMAINS line — hook:\n${hook.split("\n").find((l) => l.startsWith("ALLOWED_DOMAINS"))}`);
    }
    // Cleanup temp dir
    const tmpDir = hookPath.replace(/\/[^/]+$/, "");
    await Deno.remove(tmpDir, { recursive: true });
  }
}

console.log("");
console.log(`${BOLD}Results: ${passed} passed, ${failed} failed${RESET}`);
if (failed > 0) Deno.exit(1);
console.log("PASS");
