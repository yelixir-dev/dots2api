# dots2api Console Design System

Scope: the management console in `src/web/**`. Every color, size, space, radius, shadow and
duration used by `src/web/styles.css` is declared here first and mirrored as a CSS custom
property at the top of that file. The console belongs to the bridge family
(commandcode-bridge, cursor-ai-proxy-bridge): the kiro-lb operations layout with yelixir.dev
typography and warm dark/light materials. Restyle by changing token values, not components.

## 0. Reference

- Family reference: the rendered `commandcode/dashboard` (`index.html`, `app.css`) and its
  contract in `cursor-ai/DESIGN.md`. No kiro-lb source is copied; only its layout grammar is
  followed: sticky glass header, one tab strip, KPI cards, bordered panels.
- StyleGallery recipes consulted: `recipes/dashboard.md` and the page-grid / card-grid
  layout patterns. `consumer_reference: not_applicable`: this product consumes layout
  recipes, not a StyleGallery conformance profile.
- Product facts that drive layout: providers and their credential fields come from
  `GET /api/providers`; one active job per account; jobs can end in `unknown` (accepted but
  unconfirmed). The server is usually remote, so login flows are headless-first.

## 1. Atmosphere & Identity

An operations console in warm ink and cream. The default dark theme is near-black ink with
cream text and a gold accent; the light theme is paper with rust. A sticky glass header
carries the brand (a spectral mark and an italic serif "api"), the live-connection chip, a
refresh button and the theme switch. Navigation is one pill tab strip. Content sits in
bordered panels (KPI cards, ledger panels) on a faint grain. The **signal square** status mark
plus a Korean status word stays the status carrier. Gold (dark) or rust (light) is the only
accent and appears on primary actions, the selected tab icon, focus rings, links and running work.

## 2. Color

Dark is the default. Light is selected with `data-theme="light"` on `<html>`; the choice is
local presentation state in `localStorage` (`dots2api-theme`) and is unrelated to authentication.
Contrast ratios below were computed against `--paper` / `--surface`.

| Role | Token | Dark | Light | Usage |
|------|-------|------|-------|-------|
| Surface/app | `--paper` | `#0E0C0A` | `#F1EDE5` | Page background, selected tab |
| Surface/raised | `--surface` | `#15120F` | `#F7F4EE` | Panels, cards, inputs, drawers, dialogs |
| Surface/sunken | `--sunken` | `#1B1714` | `#EBE5DA` | Code blocks, skeletons, segmented track |
| Text/primary | `--ink-1` | `#F1EDE5` | `#28231F` | Titles, body (16.7:1 / 13.3:1) |
| Text/secondary | `--ink-2` | `#CBC2B4` | `#5C544A` | Descriptions (11.1:1 / 6.4:1) |
| Text/tertiary | `--ink-3` | `#A69B8C` | `#6B6258` | Meta, captions (7.1:1 / 5.1:1) |
| Text/placeholder | `--ink-4` | `#8F8576` | `#7A7064` | Placeholders only (5.4:1 / 4.2:1) |
| Wash hover/selected/pressed | `--wash-1/2/3` | cream at 4/7/11% | ink at 4/7/11% | Row, ghost, segment states |
| Border/hairline | `--line` | cream at 12% | `#D2CBC0` | Panel edges, dividers |
| Border/control | `--line-control` | cream at 42% | `#8A8173` | Inputs, switches, secondary buttons (3.6:1 / 3.5:1) |
| Accent | `--accent` | `#E5B45B` | `#9F4D2E` | Primary fill, links, focus, running (10.2:1 / 5.0:1) |
| Accent hover/pressed | `--accent-hover/-press` | `#EFC578` / `#D4A24A` | `#85402A` / `#6F3523` | Primary states |
| Accent wash | `--accent-wash` | gold at 14% | rust at 10% | Running badge background |
| On accent | `--on-accent` | `#0E0C0A` | `#F7F4EE` | Text on accent fills (10.2:1 / 5.4:1) |
| Status/ok | `--ok` | `#7FB8BB` | `#1D6A72` | Ready, completed (8.8:1 / 5.4:1) |
| Status/warn | `--warn` | `#E5B45B` | `#7D5409` | Unknown result, attention (10.2:1 / 5.7:1) |
| Status/danger | `--danger` | `#D9805C` | `#9F4D2E` | Error, failed, destructive (6.7:1 / 5.0:1) |
| Danger hover | `--danger-hover` | `#E39573` | `#85402A` | Destructive button hover |
| Status washes | `--ok-wash`, `--warn-wash`, `--danger-wash` | status at 14% | status at 10-13% | Badge and notice backgrounds |
| Neutral wash | `--neutral-wash` | cream at 8% | ink at 7% | Unconnected, disabled badges |
| Scrim | `--scrim` | `rgba(0,0,0,0.6)` | `rgba(40,35,31,0.4)` | Dialog and drawer backdrop |
| Header glass | `--glass` | `rgba(21,18,15,0.9)` | `rgba(241,237,229,0.9)` | Sticky header, blur 16px |

### Rules
- Accent marks at most one or two likely actions per screen (e.g. "계정 추가", "작업 보내기").
  Peer actions use secondary/ghost style. The spectral brand mark is the one decorative exception.
- Status color always ships with a word (`준비됨`, `오류`, `결과 불확실` …); color is never the
  only carrier.
- Selected tab is a bordered pill on `--paper` plus an accent icon; selected rows use an ink wash — never a colored side border.
- No color outside this table; extend the table first.

## 3. Typography

| Level | Token | Size / Line | Weight | Tracking | Usage |
|-------|-------|-------------|--------|----------|-------|
| Page | `--text-page` | 30px / 1.15 | 500 display | -0.02em | One `h1` per view |
| Figure | `--text-figure` | 30px / 1 | 500 display | -0.02em | Overview stat figures (tabular) |
| Title | `--text-title` | 20px / 1.3 | 650 | -0.01em | Drawer/dialog titles |
| Lead | `--text-lead` | 16px / 1.5 | 500 display (section titles), 600 (row titles) | -0.01em | Section titles, row titles |
| Body | `--text-body` | 14px / 1.55 | 400 | 0 | Default UI text, inputs |
| Meta | `--text-meta` | 13px / 1.5 | 400 | 0 | Secondary row lines, help text |
| Caption | `--text-caption` | 12px / 1.4 | 600 | 0.02em | Field labels over figures, badges |

- Display (page, section, figure, brand): `"Space Grotesk", "DM Sans", "Pretendard Variable", Pretendard, "Apple SD Gothic Neo", "Noto Sans KR", "Malgun Gothic", system-ui, sans-serif`.
- Sans (body): `"DM Sans", "Pretendard Variable", Pretendard, -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Noto Sans KR", "Malgun Gothic", "Segoe UI", system-ui, sans-serif`.
- Serif: `"Instrument Serif", Georgia, serif`, italic, only for the "api" in the brand name.
- Mono: `"JetBrains Mono", ui-monospace, "SF Mono", Menlo, Consolas, "D2Coding", monospace` for
  IDs, URLs, keys, code and the live chip.
- Latin faces load from `yelixir.dev/fonts/*.woff2` with `font-display: swap`, as the sibling
  consoles do. Offline, the explicit system fallbacks above render; layout does not depend on
  the web fonts. Korean glyphs come from the fallback stack.
- Korean text uses `word-break: keep-all` + `overflow-wrap: anywhere` so words never split
  mid-syllable but unbroken tokens (URLs, IDs, cookies) still wrap; headings use
  `text-wrap: balance`, prose `text-wrap: pretty`.
- Every count, time and duration uses `font-variant-numeric: tabular-nums`.

## 4. Spacing & Layout

Base unit 4px.

| Token | Value | Usage |
|-------|-------|-------|
| `--space-1` | 4px | Icon-to-label, badge padding |
| `--space-2` | 8px | Inline groups, button gaps |
| `--space-3` | 12px | Control padding, row inner gaps |
| `--space-4` | 16px | Row padding, mobile page gutter |
| `--space-5` | 20px | Drawer inner padding (mobile) |
| `--space-6` | 24px | Drawer inner padding, section inner spacing |
| `--space-8` | 32px | Between sections |
| `--space-10` | 40px | Maximum page gutter |
| `--space-12` | 48px | Page bottom breathing room |

| Layout token | Value | Usage |
|--------------|-------|-------|
| `--content-max` | 1320px | Centered content track (header and main) |
| `--gutter` | `clamp(16px, 4vw, 40px)` | Fluid horizontal page padding |
| `--drawer-width` | 30rem | Side panel width (full width under 640px) |
| `--dialog-width` | 26rem | Confirm dialog |
| `--control-h` | 36px | Button/input height |
| `--control-h-sm` | 32px | Compact buttons, header controls, chips |
| `--tab-h` | 40px | Tab strip item height |

- Breakpoints: `640px` (drawer becomes full-screen sheet below), `720px` (header refresh
  label hides, tab icons hide), `480px` (brand subtitle and chip text hide), `960px` (wide row
  layouts collapse to one column).
- Shell: the document is the scroll owner. The glass header is `position: sticky`. The tab strip
  is a pill-shaped `nav` of four equal links with visible labels at every width (route links
  with `aria-current`, not a `tablist`). Drawers own their own scroll (body scrolls, header and
  footer pinned).
- KPI figures are separate bordered cards; providers, accounts, jobs and attention items are
  rows inside one bordered ledger panel (`--radius-lg`). The grain overlay is `opacity: 0.035`.
- No horizontal page scroll at 375px; only code blocks scroll horizontally inside themselves.

## 5. Components

All primitives live in `src/web/components/`. Every interactive element has hover, active,
`focus-visible`, disabled states; async ones also have a loading state.

### Header and tabs (`.site-header`, `.tabs`)
- Sticky glass header: brand link, live-connection chip (`role="status"`, signal square +
  text), refresh button, and a theme icon button whose label names the target theme.
- Tab strip: pill `nav` with four equal route links (개요, 계정, 작업, API 안내); the
  selected link carries `aria-current="page"`, a control-border pill and an accent icon.
  Counts use the mono face.

### Button (`.btn`)
- **Structure**: `<button class="btn btn--{variant} btn--{size}">[icon] label</button>`
- **Variants**: `primary` (accent fill), `secondary` (surface + control border), `ghost`
  (transparent, ink wash on hover), `danger` (danger fill).
- **Sizes**: `md` (`--control-h`), `sm` (`--control-h-sm`).
- **States**: hover darkens fill / adds wash; active uses pressed token; focus ring; disabled
  50% opacity; loading swaps the icon for a spinner, keeps the label, sets `aria-busy`.
- **Shape**: pill (`--radius-full`).
- **Icon button**: round `ghost`, mandatory `aria-label` + `title`.

### Signal + StatusBadge (`.badge`)
- 8px square (`--radius-xs`) in status color + Korean word, on the status wash.
- Variants: `ready`, `completed` (ok), `error`, `failed` (danger), `unknown` (warn),
  `running`, `checking` (accent; running pulses opacity), `unconnected`, `disabled`, `busy`
  (neutral).

### Switch (`.switch`)
- `<button role="switch" aria-checked>`; 36×20 track, control-border when off, ok fill when
  on; loading state shows a spinner in the knob and disables input.

### Field (`.field`)
- Label (+ `필수`/`선택` marker), control, help (`--text-meta`, ink-3), error (danger, with
  icon, `role="alert"`). `aria-describedby` links help and error.
- Controls: text input, secret input (password + show/hide icon button), textarea (secret
  textareas masked with `-webkit-text-security` + show/hide), native select.

### Segmented control (`.segmented`)
- Radio group with sunken track; selected segment is surface + hairline, not accent.
- Used for provider filters (with counts), job status filter, job target mode.

### Notice (`.notice`)
- Icon + text block on a wash: `info` (sunken), `warn`, `danger`, `ok`. Inline, never toast,
  for outcomes that belong to an object.

### EmptyState (`.empty`)
- Icon on a hairline square, title (`--text-lead`), one sentence, one action. No artwork.

### CodeBlock (`.code`)
- Sunken mono block, own horizontal scroll, header with caption + copy button.

### Drawer (`dialog.drawer`)
- Native `<dialog>` opened with `showModal()` (focus trap, Esc, top layer). Right side panel,
  `--drawer-width`; full-screen sheet below 640px. Header (title + close) and footer pinned,
  body scrolls. Focus goes to `[data-autofocus]`, returns to the opener on close. Esc and
  backdrop click are ignored while a save is in flight.

### Provider login
- Reuse Drawer, Notice, Field, CodeBlock and Button without new visual tokens.
- Dots shows a verification link, one-time device code and expiry, then an existing
  Dot thread input. Pending authorization and revoked/expired login remain explicit.
- Account operations are disabled during a server-held login lease. Completion
  means an actual provider connection check, not merely a successful OAuth exchange.
- Context budgets use tabular figures and an adjacent basis label ("지정값": a configured value, not a measurement).

### Job images (`.gallery`)
- Job detail lists remote-produced images in an intrinsic grid (`minmax(11rem, 1fr)`), each a
  bordered `--radius-lg` thumbnail on the sunken surface, `object-fit: contain`, linked to the
  original. The caption row carries the format, size (tabular) and a save link. Alt text names
  the image by its position; the remote agent's own text is never used as alt.

### ConfirmDialog (`dialog.confirm`)
- Centered `<dialog>`, `--dialog-width`; destructive confirm button focused last-safe:
  initial focus on Cancel.

### Toast (`.toast`)
- Bottom-right stack (bottom full-width on mobile), `role="status"`; used only for outcomes
  not visible in place (long check finished while elsewhere, deletion, save results).

### Ledger rows (`.ledger`, `.row`)
- Hairline-separated grid rows inside one bordered panel (`--radius-lg`, `--surface`);
  hover wash only when the row is itself a link. KPI figures use the same panel material.

## 6. Motion & Interaction

| Token | Value | Usage |
|-------|-------|-------|
| `--dur-1` | 160ms | Color/background changes on hover, press, toggle knob |
| `--dur-2` | 260ms | Drawer slide, dialog/scrim fade, toast enter |
| `--ease-out` | `cubic-bezier(0.22, 1, 0.36, 1)` | All enter motion |

- Only `transform` and `opacity` animate.
- Running work: the signal square pulses opacity (1.6s) — it means "still running".
- Spinner (0.8s rotation) appears for any request; long checks also show an elapsed clock
  (`0:42`) and an explanation of the login window, because they can legitimately last minutes.
- Async feedback: controls disable at once; success is shown by the changed row itself;
  failures are shown next to the object (form notice) or as a toast for row actions.
- No polling: data refreshes on SSE `change`, on SSE reconnect, and on explicit "새로 고침".
- `prefers-reduced-motion`: drawer slide becomes a fade; pulses and spinners stay (progress).

## 7. Depth & Surface

Strategy: **borders-only in the page, shadow only for overlays.**

| Type | Value | Usage |
|------|-------|-------|
| Hairline | `1px solid var(--line)` | Dividers, row separators, panel edges |
| Control | `1px solid var(--line-control)` | Inputs, selects, secondary buttons |
| `--shadow-overlay` | dark `0 16px 40px rgba(0,0,0,0.5), 0 2px 6px rgba(0,0,0,0.3)`; light `0 16px 40px rgba(40,35,31,0.18), 0 2px 6px rgba(40,35,31,0.08)` | Drawer, dialog, toast |

| Radius token | Value | Usage |
|--------------|-------|-------|
| `--radius-xs` | 2px | Signal square |
| `--radius-sm` | 4px | Badges, chips, segmented inner |
| `--radius-md` | 6px | Inputs, code blocks, notices |
| `--radius-lg` | 14px | KPI cards, ledger panels, composer, dialogs |
| `--radius-full` | 999px | Buttons, icon buttons, tab strip and tabs, status chip, switch |

## 8. Accessibility Constraints & Accepted Debt

### Constraints
- WCAG 2.2 AA: text contrast ≥ 4.5:1 (tokens above are checked), control boundaries ≥ 3:1,
  visible `focus-visible` ring (2px paper gap + 2px accent) on every interactive element.
- Full keyboard path: skip link, nav links with `aria-current`, rows are links/buttons,
  dialogs trap focus and close with Esc, `⌘/Ctrl + Enter` submits a job prompt.
- Route changes move focus to the view's `h1` and update `document.title`.
- Live regions: toasts `role="status"`, form errors `role="alert"`, SSE state announced
  politely.
- Secrets: never rendered back (the API never returns them), never logged, never stored in
  web storage; blank credential fields on edit are omitted from the PATCH body.

### Accepted Debt
| Item | Location | Why accepted | Owner / Exit |
|------|----------|--------------|--------------|
| No react-grab/react-scan/react-doctor dev tooling | `package.json` | UI scope forbids package changes | Lead decides |
| Server-provided field labels/help/descriptions render as sent (English today) | account drawer | Contract has no locale; translating dynamic adapter text would fabricate meaning | Provider owners localize |
| Masked multiline secrets rely on `-webkit-text-security` | secret textareas | No standard CSS for masking textareas; unmasked fallback in engines without it | Revisit if a standard lands |
| Credential fields cannot be cleared to empty on edit (blank = keep) | account drawer | Contract only defines omission semantics | Contract extension |
| `--ink-4` placeholder contrast 4.2:1 (light) | inputs | Placeholders carry examples only; instructions live in help text | — |
| Web fonts load from yelixir.dev | `styles.css` | Matches the sibling consoles; system fallbacks are explicit | Self-host if the family does |
