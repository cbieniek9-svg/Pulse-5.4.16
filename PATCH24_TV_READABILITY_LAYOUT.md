# Patch 24: TV Readability Layout

**Status:** Shipped (historical patch notes). Still accurate for native TV layout intent as of 5.3.2.

This patch keeps the TV layout recognizable while giving the board more breathing room.

## Changes

- Moves Floor Comms out of the right-side secondary column.
- Renders Floor Comms above the map/FIFO area instead.
- Limits the TV Floor Comms block to the latest 3 relevant messages.
- Keeps KPI bar, map, FIFO breakdown, active directives, safety panel, OOS, and customer orders.
- Changes 7-day expiry warnings from a full list into a compact summary card.
- Pull-today expiry items still render as full urgent cards.

## Files

- `resources/app/public/tv/tv-dashboard.js`
- `resources/app/public/tv/tv-dashboard.css`
- `resources/app/public/tv/tv-overrides.js`
- `resources/app/tests/tv-readability-layout.test.cjs`
