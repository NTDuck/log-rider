## ESSENTIALS
- Implement classifier using fastText. 
- Telegram bot [...]
- Alert dedup UI [...]

## BUGS

- Status column does not update in real time (requires refresh)
- Classified tags of logs does not show in /dashboard.
- 
- /dashboard:
  - when clicking page's "refresh" button, scrollbar position changes
  - 

## NICE FEATURES TO HAVE
- ALL Timestamps should be displayed based on browser's timezone (instead of UTC)
- Rearchitect

## NON-ESSENTIALS > UI
(general theme: mimic https://aws-console.dev/)

- Change labels:
- Light/Dark transition (when clicking Light/Dark mode toggle button) is not consistent
- /dashboard:
  - next to title "log-rider" (top left) is green "Preview", change it to blue "Console" like /config and /metrics
  - remove "Streaming via WebSocket" label (make it icon only), move it next to 
  - remove "Live Log Stream" label
  - Timestamps format: YYYY-MM-DD\nHH:MM:SS.sss

## REGRESSIONS
(anything previously worked but does not anymore due to new changes will show up here)
