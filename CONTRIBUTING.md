# Contributing

Thanks for your interest in **agentic-messaging-cloudflare**! Contributions are welcome.

## Development setup

See the README "Quick start". In short:

```bash
npm run setup       # installs deps + provisions a local/dev environment
npm run type-check  # TypeScript check
npm run smoketest   # end-to-end self-test (spawns a local Worker, tears down)
```

Please run `npm run type-check` before opening a PR (and `npm run smoketest` if your change touches
runtime behavior). CI runs the type check + a script syntax check on every PR.

## Branches & PRs

- `main` is the trunk. Fork the repo, create a topic branch off `main`, and open your PR against **`main`**.
- Keep PRs focused. Describe what changed and how you tested it (the PR template will prompt you).
- Releases are tagged on `main` (e.g., `v0.1.0`).

## Commit sign-off (DCO)

This project uses the [Developer Certificate of Origin](https://developercertificate.org/). Sign off
each commit:

```bash
git commit -s -m "your message"
```

That adds a `Signed-off-by:` line certifying you wrote the code, or otherwise have the right to submit
it under the terms below.

## Licensing of contributions

This project is open source under the **MIT License**. By submitting a contribution, you agree that your
contribution is provided under the project's MIT license.

## Code style

Match the surrounding code. TypeScript strict mode is on — keep it type-clean, and prefer small,
reviewable changes.
