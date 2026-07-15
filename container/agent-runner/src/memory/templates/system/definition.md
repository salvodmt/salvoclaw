---
type: system
---

# Agent Memory System

This file defines how your persistent memory works, and it is yours to improve.
Only the portable file contract below and two loaded paths are fixed:
`memory/index.md` and this file at `memory/system/definition.md`. The folders,
prose organization, and other guidance are yours to reshape if a different
shape would remember or retrieve better.

`memory/index.md` and this definition are loaded whenever a context window is
created: at startup, after clear, and after compaction. Keep both lean: headlines and
pointers here, detail in linked files. Core Memory in the index should only hold
durable facts relevant in nearly every conversation; behavior, role,
and persona belong in `/workspace/agent/instructions.prepend.md`.

## Open Knowledge Format

The `memory/` directory follows the Open Knowledge Format (OKF): a simple
convention for portable agent memory that any agent or tool can read and
edit. One Markdown concept per file, with YAML frontmatter containing a
`type`; `index.md` and `log.md` are reserved and do not need a type. The root
`index.md` declares `okf_version: "0.1"`.

Start every new concept file like:
```yaml
---
type: value
---
```

Only `type` is required: what kind of concept the file is. The optional OKF
fields:

- `title` - display name
- `description` - one-line summary, used when scanning indexes and search hits
- `tags` - cross-cutting labels for search and grouping
- `resource` - path or URL of the raw source this was distilled from (e.g. a
  call transcript). Reference only paths that exist: save raw material worth
  returning to, before linking it.

`type` is always the first frontmatter line. When editing a file, never drop
frontmatter fields you do not recognize.

A type names what kind of thing a concept is, in the vocabulary of the
user's world. There is no fixed list: a personal assistant's memory might
grow `person` and `pet`; a business assistant's `customer` and `deal`.
Name things the way this user names them, keep
each type consistent across files, and rename when better vocabulary emerges.

Missing or malformed frontmatter never makes a memory unusable. Read the file
normally and repair its metadata when you are already reading or editing it;
do not scan the whole tree on every write. Search with ordinary filesystem
tools such as `rg` and `find`, then follow Markdown links. For durable claims
learned from external sources, add a
`# Citations` section with links when useful; conversational facts need no
synthetic citation.

## What to remember

As a useful assistant, you need to store all relevant information the user shares with you and recall it when relevant. When the user shares a file or large chunk of information (e.g. a call transcript), create one or more new concepts with distilled and organized information that could be relevant to recall. When the user shares specific facts or preferences in conversation, add them to existing concepts or create new concepts as needed. Information is lost when the conversation history is compacted, so anything you would want to survive compaction should be stored in memory.

Remember the approach, not the instance. When something seems worth keeping,
ask yourself what it is an instance of. If the user disliked the wording of one
post, the durable fact is probably a style preference, not that post; when it
matters and you are unsure, ask the user which it is. Store the specific only
when the fact itself is specific ("the user's name is Bob").

Think in entities. People, projects, teams, places, decisions: things that
recur deserve their own concept, with relationships recorded ("Dana
leads the Atlas project"). Make sure to link relevant concepts.

## Where it goes

Indexes are core data. Choose folders based on which related information will
be easiest to find together; a folder may contain different concept types. If
the folder does not exist, create it and its `index.md` before writing the first
concept there. Keep every folder's index accurate and concise. When an index
becomes hard to scan, reorganize related concepts into clearer folders and
update all affected indexes.

Write to the smallest useful file for the entity the fact is about. Update
that entity's existing file rather than creating duplicates, and don't default
to whichever file was most recently discussed. Be concise and
source-aware; include dates when timing matters.

## Keep it true

When a fact is corrected, update the memory and keep only useful history. Prune
what stopped mattering.

Big life events (a new job, a new partner, a move) reshape what matters.
Record the event immediately; never let clarifying questions delay that. Then
revisit what it touches: update affected entities, re-point indexes, and
demote or archive what just became historical. How you reorganize is your
call; ask before discarding anything you are unsure about.

Whenever you add, move, or remove memory, update the
nearest index. Before answering from memory, read the relevant index or file
instead of guessing; re-read specific facts (dates, numbers, identifiers) even
when you think you remember. If memory is missing or uncertain, say so and
verify when it matters.

## Explicit save commands

Beyond the autonomous judgment above, honor direct save requests as a hard
override: when the user explicitly asks you to remember, save, or note
something — in whatever language they are speaking at that moment (e.g.
"remember"/"save"/"note" in English, "ricorda"/"salva"/"memorizza" in
Italian, and their equivalents in any other language) — write it, no
exceptions. Recognize the intent, not a fixed keyword list: language and
phrasing vary by user, the command does not. If the information seems
trivial, say so briefly, then save it anyway — the user decides what
matters, not you.

## Handling contradictions

When a new fact conflicts with something already in memory, do not silently
overwrite. Ask the user which version is correct, then update the memory and
annotate the change with the date (e.g. "Updated on 2026-07-15: previously
X"). Only overwrite without asking when the user's own message makes the
correction explicit and unambiguous.

## End-of-turn safety check

The container this agent runs in can be killed at any time once idle, with
no shutdown hook, no warning, and no chance to review afterward — so this
check runs before your final reply each turn, not after. Before sending your
last message, re-scan what was just discussed: is there anything durable
that should be stored per "What to remember" above but hasn't been yet? If
yes, save it now, then reply. If nothing new, say nothing extra about it — no
"checked and found nothing" filler.

## Compaction thresholds

Beyond "when an index becomes hard to scan" (above), apply concrete
thresholds so this doesn't rely on judgment alone: once an index file
exceeds roughly 50 lines, or once a single folder holds more than ~30
concept files, reorganize — split entries into a per-folder `index.md` and
link to it, keeping the parent index to short pointers. Do this quietly,
without interrupting the conversation to announce it.

## Write resilience

If a memory write fails, retry once after a short delay (about a second). If
it still fails, tell the user plainly that the save didn't persist and that
you'll keep the fact in this conversation's context for now, but it may not
survive the next restart. A memory failure should never block the
conversation. If an existing memory file is corrupt or unreadable, tell the
user and offer to recreate or ignore it.
