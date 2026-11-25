# Data pages

A data page shows numbers: a dashboard, a report built on figures, a tracker, any result the owner will scan more than read. You write the data and Nod draws it, with its own charts, sortable tables and a CSV download for each table. Do not write HTML for these.

Write one JSON file whose name ends in `.data.json`, such as `client-projects.data.json`, and call share_file with it. Nod checks the file when you share it. When share_file returns an error, the message names the field: fix it and share again.

## Shape

```json
{
  "version": 1,
  "title": "Client projects",
  "summary": "2 of 6 projects need attention.",
  "source": "Project tracker",
  "readAt": "Mon, 23 Nov 2026",
  "blocks": [
    {
      "type": "note",
      "status": "warn",
      "title": "Needs attention",
      "text": "Lantern Forum launch kit is off track."
    },
    {
      "type": "figures",
      "items": [
        {
          "label": "Budget used",
          "value": "57.8%",
          "detail": "€69,100 of €119,500",
          "status": "warn"
        }
      ]
    },
    {
      "type": "chart",
      "title": "Hours logged per week",
      "chart": "line",
      "unit": "h",
      "note": "Capacity is 240 hours a week.",
      "series": [
        {
          "label": "Hours logged",
          "points": [
            { "label": "Week 1", "value": 212 },
            { "label": "Week 2", "value": 198 }
          ]
        }
      ]
    },
    {
      "type": "table",
      "title": "All projects",
      "columns": [
        { "key": "project", "label": "Project" },
        { "key": "status", "label": "Status", "kind": "status" },
        { "key": "done", "label": "Done", "kind": "number", "unit": "%" }
      ],
      "rows": [
        {
          "project": "Tern docs refresh",
          "status": { "status": "good", "text": "On track" },
          "done": 90
        }
      ]
    }
  ]
}
```

- `title`, `source` and `readAt` are required. `source` says where the numbers came from and `readAt` when they were read, in the owner's words or a plain date. `summary` is the one finding the reader should keep.
- `blocks` holds 1 to 16 blocks, shown in order.
- `figures`: 1 to 6 items. `value` is text as it should appear, with its unit, such as "€553,930" or "270 h". `detail` gives the comparison or the parts. `status` is `good`, `warn` or `bad`.
- `chart`: `bar` or `line`, 1 to 3 series, 1 to 24 points each. A line needs at least two points. Values are plain numbers; put the unit in `unit`. Series in one chart share the same point labels.
- `table`: up to 12 columns and 500 rows. A column `kind` is `text`, `number` or `status`. A `number` cell is a number or `null`. A `status` cell is `{"status": "good"|"warn"|"bad", "text": "On track"}` or `null`. A row uses only the column keys.
- `note`: a short paragraph, with an optional `title` and `status`.

## Rules

- Calculate every total, share and change in code from the source data, and read the result back before writing it into the file.
- Lead with what needs action: a `note` with `status` first when something does, then `figures`, then charts, then tables.
- Every figure also appears in a table or chart in the same file, so the reader can see where it comes from.
- A missing value is `null`, which Nod shows as "Not stated". Never write a dash or a guess.
- Use a chart for a trend or a comparison of several values, and a table for anything the reader will look up. Do not chart two numbers.
- Sort table rows by what matters most, such as the most urgent first.
- Every number, name and date comes from the owner or a checked source. Do not add sample rows.
- To update a data page, write the new numbers to the same file and share it again. That saves a new version.
- In a chat app, a data page arrives as a file the owner cannot read there. When the owner is not in the Nod app, give the main numbers in the message too, or make a PDF instead.
