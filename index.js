#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const { parse } = require('csv-parse/sync');
const PDFDocument = require('pdfkit');

const REQUIRED_FILES = ['routes.txt', 'trips.txt', 'stops.txt', 'stop_times.txt'];

const parseArgs = (argv) => {
  const args = { input: null, output: 'output', route: null, maxTrips: 8, help: false };
  for (let i = 2; i < argv.length; i += 1) {
    const value = argv[i];
    const nextValue = () => {
      if (i + 1 >= argv.length) {
        throw new Error(`Missing value for ${value}`);
      }
      i += 1;
      return argv[i];
    };
    if (value === '--help' || value === '-h') {
      args.help = true;
    } else if (value === '--input' || value === '-i') {
      args.input = nextValue();
    } else if (value === '--output' || value === '-o') {
      args.output = nextValue();
    } else if (value === '--route' || value === '-r') {
      args.route = nextValue();
    } else if (value === '--max-trips') {
      const maxTrips = Number(nextValue());
      if (!Number.isInteger(maxTrips) || maxTrips <= 0) {
        throw new Error('Invalid value for --max-trips; expected a positive integer.');
      }
      args.maxTrips = maxTrips;
    }
  }
  return args;
};

const printHelp = () => {
  console.log(`GTFS Converter

Usage:
  gtfs-converter --input <path-to-gtfs.zip-or-folder> [--output <dir>] [--route <route_id_or_short_name>]

Options:
  -i, --input       Path to GTFS zip file or extracted folder (required)
  -o, --output      Output directory for HTML/PDF files (default: output)
  -r, --route       Only render a specific route by route_id or short_name
  --max-trips       Maximum trips to include per timetable (default: 8)
  -h, --help        Show this help message
`);
};

const parseCsv = (content) =>
  parse(content, {
    columns: true,
    skip_empty_lines: true,
    trim: true
  });

const loadGtfsFiles = (inputPath) => {
  const stats = fs.statSync(inputPath);
  const files = {};
  if (stats.isDirectory()) {
    REQUIRED_FILES.forEach((file) => {
      const filePath = path.join(inputPath, file);
      if (!fs.existsSync(filePath)) {
        throw new Error(`Missing required GTFS file: ${file}`);
      }
      files[file] = fs.readFileSync(filePath, 'utf8');
    });
    const calendarPath = path.join(inputPath, 'calendar.txt');
    if (fs.existsSync(calendarPath)) {
      files['calendar.txt'] = fs.readFileSync(calendarPath, 'utf8');
    }
  } else {
    const zip = new AdmZip(inputPath);
    REQUIRED_FILES.forEach((file) => {
      const entry = zip.getEntry(file);
      if (!entry) {
        throw new Error(`Missing required GTFS file in zip: ${file}`);
      }
      files[file] = entry.getData().toString('utf8');
    });
    const calendarEntry = zip.getEntry('calendar.txt');
    if (calendarEntry) {
      files['calendar.txt'] = calendarEntry.getData().toString('utf8');
    }
  }
  return files;
};

const timeToMinutes = (timeValue) => {
  if (!timeValue) return null;
  const parts = timeValue.split(':');
  if (parts.length < 2) return null;
  const [hours, minutes] = parts.map((part) => Number(part));
  if (Number.isNaN(hours) || Number.isNaN(minutes)) return null;
  return hours * 60 + minutes;
};

const formatTime = (timeValue) => {
  if (!timeValue) return '';
  const parts = timeValue.split(':');
  if (parts.length < 2) return '';
  const [hours, minutes] = parts;
  if (typeof hours !== 'string' || typeof minutes !== 'string') return '';
  return `${hours.padStart(2, '0')}:${minutes.padStart(2, '0')}`;
};

const buildTimetables = (gtfs, options) => {
  const stopsById = new Map(gtfs.stops.map((stop) => [stop.stop_id, stop.stop_name]));
  const routesById = new Map(gtfs.routes.map((route) => [route.route_id, route]));
  const tripsByRoute = new Map();
  gtfs.trips.forEach((trip) => {
    if (!tripsByRoute.has(trip.route_id)) {
      tripsByRoute.set(trip.route_id, []);
    }
    tripsByRoute.get(trip.route_id).push(trip);
  });
  const stopTimesByTrip = new Map();
  gtfs.stopTimes.forEach((stopTime) => {
    if (!stopTimesByTrip.has(stopTime.trip_id)) {
      stopTimesByTrip.set(stopTime.trip_id, []);
    }
    stopTimesByTrip.get(stopTime.trip_id).push(stopTime);
  });
  stopTimesByTrip.forEach((times) => {
    times.sort((a, b) => Number(a.stop_sequence) - Number(b.stop_sequence));
  });

  const timetables = [];
  routesById.forEach((route) => {
    if (
      options.route &&
      options.route !== route.route_id &&
      options.route !== route.route_short_name
    ) {
      return;
    }
    const trips = (tripsByRoute.get(route.route_id) || []).filter((trip) =>
      stopTimesByTrip.has(trip.trip_id)
    );
    if (!trips.length) return;
    const sortedTrips = trips
      .map((trip) => {
        const firstStop = stopTimesByTrip.get(trip.trip_id)[0];
        const startMinutes = firstStop ? timeToMinutes(firstStop.departure_time) : null;
        return {
          trip,
          startMinutes: startMinutes ?? 0
        };
      })
      .sort((a, b) => a.startMinutes - b.startMinutes)
      .slice(0, options.maxTrips);
    const selectedTrips = sortedTrips.map((entry) => entry.trip);
    if (!selectedTrips.length) return;
    const baseTripStops = stopTimesByTrip.get(selectedTrips[0].trip_id);
    const stopOrder = baseTripStops.map((stopTime) => stopTime.stop_id);

    const rows = stopOrder.map((stopId) => {
      const row = [stopsById.get(stopId) || stopId];
      selectedTrips.forEach((trip) => {
        const timeEntry = stopTimesByTrip
          .get(trip.trip_id)
          .find((stopTime) => stopTime.stop_id === stopId);
        row.push(formatTime(timeEntry?.arrival_time || timeEntry?.departure_time || ''));
      });
      return row;
    });

    timetables.push({
      route,
      headers: [
        'Stop',
        ...selectedTrips.map((trip) => trip.trip_headsign || trip.trip_id)
      ],
      rows
    });
  });
  return timetables;
};

const writeHtml = (timetable, outputDir) => {
  const routeName = timetable.route.route_short_name || timetable.route.route_long_name;
  const fileName = `${timetable.route.route_id}.html`;
  const filePath = path.join(outputDir, fileName);
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${routeName} Timetable</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 24px; color: #1a1a1a; }
    h1 { margin-bottom: 4px; }
    .meta { margin-bottom: 16px; color: #555; }
    table { border-collapse: collapse; width: 100%; font-size: 12px; }
    th, td { border: 1px solid #333; padding: 4px 6px; text-align: center; }
    th:first-child, td:first-child { text-align: left; }
    thead { background: #f0f0f0; }
  </style>
</head>
<body>
  <h1>Route ${routeName} Timetable</h1>
  <div class="meta">Generated ${new Date().toLocaleString()}</div>
  <table>
    <thead>
      <tr>${timetable.headers.map((header) => `<th>${header}</th>`).join('')}</tr>
    </thead>
    <tbody>
      ${timetable.rows
        .map(
          (row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join('')}</tr>`
        )
        .join('')}
    </tbody>
  </table>
</body>
</html>`;
  fs.writeFileSync(filePath, html, 'utf8');
  return filePath;
};

const drawPdfTable = (doc, timetable) => {
  const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const columnCount = timetable.headers.length;
  const firstColumnWidth = Math.min(200, pageWidth * 0.35);
  const otherColumnWidth =
    columnCount > 1 ? (pageWidth - firstColumnWidth) / (columnCount - 1) : pageWidth;
  const columnWidths = timetable.headers.map((_, index) =>
    index === 0 ? firstColumnWidth : otherColumnWidth
  );

  const rowHeight = 20;
  const cellPaddingX = 3;
  const cellPaddingY = 4;
  const cellPaddingWidth = cellPaddingX * 2;
  const drawRow = (cells, startY, isHeader) => {
    const font = isHeader ? 'Helvetica-Bold' : 'Helvetica';
    doc.font(font).fontSize(8);
    let x = doc.page.margins.left;
    cells.forEach((cell, index) => {
      const width = columnWidths[index];
      doc.rect(x, startY, width, rowHeight).stroke();
      doc.text(String(cell), x + cellPaddingX, startY + cellPaddingY, {
        width: width - cellPaddingWidth,
        align: 'center'
      });
      x += width;
    });
  };

  let y = doc.y + 10;
  drawRow(timetable.headers, y, true);
  y += rowHeight;

  timetable.rows.forEach((row) => {
    if (y + rowHeight > doc.page.height - doc.page.margins.bottom) {
      doc.addPage();
      y = doc.page.margins.top;
      drawRow(timetable.headers, y, true);
      y += rowHeight;
    }
    drawRow(row, y, false);
    y += rowHeight;
  });
};

const writePdf = (timetable, outputDir) => {
  const routeName = timetable.route.route_short_name || timetable.route.route_long_name;
  const fileName = `${timetable.route.route_id}.pdf`;
  const filePath = path.join(outputDir, fileName);
  const doc = new PDFDocument({ margin: 32, size: 'A4', layout: 'landscape' });
  doc.pipe(fs.createWriteStream(filePath));
  doc.font('Helvetica-Bold').fontSize(16).text(`Route ${routeName} Timetable`, {
    align: 'center'
  });
  doc.moveDown(0.5);
  doc.font('Helvetica').fontSize(10).text(`Generated ${new Date().toLocaleString()}`, {
    align: 'center'
  });
  doc.moveDown(0.5);
  drawPdfTable(doc, timetable);
  doc.end();
  return filePath;
};

const main = () => {
  const args = parseArgs(process.argv);
  if (args.help || !args.input) {
    printHelp();
    process.exit(args.help ? 0 : 1);
  }
  const outputDir = path.resolve(args.output);
  fs.mkdirSync(outputDir, { recursive: true });
  const files = loadGtfsFiles(path.resolve(args.input));
  const gtfs = {
    routes: parseCsv(files['routes.txt']),
    trips: parseCsv(files['trips.txt']),
    stops: parseCsv(files['stops.txt']),
    stopTimes: parseCsv(files['stop_times.txt'])
  };
  if (!gtfs.routes.length || !gtfs.trips.length) {
    throw new Error('GTFS feed is missing route or trip data.');
  }
  const timetables = buildTimetables(gtfs, args);
  if (!timetables.length) {
    throw new Error('No matching timetables found for the provided GTFS feed.');
  }
  timetables.forEach((timetable) => {
    const htmlPath = writeHtml(timetable, outputDir);
    const pdfPath = writePdf(timetable, outputDir);
    console.log(`Generated ${htmlPath} and ${pdfPath}`);
  });
};

try {
  main();
} catch (error) {
  console.error(`Error: ${error.message}`);
  process.exit(1);
}
