# TimeTracker for Even G2

A glanceable time tracker for the Even G2 smart glasses, built with the Even Hub SDK. Start a timer from the glasses, see the time per task, and configure your task list from a companion page on your phone.

Built in the Even Hub simulator with Claude. It has not been tested on G2 hardware.

## Features

- **Tasks screen:** each task has a live timer beside it. Click a task to start its timer. Only one task runs at a time, so starting a new one stops the previous one.
- **Single-task screen:** shows just the task name and its timer. You can hide the timer while you work. Click to stop, or double-click to leave it running and go back.
- **Reports:** Today, This week, or a custom date range with exact start and end dates. Each report shows time per task and a total, and it remembers the last report you viewed. With more than 6 tasks, the report pages through them.
- **Companion editor:** a phone-side page to add, rename, reorder, and remove tasks (up to 15, names up to 20 characters), and to choose where double-click goes from the single-task screen. Removing a task keeps its past time.
- **Demo data:** `DEMO_WEEK` in `main.ts` fills in last week and this week with sample sessions for screenshots and recordings. Set it to `false` to turn it off.

## Controls

| Gesture | Tasks screen | Single-task screen |
|---|---|---|
| Scroll | Move the cursor | Move between the menu lines |
| Click | Start the task and open its screen | Select the menu line (hide/show timer, stop timer) |
| Double-click | Open Reports | Go back (the timer keeps running) |
| Long press | On the running task: open its screen. On Reports: next task page | |

## Run it

```
npm install
npm run dev
```

In a second terminal:

```
evenhub-simulator http://localhost:5173
```

## Notes from building it

- Lists can't line up with a second column, so rows are plain text lines with a matching timer box.
- There is no bold or underline, so emphasis uses bordered boxes and a `*` marker.
- Long press arrives as `eventType: 10` in the event data; I did not find it in the docs I could reach.
- Zero-valued protobuf fields arrive as `undefined`, so a click and the first list item need special handling.
