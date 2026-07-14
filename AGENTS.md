# Agent Fleet cross-platform development policy

- Design shared user-facing workflows once across the wtmux protocol, Windows Agent Fleet, and Android Agent Fleet.
- Implement and validate Windows first when it provides the faster feedback loop, then complete Android parity before calling the workflow done.
- Sessions, Native conversation, limits, schedules, attachments, and settings require equivalent Windows and Android behavior unless a documented platform constraint prevents it.
- Any shared protocol or fixture change must be validated by both client repositories before rollout.
- Keep platform-specific internals independent, but document every intentional user-visible deviation and its reason in the relevant specification and implementation plan.

