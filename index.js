#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const { parse } = require('csv-parse');
const PDFDocument = require('pdfkit');
const os = require('os');

const REQUIRED_FILES = ['routes.txt', 'trips.txt', 'stops.txt', 'stop_times.txt'];
const OPTIONAL_FILES = ['agency.txt', 'calendar.txt'];

const normalizeStopValue = (value) => {
  if (!value) return '';
  return String(value).trim().toLowerCase();
};

const parseArgs = (argv) => {
  const args = {
    input: null,
    output: 'output',
    route: null,
    maxTrips: 8,
    help: false,
    majorStops: new Set()
  };
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
    } else if (value === '--major-stops') {
      const stops = nextValue()
        .split(',')
        .map((stop) => normalizeStopValue(stop))
        .filter(Boolean);
      stops.forEach((stop) => args.majorStops.add(stop));
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
  --major-stops     Comma-separated stop IDs or names to emphasize as major stops
  --max-trips       Maximum trips to include per timetable page (default: 8)
  -h, --help        Show this help message
`);
};

const parseCsvStream = (stream, onRecord) =>
  new Promise((resolve, reject) => {
    const parser = parse({
      columns: true,
      skip_empty_lines: true,
      trim: true
    });
    stream.on('error', reject);
    parser.on('readable', () => {
      let record;
      while ((record = parser.read()) !== null) {
        if (onRecord) {
          onRecord(record);
        }
      }
    });
    parser.on('error', reject);
    parser.on('end', () => resolve());
    stream.pipe(parser);
  });

const parseCsv = async (stream) => {
  const records = [];
  await parseCsvStream(stream, (record) => records.push(record));
  return records;
};

const DAY_LABELS = [
  { key: 'monday', label: 'lundi' },
  { key: 'tuesday', label: 'mardi' },
  { key: 'wednesday', label: 'mercredi' },
  { key: 'thursday', label: 'jeudi' },
  { key: 'friday', label: 'vendredi' },
  { key: 'saturday', label: 'samedi' },
  { key: 'sunday', label: 'dimanche' }
];
const FALLBACK_SERVICE_ID = 'no-service-id';

const escapeHtml = (value) =>
  String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\"/g, '&quot;')
    .replace(/'/g, '&#39;');

const sanitizeFileComponent = (value) => {
  if (!value) return '';
  return String(value)
    .trim()
    .replace(/[\\/:"*?<>|]+/g, '')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
};

const formatDate = (dateValue) => {
  if (!dateValue || dateValue.length !== 8) return dateValue || '';
  const year = dateValue.slice(0, 4);
  const month = dateValue.slice(4, 6);
  const day = dateValue.slice(6, 8);
  return `${day}/${month}/${year}`;
};

const formatServiceDays = (service) => {
  if (!service) return '';
  const activeDays = DAY_LABELS.flatMap((day, index) =>
    String(service[day.key]) === '1' ? [{ ...day, index }] : []
  );
  if (!activeDays.length) return '';
  if (activeDays.length === DAY_LABELS.length) {
    return 'Tous les jours';
  }
  const isConsecutive = activeDays.every((day, index) =>
    index === 0 ? true : day.index === activeDays[index - 1].index + 1
  );
  if (isConsecutive && activeDays.length > 1) {
    return `Du ${activeDays[0].label} au ${activeDays[activeDays.length - 1].label}`;
  }
  if (activeDays.length === 1) {
    return `Le ${activeDays[0].label}`;
  }
  return activeDays.map((day) => day.label).join(', ');
};

const buildServiceSummary = (calendar, trips) => {
  if (!calendar?.length || !trips?.length) {
    return { serviceDates: '', serviceDays: '' };
  }
  const calendarByService = new Map(calendar.map((entry) => [entry.service_id, entry]));
  const service = calendarByService.get(trips[0].service_id);
  if (!service) {
    return { serviceDates: '', serviceDays: '' };
  }
  const startDate = formatDate(service.start_date);
  const endDate = formatDate(service.end_date);
  const serviceDates =
    startDate && endDate ? `Horaires valables du ${startDate} au ${endDate}` : '';
  const serviceDays = formatServiceDays(service);
  return { serviceDates, serviceDays };
};

const loadGtfsFiles = (inputPath) => {
  const stats = fs.statSync(inputPath);
  const files = {};
  if (stats.isDirectory()) {
    REQUIRED_FILES.forEach((file) => {
      const filePath = path.join(inputPath, file);
      if (!fs.existsSync(filePath)) {
        throw new Error(`Missing required GTFS file: ${file}`);
      }
      files[file] = filePath;
    });
    OPTIONAL_FILES.forEach((file) => {
      const optionalPath = path.join(inputPath, file);
      if (fs.existsSync(optionalPath)) {
        files[file] = optionalPath;
      }
    });
    return { files, cleanup: null };
  }
  const zip = new AdmZip(inputPath);
  const previousUmask = process.umask(0o077);
  let tempDir;
  try {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gtfs-'));
  } finally {
    process.umask(previousUmask);
  }
  const removeDirectory = (directory) => {
    if (!directory || !fs.existsSync(directory)) {
      return;
    }
    if (fs.rmSync) {
      fs.rmSync(directory, { recursive: true, force: true });
      return;
    }
    let lastError;
    fs.readdirSync(directory, { withFileTypes: true }).forEach((entry) => {
      const entryPath = path.join(directory, entry.name);
      try {
        if (entry.isDirectory()) {
          removeDirectory(entryPath);
        } else {
          fs.unlinkSync(entryPath);
        }
      } catch (error) {
        lastError = error;
      }
    });
    try {
      fs.rmdirSync(directory);
    } catch (error) {
      lastError = error;
    }
    if (lastError) {
      throw lastError;
    }
  };
  const cleanupTempDir = () => {
    try {
      if (!tempDir) {
        return;
      }
      removeDirectory(tempDir);
    } catch (cleanupError) {
      console.warn(
        `Warning: Unable to remove temporary GTFS directory (${tempDir}): ${cleanupError.message}`
      );
    }
  };
  try {
    zip.extractAllTo(tempDir, true);
    REQUIRED_FILES.forEach((file) => {
      const filePath = path.join(tempDir, file);
      if (!fs.existsSync(filePath)) {
        throw new Error(`Missing required GTFS file: ${file}`);
      }
      files[file] = filePath;
    });
    OPTIONAL_FILES.forEach((file) => {
      const optionalPath = path.join(tempDir, file);
      if (fs.existsSync(optionalPath)) {
        files[file] = optionalPath;
      }
    });
  } catch (error) {
    cleanupTempDir();
    throw error;
  }
  return {
    files,
    cleanup: cleanupTempDir
  };
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

const isMajorStop = (stopName, stopId, majorStops) => {
  if (majorStops && majorStops.size) {
    const normalizedName = normalizeStopValue(stopName);
    const normalizedId = normalizeStopValue(stopId);
    return (
      (normalizedName && majorStops.has(normalizedName)) ||
      (normalizedId && majorStops.has(normalizedId))
    );
  }
  if (!stopName) return false;
  const trimmed = stopName.trim();
  return trimmed && trimmed === trimmed.toUpperCase();
};

const chunkTrips = (items, chunkSize) => {
  if (!items || !items.length) return [];
  const size = Number.isInteger(chunkSize) && chunkSize > 0 ? chunkSize : items.length;
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
};

const buildTimetables = (gtfs, options) => {
  const stopsById = new Map(gtfs.stops.map((stop) => [stop.stop_id, stop.stop_name]));
  const routesById = new Map(gtfs.routes.map((route) => [route.route_id, route]));
  const agencies = gtfs.agencies || [];
  const agenciesById = new Map(
    agencies
      .filter((agency) => agency.agency_id && agency.agency_name)
      .map((agency) => [agency.agency_id, agency.agency_name])
  );
  const defaultAgencyName = agencies.length === 1 ? agencies[0]?.agency_name || '' : '';
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
    const tripEntries = trips.map((trip) => {
      const firstStop = stopTimesByTrip.get(trip.trip_id)[0];
      const startMinutes = firstStop
        ? timeToMinutes(firstStop.departure_time || firstStop.arrival_time)
        : null;
      return {
        trip,
        startMinutes: startMinutes ?? 0
      };
    });
    const tripsByService = new Map();
    tripEntries.forEach((entry) => {
      const serviceKey = entry.trip.service_id || FALLBACK_SERVICE_ID;
      if (!tripsByService.has(serviceKey)) {
        tripsByService.set(serviceKey, []);
      }
      tripsByService.get(serviceKey).push(entry);
    });
    const includeServiceId = tripsByService.size > 1;
    const agencyName = route.agency_id
      ? agenciesById.get(route.agency_id) || defaultAgencyName
      : defaultAgencyName;

    tripsByService.forEach((serviceEntries, serviceKey) => {
      serviceEntries.sort((a, b) => a.startMinutes - b.startMinutes);
      const serviceTrips = serviceEntries.map((entry) => entry.trip);
      if (!serviceTrips.length) return;
      const baseTripStops = stopTimesByTrip.get(serviceTrips[0].trip_id);
      if (!baseTripStops) return;
      const stopOrder = baseTripStops.map((stopTime) => stopTime.stop_id);
      const serviceSummary = buildServiceSummary(gtfs.calendar, serviceTrips);
      const tripChunks = chunkTrips(serviceEntries, options.maxTrips);
      tripChunks.forEach((chunk, chunkIndex) => {
        const selectedTrips = chunk.map((entry) => entry.trip);
        const rows = stopOrder.map((stopId) => {
          const row = [stopsById.get(stopId) || stopId];
          selectedTrips.forEach((trip) => {
            const timeEntry = stopTimesByTrip
              .get(trip.trip_id)
              .find((stopTime) => stopTime.stop_id === stopId);
            row.push(formatTime(timeEntry?.departure_time || timeEntry?.arrival_time || ''));
          });
          return row;
        });
        timetables.push({
          route,
          agencyName,
          headers: [
            'Stop',
            ...selectedTrips.map((trip) => trip.trip_headsign || trip.trip_id)
          ],
          rows,
          stopIds: stopOrder,
          majorStops: options.majorStops,
          meta: serviceSummary,
          serviceId: includeServiceId ? serviceKey : '',
          pageIndex: chunkIndex + 1,
          pageCount: tripChunks.length
        });
      });
    });
  });
  return timetables;
};

const getColumnCount = (timetable) =>
  timetable.rows[0]?.length || timetable.headers.length || 1;

const buildOutputBaseName = (timetable) => {
  const routeIdentifier = timetable.route.route_short_name || timetable.route.route_id;
  const parts = [routeIdentifier, timetable.agencyName].filter(Boolean);
  if (timetable.serviceId) {
    parts.push(timetable.serviceId);
  }
  if (timetable.pageCount > 1) {
    parts.push(`page-${timetable.pageIndex}`);
  }
  const sanitized = parts.map((part) => sanitizeFileComponent(part)).filter(Boolean);
  if (sanitized.length) {
    return sanitized.join('-');
  }
  return sanitizeFileComponent(routeIdentifier || timetable.route.route_id) || 'timetable';
};

const writeHtml = (timetable, outputDir) => {
  const routeNumber = timetable.route.route_short_name || timetable.route.route_id;
  const routeTitle = timetable.route.route_long_name || timetable.route.route_id;
  const routeSubtitle = timetable.route.route_long_name ? timetable.route.route_desc || '' : '';
  const serviceDates = timetable.meta?.serviceDates;
  const serviceDays = timetable.meta?.serviceDays;
  const fileName = `${buildOutputBaseName(timetable)}.html`;
  const filePath = path.join(outputDir, fileName);
  const columnCount = getColumnCount(timetable);
  const columns = Array.from({ length: Math.max(columnCount - 1, 0) })
    .map(() => '<col>')
    .join('');
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${escapeHtml(routeNumber)} Timetable</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 0; color: #111; background: #fff; }
    .sheet { width: 595px; margin: 0 auto; padding: 24px 28px 32px; box-sizing: border-box; }
    .header { display: flex; align-items: center; gap: 16px; padding-bottom: 10px; border-bottom: 2px solid #111; }
    .route-number { font-size: 40px; font-weight: 700; line-height: 1; color: #fff; background: #111; padding: 6px 12px; border-radius: 4px; min-width: 64px; text-align: center; }
    .route-title { font-size: 18px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.3px; }
    .route-subtitle { font-size: 13px; font-weight: 600; margin-top: 4px; color: #333; }
    .service-dates { margin-top: 12px; font-size: 10px; font-weight: 600; text-transform: uppercase; }
    .service-days { margin-top: 4px; font-size: 9px; color: #333; }
    .timetable { margin-top: 18px; border-collapse: collapse; width: 100%; font-size: 9px; table-layout: fixed; border: 1px solid #111; }
    .timetable td { border: 1px solid #222; padding: 2px 4px; text-align: center; }
    .timetable td:first-child { text-align: left; font-weight: 600; width: 160px; }
    .timetable tr:nth-child(even) td { background: #f5f5f5; }
    .timetable tr.major-stop td { background: #e7e7e7; }
    .timetable tr.major-stop td:first-child { font-weight: 700; text-transform: uppercase; }
  </style>
</head>
<body>
  <div class="sheet">
    <div class="header">
      <div class="route-number">${escapeHtml(routeNumber)}</div>
      <div>
        <div class="route-title">${escapeHtml(routeTitle)}</div>
        ${routeSubtitle ? `<div class="route-subtitle">${escapeHtml(routeSubtitle)}</div>` : ''}
      </div>
    </div>
    ${serviceDates ? `<div class="service-dates">${escapeHtml(serviceDates)}</div>` : ''}
    ${serviceDays ? `<div class="service-days">${escapeHtml(serviceDays)}</div>` : ''}
    <table class="timetable">
      <colgroup>
        <col class="stop-col">
        ${columns}
      </colgroup>
      <tbody>
        ${timetable.rows
          .map((row, rowIndex) => {
            const stopName = row[0];
            const stopId = timetable.stopIds?.[rowIndex];
            const rowClass = isMajorStop(stopName, stopId, timetable.majorStops)
              ? ' class="major-stop"'
              : '';
            const cells = row
              .map((cell) => `<td>${escapeHtml(cell).replace(/\n/g, '<br>')}</td>`)
              .join('');
            return `<tr${rowClass}>${cells}</tr>`;
          })
          .join('')}
      </tbody>
    </table>
  </div>
</body>
</html>`;
  fs.writeFileSync(filePath, html, 'utf8');
  return filePath;
};

const drawPdfTable = (doc, timetable, startY) => {
  const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const columnCount = getColumnCount(timetable);
  const firstColumnWidth = Math.min(180, pageWidth * 0.32);
  const otherColumnWidth =
    columnCount > 1 ? (pageWidth - firstColumnWidth) / (columnCount - 1) : pageWidth;
  const columnWidths = Array.from({ length: columnCount }, (_, index) =>
    index === 0 ? firstColumnWidth : otherColumnWidth
  );

  const rowHeight = 13;
  const cellPaddingX = 2;
  const cellPaddingY = 2;
  const cellPaddingWidth = cellPaddingX * 2;
  const drawRow = (cells, rowY, majorStop, rowIndex) => {
    const rowWidth = columnWidths.reduce((total, width) => total + width, 0);
    const baseColor = majorStop ? '#e7e7e7' : rowIndex % 2 === 1 ? '#f5f5f5' : null;
    if (baseColor) {
      doc.save();
      doc.fillColor(baseColor).rect(doc.page.margins.left, rowY, rowWidth, rowHeight).fill();
      doc.restore();
    }
    let x = doc.page.margins.left;
    cells.forEach((cell, index) => {
      const width = columnWidths[index];
      doc.rect(x, rowY, width, rowHeight).stroke();
      const cellText = String(cell);
      const isStop = index === 0;
      const isMajor = isStop && majorStop;
      doc.font(isMajor ? 'Helvetica-Bold' : 'Helvetica').fontSize(7.5);
      doc.text(cellText, x + cellPaddingX, rowY + cellPaddingY, {
        width: width - cellPaddingWidth,
        align: isStop ? 'left' : 'center'
      });
      x += width;
    });
  };

  let y = startY;
  doc.lineWidth(0.5).strokeColor('#111');

  timetable.rows.forEach((row, rowIndex) => {
    if (y + rowHeight > doc.page.height - doc.page.margins.bottom) {
      doc.addPage();
      y = doc.page.margins.top;
    }
    const stopId = timetable.stopIds?.[rowIndex];
    const majorStop = isMajorStop(row[0], stopId, timetable.majorStops);
    drawRow(row, y, majorStop, rowIndex);
    y += rowHeight;
  });
};

const writePdf = (timetable, outputDir) => {
  const routeNumber = timetable.route.route_short_name || timetable.route.route_id;
  const routeTitle = timetable.route.route_long_name || timetable.route.route_id;
  const routeSubtitle = timetable.route.route_long_name ? timetable.route.route_desc || '' : '';
  const serviceDates = timetable.meta?.serviceDates;
  const serviceDays = timetable.meta?.serviceDays;
  const fileName = `${buildOutputBaseName(timetable)}.pdf`;
  const filePath = path.join(outputDir, fileName);
  const doc = new PDFDocument({ margin: 28, size: 'A4' });
  doc.pipe(fs.createWriteStream(filePath));
  const headerLeft = doc.page.margins.left;
  const headerTop = doc.page.margins.top;
  const badgePadding = 10;
  doc.font('Helvetica-Bold').fontSize(38);
  const badgeTextWidth = doc.widthOfString(routeNumber);
  const badgeWidth = Math.max(64, badgeTextWidth + badgePadding * 2);
  const badgeHeight = 46;
  doc.rect(headerLeft, headerTop, badgeWidth, badgeHeight).fill('#111');
  doc
    .fillColor('#fff')
    .font('Helvetica-Bold')
    .fontSize(34)
    .text(routeNumber, headerLeft, headerTop + 7, { width: badgeWidth, align: 'center' });
  doc.fillColor('#111');
  const titleX = headerLeft + badgeWidth + 12;
  doc.font('Helvetica-Bold').fontSize(16).text(routeTitle, titleX, headerTop + 10);
  if (routeSubtitle) {
    doc.font('Helvetica').fontSize(12).text(routeSubtitle, titleX, headerTop + 30);
  }
  const headerLineY = headerTop + 68;
  doc.moveTo(headerLeft, headerLineY).lineTo(doc.page.width - doc.page.margins.right, headerLineY).stroke();
  if (serviceDates) {
    doc
      .font('Helvetica-Bold')
      .fontSize(9)
      .text(serviceDates.toUpperCase(), headerLeft, headerTop + 78);
  }
  if (serviceDays) {
    doc.font('Helvetica').fontSize(8).text(serviceDays, headerLeft, headerTop + 92);
  }
  drawPdfTable(doc, timetable, headerTop + 110);
  doc.end();
  return filePath;
};

const main = async () => {
  const args = parseArgs(process.argv);
  if (args.help || !args.input) {
    printHelp();
    process.exit(args.help ? 0 : 1);
  }
  const outputDir = path.resolve(args.output);
  fs.mkdirSync(outputDir, { recursive: true });
  const { files, cleanup } = loadGtfsFiles(path.resolve(args.input));
  try {
    const routes = await parseCsv(fs.createReadStream(files['routes.txt']));
    const trips = await parseCsv(fs.createReadStream(files['trips.txt']));
    if (!routes.length || !trips.length) {
      throw new Error('GTFS feed is missing route or trip data.');
    }
    const agencies = files['agency.txt']
      ? await parseCsv(fs.createReadStream(files['agency.txt']))
      : [];
    const stops = await parseCsv(fs.createReadStream(files['stops.txt']));
    const calendar = files['calendar.txt']
      ? await parseCsv(fs.createReadStream(files['calendar.txt']))
      : [];
    const routeIdsToRender = new Set(
      routes
        .filter(
          (route) =>
            !args.route ||
            args.route === route.route_id ||
            args.route === route.route_short_name
        )
        .map((route) => route.route_id)
    );
    const relevantTrips = trips.filter((trip) => routeIdsToRender.has(trip.route_id));
    const relevantTripIds = new Set(relevantTrips.map((trip) => trip.trip_id));
    const stopTimes = [];
    if (relevantTripIds.size) {
      await parseCsvStream(fs.createReadStream(files['stop_times.txt']), (record) => {
        if (relevantTripIds.has(record.trip_id)) {
          stopTimes.push(record);
        }
      });
    }
    const gtfs = {
      agencies,
      routes,
      trips,
      stops,
      stopTimes,
      calendar
    };
    const timetables = buildTimetables(gtfs, args);
    if (!timetables.length) {
      throw new Error('No matching timetables found for the provided GTFS feed.');
    }
    timetables.forEach((timetable) => {
      const htmlPath = writeHtml(timetable, outputDir);
      const pdfPath = writePdf(timetable, outputDir);
      console.log(`Generated ${htmlPath} and ${pdfPath}`);
    });
  } finally {
    if (cleanup) {
      cleanup();
    }
  }
};

main().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exit(1);
});
