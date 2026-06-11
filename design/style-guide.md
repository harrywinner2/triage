# Style guide — Triage

**Source:** inferred, not browser-captured (no headless-browser MCP in this environment). Tokens are modeled on the Replicated / troubleshoot.sh visual system — a clean, technical developer-infrastructure SaaS look — so the demo reads as on-brand without lifting any proprietary assets.

## Character (one line)

Clean dark-technical SaaS: deep navy/indigo canvas, a single bright teal-cyan accent, crisp sans-serif type, monospace for cluster/log data, generous whitespace, low-radius cards, restrained shadows. Feels like a developer tooling dashboard, not a marketing page.

## Type

- **Headings & UI:** `Inter`, system-ui fallback. Weights 600–700 for headings, 500 for labels.
- **Body:** `Inter` / system-ui, 400–450, 15–16px base, ~1.6 line-height.
- **Data / logs / commands:** `"JetBrains Mono", "SF Mono", ui-monospace, Menlo, monospace`. This carries the technical credibility — resource names, log excerpts, kubectl commands.

## Color tokens

```css
:root {
  /* canvas — dark technical */
  --bg:            #0b1020;   /* app background, deep navy */
  --bg-elevated:   #121829;   /* cards / panels */
  --bg-inset:      #0e1424;   /* code & log blocks */
  --border:        #232b40;   /* hairline borders */
  --border-strong: #303b57;

  /* text */
  --text:          #e6ebf5;   /* primary */
  --text-muted:    #9aa6c0;   /* secondary */
  --text-faint:    #6b7691;   /* tertiary / captions */

  /* brand */
  --brand:         #2bd9c4;   /* teal-cyan accent (primary action, links, focus) */
  --brand-strong:  #14b8a6;
  --brand-ink:     #04221f;   /* text on brand fills */
  --indigo:        #6366f1;   /* secondary accent / charts */

  /* severity scale (drives finding cards & verdict banner) */
  --sev-critical:  #f0506e;   /* red */
  --sev-high:      #ff8a4c;   /* orange */
  --sev-medium:    #f5c451;   /* amber */
  --sev-low:       #5aa9ff;   /* blue */
  --sev-info:      #8b95ad;   /* grey */
  --ok:            #34d399;   /* healthy / pass */

  /* shape & motion */
  --radius:        10px;
  --radius-sm:     7px;
  --radius-pill:   999px;
  --shadow:        0 1px 0 rgba(255,255,255,.02), 0 8px 24px rgba(2,6,18,.45);
  --gap:           16px;
  --maxw:          1180px;
}
```

## Components

- **Buttons:** primary = solid `--brand` fill with `--brand-ink` text, `--radius-sm`, 500 weight, no gradient. Secondary = transparent with `--border-strong` outline. Subtle 120ms ease on hover (slight lift / brightness).
- **Cards / panels:** `--bg-elevated`, 1px `--border`, `--radius`, `--shadow`. Airy internal padding (16–20px). Square-ish, not pill-rounded.
- **Severity badges:** small pill, tinted background at ~14% opacity of the severity color, solid text in the severity color, uppercase, mono or 600 sans, letter-spacing .04em.
- **Verdict banner:** full-width panel; left accent bar in the verdict's severity color; large headline + supporting count row.
- **Code / log blocks:** `--bg-inset`, mono, `--text-muted`, 13px, 1px border, horizontal scroll, line-clamped excerpts with a "source: path" caption in `--text-faint`.
- **Tables:** dense, hairline `--border` row separators, mono for resource names and numeric columns, sticky header.
- **Nav:** left sidebar or top bar with the brand mark; active item gets a `--brand` indicator and brighter text. In-report tabs are an underline-style tab row.

## Density & layout

Centered content column max `--maxw`, 24–32px page padding. Airy but information-dense where it counts (tables, findings). One strong accent only — teal-cyan — everything else is navy/grey neutrals plus the severity scale. No gradients, minimal shadow, low radius. The severity colors are the only other saturated hues and they always *mean* something.
