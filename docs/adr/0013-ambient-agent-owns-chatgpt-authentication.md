# Ambient Agent owns ChatGPT authentication

For the SaaS tenant runtime, ADR 0018 supersedes the local-file and file-lock details below when the complete tenant database environment contract is configured.

Ambient Agent starts the supported `openai-codex` headless device-code flow,
reports its verification URI, user code, expiry and progress through an
injectable callback interface, and stores only the complete ChatGPT OAuth
record in `credentials/chatgpt-oauth.json`. The credential store validates a
private regular file, serializes login and refresh with a cross-process lock,
and atomically replaces the file before rotated authorization is considered
ready. `status` inspects without prompting or revealing credential material;
`doctor --refresh` verifies rotation, and `doctor --live` gates one real model
request through the same production authorization interface.

Pi and Flue remain private model-runtime adapters. Runtime construction must
receive `ChatGptAuthentication` explicitly; it may not call Pi's default
`AuthStorage`, read `~/.pi`, accept a user-selected auth path, or fall back to
model API-key environment variables. A provisional `pi-auth.json` inside the
Ambient Agent managed credential directory may be migrated once. No unrelated
global Pi credential is discovered or copied.
