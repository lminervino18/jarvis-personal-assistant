# Security policy

J.A.R.V.IS is a private, single-owner project. It is not offered as a service and there is no supported public deployment.

## Reporting a vulnerability

Please do not open a public issue for a security problem. Use GitHub's private vulnerability reporting for this repository (Security tab, "Report a vulnerability"). If that is not available, contact the repository owner through the address on their GitHub profile. Include what you found, how to reproduce it, and the version or commit. You will get an answer as soon as the owner can give one; there is no formal response time.

## Scope

In scope: authentication and sessions, the tool policy and confirmation flow, handling of third-party content, secret handling in the image, compose files and CI, and the backup and restore scripts.

Out of scope: social engineering, denial of service by traffic volume, and issues in third-party services (Anthropic, Google, WhatsApp, hosting providers) that this project only uses.

## Secrets and personal data

The repository must never contain real credentials, `.env` files, personal data, audio or sessions. Fixtures are synthetic and live under `fixtures/`. CI scans the full history with gitleaks. If you find a secret in the repository or in its history, report it privately as above; the owner will revoke it first and then clean up.

## More

The threat model, controls and rotation procedures are in `docs/security.md`. Operating procedures, including incident handling, are in `docs/runbook.md`.
