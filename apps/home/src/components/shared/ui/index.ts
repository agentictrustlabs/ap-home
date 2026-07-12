// In-house headless + presentational UI primitives (warm-token-driven, no Radix/Tailwind).
// Adopt selectively — dialogs/popovers/tabs/tooltips get accessible behaviour for free, and
// Card/Stack/Row/Field replace the most-repeated inline-style shapes across the portal.
export { Dialog } from './Dialog';
export { Popover } from './Popover';
export { Tabs, type TabItem } from './Tabs';
export { Tooltip } from './Tooltip';
export { Card, Stack, Row, Field } from './layout';
