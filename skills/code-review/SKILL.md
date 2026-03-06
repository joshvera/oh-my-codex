---
name: code-review
description: Run the primary public code-quality review workflow
---

# Code Review Skill

Conduct a thorough code review for correctness, maintainability, API design, performance, and style.

## When to Use

This skill activates when:
- User requests "review this code", "code review"
- Before merging a pull request
- After implementing a major feature
- User wants quality assessment or maintainability feedback

## Boundary

`code-review` is the primary public review entry for general code quality in this consolidation.

It **does cover**:
- correctness and bug risk
- maintainability and code health
- API contracts and integration boundaries
- performance concerns
- style / consistency issues

It **does not replace** a dedicated security audit. For trust boundaries, auth/authz, OWASP-style vulnerability review, secrets scanning, or dependency CVE review, escalate to `security-review` as the specialist compatibility lane.

## What It Does

Delegates to the `code-reviewer` agent (THOROUGH tier) for a deep quality review:

1. **Identify Changes**
   - Run `git diff` to find changed files
   - Determine scope of review (specific files or entire PR)

2. **Review Categories**
   - **Correctness & Risk** - likely bugs, fragile logic, missing edge cases
   - **Code Quality** - complexity, duplication, testability, readability
   - **API & Contracts** - compatibility, interface clarity, call-site impact
   - **Performance** - inefficient algorithms, hot paths, needless work
   - **Style & Consistency** - naming, structure, conventions, lint alignment

3. **Severity Rating**
   - **CRITICAL** - severe correctness/production risk blocking merge
   - **HIGH** - bug or major design smell that should be fixed before merge
   - **MEDIUM** - moderate issue worth fixing soon
   - **LOW** - style/suggestion or non-blocking improvement

4. **Specific Recommendations**
   - File:line locations for each issue
   - Concrete fix suggestions
   - Call out when a separate `security-review` should be run

## Agent Delegation

```
delegate(
  role="code-reviewer",
  tier="THOROUGH",
  prompt="CODE REVIEW TASK

Review code changes for correctness, maintainability, API boundaries, performance, and style.

Scope: [git diff or specific files]

Review Checklist:
- Correctness and regression risk
- Code quality (complexity, duplication, readability)
- API compatibility and interface clarity
- Performance issues (hot spots, needless work)
- Maintainability (coupling, testability, documentation)
- Style and consistency

Important boundary:
- Do not perform a full OWASP/security audit here.
- If trust-boundary or auth/input-risk concerns are discovered, recommend `security-review` explicitly.

Output: Code review report with:
- Files reviewed count
- Issues by severity (CRITICAL, HIGH, MEDIUM, LOW)
- Specific file:line locations
- Fix recommendations
- Approval recommendation (APPROVE / REQUEST CHANGES / COMMENT)"
)
```

## External Model Consultation (Preferred)

The code-reviewer agent SHOULD consult Codex for cross-validation.

### Protocol
1. **Form your OWN review FIRST** - Complete the review independently
2. **Consult for validation** - Cross-check findings with Codex
3. **Critically evaluate** - Never blindly adopt external findings
4. **Graceful fallback** - Never block if tools unavailable

### When to Consult
- Complex architectural changes
- Unfamiliar codebases or languages
- High-stakes production code
- Large refactors with many moving parts

### When to Skip
- Simple refactoring
- Well-understood patterns
- Time-critical reviews
- Small, isolated changes

### Tool Usage
Before first MCP tool use, call `ToolSearch("mcp")` to discover deferred MCP tools.
Use `mcp__x__ask_codex` with `agent_role: "code-reviewer"`.
If ToolSearch finds no MCP tools, fall back to the `code-reviewer` agent.

**Note:** Codex calls can take up to 1 hour. Consider the review timeline before consulting.

## Output Format

```
CODE REVIEW REPORT
==================

Files Reviewed: 8
Total Issues: 10

CRITICAL (0)
-----------
(none)

HIGH (2)
--------
1. src/api/contracts.ts:42
   Issue: Breaking response-shape change without migration path
   Risk: Existing callers will fail at runtime
   Fix: Preserve the old field or add a compatibility layer

2. src/cache/team-state.ts:89
   Issue: Recomputed data in a hot path on every call
   Risk: Avoidable latency under load
   Fix: Memoize or cache the derived result

MEDIUM (5)
----------
...

LOW (3)
-------
...

RECOMMENDATION: REQUEST CHANGES

If the change affects auth, trust boundaries, or untrusted input handling, also run `security-review`.
```

## Review Checklist

The code-reviewer agent checks:

### Correctness & Design
- [ ] Likely bugs and fragile assumptions identified
- [ ] Edge cases are handled or intentionally documented
- [ ] Interfaces and data contracts remain coherent
- [ ] Changes are understandable and maintainable

### Code Quality
- [ ] Functions are reasonably sized and readable
- [ ] Cyclomatic complexity is controlled
- [ ] No needless duplication
- [ ] Names are descriptive and consistent

### Performance
- [ ] No obvious hot-path inefficiencies
- [ ] No accidental O(n²) behavior when avoidable
- [ ] No unnecessary rendering / recomputation loops

### Best Practices
- [ ] Error handling is appropriate
- [ ] Logging is useful and safe
- [ ] Documentation exists where public behavior changes
- [ ] Tests cover critical behavior

## Approval Criteria

**APPROVE** - No CRITICAL or HIGH issues, minor improvements only  
**REQUEST CHANGES** - CRITICAL or HIGH issues present  
**COMMENT** - Only LOW/MEDIUM issues, no blocking concerns

## Use with Other Skills

**With Team:**
```
/team "review recent state-management changes and report findings"
```
Includes coordinated review execution across specialized agents.

**With Ralph:**
```
/ralph code-review then fix all issues
```
Review code, get feedback, fix until approved.

**With Security Review:**
```
/code-review
/security-review
```
Run quality review and dedicated security review separately when both are needed.

## Best Practices

- **Review early** - Catch issues before they compound
- **Review often** - Small, frequent reviews beat giant reviews
- **Keep security separate when needed** - Use `security-review` for trust-boundary and OWASP work
- **Consider context** - Some issues may reflect intentional trade-offs
- **Learn from reviews** - Use feedback to improve future implementations
