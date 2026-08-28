---
name: unslop
description: "Removes AI tells from prose: puffery, AI vocabulary, em dashes, inline-header lists, hedging, filler, and abstract metaphor nouns. Use when writing or editing any prose a human reads, including README files, docs, PR descriptions, commit messages, changelogs, release notes, and marketing copy."
---

# Unslop

Edit text to remove AI patterns and add human voice.

## Process

1. Scan for the patterns below.
2. Rewrite. Preserve meaning, match the intended tone.
3. Add soul.
4. Self-audit: "what makes this obviously AI generated?" Fix what is left.

## Add soul

Removing patterns is half the job. Sterile, voiceless writing is just as obvious.

- **Have opinions.** React to facts instead of neutrally listing pros and cons.
- **Vary rhythm.** Short sentences. Then longer ones that take their time.
- **Acknowledge complexity.** "Impressive but also kind of unsettling" beats "impressive".
- **Use "I" when it fits.** First person is not unprofessional.
- **Let some mess in.** Perfect structure looks machine made.
- **Be specific.** Not "this is concerning" but "there is something unsettling about agents churning away at 3am".

## Content

1. **Puffery.** "pivotal moment", "testament to", "evolving landscape", "setting the stage for", "indelible mark". Cut it and state what happened.
2. **Name-dropping.** Listing outlets without context. Pick one, say what it said.
3. **Superficial -ing phrases.** "highlighting...", "ensuring...", "reflecting...", "showcasing...", "fostering...". Delete, or expand with a real source.
4. **Promotional language.** "nestled", "vibrant", "breathtaking", "groundbreaking", "renowned", "must-visit". Describe neutrally.
5. **Vague attributions.** "Experts believe", "Industry reports suggest", "Some critics argue". Name the source or delete the claim.
6. **Formulaic challenges.** "Despite challenges... continues to thrive." Replace with specific facts.

## Language

7. **AI vocabulary.** Additionally, crucial, delve, enduring, enhance, fostering, garner, interplay, intricate, landscape (abstract), pivotal, showcase, tapestry (abstract), testament, underscore, vibrant. Use plain words.
8. **Fancy ways to say "is".** "serves as", "stands as", "boasts", "features". Say "is" or "has".
9. **"Not just X, but Y."** State the point directly.
10. **Rule of three.** Forcing ideas into groups of three. Use the natural number.
11. **Synonym cycling.** Protagonist, main character, central figure, and hero in one paragraph. Pick one and repeat it.
12. **False ranges.** "from X to Y" where X and Y are not on a meaningful scale. List the topics directly.

## Style

13. **Em dashes.** Avoid them entirely. Use a period or a comma, not parentheses, en dashes, or a hyphen standing in for a dash. If a thought needs separation, end the sentence. Reaching for parentheses instead trades one tell for another.
14. **Mid-sentence colons.** A colon is fine before a list or an example, not as a connector. "If you are coming from traditional automation: instead of registering handlers, you describe conditions" gains nothing from the colon. Rewrite so the point stands without the comparison framing.
15. **Boldface overuse.** Do not bold every proper noun or acronym.
16. **Inline-header lists.** The tell is a bold label and colon restating the line: "**Performance:** Performance improved...". Convert those to prose. A bold lead-in that ends in a period, names the item, and is followed by genuinely new detail ("**Schema in TypeScript.** Tables live in one file.") is fine.
17. **Title case headings.** Use sentence case.
18. **Decorative emojis.** Remove them from headings and bullets.
19. **Curly quotes.** Replace with straight quotes.

## Communication artifacts

20. **Chatbot phrases.** "I hope this helps!", "Let me know if...", "Of course!", "Certainly!", "Found the smoking gun!" Remove.
21. **Cutoff disclaimers.** "While specific details are limited..." Find the source or remove the sentence.
22. **Sycophantic tone.** "Great question! You're absolutely right!" Respond directly.

## Filler

23. **Filler phrases.** "In order to" is "To". "Due to the fact that" is "Because". "It is important to note that" is nothing.
24. **Excessive hedging.** "could potentially possibly be argued that it might" is "may".
25. **Generic conclusions.** "The future looks bright." State a specific plan or fact.

## Jargon

26. **Abstract metaphor nouns.** Substrate, wedge, vector, locus, vantage, nexus, primitive (as a noun), harness (as a metaphor), surface (as in "API surface"), bedrock, scaffolding (as a metaphor), modality, paradigm, gold-plating, ratchet, evacuate (for moving code), endgame, north star, flywheel. Each has a plainer concrete word. Substrate is "base". Wedge in is "add". Vector is "way" or "method". Gold-plating is "more than the job needs". Ratchet is the mechanism's real name, or "a limit that only tightens". Evacuate is "move out". Endgame is "the last phase". Pick the concrete word.

## Plain speech

27. **Say what it does, not how it feels.** "the database stays close at hand", "SQL you can read", "types that follow your schema" all name a feeling. The fix names the mechanism or a number: "`.toSQL()` returns the exact string sent to the database", "a column rename fails the build". Ask what the sentence tells the reader to do or know, then write that. If you cannot restate it as a concrete instruction, fact, or number, cut it. If the sentence could appear unchanged in another project's docs, it says nothing about this one.
28. **Shorten or split dense sentences.** If the reader has to backtrack to parse a sentence, break it in two or drop clauses. One idea per sentence.
29. **Active voice.** Catch "is/are/was/were + past participle" and name the actor. "queries are validated" is "the compiler validates queries". "the file is parsed by the loader" is "the loader parses the file". Passive is fine only when the actor is unknown or genuinely does not matter.
30. **Cut adverbs, or use a stronger verb.** "runs quickly" is "is fast", or the number. "significantly improves" is the measured delta. An adverb propping up a weak verb means the verb is wrong.
31. **Prefer the plain word.** "utilize" is "use", "leverage" is "use", "facilitate" is "help", "numerous" is "many", "in the event that" is "if". The fancier synonym is rarely clearer.

Adapted from the `unslop` skill in [cursor/plugins](https://github.com/cursor/plugins/tree/main/pstack), MIT, copyright 2026 Lauren Tan.
