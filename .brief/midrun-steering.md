# Midrun steering — design sketch

**Status:** design doc, not yet shipped. Captures the thinking so it's not lost.
**Date:** 2026-04-13.

## The gap

`expo refine` today is a state machine: spawn → agent verdict → gate →
snapshot-or-discard → loop. The orchestrator's ONLY injection points are
pre-run (rubric, gates, scope) and between runs (REFINE.md editing,
`--continue` after stop-and-restart).

What's missing: a way to *nudge* the running loop when you notice it's
drifting without having to kill and restart.

Concrete failure mode that motivated this:

> Iteration 1: agent proposes refactoring `parseVerdict` into three nested
> helpers. KEEP (rubric was generic "improve readability").
> Iteration 2: builds on 1, extracts another helper. KEEP.
> Iteration 3: more helpers. KEEP.
> Iteration 4: realizes helpers are over-engineered, proposes flattening
> back. DISCARD (regression vs baseline intent).
> Iteration 5: tries a different over-engineering. And so on.

A human watching this would say: "Stop splitting into helpers. The original
was fine. Focus on error message clarity instead." Today you have to kill,
edit REFINE.md, restart (which loses the in-flight iteration budget).

## What it would look like

Two delivery channels, same consumption path:

### A) File-drop (human escape hatch)

```bash
# In another terminal, while refine is running
echo "Stop extracting helpers — original structure was fine.
Focus on error messages in src/parser.ts and src/loader.ts." \
  > /path/to/project/.refine/steering.txt
```

Refine reads `.refine/steering.txt` at the start of each iteration. If
present, the contents get injected into that iteration's agent prompt
under a `## Reviewer guidance` section. Then the file is deleted (so the
nudge fires once, not forever).

For sticky guidance, write `.refine/steering.json` instead:

```json
{ "text": "prefer small files over big modules", "sticky": true }
```

Sticky steering stays until manually cleared — useful for
long-running sessions with persistent directional preferences.

### B) Steering hook (programmatic path)

```bash
expo refine . --max 20 --steering-hook ./suggest.sh
```

Before each iteration's agent spawn, refine execs the hook with the
current run state as JSON on stdin:

```json
{
  "iteration": 5,
  "currentParentId": "004",
  "recentVariants": [
    {"id": "002", "change": "extracted parseHelper", "summary": "..."},
    {"id": "003", "change": "extracted another helper", ...},
    {"id": "004", "change": "yet more helpers", ...}
  ],
  "gateFailures": 0,
  "recentFailures": []
}
```

Hook's stdout (if non-empty) is the steering text. Empty stdout = no
nudge, proceed normally. Timeout fail-open (10s default) so a hanging
hook doesn't stall the loop.

This lets an orchestrator script make steering decisions based on
patterns: "if three consecutive iterations all refactor the same file,
suggest looking elsewhere." Or pipe it through an LLM: "here's the last
three changes, are we drifting? If so, what should we try instead?"

### Both channels together

When both `.refine/steering.txt` AND `--steering-hook` fire in the same
iteration, their outputs get concatenated in the prompt. Callers can
safely use both — the file path is for human nudges, the hook for
automated oversight.

## Where it lands in the prompt

Just before `## Instructions`:

```
## Reviewer guidance (mid-run)

A reviewer observing this run has noted:

> <steering text>

This is advisory — the rubric and gates still take precedence. Weight
this heavily when deciding your next change, but don't violate rubric
or gates to follow it.
```

The "advisory not mandatory" framing matters. If we told the agent
"YOU MUST do X" and X conflicts with the rubric, we create a prompt-
contradiction that produces weird output. Steering is explicitly a
tie-breaker / direction-setter, not an override.

## Implementation

Roughly:

```typescript
// refine.ts, top of each iteration loop body:
const steering = await loadSteering(dir, {
  hook: opts.steeringHook,
  timeoutMs: (opts.steeringHookTimeout ?? 10) * 1000,
  context: {
    iteration: iterations,
    currentParentId,
    recentVariants: variants.slice(-3),
    gateFailures, gatesProposed,
    recentFailures: [...recentFailures],
  },
});
// steering is { text: string, sticky: boolean, source: "file" | "hook" | "both" } | null

// Thread into prompt
const prompt = buildRefinePrompt({ ...existing, steering });

// Emit a signal so dashboards / event-file consumers see it
if (steering) {
  await emitRefineProgress(bus, agentName, iterations,
    `steering_injected: ${steering.text.slice(0, 80)}`,
    { steeringSource: steering.source, steeringSticky: steering.sticky });
}

// After the agent runs, clear non-sticky file steering so it fires once
if (steering?.source === "file" && !steering.sticky) {
  await Deno.remove(`${dir}/.refine/steering.txt`).catch(() => {});
}
```

## What NOT to build (yet)

- **Realtime injection** (push steering while an agent is mid-generation)
  — would require interrupting the in-flight subprocess, which breaks
  the clean "spawn → complete → verdict" state machine. Skip.
- **Bidirectional chat** (agent asks reviewer a question) — big rethink
  of the loop. Expo's current strength is unattended; pivoting to
  synchronous human-in-loop is a separate product.
- **Steering history in REFINE.md** — would happen automatically via
  the event-file (every steering injection is a progress signal). If
  we want it in REFINE.md specifically, the `updateRefineMd` prompt
  already has access to the session log; just add "mention any steering
  suggestions and how you weighted them" to the update prompt.

## Open questions

1. **Steering visibility:** should the agent know the source (file vs hook)
   or just see one block? I lean "one block" — the agent shouldn't care
   whether the nudge came from a human or a script.

2. **Conflict with gate-failure feedback:** if both sections fire on the
   same iteration (recent gate failures + human says "try Y"), which goes
   first in the prompt? I'd put steering LAST so it's fresher in the
   agent's context window.

3. **Rate limit:** should we cap how often steering can fire? Probably
   not — if you're running a 20-iteration loop and nudge every iteration,
   that's your call. No built-in rate limit; users who want quieter
   steering just write better hooks.

4. **Dashboard UI for this:** easy win. `/gates.html` has the variant
   list; add a "nudge current run" textbox that POSTs to
   `/api/steering` which writes the steering file. Complements the
   existing `gate add/remove` UI.

## How it pairs with the "Friday → Monday" dream

The reason "kick it off Friday, review Monday" is still scary isn't
just cost/time caps — those we have. It's that if the run drifts, you
find out Monday morning after 72 hours of drift. Steering lets you
*check in* on the run during the weekend (Slack notification from
webhook → one-line nudge via dashboard → loop self-corrects on the
next iteration) without having to kill-and-restart.

Concrete flow:

```
Fri 5pm:   expo refine . --auto --max 40 --run-timeout 216000 \
             --total-budget 150 --scope "src/**" \
             --steering-hook ./slack-steering.sh \
             --event-file /tmp/weekend.jsonl &

Sat 9am:   Slack summary of 8 iterations. Two looked questionable.
           You reply with "stop touching src/legacy/ — focus on src/api/".
           slack-steering.sh reads your Slack reply, returns the nudge.

Sat 10am:  iteration 9 sees the nudge, corrects course.

Mon 9am:   review the tree. It went where you wanted because you
           redirected once from your phone on Saturday morning.
```

That's the actual delta that makes Friday-to-Monday safe: not just
caps + scope, but *the ability to course-correct without starting
over when you notice drift*.

## Why it's future-not-today work

Shippable, probably ~150 LOC + tests. Not done today because:

1. We don't yet have a long-enough run to reveal the drift pattern
   this solves for. Build the primitive when we have a real failure
   mode to point it at.
2. The dashboard UI component adds a meaningful chunk. Ship the API
   + file-drop first, add the UI after one real use.
3. Schema design for the JSON form (`{text, sticky, priority?,
   expiresAfterIteration?}`) benefits from real-world experience.
   Ship minimal (text + sticky), extend later.
