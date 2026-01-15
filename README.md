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
- `--max-trips`: Limit the number of trips shown per timetable (default: 8)

The converter writes one HTML and one PDF timetable for each route in the feed.
