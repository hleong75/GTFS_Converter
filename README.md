# GTFS Converter

This project converts a GTFS feed (zip or extracted folder) into HTML and PDF timetable graphics.

## Usage

```bash
npm install
node index.js --input /path/to/gtfs.zip --output output
```

### Options

- `--input` / `-i`: Path to a GTFS zip file or extracted folder (required)
- `--output` / `-o`: Output directory (default: `output`)
- `--route` / `-r`: Limit output to a route ID or `route_short_name`
- `--major-stops`: Comma-separated stop IDs or names to emphasize as major stops
- `--max-trips`: Limit the number of trips shown per timetable page (default: 8)

The converter writes one or more HTML and PDF timetables for each route in the feed, splitting
pages when there are more trips than fit on a single page or when service calendars differ. Output
files use the route short name/ID plus the agency name (and page/service suffixes when needed),
for example `482-Agency-page-2.pdf`.
