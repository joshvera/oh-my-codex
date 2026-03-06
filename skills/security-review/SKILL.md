---
name: security-review
description: Run a dedicated security audit on code (specialist compatibility lane)
---

# Security Review Skill (Specialist Compatibility Lane)

Conduct a focused security audit checking trust boundaries, OWASP-style vulnerabilities, secrets exposure, and dependency risk. This remains available as a specialist compatibility entry rather than the default public review surface.

## When to Use

This skill activates when:
- User requests "security review", "security audit"
- After writing code that handles untrusted input
- After adding new API endpoints
- After modifying authentication/authorization logic
- Before deploying to production
- After adding external dependencies

## Boundary

`security-review` stays distinct from `code-review`.

It is **not** the primary public review entry; use it when the user explicitly requests a security audit or when `code-review` escalates due to trust-boundary risk.

Use this skill for:
- trust-boundary analysis
- authentication / authorization review
- untrusted input handling
- secrets exposure and credential leakage
- dependency CVEs and vulnerability posture

Do **not** use it for generic maintainability, style, or API ergonomics feedback unless those issues directly affect security.

## What It Does

Delegates to the `security-reviewer` agent (THOROUGH tier) for deep security analysis:

1. **OWASP Top 10 Scan**
   - A01: Broken Access Control
   - A02: Cryptographic Failures
   - A03: Injection (SQL, NoSQL, Command, XSS)
   - A04: Insecure Design
   - A05: Security Misconfiguration
   - A06: Vulnerable and Outdated Components
   - A07: Identification and Authentication Failures
   - A08: Software and Data Integrity Failures
   - A09: Security Logging and Monitoring Failures
   - A10: Server-Side Request Forgery (SSRF)

2. **Secrets Detection**
   - Hardcoded API keys
   - Passwords in source code
   - Private keys in repo
   - Tokens and credentials
   - Connection strings with secrets

3. **Input Validation & Trust Boundaries**
   - Untrusted input sanitized and validated
   - Injection prevention
   - Output encoding and XSS prevention
   - Path traversal / SSRF / file handling concerns

4. **Authentication/Authorization**
   - Password hashing and credential handling
   - Session/JWT security
   - Access control enforcement
   - Authn/authz bypass risk

5. **Dependency Security**
   - `npm audit` / ecosystem audit review
   - High-severity CVE identification
   - Outdated or risky dependency posture

## Agent Delegation

```
delegate(
  role="security-reviewer",
  tier="THOROUGH",
  prompt="SECURITY REVIEW TASK

Conduct a dedicated security audit of the requested code.

Scope: [specific files or entire codebase]

Security Checklist:
1. OWASP Top 10 scan
2. Hardcoded secrets detection
3. Trust-boundary and input-validation review
4. Authentication/authorization review
5. Dependency vulnerability scan

Boundary:
- Focus on security findings.
- Do not spend review time on generic style/maintainability concerns unless they materially affect security.

Output: Security review report with:
- Summary of findings by severity (CRITICAL, HIGH, MEDIUM, LOW)
- Specific file:line locations
- CVE references where applicable
- Remediation guidance for each issue
- Overall security posture assessment"
)
```

## External Model Consultation (Preferred)

The security-reviewer agent SHOULD consult Codex for cross-validation.

### Protocol
1. **Form your OWN security analysis FIRST** - Complete the review independently
2. **Consult for validation** - Cross-check findings with Codex
3. **Critically evaluate** - Never blindly adopt external findings
4. **Graceful fallback** - Never block if tools unavailable

### When to Consult
- Authentication/authorization code
- Cryptographic implementations
- Input validation for untrusted data
- High-risk vulnerability patterns
- Production deployment code

### When to Skip
- Low-risk utility code
- Well-audited patterns
- Time-critical security assessments
- Code with existing security tests

### Tool Usage
Before first MCP tool use, call `ToolSearch("mcp")` to discover deferred MCP tools.
Use `mcp__x__ask_codex` with `agent_role: "security-reviewer"`.
If ToolSearch finds no MCP tools, fall back to the `security-reviewer` agent.

**Note:** Security second opinions are high-value. Consider consulting for CRITICAL/HIGH findings.

## Output Format

```
SECURITY REVIEW REPORT
======================

Scope: Entire codebase (42 files scanned)
Scan Date: 2026-01-24T14:30:00Z

CRITICAL (2)
------------
1. src/api/auth.ts:89 - Hardcoded API Key
   Finding: AWS API key hardcoded in source code
   Impact: Credential exposure if code is public or leaked
   Remediation: Move to environment variables, rotate key immediately
   Reference: OWASP A02:2021 – Cryptographic Failures

2. src/db/query.ts:45 - SQL Injection Vulnerability
   Finding: User input concatenated directly into SQL query
   Impact: Attacker can execute arbitrary SQL commands
   Remediation: Use parameterized queries or ORM
   Reference: OWASP A03:2021 – Injection

HIGH (5)
--------
...

OVERALL ASSESSMENT
------------------
Security Posture: POOR
Recommendation: DO NOT DEPLOY until CRITICAL and HIGH issues are addressed.
```

## Security Checklist

The security-reviewer agent verifies:

### Authentication & Authorization
- [ ] Passwords hashed with strong algorithm (bcrypt/argon2)
- [ ] Session tokens cryptographically random
- [ ] JWT tokens properly signed and validated
- [ ] Access control enforced on protected resources
- [ ] No authentication bypass vulnerabilities

### Input Validation
- [ ] All untrusted inputs validated and sanitized
- [ ] Queries use safe parameterization
- [ ] File and URL handling prevent traversal / SSRF
- [ ] Output encoding blocks XSS

### Secrets & Supply Chain
- [ ] No hardcoded secrets in code or config
- [ ] Vulnerable dependencies identified
- [ ] Risky third-party integrations called out
- [ ] Remediation guidance is concrete and prioritized
