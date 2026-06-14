# 2026-06-14 — UI-only source tab cleanup

- Status: Applied on main.
- Scope: UI/CSS only.
- Screenshot target: Timeline source tabs (S1/S2) extra full-row box.
- Files changed: components/Timeline.module.css.
- Backend/API touched: No.
- Change: Made the source tab row inline, transparent, and fit-content; removed the active tab outer drop shadow so only the compact pill controls remain visible.
- Verification: Not runtime-verified in a browser from this environment; visual check is still user-side after deploy/reload.
