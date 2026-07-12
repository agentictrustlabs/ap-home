# shared/ui — in-house headless + presentational primitives

Warm-token-driven primitives (no Radix/Tailwind/MUI), built to the UI-architecture direction: keep the
custom token system, add accessible headless primitives selectively, and extract the repeated inline-style
shapes. Everything reads a `globals.css` token, so light/dark + the brand palette flow through automatically.
Behaviour lives in the `.tsx`; presentation in `ui.css` (scoped by the `ap-` prefix).

```ts
import { Dialog, Popover, Tabs, Tooltip, Card, Stack, Row, Field } from '@/components/shared/ui';
```

## Headless (accessible behaviour for free)

- **`Dialog`** — modal with focus-trap, focus restore, ESC + scrim dismiss, body scroll-lock, one history
  entry (device Back closes it), `role="dialog" aria-modal` + labelled by `title`/`label`. Replaces the
  hand-rolled scrim/ESC logic in `DmSlideOver` / `ConsentSheet` / `ProfileSheet`.
  ```tsx
  <Dialog open={open} onClose={() => setOpen(false)} title="Remove member" description="They lose access.">
    <Row gap={0.5} justify="flex-end"><button className="btn-ghost" onClick={…}>Cancel</button>
      <BusyButton busy={busy} busyLabel="Removing…" onClick={…}>Remove</BusyButton></Row>
  </Dialog>
  ```
- **`Popover`** — anchored panel; outside-click + ESC dismiss, focus returns to trigger, trigger gets
  `aria-expanded`/`aria-haspopup`. The `trigger` render-prop spreads the wiring onto your button.
  ```tsx
  <Popover trigger={(p) => <button className="btn" {...p}>Actions ▾</button>}>
    <button className="menu-item">Rename</button><button className="menu-item">Delete</button>
  </Popover>
  ```
- **`Tabs`** — `role=tablist/tab/tabpanel`, roving tabindex, ←/→/Home/End nav, `aria-selected`/`aria-controls`.
  Data-driven: `<Tabs aria-label="Settings" tabs={[{ id, label, content }]} />` (controlled via `value`/`onValueChange`).
- **`Tooltip`** — hover **and** keyboard-focus, ESC to dismiss, open delay, `role="tooltip"` +
  `aria-describedby`. `<Tooltip content="Copy address"><button>⧉</button></Tooltip>`.

## Presentational (kill the inline styles)

- **`Card`** — raised/bordered/rounded surface (the recurring `manage-card` block).
- **`Stack` / `Row`** — flex column / row with a `gap` prop (rem); `Row` centers + takes `justify`/`wrap`.
- **`Field`** — labelled control: generates the id, wires `htmlFor` + `aria-describedby` to the hint/error,
  renders the error in the danger token. `<Field label="Display name" hint="How members see you" error={err}><input …/></Field>`.

## Adopt incrementally

These are new leaf files — nothing imports them yet. Migrate a surface at a time (start where a component
hand-rolls modal/tab/tooltip behaviour or repeats the same inline `style={{}}`), keeping each change small and
reviewable. All primitives accept `style`/`className` passthrough, so a partial migration never forces a full
rewrite.
