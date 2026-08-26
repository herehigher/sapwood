# Diagram style — regeneration guide

The style spec for hand-regenerating `README.md`'s three Mermaid diagrams as
static images later (e.g. a docs export or social-preview card). No image
ships in this PR — this file is the recipe, not the artifact.

## Palette

- GitHub layer — amber `#D9A441`
- Engine layer — slate blue `#4C6EF5`
- Headless sessions layer — teal `#12B886`
- Reviewer adapter layer — violet `#7C3AED`
- Background — `#FAFAFA` (light) / `#1E1E1E` (dark)

## Node shape per layer

- GitHub — rounded rectangle (external system).
- Engine — plain rectangle (deterministic code).
- Headless sessions — rounded rectangle, dashed border (ephemeral process).
- Reviewer adapter — diamond (pluggable choice point).
- Worker-lifecycle states (Diagram 3) — rounded rectangle; the terminal
  `done` state gets a double border.

## Label rules

- Match `README.md`'s node text exactly — the image renders the same
  diagram, it does not redesign it.
- Quote any label containing a comma, parenthesis, or the `·` separator.
- No file paths or module names in labels — concepts only, same "map, not
  manual" rule the source diagrams already follow.
- Keep each diagram's node count at or under 10, matching the Mermaid
  source's own cap.

## Diagram descriptions (source of truth: `README.md`)

1. **Hero loop** (`flowchart LR`) — a worker claims a Ready issue, pushes;
   the engine opens the PR, gates it on CI + review, then merges or stops
   for a human.
2. **Layered architecture** (`flowchart TB`) — GitHub holds process truth;
   the engine orchestrates; headless sessions do the work; a pluggable
   adapter reviews it.
3. **Worker lifecycle** (`stateDiagram-v2`) — `done` is terminal; `failed`
   can resume; a soft-budget `handoff` returns to where it started.

## Regeneration recipe

1. Copy the Mermaid source straight from `README.md` (Diagrams 1–3) — never
   hand-retype it, so the image never drifts from the shipped diagram.
2. Render with the `mermaid-expert` skill/agent, or the Mermaid CLI
   (`mmdc`) with a theme config applying the palette and shapes above via
   `themeVariables`/`classDef` — never by hand-editing node text.
3. Export at 2× the diagram's natural size, targeting roughly 800px on the
   longer edge: sharp at normal zoom, a reasonable file size for a repo
   asset.
4. Save under `docs/assets/`, named for the diagram (`hero-loop.png`,
   `architecture.png`, `worker-lifecycle.png`). Do not commit an export
   until a follow-up issue asks for it — this PR ships text only.
