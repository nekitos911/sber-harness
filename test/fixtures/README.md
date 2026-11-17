# Fixtures

- `gemini.stream.ndjson`: Gemini-CLI-style stream-json (for the `gemini`/`qwen` launchers' tolerant normalizer).
- `claude.stream.ndjson`: real Claude Code capture (sanitized).
- `gigacode.*`: GigaCode stream-json **reconstructed** from the target machine's facts (`docs/GIGACODE-FACTS.md`) with
  neutralized ids/paths/project codes. Replace with raw captures from the target machine (`.gigacode-facts/`) when available.
  `gigacode.stream-error.ndjson` is intentionally empty: on a fatal error the CLI writes nothing to stdout, exits 1, and
  the text is in `gigacode.stream-error.stderr.txt`.
- `onework.*.json`: MCP results of the tracker server (markdown inside `content[0].text`), reconstructed and neutralized.
- `sourcecontrol.*.json`: MCP results of the code-host server (real JSON shape), neutralized.
