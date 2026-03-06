---
name: review
description: Deprecated alias for /plan --review
---

# Review (Deprecated Plan Review Alias)

Review is a deprecated compatibility alias for `/plan --review`. It triggers Critic evaluation of an existing plan and should not be presented as a headline public review entry.

## Boundary

This is **plan review only**.

It is a compatibility shortcut, not a primary public review surface.

It is **not** a general code review alias.
- For maintainability / correctness / API / performance review, use `code-review`
- For trust-boundary and OWASP-style review, use `security-review`

## Usage

```
/review
/review "path/to/plan.md"
```

## Behavior

This skill invokes the Plan skill in review mode:

```
/plan --review <arguments>
```

The review workflow:
1. Read a plan file from `.omx/plans/` (or a specified path)
2. Evaluate it via the `critic` role
3. Return a verdict: APPROVED, REVISE (with specific feedback), or REJECT (replanning required)

Follow the Plan skill's full documentation for review mode details.
