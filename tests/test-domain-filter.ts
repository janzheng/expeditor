/**
 * Test: Domain filter hook generation
 *
 * Verifies that SandboxConfig.allowedDomains generates a PreToolUse hook
 * in the settings file that blocks unauthorized domains.
 */

import { AgentSpawner, type SandboxConfig, SANDBOX_PRESETS } from "../src/spawner.ts";
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

console.log(`${BOLD}Test: Domain filter hook generation${RESET}`);
console.log("");

// Create a spawner instance to test settings file generation
const bus = new SignalBus();
const registry = new Registry();
const spawner = new AgentSpawner(bus, { registry });

// Access private method via prototype trick
const generateSettings = (spawner as unknown as {
  generateSettingsFile: (sandbox: SandboxConfig, agentId: string) => Promise<string>;
}).generateSettingsFile.bind(spawner);

// Test 1: Sandbox without allowedDomains — no hooks
{
  const path = await generateSettings({ allow: ["Read"] }, "test-no-domains");
  const settings = JSON.parse(await Deno.readTextFile(path));
  if (!settings.hooks) {
    pass("No hooks when allowedDomains not set");
  } else {
    fail("Hooks present when allowedDomains not set");
  }
  // Cleanup
  await Deno.remove(path.replace(/\/[^/]+$/, ""), { recursive: true });
}

// Test 2: Sandbox with allowedDomains — hooks generated
{
  const path = await generateSettings({
    allow: ["Read", "Bash(curl:*)"],
    allowedDomains: ["api.github.com", "pubmed.ncbi.nlm.nih.gov"],
  }, "test-with-domains");

  const settings = JSON.parse(await Deno.readTextFile(path));
  if (settings.hooks?.PreToolUse?.length === 3) {
    pass("PreToolUse hooks generated for Bash, WebFetch, WebSearch");
  } else {
    fail(`Expected 3 PreToolUse hooks, got ${settings.hooks?.PreToolUse?.length ?? 0}`);
  }

  // Check hook script exists and contains domains
  const hookPath = settings.hooks?.PreToolUse?.[0]?.command;
  if (hookPath) {
    const hookScript = await Deno.readTextFile(hookPath);
    if (hookScript.includes("api.github.com") && hookScript.includes("pubmed.ncbi.nlm.nih.gov")) {
      pass("Hook script contains allowed domains");
    } else {
      fail("Hook script missing allowed domains");
    }
    if (hookScript.includes("BLOCKED by domain filter")) {
      pass("Hook script has blocking logic");
    } else {
      fail("Hook script missing blocking logic");
    }
  } else {
    fail("No hook command path found");
  }

  // Cleanup
  await Deno.remove(path.replace(/\/[^/]+$/, ""), { recursive: true });
}

// Test 3: Hook matchers target the right tools
{
  const path = await generateSettings({
    allow: ["Read"],
    allowedDomains: ["example.com"],
  }, "test-matchers");

  const settings = JSON.parse(await Deno.readTextFile(path));
  const matchers = settings.hooks?.PreToolUse?.map((h: { matcher: string }) => h.matcher) ?? [];
  if (matchers.includes("Bash") && matchers.includes("WebFetch") && matchers.includes("WebSearch")) {
    pass("Hook matchers cover Bash, WebFetch, WebSearch");
  } else {
    fail(`Wrong matchers: ${matchers.join(", ")}`);
  }

  // Cleanup
  await Deno.remove(path.replace(/\/[^/]+$/, ""), { recursive: true });
}

console.log("");
console.log(`${BOLD}Results: ${passed} passed, ${failed} failed${RESET}`);
if (failed > 0) Deno.exit(1);
console.log("PASS");
