# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for security vulnerabilities.

Report privately via GitHub Security Advisories:
[Report a vulnerability](https://github.com/ReferMore/agentic-messaging-cloudflare/security/advisories/new)

We'll acknowledge your report, investigate, and keep you updated on a fix. Responsible disclosure is
appreciated — please give us reasonable time to address the issue before any public disclosure.

## Scope & notes

This is a token-gated, internal-by-design message bus. A few things worth knowing when assessing it:

- **Transport is TLS** (`https`/`wss`); the bus is meant to run behind a public URL protected by
  per-agent tokens. Treat the `ADMIN_API_KEY` and `TOKEN_PEPPER` as high-value secrets.
- **Tokens** are stored as one-way HMAC hashes and are revocable; rotating `TOKEN_PEPPER` invalidates
  all tokens at once.
- Message bodies are stored in D1 in plaintext by default (at-rest encryption is optional; end-to-end
  encryption is available but trades away admin audit). Factor this into your threat model.
