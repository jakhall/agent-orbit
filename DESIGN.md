---
name: Orbit
description: A constellation of the Claude Code sessions one developer runs at once, with who needs me, and what for, beside it.
colors:
  bg: "#0B0C0E"
  surface: "#111214"
  raised: "#1B1D21"
  hover: "#22252A"
  line: "#26292E"
  line-strong: "#3C4048"
  control-edge: "#656B76"
  text: "#E4E6EA"
  label: "#C3C7CE"
  muted: "#8B9099"
  accent: "#6C93E8"
  on-accent: "#0B0C0E"
  amber: "#FF7A1F"
  green: "#2FD58F"
  coral: "#E06464"
  dim: "#676B73"
  bg-light: "#F7F8FA"
  surface-light: "#FFFFFF"
  raised-light: "#EEF0F3"
  hover-light: "#EAEDF1"
  line-light: "#DADDE3"
  line-strong-light: "#BCC1CA"
  control-edge-light: "#858A93"
  text-light: "#16181D"
  label-light: "#3D424B"
  muted-light: "#5B616C"
  accent-light: "#2F5FC4"
  on-accent-light: "#FFFFFF"
  amber-light: "#D9560A"
  green-light: "#0E8F5A"
  coral-light: "#C94A4A"
  dim-light: "#858B95"
typography:
  detail-title:
    fontFamily: "'Segoe UI Variable Text', 'Segoe UI', system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: 600
    lineHeight: 1.3
  brand:
    fontFamily: "'Segoe UI Variable Text', 'Segoe UI', system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 600
    lineHeight: 1.45
  body:
    fontFamily: "'Segoe UI Variable Text', 'Segoe UI', system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.45
  heading:
    fontFamily: "'Segoe UI Variable Text', 'Segoe UI', system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 600
    lineHeight: 1.45
  meta:
    fontFamily: "'Segoe UI Variable Text', 'Segoe UI', system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.45
  small:
    fontFamily: "'Segoe UI Variable Text', 'Segoe UI', system-ui, sans-serif"
    fontSize: "11px"
    fontWeight: 400
    lineHeight: 1.45
  mono:
    fontFamily: "'Cascadia Mono', Consolas, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.45
rounded:
  key: "3px"
  segment: "4px"
  control: "6px"
  panel: "8px"
  round: "999px"
spacing:
  2xs: "2px"
  xs: "4px"
  sm: "6px"
  md: "8px"
  lg: "10px"
  xl: "12px"
  2xl: "14px"
  3xl: "16px"
  4xl: "18px"
size:
  control: "30px"
  control-small: "24px"
  menu-button: "26px"
  send: "35px"
  icon: "14px"
  dot: "7px"
  left-column: "260px"
  details-panel: "380px"
components:
  header:
    backgroundColor: "{colors.surface}"
    padding: "10px 16px"
    gap: "16px"
  footer:
    backgroundColor: "{colors.surface}"
    typography: "{typography.meta}"
    textColor: "{colors.muted}"
    padding: "5px 16px"
  side-row:
    backgroundColor: "raised 30% over surface (1.15 bg2)"
    borderColor: "{colors.line}"
    rounded: "{rounded.control}"
    padding: "8px 10px"
    margin: "0 0 6px"
  side-row-selected:
    backgroundColor: "{colors.hover}"
    borderColor: "{colors.label}"
  button:
    backgroundColor: "{colors.raised}"
    borderColor: "{colors.line-strong}"
    rounded: "{rounded.control}"
    padding: "4px 12px"
    height: "{size.control}"
  button-primary:
    backgroundColor: "{colors.text}"
    textColor: "{colors.bg}"
    typography: "{typography.heading}"
  icon-button:
    width: "{size.control}"
    iconColor: "{colors.label}"
  input:
    backgroundColor: "{colors.surface}"
    borderColor: "{colors.control-edge}"
    rounded: "{rounded.control}"
    padding: "4px 10px"
  prompt-card:
    backgroundColor: "accent 12% over surface"
    borderColor: "accent 45% over surface"
    rounded: "{rounded.panel}"
    padding: "8px 12px 8px 10px"
  facts-grid:
    columns: "repeat(auto-fill, minmax(140px, 1fr))"
    gap: "10px 14px"
    padding: "14px 0"
  floating-panel:
    backgroundColor: "{colors.surface}"
    borderColor: "{colors.line}"
    rounded: "{rounded.panel}"
---

> Status: **Contract** for 2.1 (S0, 2026-11-13). After 2.0 the owner asked to restore the style and layout of 1.15.2. This file now describes 1.15.2's look (`companion/app.css` at tag `orbit-1.15.2`), with 2.0's behaviour, safety, light theme and contrast fixes kept underneath. The 2.0 rules that conflicted with 1.15 are gone: no accent fills, dots only, one raised element and the four-step type scale. The eyebrow stays dropped (U-03).

Unsuffixed colour keys are the dark theme; each `{colors.x}` resolves to `x-light` in the light theme. Every value above is 1.15.2's unless this file says otherwise.

# Design System: Orbit

## Overview

**Creative North Star: "The Quiet Constellation"**

Orbit shows every Claude Code session one developer runs at once, as a constellation, with who needs them beside it. It lives in an Edge `--app` window next to the Claude desktop app on Windows, often on a second monitor, and is read in glances between other work.

- **Map:** the stage. Project hubs, spokes, ringed session nodes.
- **Left column:** the sessions grouped by what they need.
- **Details panel:** opens on the right for the one you select, with its conversation and composer.

The chrome is dark, dense and aligned. Blue is the one colour that guides the eye: the needs-you count, heading icons, selection, counts and your own prompts. Status hues live in dots.

**Key characteristics:**
- 1.15's dark neutrals with one periwinkle accent; three text greys (`text`, `label`, `muted`).
- Small, even type: 13 px body, 12 px meta, 11 px small.
- Icon buttons with tooltips for every standard action; one primary text button per view.
- Rows and controls are filled, bordered, 6 px-radius blocks; panels and floating panels use 8 px.
- Light and dark themes from one token set.

**Principles:**
1. **Need first.** Needs you is the first group and the blue count in the header. Urgency sorts; colour only marks.
2. **Blue guides, never shouts** (the 1.7 rule). Text stays neutral. Blue marks headings (an icon beside a neutral title), what you can act on or have selected, counts that matter, and your prompts in the conversation.
3. **Name everything.** Every control has a tooltip and an `aria-label`, and an icon alone is never a control's only name. Every status has text.

## Colors

### Neutral
- **`bg`**: the window and the map ground.
- **`surface`** (1.15 `panel`): header, footer, left column, details panel, floating panels (Legend, zoom stack), inputs.
- **`raised`** (1.15 `bg3`): buttons, side rows, callouts, the conversation header.
- **`hover`**: hover, pressed and selected fills (a selected row, the active segment, an open toggle).
- **`line`**: hairlines between regions and sections, and quiet row edges.
- **`line-strong`**: button edges, the chat split.
- **`control-edge`**: input edges and focusable boundaries (3:1).

### Text (three greys)
- **`text`**: titles, values, primary text.
- **`label`**: fact values, section titles, icons on icon buttons, the selected row's edge.
- **`muted`**: meta lines, counts beside headings, hints, the footer.

### Accent: Calm Periwinkle (`accent`)
Used for:
- the header's needs-you count;
- section-heading icons (the title beside them stays `label`);
- the focus ring and the resizer and split handles while hovered or dragged;
- pressed icon buttons (the icon turns blue);
- the hover card's fact icons (project, branch), as 1.15's facts; their text stays `label`;
- the map's kind icons left of each label, and their legend entries (see Map kind icons);
- the "filters on" dot;
- the live dot in the footer;
- the composer's Send while it can send;
- the "new messages" chip;
- your prompts in the conversation (prompt cards and the pinned request card: accent 12% over `surface`, edge accent 45%).

An accent fill holds `on-accent` text or icons.

### Status (dots)
- **`amber`**: needs you.
- **Running:** the accent.
- **`green`**: done or ready for review.
- **`coral`**: failed.
- **`dim`**: idle, stale or unknown.

Rules:
- Status hues mark status only through 7 px dots (and node rings on the map), never text colour.
- The one exception is the error text of a failed action (`coral`), which is not a status.
- A usage limit's level is a dot beside its percentage: amber from 80%, coral from 95%.

### Session colours (2.2.16; brighter and red added in 2.2.17)
- A person can give a session's robot icon one of eight colours: blue (the `accent`, the default), violet, pink, red, teal, lime, sand, slate (`tintViolet` … `tintSlate`, each with a light twin).
- The rename form holds only the name, the swatches and its buttons: no explanatory text.
- A project has a default colour too, set in its project panel (blue unless chosen): its sessions take it unless one has its own, Blue included. On the map the project's folder icon takes it; the hexagon outline stays neutral.
- They colour only the session's robot icon: on its map label, before its title in the panel and conversation heads, and before its title in the left column (only when not blue). Never text, dots or fills, and never a status hue.

### Contrast (WCAG 2.x, computed)

| Pair | Dark: bg / surface / raised / hover | Light: bg / surface / raised / hover | Need |
|---|---|---|---|
| text | 15.66 / 15.00 / 13.51 / 12.30 | 16.71 / 17.76 / 15.55 / 14.58 | 4.5 |
| label | 11.54 / 11.05 / 9.95 / 9.06 | 9.50 / 10.10 / 8.85 / 8.29 | 4.5 |
| muted | 6.10 / 5.84 / 5.26 / 4.79 | 5.86 / 6.23 / 5.46 / 5.11 | 4.5 |
| accent | 6.50 / 6.23 / 5.61 / 5.11 | 5.56 / 5.91 / 5.17 / 4.85 | 3 (4.5 as text) |
| on-accent on accent | 6.50 | 5.91 | 4.5 |
| amber dot | 7.51 / 7.19 / 6.47 / 5.90 | 3.74 / 3.97 / 3.48 / 3.38 | 3 |
| green dot | 10.28 / 9.85 / 8.87 / 8.08 | 3.88 / 4.12 / 3.61 / 3.51 | 3 |
| coral dot | 5.76 / 5.51 / 4.96 / 4.52 | 4.33 / 4.60 / 4.03 / 3.78 | 3 |
| dim dot | 3.66 / 3.51 / 3.16 / 2.87 | 3.23 / 3.43 / 3.00 / 2.82 | 3 |
| control-edge | 3.65 / 3.50 / 3.15 / 2.87 | 3.26 / 3.47 / 3.04 / 2.85 | 3 |
| tint violet | 6.39 / 6.12 / 5.51 / 5.02 | 5.73 / 6.09 / 5.33 / 5.18 | 3 |
| tint pink | 6.93 / 6.64 / 5.98 / 5.45 | 4.61 / 4.90 / 4.29 / 4.17 | 3 |
| tint red | 5.98 / 5.73 / 5.16 / 4.70 | 4.91 / 5.21 / 4.57 / 4.44 | 3 |
| tint teal | 11.67 / 11.18 / 10.07 / 9.17 | 4.16 / 4.42 / 3.88 / 3.77 | 3 |
| tint lime | 12.66 / 12.12 / 10.92 / 9.94 | 4.25 / 4.52 / 3.96 / 3.85 | 3 |
| tint sand | 10.93 / 10.47 / 9.43 / 8.59 | 4.42 / 4.69 / 4.11 / 4.00 | 3 |
| tint slate | 8.20 / 7.85 / 7.07 / 6.44 | 5.49 / 5.83 / 5.11 / 4.97 | 3 |

What differs from 1.15.2, and why:
- **Dropped:** 1.15's `faint` (`#7C818A`) and `grey` (`#80858E`); `muted` covers both.
- **`dim`:** stays 2.0's `#676B73`, because 1.15's `#50545C` failed 3:1 for dots.
- **`control-edge`:** stays 2.0's `#656B76`, because 1.15's `#60656E` is 2.88 on raised.
- **Light theme:** 2.0's, plus `hover` and `label` at the same steps.
- **Below 3:1 on `hover`:** dim dots and control edges. A selected row's idle dot still has its status in the row's text, and no input sits on `hover`.

### Theme
Dark and light share every role; the light values come from `PALETTE_LIGHT` through `lightThemeCss()`. The light theme follows the system unless the window chose one: `localStorage['orbit.theme']` holds `"light"` or `"dark"` and shows as `data-theme` on the root. A change made in another Orbit window applies at once.

- **The No-Flash Rule.** The light tokens and the stored choice apply in `<head>`, before any stylesheet or module runs:
  - an inline `<style>` equal to `lightThemeCss()`;
  - a `color-scheme` meta;
  - a classic, blocking `/inbox/theme.js`.

  Never from a module, and never as an inline script (the page's CSP forbids it).
- **Placeholders** use `muted` at full opacity.
- **Needs-you dots are plain orange, with no edge, everywhere (2.2.18):** the text beside a dot, or a map node's tooltip and sonar ping, says the status. `amber` is a vivid orange (`#FF7A1F`, light `#D9560A`; since 2.2.17) so it reads apart from green and from the yellow it used to be; `green` is a vivid green (`#2FD58F`, light `#0E8F5A`). Wherever a dot is the only mark, the row's text also says the status.

## Typography

**Body font:** Segoe UI Variable Text (with Segoe UI, system-ui, sans-serif). **Mono:** Cascadia Mono (with Consolas, monospace).

| Role | Size / weight | Where |
|---|---|---|
| Detail title | 16 / 600, 1.3 | the selected item's title in the details panel |
| Brand | 14 / 600 | "Orbit" in the header |
| Body | 13 / 400, 1.45 | everything by default: rows' titles, controls, conversation, facts |
| Heading | 13 / 600 | section titles (`label`), counts' numbers, the primary button |
| Meta | 12 / 400 | row meta lines, hints, the footer, Legend, `.small` buttons, heading counts, the pinned request text |
| Small | 11 / 400 | key badges (mono 600), times in the conversation, the composer hint |
| Mono | 12 / 400 | paths, commands, tool input, code |

Rules:
- Two weights only: 400 and 600.
- Numbers in counts use `tabular-nums`.
- No uppercase-tracked labels; no eyebrow (U-03).
- Section titles are sentence case, in `label` at 600, after an accent icon.

## Layout

At 1440 px, top to bottom:

- **Header** (`surface`, 10 px × 16 px padding, 16 px gaps, hairline under it):
  - **Left:** the brand (a 12 px ring mark with a blue satellite dot, then "Orbit"); the counts ("**1** need you" in accent as a button, "**2** running", "**6** sessions").
  - **Right:** search (220 px, shrinks to 120), the time window select, then icon buttons, 8 px apart: filters, the map/list segmented toggle, new session and settings.
  - While remote control is on, the settings button carries the armed dot (below); the header has no armed text or chips.
- **Body:** a three-column grid.
  - **Left column:** 260 px, `surface`, hairline right, padding 4 px 12 px 12 px.
  - **Map:** fills the middle.
  - **Details panel:** 380 px, `surface`, hairline left. It appears when something is selected: above 1280 px as the third column (the map narrows and keeps its scale), at 1280 px and below over the map, with the zoom stack and minimap moved clear of it.
- **Floating over the map:**
  - **Legend:** bottom-left, a collapsible `surface` panel.
  - **Zoom stack:** bottom-right, three 30 px icon buttons in a column, 4 px apart: zoom in, zoom out, fit.
  - **Minimap:** 160 × 96, left of the zoom stack; it stays clear of both. Shown above 50 sessions or past 1.6× the fit zoom. It draws the map's shape at a glance, as the map does since 2.1: per project a 4 px hub hexagon (`bg2` fill, `control-edge` edge so hubs read at 1× in the light theme, the minimap's own border colour), faint `line-strong` spokes (0.75 px) to its sessions, a 1.25 px `dim` dot per session, and sessions that need you as 2 px `amber` dots on top, above the view's accent rectangle. The map is inset 6 px so hubs at its edge are drawn whole. A click on the minimap moves the camera there (2.1.2; 2.0's per-project rings are gone).
- **Footer status bar** (`surface`, 5 px × 16 px, 12 px `muted`, hairline above):
  - **Left:** the live state (a blue dot when live), "Updated <1m ago" and any source problem.
  - **Right:** the limit meters (2.1.6, in place of the key hints; see Limit meter).

### Narrow widths
- **1100 px and below:** the left column narrows to 240 px. **1040 px and below:** the session total goes. **900 px and below:** the meter's "+N" goes.
- **860 px and below:** the left column becomes 2.0's 56 px strip, which opens the column over the map. The details panel overlays the map, never more than 55% of it. The search shrinks before anything else is dropped.
- **No horizontal overflow at any width.**

### Spacing
1.15's steps: 2, 4, 6, 8, 10, 12, 14, 16 and 18 px. Rows are 6 px apart. Sections are separated by a hairline and 8–10 px. The details panel's blocks are 14–18 px apart.

### Map kind icons (2.2.12)
- Every map label starts with a small `accent` line icon that names what the node is, so kinds read apart at a glance:
  - **Session:** a robot, in the session's colour when the person chose one (Session colours).
  - **Forked session** (`parent.kind` is `fork`): a fork. Side sessions, hand-offs and spawned sessions keep the robot.
  - **Sub-agent:** an arrow turning right, out of its parent (its label shows when it is selected or lit).
  - **Project:** a folder, left of the hub's name.
  - **Worktree:** a branch.
  - Pull requests keep their "#n" label with no icon.
- The icon is 0.95 em of the label's size with a 0.3 em gap, centred on the title line, drawn over a `bg` halo like the text; the label's box includes it, so labels still never overlap. It fades with its node.
- The Legend lists the five icons after Project.
- A label left of its node ends exactly at its spot, the end its leader line meets: the text is anchored there and only the icon is placed from the text's drawn width (2.2.14), so a title never drifts away from its node or its leader.
- Sub-agents sit on one arc of equal spokes facing away from the hub (2.2.20): each top-level agent, oldest first, takes the next spoke 0.4 rad apart at 68 units, centred on the hub-to-session line, at most seven (about 140 degrees); more start an arc 30 units further out, turned half a spoke when its spokes would line up with the arc before's. An agent started by another agent extends its parent's spoke one step out. A session's PRs sit beyond its agents. They never wrap behind the session.
- A session's label is its title alone (2.2.12): no status sub-line under it, so the map stays uncluttered; the dot carries the status and the tooltip and hover card say the rest. A hub keeps its "N sessions" line.

### Map interaction (as 1.15)
- **Drag a node** to move it: a hub moves its whole cluster, a session moves with its own children. The node and its lines follow the pointer; on release the place is saved for every window (`prefs.positions`: a hub at its place, anything else relative to its parent) and the map lays out again around it. Settings › Data › Reset map layout clears them, and expands collapsed projects. The Reposition button under Fit (2.2.22) clears only the dragged places, lays the map out afresh and fits it, with undo in its toast. A dragged hub stays exactly where it is dropped, even over another cluster; only hubs Orbit places itself keep clear of dragged ones (2.2.12).
- **Drag empty map** to pan; the wheel zooms.
- **A press without movement** (4 px slop) is a click: a session opens; empty map deselects and closes the panel; a hub does nothing.
- **Esc** closes the open panel (and any hover card with it) in one press; a field you're typing in, the search and the queue overlay come first; dialogs and menus before all of them.

### Motion
State changes run 120–200 ms ease-out on opacity, colour and the chevron's rotation.

- **Map camera:** fit, focus-on-select and minimap clicks move it over 200 ms.
- **Kept from 1.15:**
  - the working dot's slow pulse in the conversation ("Working…");
  - a 1.6 s flash on a prompt you jump to;
  - the map pulses, opt-in through Settings › Map animation (default Off; 2.1.5): Low sends a sonar ping from a session that needs you (every 2 s a ring leaves the node's edge, grows 22 px and fades out, eased; 2.2.5; since 2.2.11 there is no steady outer ring, so a needs-you node has one ring like every session; its dot has no edge since 2.2.18), Normal also the dot of a working one (0.15 to 1, 1.6 s; 2.2.3, deeper and faster than 1.15's so they read at a glance). The pane's map never animates.
- `prefers-reduced-motion` removes all of it while Map animation is Off. Low or Normal is the person asking for motion, so the pop-out animates anyway (sets `html.motion-always`; 2.2.5, replacing 2.2.1's separate checkbox). Windows reports reduced motion whenever "Animate controls and elements inside windows" is off, which low-performance and remote-desktop machines do by default.

## Keys

One key map for the pop-out and the pane (`KEY_MAP` in `shared/popout.js`), with one meaning per key. Letter, digit and symbol keys work only while focus is on the map, the queue, the card or the panel (WCAG 2.1.4); they never fire in a text field. Ctrl, Alt and Meta are left to the browser and the OS. Shift decides the upper-case actions; Caps Lock does not.

| Key | Action |
|---|---|
| n / Shift+N | Next / previous session that needs you (opens it) |
| j / k | Next / previous session in the queue |
| 1 to 9 | Open the queue's Nth session |
| Enter | Open the focused session |
| o | Open the session in Claude |
| r | Reply (opens the conversation) |
| d | Done |
| s / Shift+S | Snooze an hour / until 9:00 tomorrow |
| h | Hide until it is active again (not offered for a session that needs you) |
| u | Undo the last Done, Snooze or Hide |
| c | New session |
| l / g | Conversation view / map |
| Ctrl+K | Go to a session or run an action (the palette) |
| / | Search sessions |
| Esc | Close, in order: the search, the card, the queue overlay, the conversation. In a text field in the panel, Esc first leaves the field (to the request card's title, else the conversation's title); Esc again closes |
| Arrows | Move map focus to the nearest session in that direction |
| Shift+arrows | Pan the map |
| + / − / 0 | Zoom in / zoom out / Fit |

While a dialog is open (Settings, New session, the palette) the page's keys pause and Esc closes the dialog.

Keys act on the session that has focus: the focused queue row, then the card, then the open conversation, then the session ringed on the map. On a control that is not a session (a strip button, the camera controls, the minimap, the toast) session keys do nothing. The map's roving focus is for sighted keyboard users. With a screen reader, the queue is the path: it lists the same sessions, and every action is a button there or in the conversation's header.

## The pane (Claude's dock)

The pane draws with the kit's components, mapped onto these tokens:

- Text sizes: `footnote` = small (11), `caption` = meta (12) for section titles (semibold), default = body (13), `heading` = detail title (16).
- Colour names: `warning` = amber (needs you), `error` = coral (failed), `success` = green (review), `suggestion` = accent (working), `subtle` = muted (the kit has no `dim`).
- Status still speaks only through dots.
- The pane's graph uses the same `mapParts` with `PALETTE_LIGHT` when the desktop is in light theme.
- Keys: the pane uses a subset of the key map above with the same meanings (`n`, `o`, `d`, `s`, `h`, `u`, `c`, `0`), plus three of its own: `l` List, `g` Graph, `p` Pop out. Its digits `1` to `9` open the queue item's details, the pane's equivalent of the page's panel. No key means something different on the two surfaces.

## Elevation & Depth

Depth is mostly tonal: `bg` under `surface` under `raised` under `hover`, with hairlines. Two shadows only, both from 1.15:

- **Floating menus:** the hover card, the Snooze menu, the toast and the "new messages" chip, `0 2px 8px` at 35% black.
- **The pinned request card:** it overlaps the conversation, `0 6px 10px -4px`.

## Shapes

| Radius | Where |
|---|---|
| 6 px | buttons, inputs, selects, side rows, callouts |
| 8 px | floating panels (Legend, palette, the hover card), prompt cards, request cards |
| 4 px | segments inside the segmented toggle; scroll boxes |
| 3 px | key badges |
| 999 px | dots, the "new messages" chip, scroll bar thumbs |

Borders are 1 px. A dashed edge means not yet sent (a pending prompt) or read-only.

Scroll bars are seamless, one rule for the whole page (`base.css`): no track, no arrows, a 6 px `line-strong` pill floating in a 10 px transparent gutter, `faint` while hovered or dragged.

## Components

### Buttons
- **Default:**
  - Fill and edge: `raised` with a `line-strong` edge; 30 px tall; padding 4 px × 12 px; 6 px radius.
  - Hover: `hover` with a `control-edge` edge.
  - Disabled: 55% opacity.
- **Primary:**
  - `text` fill with a `bg` label at 600; hover `label`.
  - One per view: Open in the details panel, Start in New session, the request card's answer.
  - It may lead with an icon.
- **Ghost:** transparent and `muted`; on hover `text` with a `line-strong` edge. Used for close, reset and "N more".
- **Small:** 24 px tall, 12 px text, padding 1 px × 10 px.
- **Icon button:**
  - 30 × 30 px (small: 24), a 14 px line icon in `label` that turns `text` on hover.
  - Pressed (`aria-pressed="true"`): the icon turns `accent`.
  - "Some filters on": a 5 px accent dot at the top right.
  - Every icon button has a `title` and the same `aria-label`; a key it answers to goes in the title ("New session (c)") and `aria-keyshortcuts`.
- **Segmented toggle (map/list):**
  - The group: a 30 px `surface` well with a `line-strong` edge, padding 2 px, gap 2 px.
  - Each segment: 32 px wide, 4 px radius.
  - The active segment: a `hover` fill with a `text` icon; the others have `muted` icons.
- **Focus:** a 2 px accent outline at 1 px offset on every control.

### Icons
- 14 px line icons: 16-unit viewBox, 1.4 stroke, round caps, `currentColor`.
- The set is 1.15's (`ICONS` in `companion/js/ui.js` at `orbit-1.15.2`): folder, branch, model, clock, activity, alert, pin, check, flag, info, chevron, open, plus, minus, fit, filter, sliders, graph, list, copy, eye, eyeoff, moon, send, close, diff, person, claude, pr, and others.
- Icons are static markup, never built from data.

### App icon
- "Hex in orbit": a `text`-rimmed hexagon planet filled `raised`, on an `accent` orbit tilted -24°, with an `accent` moon at the top right, on a `surface` tile (14 rounded corners on 64). The tile stays dark in both themes, so the icon reads on light and dark taskbars alike.
- The orbit's far half is faint (45%) and runs behind the planet; the near half crosses in front, cut out of the hexagon by a `surface` gap. The moon sits in its own `surface` gap where it meets the orbit.
- Small sizes are drawn, not shrunk, with the hexagon's sides snapped to whole pixels: at 24 and 32 px the strokes are heavier and the whole orbit runs behind the planet (a front crossing breaks the hexagon at that size); at 16 px the orbit is dropped and the planet and moon grow.
- Files in `companion/icons/`: `orbit.svg` (the full mark), `orbit-16/24/32/48/256.png` (24 is the Windows 11 taskbar at 100%) and `favicon.ico` (the five PNGs). All are generated by `node tools/make-icons.mjs` (pure Node, no dependencies; `--preview <file>` writes a sheet at 16, 32 and 256 on dark and light). Change the shapes there, never the files by hand.
- The page links only the PNGs: browsers prefer an SVG icon over sized PNGs, which would put the full mark, orbit and all, into the 16 px title bar. The SVG stays as the source drawing.
- The header's brand mark is unchanged; the app icon is only for the window, taskbar and tab.

### Section heading
- An accent icon, the title in `label` at 600, and a `muted` 12 px count pushed to the right.
- As a disclosure, it is led by a 12 px `dim` chevron that turns 90° when open; hover turns the title `text`.
- Open or closed is remembered per section.

### Left column
- **Groups:** Needs you, Failed, Ready for review, Working, Idle.
  - Each is a disclosure group with a section heading and a count.
  - Working and Idle start collapsed.
  - Groups after the first are separated by a hairline and 8 px.
  - Empty groups are not drawn.
- **Group icons:** alert (Needs you), alert (Failed), check (Review), activity (Working), clock (Idle).
- **Row:**
  - A full-width button: 1.15's `bg2` fill (`raised` 30% over `surface`), `line` edge, 6 px radius, padding 8 px × 10 px, 6 px below. Hover: `hover` fill, `line-strong` edge.
  - Contents: the title (`text`, 13 px) over a meta line (12 px `muted`, one line, ellipsis) that leads with a 7 px status dot, then the state and reason ("Needs you 1h · run 'aws sso login'").
  - Needs-you rows lead with a key badge (1–9).
  - A pinned row shows a small diamond before its title.
  - A session with a colour other than blue shows its robot in that colour before its title.
- **Selected row:** `hover` fill and `label` edge.
- **Overflow:** "N more" is a ghost button that fills the row's width.
- **Keyboard:** unchanged from 2.0 (j/k, 1–9, Enter, focus recovery).

### Key badge
- Mono 600 11 px in `label`, 3 px radius, `line-strong` edge, at least 16 px wide.

### Details panel
In this order:
1. A head: the session's robot in its colour and the title (16 px 600), then a ghost edit (pencil) and a ghost close icon button.
   - Edit swaps the title and status line for a form: Name (one line, at most 120 characters), Icon colour (a radio group of round swatches: first Project default (<colour>), a ring in the project's colour, then the eight colours, Blue an explicit choice; the chosen one ringed in `text`), a `muted` line saying whether Claude is renamed too, then Save (primary), Cancel and, while Orbit's name is in use, Use desktop name. Enter saves, Esc cancels; the head stops redrawing while the form is open.
   - Save keeps the name and colour in Orbit's prefs, shown everywhere in Orbit; when the name changed and the session lists `/rename` with Replies as me on, it also runs `/rename <name>` in the session.
2. A status line: a status mark, the state in text, then `·` and the phase in `muted`. When the session failed or asks you something, that text (Failed: … or Asks you: …) takes the phase's place: one line, ellipsed, the full text in its tooltip. There are no callout boxes.
3. The actions row (6 px gaps, 14 px above):
   - the primary **Open** (open icon);
   - then icon buttons: Pin (pressed when pinned), Done, Snooze (a menu: an hour, until tomorrow; arrows move, Esc returns to the button), Hide (not for a session that needs you);
   - last, the Remote Control toggle (a phone with signal waves, `aria-pressed`): filled `text` with a `surface` icon while on (white in dark, near-black in light), like the others while off; its Switching… or give-up note sits to its right. Hidden while the desktop record does not say.
4. Details, a disclosure section closed by default (its open state kept per window; its heading counts sub-agents when there are any), holding three sub-sections, each its own disclosure with a section heading, hairlines between them, open state kept per window:
   - **Configuration** (open by default), holding:
     - the facts grid: auto-fill columns of at least 140 px, 10 px × 14 px gaps; each fact an icon plus a `label` value, ellipsed, the full value in its tooltip; the facts: project, branch, model and effort, time in state;
     - Now: an icon and the summary or current activity in `muted`;
     - the remaining facts and the Project picker.
   - **Sub-agents** (closed by default; only while the session has any): one row each, opening its transcript.
   - **Changes** (closed by default; loads only while open).
5. The conversation (see below).

Items 1 to 4 scroll together in the panel's top region. Below it, 1.15's grip (a 32 × 4 px `grey` bar, accent while hovered or dragged) sets the conversation's share of the panel: drag, or ↑ ↓ on it (25–85%, default 55%, kept per window; double-click resets). The pending request card and the conversation sit below the grip, so the composer is always in view.

The conversation is open by default and folds from its header (click it, or the chevron at its right; the choice is kept per window). Folded, the grip, request card and conversation body hide and only the header bar stays, at the panel's foot. A pending permission request or question unfolds it. In the Conversation view the conversation is the main area and does not fold; the side panel there keeps items 1 to 4.

### Project panel
Clicking a project's hexagon on the map opens it in the side panel, in place of a session's. In this order:
1. A head: the project's folder icon in its colour and its name (16 px 600), a status line (Project, then `·` and in `muted` the session count and how many are working or need you), and a ghost close icon button. Esc closes it and returns focus to the map.
2. The facts grid: folder, remote (when known), last active.
3. Session icon colour: the eight swatches (Blue the default), then a `muted` note that its sessions use this colour unless one picks its own. A pick saves at once; a failed save puts the colour back and says so.
4. Sessions: a section heading with the count, then one row per session, newest first (robot icon, title, status line), each opening that session's panel.

### Conversation
- **Header:** a 36 px `raised` bar, title 13 px.
- **List:** padding 12 px × 18 px.
- **Your prompts:** prompt cards with an accent 12% fill, an accent 45% edge and 8 px radius, right-aligned and as wide as their text (at most 85% of the conversation, 640 px; 2.2.11).
- **Claude's replies:** plain text.
- **Tool runs:** one muted line.
- **Day separators:** centred `muted` 11 px.
- **The pinned request card:** across the top, accent-tinted like a prompt, with a hairline accent edge and a short shadow. It shows the latest prompt's text only, two lines at most: no icon or time (its tooltip names the time).
- **Composer:** at the bottom, behind a hairline.
  - A textarea that grows to eight lines, and a 35 px Send icon button that fills with the accent while it can send.
  - A hint line (11 px `muted`) under it while it is focused.
  - When replies are not possible, a dashed read-only line says why.
  - An asleep desktop session Orbit can open shows a one-line asleep card over the message box, which stays usable for drafting with only Send disabled (its tooltip says why): the bold state and one muted line on the left, and on the right the sleeping moon in an accent-tinted round button (its z marks drift, held still under reduced motion). Pressing the moon opens the session in Claude desktop, which restarts it; while it wakes the card reads Waking up and the moon becomes a spinner (slowed, not stopped, under reduced motion: it is the only sign of progress). If Claude desktop cannot open it, or it is still asleep 60 s later, the card turns amber (amber edge and title) and reads Couldn't wake it (with the reason) or Still asleep, and the moon tries again. Send comes back once the session is awake; a reply never wakes it.
  - A message you sent shows the same 12-bar spinner (14 px, accent) just left of its bubble, level with the first line, until the agent takes it in; it goes once the message is refused, expired or of unknown fate. Slowed, not stopped, under reduced motion.
- **Request cards** (permission or question): the same card language, 8 px radius, holding the answer as the primary button.

### Hover card
Shown after 150 ms on a hovered node, or at once for the node with keyboard focus; it stays open while the pointer crosses from the node into it, and hides 300 ms after it leaves both. Placed by `cardSpot`, clear of the node. Built from `cardModel` in `shared/map.js`.

- 300 px wide, `raised`, `control-edge` edge, 8 px radius, the floating shadow, padding 10 px 12 px 12 px 14 px, 8 px between rows (1.15.2's hovercard spacing).
- **Row 1:** the title, 600, one line with an ellipsis. On the right, 24 px ghost icon buttons 2 px apart, no edge or fill until hovered: Pin (blue while pinned, `aria-pressed`), Done, Snooze (its menu opens right-aligned under it) and Hide, not for a session that needs you. Same names, tooltips and key hints as the panel. No Open: it stays in the panel and on `o`.
- **Row 2:** the shared 7 px status dot (`.dot`) and one 12 px `muted` line worded exactly as the session's left-column row ("Needs you 26m · Asked you a question": state word, age, then the reason; `statusLine` in `shared/popout.js`); it never wraps (ellipsis).
- **Row 3:** the facts, project (folder) and branch, only when known: accent icons, 12 px `label` text, each ellipsed, the folder path in the project's tooltip.
- **Row 4:** one 12 px `muted` block clamped to two lines under a hairline: the ask for a session that needs you, else the last report (whitespace folded, 240 characters at most).
- **Tooltips:** the title, status and body carry their own text as a tooltip only when the ellipsis or clamp cuts them; facts always do.
- Nothing else: no provenance ("by its start folder"), no "Side session of", no parent, no PR lines; those live in the panel.

The 2.0 node quick menu is retired (2.1.2): its actions were repeats of the card and the panel. `d`, `h`, `s` and Shift+S act on the selected node without it.

### Legend
- Bottom-left, `surface`, `line` edge, 8 px radius, padding 6 px × 10 px, 12 px `muted`.
- A `<details>` whose summary is "Legend"; its items wrap with 6 px × 12 px gaps.

### Footer status bar
See Layout. The live dot is 6 px accent. A source problem reads in `coral`. A hidden-sessions note ("3 hidden · Show") is a small ghost button.

### Limit meter
2.0's meters, reinstated in 2.1.2 in place of 2.1's "Limits 5h 28%, 7d 53%" text line (the owner's call).
- At the right of the footer (2.1.6; the header until then), one button holding a meter per rate-limit window that has not reset ("5h 82%", "7d Opus 40%"), each one row: a 6 px column kept for the dot so nothing shifts when a dot appears, the Meta text, then a fixed 40 px, 3 px bar (`text` fill on a `line-strong` track), 6 px apart, meters 14 px apart. One row keeps the footer at its 14 px line.
- The level is that dot, never a coloured bar or text: amber from 80%, coral from 95%, none below (the column stays empty, not grey). The text turns from `muted` to `text` once a dot shows.
- A reading over 15 minutes old is muted (text `muted`, fill `dim`) and says "reading from" in its name.
- The footer shows the two fullest windows with "+N" for the rest; "+N" goes at 900 px and below. The meters never leave the footer.
- The button's accessible name leads with each window and its level, then the reset and the reading time; the tooltip gives each window's use, reset and reading time. It opens Settings at "Usage limits", which lists every window with its reset. With no reading, no meter.

### Conversation view
The header's segmented toggle, `l` and `g` switch between the map and the Conversation view (kept per window; a stored List choice opens it). The left column stays; the open session's conversation, its request cards and message box take the map's place, and the right pane keeps only its head and Details (Configuration, Sub-agents, Changes). A sub-agent opens its transcript in the centre and hides the right pane. With nothing open, the centre shows how many sessions need you, the first five as rows that open them, and the keys `n`, `c`, `/`, `g`; the right pane is hidden. Under 1,100 px wide the details fold behind the info button in the conversation's header and open over the conversation; Esc folds them first, then closes the session. The map does not draw, fit or move while it is hidden.
- **Layout:** one centred column, at most 980 px, padding 8 px × 24 px (12 px at 860 and below).
- **Groups:** the left column's section headings (chevron, accent icon, `label` title, count), sticky while scrolling; the same open or closed state as the left column.
- **Rows:** divided by `line` hairlines, not cards, so the list reads apart from the column. A 52 px row: the status dot (a key badge on needs-you rows), the title over the meta line ("Needs you · reason", 12 px `muted`), the project (12 px `label`, 170 px, dropped at 860) and the age (right-aligned, tabular).
- **States:** hover and focus `bg2`; selected `hover` with a 2 px `label` edge on the left (1.15's).
- **Row actions:** Open, Done, Snooze an hour and Hide (not for a session that needs you) as small icon buttons on a `surface` pill with a `line-strong` edge, in their own 112 px column at the row's end, shown while the row is hovered, focused or selected (120 ms fade, none under reduced motion).
- **Beside the panel:** at 1280 px and below, where the panel overlays, the list ends at the panel's edge. Esc from the panel returns focus to the row it was opened from.
- Direction (tb-design, inline): Operate mode, refine 1.15; rows over cards so the two lists differ; no authored motion.

### Sheets and dialogs
Settings, New session and the Ctrl+K palette keep 2.0's content and behaviour (native modal dialogs, focus held inside, Esc closes, focus returns). They take these tokens:
- `surface` panels with 8 px radius;
- 6 px controls;
- section headings with accent icons;
- 12 px hints;
- one primary button.

### Shell banner and toasts
- **Banner:** one line under the header (paused, stale, not live, reconnecting, server gone), on `raised` with a status dot and one action.
- **Toast:** an 8 px-radius `raised` panel with a `line-strong` edge, the floating shadow and a small Undo button.
- **Notice banner:** the same panel at the stage's top-right (12 px in, at most 360 px wide): the bucket's status dot, a small uppercase `lab` label ("Needs you"), the session title, the reason in `muted`, an Open button and a × dismiss. It fades in (off under reduced motion), stays 8 s, and longer while hovered, focused or unwatched. It closes as soon as the session leaves the state it announced (2.2.18), and so does its Windows notification.
- **Chime:** Needs you only, a soft rising two-note sine (E5 then B5, about 0.35 s); per window, on by default, in Settings. Windows notifications from the window are silent.
- **Banner dot:** `dim` for paused and not live, plain `amber` (no ring) for reconnecting and stale, `coral` for errors and a server that is gone.

### Armed dot
- While any remote-control capability is armed, a 7 px `accent` dot sits at the top-right of the header's settings button (4 px in), with a 1.5 px `surface` ring.
- The button's tooltip and `aria-label` name what is on, "Settings · Remote control on: Approvals, Questions" (`settingsName` over `armedCapabilities` in `shared/popout.js`); with nothing armed there is no dot and both say "Settings".
- A click while armed opens Settings at the first armed switch.
- The settings button never hides, so the dot shows at every width and in map and list (A5: armed is visible in every view). The pane keeps its own indicator.

## Do's and Don'ts

### Do:
- **Do** put blue on the heading's icon, never on its title.
- **Do** give every icon button a tooltip and an `aria-label` that say the same thing, with its key.
- **Do** keep status words in neutral text and let a dot carry the hue.
- **Do** use sentence case. Errors name the problem and the recovery. Keep copy short, with no footnotes.
- **Do** check every width (1440, 1100, 820) for overflow after a header change.

### Don't:
- **Don't** add an eyebrow above titles (U-03).
- **Don't** add text buttons where 1.15 had an icon button (Settings, New session, Filters, Pin, Hide).
- **Don't** colour text by status.
- **Don't** use a blue fill for a panel, row or banner. Blue fills are for prompt cards, the pinned request and the Send button only.
- **Don't** add a second primary style.
- **Don't** leave a control without a text name.
