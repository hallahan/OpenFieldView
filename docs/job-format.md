# Trimble Access job file (.job) format

Trimble doesn't publish the `.job` format. This is what has been worked out so
far, by comparing JOB files with JobXML (`.jxl`) exported from the same jobs.
It is enough to read points, codes, feature attributes, edits, renames,
deletes, GNSS observations and their quality control, averaged points, the
site calibration and the coordinate system. `src/job.ts` implements it, and
`src/job.compare.test.ts` checks it against JobXML.

Checked against Trimble Access 25.10, 25.20 and 26.10 (database versions
2510-3, 2520-12, 2610-15): eleven job and JobXML pairs in all, GNSS control
and topo work with site calibrations. Everything is little-endian. Confidence is marked
where it matters: **known** means it matches JobXML on every point of every
sample, **guess** means it fits the samples but hasn't been tested by a job
that would tell it apart from something else.

## File layout

| Offset | Size | What |
| --- | --- | --- |
| 0 | 42 | `Trimble General Survey Journal`, zero padded |
| 42 | 3 | `01 04 00` (unknown, constant) |
| 45 | 3 | database version: major, minor, build (`1a 0a 0f` = 26.10.15) |
| 48 | … | records, back to back, to the end of the file |

The file is a journal. Records are only ever appended: an edit is a new
record that points back at the record it changes, so the current state of
the job is found by replaying the file from the start.

## Records

Each record is a `u32` length *n*, then *n* bytes:

| Offset | Size | What |
| --- | --- | --- |
| 0 | 1 | status (0–3). Meaning unknown; constant for each record type |
| 1 | 2 | kind (below) |
| 3 | 4 | parent record ID (0 for top-level records) |
| 7 | 2 | record type (below) |
| 9 | 4 | record ID. JobXML's `ID` attribute is this in hex |
| 13 | 8 | time stored: `f64` seconds since 1980-01-01, controller local time |
| 21 | 2 | minutes to add to local time to get UTC (420 = PDT, 480 = PST) |
| 23 | n − 25 | payload |
| n − 2 | 2 | CRC-16/ARC of bytes 0 … n − 3 (reflected poly 0x8005, init 0) |

**Known:** framing and CRC check out on every record of every sample, and the
last record ends exactly at the end of the file.

Kinds:

| Kind | Meaning |
| --- | --- |
| `0x2a30` | a new record |
| `0x2a31` | a replacement for the record whose ID is in the parent field |
| `0x2a32` | a replacement child (seen once; treated like `0x2a33`) |
| `0x2a33` | a child of the parent record: position, edit, delete, note… |

## Value encodings

- Strings are null-terminated UTF-8.
- Doubles are IEEE `f64`. `a0 c8 eb 85 f3 cc e1 7f` (about 1e308) means "no value".
- Geodetic coordinates and projection angles are radians. Lengths are metres,
  whatever units the job displays in.
- Several records start with the two letters `KI` after the first byte. Points
  carry a similar two-letter tag (below).

## Record types

| Type | JobXML | Notes |
| --- | --- | --- |
| 0 | (`JOBFile` attributes) | name the job was created as, controller serial, Access version, product |
| 1 | `NoteRecord` / point `Notes` | text. As a child of a point: "Deleted 11:04:03 AM 9/25/2026", "Old values …". At the top level: "New base station detected", "VRSID:21, 37°30'28.79700", …, PRSID:19" |
| 2 | `PointRecord` | see below |
| 8 | `ECEFDeltas` … | GNSS vector, no tilt |
| 9 | `ECEFDeltas`, `DeviceAxisOrientation` | GNSS vector with IMU tilt |
| 15 | `WGS84` | keyed-in or base position: lat, lon (radians), height |
| 17 | `Grid` | keyed-in grid: north, east, elevation (metres) |
| 19 | `SourcePoint`, `Polar` | COGO point: source name, azimuth, horizontal and vertical distance |
| 21 | (not in the samples' JobXML) | total station observation, probably HA, VA, SD and IDs of setup, backsight, target |
| 31 | — | end of a point's records (payload `00`) |
| 32 | `QualityControl1` | satellites, DOPs, epochs, start and end time |
| 33 | `QualityControl2` | vector covariance (VCV xx, xy, xz, yy, yz, zz) |
| 35 | `Precision` | horizontal, vertical |
| 36 | `EllipsoidRecord` | |
| 37 | `DatumRecord` | |
| 38 | `ProjectionRecord` | |
| 39 | `HorizontalAdjustmentRecord` | |
| 40 | `VerticalAdjustmentRecord` | |
| 41 | `CorrectionsRecord` | |
| 44 | `CalibrationPointRecord` | see below |
| 45 | `GPSEquipmentRecord` | |
| 46 | `AntennaRecord` | |
| 47 | `RoverSurveyOptionsRecord` | not decoded |
| 48 | `BaseSurveyOptionsRecord` | not decoded |
| 49 | `SurveyEventRecord` | `u8` 0, `u8` event: 1 StartRoverSurvey, 3 EndSurvey |
| 51 | `UnitsRecord` | see below |
| 54 | `FeatureCodingRecord` | `u8` 0, library name, full path on the controller, file name, 4 bytes |
| 68 | `InitialisationRecord` | `u8` 0, `u8` event (7 RTKInitialised, 8 RTKNotInitialised), `u8`, `u16` GPS week, `f64` seconds, `u8` type (3 OnTheFly, 4 ResetRTK) |
| 70 | `ReferenceRecord` | GNSS base |
| 87 | `CoordinateSystemRecord` | |
| 125 | `LinkedFilesRecord` | not decoded |
| 127 | `ActiveMapFilesRecord` | `u8` 0, then the file's path when there is one. **Guess** for more than one file |
| 128 | `JobPropertiesRecord` | not decoded |
| 144 | `GridStandardDeviations` | after an averaged point: `u8` 0, north, east, elevation |
| 146 | `TimeZoneRecord` | `u8` 0, zone name, `f64` hours to UTC |
| 151 | `NTRIPDataSourceRecord` | `u8` 0, mount point, data format, solution, IP address (strings), `u16` port |
| 155 | `AverageResiduals` | after an averaged point, see below |
| 172 | `DeviceAxisOrientation` (VerticalTiltError) | after a point shot with the electronic bubble: `u8` 0, `u8` 1, pitch, roll (radians) |
| 173 | `TiltSensorCalibrationRecord` | not decoded |
| 204 | `IMUCenteringAlignmentRecord` | not decoded |
| 215–217 | `DisplacementModelsRecord`, `KinematicTransformationsRecord`, `ReferenceFrameTransformationsRecord` | 216 decoded |
| 1000 | `Deleted` | child of a point: `00 00` deleted, `00 01` restored. Latest wins |
| 1003 | `jobName`, point `Name` | child of record 0: the job's current name (`00 02`, name). Child of a point: its new name after a rename (`00 00`, name) |
| 1004 | `Features` | child of a point: its whole code and attribute list again, after an edit. Latest wins |

Types 124, 197 and 220 appear alongside total station work and are not
decoded yet. Types 55 to 60, 66, 73 to 82, 85, 88, 117, 126, 156, 164, 182,
187, 195, 198, 200 and 221 are in every GNSS job and have no JobXML record of
their own; they look like survey style settings and aren't needed to read
the job.

### Point (type 2)

| What | Encoding |
| --- | --- |
| note | string, usually empty. A point whose attributes were edited before it was stored opens with "Modified 2:01:25 PM 11/6/2026", "Old values CTRLP", a line each |
| feature codes | `u32` count, then for each: `u8` 0, name, `u8` 3, `u16` 0, `u32` attribute count, attributes |
| attribute | `u16` type, name, value: type 0 Numeric `f64`; 1 Text string; 2 Menu `u16` item index + string; 5 File string; 8 Photo string (file name only; JobXML adds `<job> Files/`) |
| description 1 | string |
| ? | 7 bytes, all zero in the samples. **Guess:** the first is an empty description 2 |
| name | string |
| source | 2 ASCII letters: `KI` keyed in, `TP` topo, `SI` base, `CN` control, `CC` copied, `AV` averaged, `SN`, `F2`… |
| method | `u16`: 1 Coordinates, 6 BearingDistancePointIntersection, 11 GpsStaticObservation, 13 GpsRTKControlPoint, 59 CopiedPoint, 60 FromBase |
| survey method | `u16`: 0 KeyedIn, 1 Autonomous, 14 RTK, 15 NetworkRTK |
| classification | `u16`: 0 Check, 3 Construction, 4 Normal, 7 Averaged, 9 Control |
| ? | `u8` 0 |
| source file | string: for a copied point, the path of the file it came from |
| ? | `u16` 0 or 1 |

A point's precision (35), quality control (32, 33), bubble tilt (172) and, for
an averaged point, standard deviations (144) and residuals (155) follow it as
top-level records, up to the point's end marker (31).

Several points can share a name: a mark shot twice and then averaged, or a
base keyed in and later checked. JobXML's `Reductions` has one point per
name, chosen by class: Control, Averaged, Adjusted, Normal, Construction,
Check. Within a class the oldest stands, except that a newer control point
replaces an older one. **Known** for Averaged over Normal and Normal over
Check; the rest is Trimble's documented search rule.

The point's code in JobXML is the feature code names joined by spaces.
JobXML from Access 26 only lists codes that have attributes as `Features`;
Access 25 also lists the plain ones (BL, EL…).

### GNSS vector (types 8 and 9)

`u8` 0, ΔX, ΔY, ΔZ (`f64`, ECEF metres), `u32` reference record ID, `u32`
antenna record ID. Type 9 then has `u8` 3 (IMU tilt), yaw, pitch, roll
(radians), and their standard deviations.

The vector runs from the base antenna's phase centre to the rover's. To get
the ground mark (**known**, matches JobXML to < 0.01 mm on every point):

1. Base mark: the WGS84 position of the point named in the reference record.
2. Base phase centre: up the ellipsoid normal by the base antenna's height.
3. Rover phase centre: base phase centre + ΔX, ΔY, ΔZ.
4. Pole length *H*: antenna record's measured height + the equipment record's vertical offset.
5. Down the pole. In local east/north/up at the phase centre, with
   *p* = −pitch, *r* = roll, *a* = −yaw:
   forward = *H* sin *p* cos *r*, right = *H* sin *r*, up = *H* cos *p* cos *r*;
   east = forward sin *a* + right cos *a*, north = forward cos *a* − right sin *a*.
   Without tilt, it's *H* straight down.

### Quality control (32, 33)

QC1 (32), offsets into the payload: 1 seven `u16` satellite counts (total,
GPS, GLONASS, Galileo, QZSS, BeiDou, NavIC), 15 the same seven as the minimum
during the occupation, 30 PDOP, GDOP, HDOP, VDOP (`f64`), 62 the same four at
the moment of storing, 102 `u16` positions used, 154 `u16` start GPS week,
156 start seconds, 164 `u16` end week, 166 end seconds, 176 correction age.
The satellite list and the warning flags are in there too and aren't decoded.

QC2 (33): `u8` 0, `u16` satellites, error scale, VCV xx, xy, xz, yy, yz, zz,
unit variance.

### Averaged points (144, 155)

Residuals (155): `u8` 0, `u32` count, then 72 bytes for each observation: 17
bytes (not understood), `u32` ID of the observation's point record, `u8`
included in the average, north, east and elevation residuals, three empty
doubles (the angle residuals of a total station observation), 2 bytes.

### Calibration point (44)

`u8` 0, grid point name, GNSS point name, `u8` dimension (2 = horizontal
only, 3 = 3D), `u8` 0, vertical residual, horizontal residual, 3D residual,
the control point's north, east and elevation, then the residual north, east
and elevation, `u32` record ID. The residuals are empty in a calibration that
was carried into the job instead of computed in it.

### Equipment (45) and antenna (46)

Equipment: `u8` 0, receiver type, a short serial, receiver serial, firmware
`f64`, antenna type, antenna short name, measurement method ("Bottom of quick
release"), antenna serial, `u16` antenna number, `u8` antenna method, `u8`,
tape adjustment, horizontal offset, vertical offset (`f64`s), …

Antenna: `u8` 0, measured height `f64`, `u8` measurement type (0 Corrected,
3 Raw), `u8`, `u32` equipment record ID, ….

Reference (70): `u8` 0, base point name, `u32` antenna record ID, `KI`.

### Coordinate system

Payload offsets (after the 23-byte header):

- **Ellipsoid (36):** 3 semi-major axis, 11 flattening, 23 `i32` EPSG.
- **Projection (38):** 3 `u16` type (1 = ScaleOnly, 7 = Lambert2Parallel), 5 central latitude,
  13 central longitude, 21 scale, 29 false northing, 37 false easting,
  63 parallel 1, 71 parallel 2 (angles in radians). Project location height
  is 41 bytes from the end (the record is 2 bytes shorter before Access 26).
- **Datum (37):** 62 `i32` reference frame ID, 66 `i32` EPSG, 74 epoch,
  82 frame name, then displacement model name.
- **Horizontal adjustment (39):** 3 `u16` type (0 none, 1 PlaneAdjustment),
  then origin N, origin E, translation N, translation E, rotation (radians),
  scale.
- **Vertical adjustment (40):** 3 `u16` type (0 none, 3 GeoidModel, 4 and 5
  GeoidModelAndInclinedPlane), origin N, origin E, slope N, slope E, constant,
  geoid file name (`g18us`), `i32` EPSG. Type 4 is a calibration computed in
  the job and 5 one carried into it; JobXML names both the same.
- **Coordinate system (87):** system, zone and datum names; the last 12 bytes
  are `i32` zone ID, projected CRS EPSG and compound CRS EPSG (-1 for none).
- **Corrections (41):** byte 16 is the Cogo distance setting (0 grid, 2 ground).
- **Units (51):** `u16`s from offset 1, numbered in one list across all kinds
  of unit: distance, height, angle, latitude/longitude, ?, ?, temperature,
  pressure, grade, area, volume. Then at 50 precision (0 1Sigma, 1 95Percent,
  3 DRMS) and at 52 mass. Seen: 0 Metres, 6 USSurveyFeet, 14 DMSDegrees,
  29 Celsius, 30 Fahrenheit, 31 MilliBar, 32 InchHg, 37 SquareMetres,
  40 SquareUSSurveyFeet, 50 CubicMetres, 54 CubicUSSurveyYards, 59 Kilograms,
  65 Pounds.
- **Kinematic transformations (216):** `u8` 0, `u32` count, then each: `u32`
  system ID, `u32` type (1 = 14 parameters), name, source, target, epoch, 16
  bytes, rotations X Y Z, translations X Y Z, scale, then their rates in the
  same order, 2 bytes.

## What the JOB doesn't have

Trimble Access computes these when it exports JobXML, and the JOB doesn't
store them. `src/job.ts` computes them the same way, and on every sample
they match JobXML to 0.01 mm:

- **Grid coordinates of measured points.** The WGS84 position is moved onto
  the job's own ellipsoid (for NAD83, GRS80: the datum shift is zero but the
  flattening differs, worth 0.1 mm of northing), projected, then put through
  the site calibration's plane adjustment.
- **Elevations of measured points.** Height above the job's ellipsoid, less
  the geoid height, plus the vertical adjustment's constant (and its slopes
  from the origin: **guess**, every sample's slopes are zero). The geoid model
  isn't in the job, only its file name; see below.
- **The combined scale factor.** Given at the mean of the points' grid
  coordinates (one point per name) and the project height.

## Geoid grid file (.ggf)

The geoid model is a separate file in the controller's System Files folder,
such as `g18us.ggf` for GEOID18. `src/geoid.ts` reads it. Little-endian:

| Offset | Size | What |
| --- | --- | --- |
| 0 | 2 | zero |
| 2 | 14 | `TNL GRID FILE`, null terminated |
| 16 | 32 | model name (`GEOID18 (Conus)`), null padded. JobXML's `GeoidName` |
| 48 | 16 | `f64` south and north latitude, degrees |
| 64 | 16 | `f64` west and east longitude, degrees east (230 = 130°W) |
| 80 | 16 | `f64` latitude and longitude spacing |
| 96 | 8 | `i32` rows, `i32` columns |
| 104 | 42 | flags, not understood |
| 146 | … | `f32` geoid heights in metres, row by row from the south-west corner, each row west to east |

Trimble Access interpolates with a quadratic through the three nearest rows
and columns (**known**: this matches its elevations to 0.01 mm, where
bilinear interpolation is off by up to 1 mm).

## Still to work out

- Total station setups, backsights, observations and targets, and stakeouts.
- What's in the 7 bytes after description 1, using a point with description 2.
- Enum values not in the samples: other projections, units, methods.
- The satellite list and warning flags in quality control 1.
- Survey options (47, 48), IMU alignment (204), tilt sensor calibration (173).
