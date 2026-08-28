---
name: writing-for-agents
description: "Levers for writing documents an agent consumes: context pointers, the two loads, information hierarchy, progressive disclosure, completion criteria, leading words, and pruning. Use when creating or editing a skill, an agent definition, an instruction file, AGENTS.md, or CLAUDE.md."
---

# Writing for Agents

Reference for any document an agent consumes: a skill, an instruction file, a doc reached by a pointer. The packaging differs, the writing does not. The same levers make each one predictable, because the agent takes the same *process* every run rather than producing the same output.

## Context pointers

A **context pointer** is a reference held in the agent's context that names out-of-context material and encodes the condition for reaching it. A skill's `description` is one. The pointer's *wording*, not its target, decides when and how reliably the agent reaches the material. A must-have target behind a weakly worded pointer is a variance bug: sharpen the wording first, and inline the material only if sharpening fails.

A pointer does two jobs: state what the material is, and list the **branches** that should trigger reaching it. Every word costs on every turn, so it earns harder pruning than the body.

- **Front-load the leading word.** The pointer is where it does its triggering work.
- **One trigger per branch.** Synonyms renaming a single branch are one branch written twice.
- **Cut identity the body already carries.**

## The two loads

Every document and pointer spends one of two budgets.

- **Context load** is the cost of always-loaded material on the agent's window. It spends tokens and attention whether or not it fires.
- **Cognitive load** is the cost on the human: which documents exist and when to reach for each. Not a cost to minimise, it is the price of human agency. Spend it where human judgement matters, remove it where it does not.

Material reached only through a pointer escapes context load at the price of the pointer's own line. Material with no pointer rides entirely on cognitive load.

## Information hierarchy

A document is built from **steps** (ordered actions) and **reference** (definitions, rules, facts consulted on demand). The two mix freely. The core decision is where each piece sits on a ladder ranked by how immediately the agent needs it:

1. **In-file step.** The primary tier: what the agent does, in order.
2. **In-file reference.** Consulted on demand. Often a legitimately flat peer set, which is a fine arrangement rather than a smell.
3. **Disclosed reference.** Pushed into a separate file behind a pointer, loaded only when the pointer fires.

Push too little down and the top bloats. Push too much and you hide material the agent needs.

**Progressive disclosure** is the move down the ladder so the top stays legible. Branching is the cleanest test: inline what every branch needs, push behind a pointer what only some branches reach. Where a document has steps, undisclosed reference buries them and turns attending to them into a coin flip.

**Co-location** decides what sits beside a piece once its rung is chosen. Keep a concept's definition, rules, and caveats under one heading so reading one part brings its neighbours. Scattering fragments one meaning across many places, which is distinct from duplication repeating one meaning in two.

**Sprawl** is the failure mode: a document too long even when every line is live and unique. Attention thins across the excess. The cure is the ladder.

## Completion criteria

Every step ends on a **completion criterion**, the condition telling the agent the work is done. Two properties make it a lever:

- **Clarity.** Can the agent tell done from not-done? A vague bound ("understanding reached") invites **premature completion**, ending the step early as attention slips toward being done. The visible **post-completion steps** supply the pull; the criterion's clarity is the resistance. Sharpen the bound first, since that is local and cheap. Only if it is irreducibly fuzzy *and* you observe the rush, hide the later steps by splitting the sequence, which works only across a real context boundary such as a hand-off.
- **Demand.** How much it requires. "Every modified model accounted for" forces thorough work where "produce a change list" does not. Demand drives the **legwork** latent in the wording. It is not step-bound: "every rule applied" binds flat reference the way "every step done" binds a sequence.

The strongest criteria are both checkable and exhaustive.

## Leading words

A **leading word** is a compact concept already in the model's pretraining that the agent thinks with while running the document (*lesson*, *fog of war*, *tracer bullets*). Repeated as a token, never as a sentence, it accumulates a distributed definition and anchors a region of behaviour in the fewest tokens. Coining your own works if you define it clearly, but a made-up word recruits no priors, so reach for an existing word first.

It anchors twice. In the body it anchors execution, so the agent reaches for the same behaviour every time the word appears. In a pointer it anchors invocation, so shared language across prompts, docs, and code reaches the material more reliably.

Hunt for passages that collapse into a single token. "fast, deterministic, low-overhead" becomes *tight*. "a loop you believe in" becomes *red*, turning a fuzzy gate into a binary observable state. Assume every document carries restatements that leading words retire.

**Negation** is the failure mode beside this lever. Steering by prohibition drags the forbidden behaviour into context and makes it *more* available. Prompt the **positive**: state the target behaviour so the banned one is never spoken. A prohibition earns its place only as a hard guardrail you cannot phrase positively, and even then pair it with the positive target.

## Pruning

- **Single source of truth.** One authoritative place per meaning, so changing behaviour is a one-place edit. Duplication costs maintenance and tokens, and inflates a meaning's rank on the ladder.
- **The environment is a source of truth too** (`package.json` scripts, config files, directory layout, `--help` output). A document restating it is a **cache**, earning its load only when the lookup is expensive. Cache the unwritten convention, the reason behind a choice, the gotcha no config confesses. Leave one-command lookups to the environment, where they cannot go stale.
- **Relevance.** Does the line still bear on what the document does? Without a pruning discipline the default fate is **sediment**: stale layers that settle because adding feels safe and removing feels risky.
- **No-ops.** An instruction the model already obeys by default pays load to say nothing. The test is model-relative, not reader-relative: settle a disagreement by running the document, not by debate. When a sentence fails, delete the whole sentence rather than trim words from it. This also grades leading words, since a word too weak to beat the default (*be thorough*) is a no-op, and the fix is a stronger word (*relentless*).

## When to split

Splitting spends one of the two loads, so split only when the cut earns it.

- **By sequence.** Split a run of steps where the post-completion steps tempt the agent to rush the one in front of it. Merging sequences has the reverse effect.
- **By trigger.** Split off a skill when it has a distinct leading word that should fire it on its own, or when another skill must reach it. You pay context load for a new always-loaded description, so that independent reach has to be worth it.

When skills multiply past what a human can remember, that piled-up cognitive load is cured by a **router**: one document naming the others and when to reach for each.

## How this project compiles a skill

A skill is one directory holding `SKILL.md` with `name` and `description` frontmatter. The `description` is the skill's top-level context pointer and the only part guaranteed to reach every assistant, so it carries the trigger branches. Claude Code and the single-file targets also receive sibling files, but Cursor and Windsurf compile `SKILL.md` alone. Anything the agent must have therefore belongs in `SKILL.md`.

Adapted from the `writing-for-agents` skill in [mattpocock/skills](https://github.com/mattpocock/skills), MIT, copyright 2026 Matt Pocock.
