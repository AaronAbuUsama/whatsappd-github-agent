# Vendored Claude Code `/verify` methodology

`verify/SKILL.md` is the decoded built-in `/verify` skill from this exact public npm artifact:

- Package: `@anthropic-ai/claude-code-darwin-arm64@2.1.214`
- Tarball: `https://registry.npmjs.org/@anthropic-ai/claude-code-darwin-arm64/-/claude-code-darwin-arm64-2.1.214.tgz`
- npm integrity: `sha512-z99kjSImARBWdE6lGoCXSi83tbiabtIv7vtFyuwrHD56WZTFSguedBb9F8wlUncEEfUVtqHKa9nCZ55j6spiIA==`
- `package/claude` SHA-256: `59796dd18e9d77f1256f367db6d28ce4bd9cd5968e402ad3a327aac36abc6dec`
- Start marker: ``var vPf=`---\nname: verify``
- End marker: `` `;var EPf= ``

Reproduction requires npm to verify the package integrity, verification of the extracted binary SHA-256, exactly one occurrence of each ordered marker, extraction of the bytes between them, and decoding JavaScript escapes such as `\u2014` and escaped backticks. The vendored file is not sourced from this repository's `.claude/skills/verify/SKILL.md`.
