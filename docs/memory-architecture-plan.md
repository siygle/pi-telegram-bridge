# Memory Architecture Plan

## Background

Current implementation loads the full persistent memory dump during `session_start` and appends it to `systemPrompt` in `before_agent_start`.

```ts
systemPrompt: `${event.systemPrompt}\n\n${MEMORY_PROMPT_HEADER}${memoryDump}`
```

This is simple, but it does not scale well as memory grows.

## Problem

If the memory dump keeps growing, it reduces usable context on every new session:

- every session pays the full token cost up front
- less room remains for user requests, code, logs, and tool output
- irrelevant memory can dilute the model's attention
- the same static memory is resent repeatedly even when not needed

## Goals

- keep personalization and long-term preferences
- minimize context usage
- make memory scale as data grows
- load only memory relevant to the current task

## Recommended Design

Use a 3-layer memory architecture.

### 1. Core memory (always inject)

Small, high-value, stable preferences that should be present in every session.

Examples:

- reply language preference
- notification preference
- remote-browser write confirmation rule
- user identity basics

Target size:

- ideally 300-800 tokens
- hard upper bound should be enforced

### 2. Category memory (inject only when relevant)

Store memory by domain and load only when needed.

Example categories:

- `device`
- `church`
- `project`
- `family`
- `schedule`

Examples of routing:

- remote-browser / adb / chrome -> load `device`
- church events / posters / sermons -> load `church`
- cron / automation / telegram push -> load `schedule`

### 3. Full memory (query, do not preload)

Keep full memory in storage, but do not inject it into every session.

Instead:

- search by keyword
- search by category
- summarize the matched results
- inject only the top relevant items for the current turn

This makes memory behave more like lightweight RAG.

## Proposed CLI / script changes

Extend `memory.sh` with focused retrieval modes.

Examples:

```bash
memory.sh dump --mode core
memory.sh dump --mode summary
memory.sh dump --category device
memory.sh search "telegram"
```

Possible output contracts:

- `dump --mode core`: short stable prompt-safe memory block
- `dump --category <name>`: category-specific memory block
- `search <query>`: top relevant memory entries
- optional `--json`: structured output for ranking and post-processing

## Proposed Extension Changes

### Phase 1: minimal safe improvement

Replace full dump injection with core-only injection.

Flow:

1. `session_start` -> load `memory.sh dump --mode core`
2. cache as `coreMemoryDump`
3. `before_agent_start` -> inject only core memory

Also add a strict size guard.

Example:

- trim by chars or tokens before prompt injection
- warn in UI if core memory exceeds threshold

### Phase 2: relevant-memory injection

Load additional memory only when the current message suggests a matching category.

Possible flow:

1. session starts with core memory only
2. user sends a message
3. detect likely categories or keywords
4. fetch relevant memory
5. inject a short relevant-memory block for that turn

### Phase 3: search + summarize

For free-form requests, query memory storage and summarize only the top matches.

Example injected block:

```text
[Relevant memory]
- User prefers Traditional Chinese replies.
- Notifications should be sent via Telegram.
- Remote browser write actions require confirmation first.
- Church: 真耶穌教會永康教會, phone 06-231-2730.
```

## Suggested Heuristics

### Always include

- `preference`
- selected `user` basics

### Include conditionally

- `device`
- `church`
- `project`
- `family`
- `schedule`

### Never inject by default

- long notes
- historical details
- infrequently used records
- large project-specific memory blocks

## Guardrails

- enforce maximum token / character budgets
- prefer summaries over raw dumps
- avoid injecting duplicate memory already present in the conversation
- log what memory categories were loaded for observability
- make fallback behavior explicit when memory retrieval fails

## Suggested Implementation Order

1. add `memory.sh dump --mode core`
2. switch extension from full dump to core dump
3. add size limits and warnings
4. add category retrieval
5. add keyword search and summarization

## Decision Summary

### Do not

- inject the full memory dump into every session prompt

### Do

- inject a short core memory block every session
- retrieve category or keyword-relevant memory on demand
- summarize before injecting when memory is large

## Short Conclusion

Yes, unbounded full-memory injection will reduce usable context for every session.

The better design is:

- **core memory always loaded**
- **relevant memory loaded on demand**
- **full memory kept in storage and queried only when needed**
