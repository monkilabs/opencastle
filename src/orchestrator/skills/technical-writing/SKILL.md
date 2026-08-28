---
name: technical-writing
description: "Four-layer standard for technical prose: Diataxis document modes, Google developer style sentences, Simplified Technical English instruction rules, Global English disambiguation. Use when writing or reviewing docs, RFCs, README files, PR descriptions, or commit messages."
---

# Technical Writing

The goal is writing a tired engineer understands on the first read. Four layers get you there, one question each: what kind of document is this, how do sentences address the reader, how much does each sentence carry, and can any sentence be read two ways. Apply all four, then run the **unslop** skill over the result.

Three rules sit above the layers:

- **Cut every word that does no work.** "In order to" is "to". "It is important to note that" is nothing.
- **Use the short, everyday word.** "Use", not "utilize". A long word has to buy its length with precision.
- **When a rule makes a sentence worse, fix it another way or leave it alone.** A sentence that follows every rule and sounds machine written has failed.

The codebase is the word list. Write the real symbol, file, flag, or command name, never a synonym or a description of it. Do not invent jargon; use the words a developer says out loud.

## Layer 1: pick the mode (Diataxis)

One document, one mode. Two questions pick it: does the content inform action or understanding, and does it serve learning or work?

| | Learning | Work |
|---|---|---|
| **Action** | Tutorial | How-to |
| **Understanding** | Explanation | Reference |

- **Tutorial.** You are the teacher and the learner's success is your job. Open with what they will build, not what they will "learn". Every step produces a visible result, and you say what they should see. Cut explanation to one clause and a link. Write as "we", in commands.
- **How-to.** Solve a problem a person has, not an operation the machine can perform. Assume competence, skip teaching, allow forks: "If you want x, do y." Name it by the task.
- **Reference.** Describe, only describe. No instruction, no opinion, no hedging. State facts, options, limits, and errors. Mirror the structure of the thing described. Generate from code where possible so it stays true.
- **Explanation.** One bounded topic, readable away from the product. Each title should tolerate an implicit "About...". Give design decisions, history, constraints, alternatives. Opinion is allowed here and nowhere else.

Do not mix modes. No reference tables inside a tutorial, no hand-holding inside reference, no arguing inside a how-to. Split and link instead.

## Layer 2: write sentences to the reader (Google developer style)

- Address the reader as "you", in the present tense. "Will" only for things that genuinely happen later.
- Say who does what: "the compiler checks", not "is checked".
- Write instructions as commands: "Click Submit." Never "should be done".
- Put the condition before the instruction: "To delete the document, click Delete." The reader skips what does not apply.
- Put the common case first, exceptions after.
- Sound like a knowledgeable friend. No buzzwords, no figurative language, no "please", and never "simply", "easy", or "quickly" in a procedure.
- Do not pre-announce features, and do not start consecutive sentences with the same phrase.
- Link with words that say where the link goes. Never "click here".
- Headings carry the point, not just the topic ("Pick the mode first", not "Modes"). Sentence case, one h1 per page, no skipped levels. Task headings are bare verb phrases, concept headings are noun phrases.
- Numbered lists for sequences, bullets for everything else. Introduce a list with a complete sentence and keep items parallel.
- Code in code font, UI elements in bold, serial commas. Drop "etc." and say up front that a list is partial.

## Layer 3: load one statement at a time (Simplified Technical English)

- One instruction per sentence. One thought per sentence everywhere else.
- Split instructions longer than about 20 words, other sentences longer than about 25.
- Put the warning or condition before the step it guards.
- Keep "the" and "a". "Remove backup file" reads two ways; "Remove the backup file" reads one.
- Give each word one meaning and one job, then keep it. If "check" means inspect, do not also use it for restrain.
- Pick one word per action and stick to it: "start", never "start" here and "initiate" there.
- Write procedures as direct commands, never as narration and never in the passive.
- Avoid "-ing" words where you can. They take too many grammatical jobs and breed misreadings.

## Layer 4: leave no sentence open to two readings (Global English)

- Keep "only" and "not" next to the word they change. "only fails on growth" and "fails only on growth" say different things.
- Break up long noun strings: "the proto import budget check script" becomes "the script that checks the proto-import budget".
- Make every "it", "they", and "this" point at one obvious thing. Repeat the noun when in doubt. Never use "this" or "which" to point at a whole clause.
- Do not drop verbs. "Phase 1 moves the converters and Phase 2 the runtime" leaves Phase 2 without one.
- Keep the small words that show structure. "Ensure that the switch is off" keeps "that" because it makes the sentence parse one way.
- Repeat the article in a series when it prevents a misread: "the client and the host", when they are two things.

## Worked example

Before:

> Configuration of the proto import ratchet budget script parameters is performed via budget.json. Note that it's important to remember that running with --write, which updates the committed budget to reflect the current count, should only be done when lowering it. If exceeded, CI fails.

After:

> `budget.mjs` reads the committed budget from `budget.json` and counts the files that import protos. If the count exceeds the budget, CI fails. Run `budget.mjs --write` only to lower the budget.

By layer: "configuration is performed" becomes "`budget.mjs` reads", so someone does something (layer 2). "Ratchet" goes away and the real filename does the naming. The five-noun string breaks into plain clauses (layer 4). The hedge is deleted. The failure condition moves ahead of the step it explains, and the buried "should only be done when lowering" becomes a command with "only" beside its verb (layer 3).

## Review checklist

1. Is each file one mode, with links where modes meet?
2. Is every instruction a command, with its condition in front?
3. Does any sentence carry two instructions or two thoughts? Split it.
4. Can any word be cut without losing meaning? Cut it.
5. Is "only" beside the word it changes? Does every "it" point at one thing? Does every clause keep its verb?
6. Does each thing have exactly one name across the docs?
7. Would a developer say these words out loud?
8. Are all symbols, paths, and counts real at this commit, with the commands that regenerate the counts?

Sources: diataxis.fr, developers.google.com/style, asd-ste100.org (Issue 9, 2025). Adapted from the `technical-writing` skill in [cursor/plugins](https://github.com/cursor/plugins/tree/main/pstack), MIT, copyright 2026 Lauren Tan.
