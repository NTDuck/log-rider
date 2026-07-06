## ESSENTIALS
- Telegram bot [...]
- Alert dedup UI [...] -> noti

- Fix regressions (verify: scripts)
- Fix UI
- Slides
- Report

## BUGS

- [PATCHED] Status column does not update in real time (requires refresh)
- [PATCHED] Classified tags of logs does not show in /dashboard.

- /dashboard:
  - when clicking page's "refresh" button, scrollbar position changes
  - 

## NICE FEATURES TO HAVE
- ALL Timestamps should be displayed based on browser's timezone (instead of UTC)
- Rearchitect, centralized configuration
- Remove redundant files
- Add more configs
- Use https://github.com/logpai/loghub for logging simulation

## NON-ESSENTIALS > UI
(general theme: mimic https://aws-console.dev/)

- Change labels:
- Light/Dark transition (when clicking Light/Dark mode toggle button) is not consistent across all components
- Add icon log-rider.png to the left of "log-rider" label, make it transparent & properly sized
- 
- /dashboard:
  - next to title "log-rider" (top left) is green "Preview", change it to blue "Console" like /config and /metrics
  - remove "Streaming via WebSocket" label (make it icon only), move it next to 
  - remove "Live Log Stream" section (within the logs table)
  - Timestamps format: YYYY-MM-DD\nHH:MM:SS.sss
  - Trace ID column should not use default tooltip which is unformated, use custom tooltip which is formatted e.g. font
  - Search bar: Add search icon to the left of "global-search-col" element, separated; add slide down/up animation for dropdown menu, make dropdown menu properly formatted e.g. font
- /alerts:
  - Remove "Filter by application" section

[[OUDATED]]

Benchmarks
- ALL Timestamps should be displayed based on browser's timezone (instead of UTC)s
Configs
Icon log-rider

## REGRESSIONS
(anything previously worked but does not anymore due to new changes will show up here)

## QUESTIONS
(1) ```**Phân hệ Điều phối Cảnh báo & Khóa Trùng (Alert Locking Mechanism):** Khi nhận được Event lỗi nguy cấp, hệ thống tự động đẩy thông báo thời gian thực qua WebSocket lên màn hình giám sát của kỹ sư vận hành và gửi tin nhắn về Telegram. Áp dụng cơ chế khóa trùng cảnh báo (Alert Deduplication) bằng Redis: Nếu một lỗi xuất hiện liên tiếp 100 lần trong 1 phút, hệ thống chỉ phát 1 thông báo duy nhất nhằm tránh gây tràn ngập (Alert Fatigue) cho kỹ sư.```
Should notis persist?

(2) Change machine?

(3) Is Báo cáo nộp only (present?)
