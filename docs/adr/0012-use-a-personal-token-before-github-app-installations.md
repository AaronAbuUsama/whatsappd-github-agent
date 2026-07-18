---
status: superseded by #153
---

# Use a personal token before GitHub App installations

The first production Issue Management capability uses one CLI-managed fine-grained personal access token and keeps Octokit behind its domain-facing issue interface, which ships the real single-operator slice without introducing a hypothetical authentication framework. Configuration represents the connection as a discriminated personal-token kind so a later GitHub App installation adapter can be added without changing the Issue Management Skill, Tools, or agent interface; GitHub App installation support remains an explicit later capability rather than hidden scope in this rollout.
