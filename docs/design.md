# Gemination Studio Design System

## 1. Aesthetic Direction
Gemination Studio is a local Agentic Development Environment (ADE) workbench for sustained coding sessions connecting `gemini.google.com` or local MCP clients to a local PC (macOS, Windows, and Linux) over MCP: calm, dense, operational tonal surfaces built with zero decorative clutter.

- **Mood**: quiet engineering tool, zero marketing hype, zero neon glows, zero decorative accent stripes.
- **Icons**: monochrome 24x24 stroke SVG sprite only (`stroke-width: 1.7`, round caps/joins). Zero emojis in code or UI.
- **Strict Craft Rules**: no cards inside cards (use `border-top` dividers and spacing inside panels), no left/top accent border stripes on rounded surfaces, state-stable buttons with fixed slots/min-widths.

## 2. Color Tokens

### Light Theme (`:root`)
- `--page`: `#f5f5f7`
- `--rail`: `#eceef2`
- `--card`: `#ffffff`
- `--sunk`: `#f8f9fb`
- `--hover`: `#ebedf2`
- `--ink`: `#111318` (contrast > 14:1 on `--card`)
- `--soft`: `#4b5262` (contrast > 7:1 on `--card`)
- `--faint`: `#5f6778` (contrast > 4.7:1 on `--card` and `--page`)
- `--line`: `#dfe2e8`
- `--edge`: `#cfd4de`
- `--accent`: `#2563eb`
- `--accent-btn`: `#2563eb`
- `--accent-btn-hover`: `#1d4ed8`
- `--accent-ink`: `#ffffff`
- `--accent-wash`: `#e8f0fe`
- `--accent-edge`: `#bdd2fb`
- `--green`: `#15803d`
- `--green-wash`: `#eaf7ef`
- `--green-edge`: `#bfe7ce`
- `--amber`: `#92400e`
- `--amber-wash`: `#fef6e6`
- `--amber-edge`: `#f5d89a`
- `--red`: `#b91c1c`
- `--red-wash`: `#fef0f0`
- `--red-edge`: `#f5c2c2`

### Dark Theme (`:root[data-theme="dark"]`, Default)
- `--page`: `#141517`
- `--rail`: `#181a1d`
- `--card`: `#1d1f23`
- `--sunk`: `#16181b`
- `--hover`: `#25282e`
- `--ink`: `#eceef2` (contrast > 13:1 on `--card`)
- `--soft`: `#b3b9c5` (contrast > 7.5:1 on `--card`)
- `--faint`: `#9aa2b1` (contrast > 4.9:1 on `--card` and `--page`)
- `--line`: `#2a2e35`
- `--edge`: `#363b45`
- `--accent`: `#3b82f6`
- `--accent-btn`: `#2563eb`
- `--accent-btn-hover`: `#1d4ed8`
- `--accent-ink`: `#ffffff`
- `--accent-wash`: `#1c2a42`
- `--accent-edge`: `#2d466d`
- `--green`: `#4ade80`
- `--green-wash`: `#12261b`
- `--green-edge`: `#244d36`
- `--amber`: `#fbbf24`
- `--amber-wash`: `#292112`
- `--amber-edge`: `#52401b`
- `--red`: `#f87171`
- `--red-wash`: `#2b1618`
- `--red-edge`: `#59292e`

## 3. Typography & Scale
- **Sans UI**: `"Apple SD Gothic Neo", "Malgun Gothic", -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans KR", sans-serif`
- **Monospace (strictly for code, paths, URLs, PINs, timestamps, git diffs)**: `ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace`
- **Scale** (`>= 1.25x` per step):
  - `h1` view heading: `24px` (`1.5rem`, weight `650`, line-height `1.25`)
  - `h2` section heading: `18px` (`1.125rem`, weight `620`, line-height `1.3`)
  - `body`: `14px` (`0.875rem`, line-height `1.55`, measure `<= 68ch`)
  - `meta` / table headers: `12px` (`0.75rem`, weight `550`)
- **Numerals**: `font-variant-numeric: tabular-nums` on timestamps, latencies, PINs, and counts.

## 4. Radii & Spacing
- Radii: `--r-xs: 6px`, `--r-sm: 8px`, `--r-md: 10px`, `--r-lg: 14px`, `--pill: 999px`
- Group separation `>= 2x` intra-group gap (`24px` section stack vs `10px–12px` row/field gaps).
- Pointer targets: minimum `32px` control height / `>= 24x24px` hit box everywhere.

## 5. Scroll Ownership & Reflow Architecture
- Root shell: `height: 100dvb; overflow: hidden;`
- Desktop grid: `grid-template-columns: 248px minmax(0, 1fr); grid-template-rows: 48px minmax(0, 1fr);`
- **Fixed**: `.topbar` (`48px`) and `.sidebar` (`248px` rail on desktop; off-canvas drawer `<= 900px`).
- **Scroll owner**: `<main class="workspace-main">` has `min-block-size: 0; overflow-y: auto; overflow-x: hidden;`.
- Inside View 3 (Files & Git), split list-detail panes collapse cleanly from 2 columns (`minmax(min(17rem, 100%), 0.9fr) minmax(min(22rem, 100%), 1.4fr)`) to 1 column below `900px`.
