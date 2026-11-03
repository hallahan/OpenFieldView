// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { parseDms, parseVrsNote } from './calibration';
import { calibrationHtml } from './calibrationview';
import { parseJxl } from './jxl';
import { unitOf } from './properties';

// A calibration imported from an older job (blank residuals) and computed
// again in this one, a network RTK connection with a VRS note, a checkshot,
// and the same reference station keyed in from the older job.
const job = `<?xml version="1.0" encoding="UTF-8"?>
<JOBFile jobName="Calibration test" version="6.34" product="Trimble Access" TimeStamp="2026-11-02T10:00:00">
  <FieldBook>
    <UnitsRecord ID="00000001"><DistanceUnits>Metres</DistanceUnits></UnitsRecord>
    <CoordinateSystemRecord ID="00000002"><SystemName>United States/NAD83/CA SRS</SystemName><ZoneName>California Epoch 2017.50 Zone 3</ZoneName></CoordinateSystemRecord>
    <PointRecord ID="00000010" TimeStamp="2026-11-02T10:00:00">
      <Name>CP1</Name><Code>CTRL</Code><Method>Coordinates</Method><SurveyMethod>KeyedIn</SurveyMethod><Classification>Control</Classification><Deleted>false</Deleted>
      <Grid><North>1000.000</North><East>2000.000</East><Elevation>50.000</Elevation></Grid>
    </PointRecord>
    <PointRecord ID="00000011" TimeStamp="2026-11-02T10:00:00">
      <Name>CP2</Name><Code>CTRL</Code><Method>Coordinates</Method><SurveyMethod>KeyedIn</SurveyMethod><Classification>Control</Classification><Deleted>false</Deleted>
      <Grid><North>1500.000</North><East>2500.000</East><Elevation>55.000</Elevation></Grid>
    </PointRecord>
    <PointRecord ID="00000012" TimeStamp="2026-11-02T10:00:00">
      <Name>OLDBASE</Name><Code /><Method>Coordinates</Method><SurveyMethod>KeyedIn</SurveyMethod><Classification>Normal</Classification><Deleted>false</Deleted>
      <Grid><North>9000.000</North><East>8000.000</East><Elevation>100.000</Elevation></Grid>
    </PointRecord>
    <PointRecord ID="00000013" TimeStamp="2026-11-02T10:00:00">
      <Name>CP1_GNSS</Name><Code /><Method>Coordinates</Method><SurveyMethod>KeyedIn</SurveyMethod><Classification>Normal</Classification><Deleted>false</Deleted>
      <WGS84><Latitude>37.0</Latitude><Longitude>-121.5</Longitude><Height>20</Height></WGS84>
      <ComputedGrid><North>999.990</North><East>2000.020</East><Elevation>50.005</Elevation></ComputedGrid>
    </PointRecord>
    <CalibrationPointRecord ID="00000020" TimeStamp="2026-11-02T10:00:00">
      <GridPointName>CP1</GridPointName><WGS84PointName>CP1_GNSS</WGS84PointName><Dimension>3D</Dimension>
      <HorizontalResidual /><VerticalResidual /><Residual3D />
      <GridResidual><DeltaNorth /><DeltaEast /><DeltaElevation /></GridResidual>
    </CalibrationPointRecord>
    <HorizontalAdjustmentRecord ID="00000021" TimeStamp="2026-11-02T10:00:00">
      <Type>PlaneAdjustment</Type><OriginNorth>1000</OriginNorth><OriginEast>2000</OriginEast>
      <TranslationNorth>0.1</TranslationNorth><TranslationEast>-0.05</TranslationEast><Rotation>0.0001</Rotation><ScaleFactor>1.000002</ScaleFactor>
    </HorizontalAdjustmentRecord>
    <NTRIPDataSourceRecord ID="00000030" TimeStamp="2026-11-02T11:00:00">
      <MountPoint>NET_CMRx</MountPoint><DataFormat>CMRx</DataFormat><Solution>Network</Solution><IPAddress>10.0.0.1</IPAddress><IPPort>2101</IPPort>
    </NTRIPDataSourceRecord>
    <SurveyEventRecord ID="00000031" TimeStamp="2026-11-02T11:00:00"><Event>StartRoverSurvey</Event></SurveyEventRecord>
    <NoteRecord ID="00000032" TimeStamp="2026-11-02T11:00:05"><Notes><Note>New base station detected</Note></Notes></NoteRecord>
    <NoteRecord ID="00000033" TimeStamp="2026-11-02T11:00:05"><Notes><Note>VRSID:4, 37°05'16.60741", -121°36'07.95778", 183.600sft, PRSID:9</Note></Notes></NoteRecord>
    <PointRecord ID="00000034" TimeStamp="2026-11-02T11:00:05">
      <Name>NEWBASE</Name><Code /><Method>FromBase</Method><SurveyMethod>KeyedIn</SurveyMethod><Classification>Normal</Classification><Deleted>false</Deleted>
      <WGS84><Latitude>37.1</Latitude><Longitude>-121.6</Longitude><Height>70</Height></WGS84>
      <ComputedGrid><North>9000.300</North><East>7999.800</East><Elevation>100.002</Elevation></ComputedGrid>
    </PointRecord>
    <ReferenceRecord ID="00000035" TimeStamp="2026-11-02T11:00:05"><PointName>NEWBASE</PointName><AntennaID>00000036</AntennaID></ReferenceRecord>
    <PointRecord ID="00000040" TimeStamp="2026-11-02T11:05:00">
      <Name>CP2-G</Name><Code /><Method>GpsRTKControlPoint</Method><SurveyMethod>NetworkRTK</SurveyMethod><Classification>Normal</Classification><Deleted>false</Deleted>
      <ECEFDeltas><DeltaX>1</DeltaX><DeltaY>1</DeltaY><DeltaZ>1</DeltaZ></ECEFDeltas><ReferenceRecordID>00000035</ReferenceRecordID><RTK_Base>NEWBASE</RTK_Base>
      <ComputedGrid><North>1500.003</North><East>2499.996</East><Elevation>55.010</Elevation></ComputedGrid>
    </PointRecord>
    <PointRecord ID="00000041" TimeStamp="2026-11-02T11:10:00">
      <Name>CP1-CHK</Name><Code /><Method>GpsStaticObservation</Method><SurveyMethod>NetworkRTK</SurveyMethod><Classification>Stakeout</Classification><Deleted>false</Deleted>
      <ECEFDeltas><DeltaX>1</DeltaX><DeltaY>1</DeltaY><DeltaZ>1</DeltaZ></ECEFDeltas><ReferenceRecordID>00000035</ReferenceRecordID><RTK_Base>NEWBASE</RTK_Base>
      <ComputedGrid><North>1000.280</North><East>1999.800</East><Elevation>50.010</Elevation></ComputedGrid>
      <Stakeout>
        <PointDesign><Name>CP1</Name><StakeoutMethod>ToThePoint</StakeoutMethod></PointDesign>
        <GridDeltas><DeltaNorth>-0.28</DeltaNorth><DeltaEast>0.2</DeltaEast><DeltaElevation>-0.01</DeltaElevation></GridDeltas>
      </Stakeout>
    </PointRecord>
    <CalibrationPointRecord ID="00000050" TimeStamp="2026-11-03T08:00:00">
      <GridPointName>CP2</GridPointName><WGS84PointName>CP2-G</WGS84PointName><Dimension>3D</Dimension>
      <HorizontalResidual>0.005</HorizontalResidual><VerticalResidual>0.01</VerticalResidual><Residual3D>0.0112</Residual3D>
      <GridResidual><DeltaNorth>-0.003</DeltaNorth><DeltaEast>0.004</DeltaEast><DeltaElevation>-0.01</DeltaElevation></GridResidual>
    </CalibrationPointRecord>
    <CalibrationPointRecord ID="00000051" TimeStamp="2026-11-03T08:00:00">
      <GridPointName>CP1</GridPointName><WGS84PointName>CP1_GNSS</WGS84PointName><Dimension>Horizontal</Dimension>
      <HorizontalResidual /><VerticalResidual /><Residual3D />
      <GridResidual><DeltaNorth /><DeltaEast /><DeltaElevation /></GridResidual>
    </CalibrationPointRecord>
    <HorizontalAdjustmentRecord ID="00000052" TimeStamp="2026-11-03T08:00:00">
      <Type>PlaneAdjustment</Type><OriginNorth>1200</OriginNorth><OriginEast>2200</OriginEast>
      <TranslationNorth>-0.2</TranslationNorth><TranslationEast>0.15</TranslationEast><Rotation>-0.000175</Rotation><ScaleFactor>1.0000068</ScaleFactor>
    </HorizontalAdjustmentRecord>
    <VerticalAdjustmentRecord ID="00000053" TimeStamp="2026-11-03T08:00:00">
      <Type>GeoidModelAndInclinedPlane</Type><OriginNorth>1000</OriginNorth><OriginEast>2000</OriginEast>
      <SlopeNorthPerUnit>0.0000046</SlopeNorthPerUnit><SlopeEastPerUnit>-0.0000085</SlopeEastPerUnit><ConstantAdjustment>-0.0174</ConstantAdjustment>
      <GeoidName>GEOID18 (Conus)</GeoidName>
    </VerticalAdjustmentRecord>
  </FieldBook>
</JOBFile>`;

describe('calibrationFromJob', () => {
  const cal = parseJxl(job).calibration!;

  it('reads the calibration in force, not the one it replaced', () => {
    expect(cal.horizontalType).toBe('PlaneAdjustment');
    expect(cal.horizontal!.originNorth).toBe(1200);
    expect(cal.horizontal!.scale).toBeCloseTo(1.0000068, 9);
    expect(cal.computed).toBe('2026-11-03T08:00:00');
    expect(cal.pairs.map((p) => p.gridPoint)).toEqual(['CP2', 'CP1']);
  });

  it('reads the vertical inclined plane', () => {
    expect(cal.vertical).toMatchObject({
      type: 'GeoidModelAndInclinedPlane',
      geoid: 'GEOID18 (Conus)',
      originNorth: 1000,
      originEast: 2000,
      constant: -0.0174,
      slopeNorth: 0.0000046,
      slopeEast: -0.0000085,
    });
    const crs = parseJxl(job).metadata.find((s) => s.title === 'Datum and projection')!.entries;
    expect(crs).toContainEqual(['Vertical adjustment', 'constant -0.017 m, slope N 4.60 ppm, E -8.50 ppm']);
  });

  it('keeps stored residuals and works out blank ones from the computed grid', () => {
    const [cp2, cp1] = cal.pairs;
    expect(cp2.residualSource).toBe('File');
    expect(cp2.residual).toMatchObject({ north: -0.003, east: 0.004, elevation: -0.01, horizontal: 0.005, vertical: 0.01 });
    expect(cp1.residualSource).toBe('Computed');
    expect(cp1.dimension).toBe('Horizontal');
    // Control minus computed grid, like Trimble's GridResidual.
    expect(cp1.residual!.north).toBeCloseTo(0.01, 6);
    expect(cp1.residual!.east).toBeCloseTo(-0.02, 6);
    expect(cp1.residual!.elevation).toBeCloseTo(-0.005, 6);
    expect(cp1.residual!.vertical).toBeCloseTo(0.005, 6);
    expect(cp1.residual!.horizontal).toBeCloseTo(Math.hypot(0.01, 0.02), 6);
  });

  it('reads checkshot stakeout deltas', () => {
    expect(cal.checkshots).toHaveLength(1);
    expect(cal.checkshots[0]).toMatchObject({ name: 'CP1-CHK', design: 'CP1', north: -0.28, east: 0.2, elevation: -0.01 });
    expect(cal.checkshots[0].horizontal).toBeCloseTo(Math.hypot(0.28, 0.2), 9);
  });

  it('reads RTK base connections with the VRS note and the points they served', () => {
    expect(cal.bases).toHaveLength(1);
    const b = cal.bases[0];
    expect(b).toMatchObject({ base: 'NEWBASE', mountPoint: 'NET_CMRx', format: 'CMRx', solution: 'Network', server: '10.0.0.1:2101', prsId: '9', newBase: true, points: 2 });
    expect(b.vrs!.id).toBe('4');
    expect(b.basePosition).toEqual({ lat: 37.1, lon: -121.6, height: 70 });
  });

  it('flags a base that lands near another point, such as the same station keyed in from an older job', () => {
    expect(cal.baseChecks).toHaveLength(1);
    const c = cal.baseChecks[0];
    expect(c).toMatchObject({ base: 'NEWBASE', point: 'OLDBASE' });
    expect(c.north).toBeCloseTo(-0.3, 6);
    expect(c.east).toBeCloseTo(0.2, 6);
    expect(c.horizontal).toBeCloseTo(Math.hypot(0.3, 0.2), 6);
  });

  it('is absent for a job with no calibration, checkshots or RTK bases', () => {
    const plain = job.replace(/<(CalibrationPointRecord|HorizontalAdjustmentRecord|VerticalAdjustmentRecord|NTRIPDataSourceRecord|ReferenceRecord|NoteRecord)[\s\S]*?<\/\1>/g, '').replace(/<Stakeout>[\s\S]*?<\/Stakeout>/, '');
    expect(parseJxl(plain).calibration).toBeUndefined();
  });
});

describe('VRS notes', () => {
  it('parses position, height in survey feet and the physical station', () => {
    const n = parseVrsNote(`VRSID:4, 37°05'16.60741", -121°36'07.95778", 183.600sft, PRSID:9`)!;
    expect(n.vrs.id).toBe('4');
    expect(n.vrs.lat).toBeCloseTo(37 + 5 / 60 + 16.60741 / 3600, 10);
    expect(n.vrs.lon).toBeCloseTo(-(121 + 36 / 60 + 7.95778 / 3600), 10);
    expect(n.vrs.height).toBeCloseTo(183.6 * (1200 / 3937), 9);
    expect(n.prsId).toBe('9');
  });

  it('ignores other notes', () => {
    expect(parseVrsNote('New base station detected')).toBeUndefined();
  });

  it('reads hemisphere letters', () => {
    expect(parseDms(`121°36'07.95778"W`)).toBeCloseTo(-121.6022105, 6);
    expect(parseDms(`37°05'16.6"N`)).toBeCloseTo(37.087944, 6);
  });
});

describe('calibrationHtml', () => {
  const doc = parseJxl(job);
  const html = calibrationHtml(doc.calibration!, unitOf('Metres'), (name) => doc.points.find((p) => p.name === name)?.index);

  it('shows the parameters, pairs, checkshots and bases', () => {
    for (const heading of ['Parameters', 'Point pairs', 'Checkshots', 'Base against nearby points', 'RTK bases']) {
      expect(html).toContain(`<h3>${heading}</h3>`);
    }
    expect(html).toContain('Calibrated on 2 point pairs, 2026-11-03 08:00.');
    expect(html).toContain('-0.630″');
    expect(html).toContain('+6.80 ppm');
    expect(html).toContain('NET_CMRx');
  });

  it('warns about checkshots and a moved base', () => {
    expect(html).toContain('Checkshots miss control by up to 0.344 m (CP1)');
    expect(html).toContain('Base NEWBASE lands 0.361 m from OLDBASE');
    expect(html).toContain('Residuals are not stored in the file');
  });

  it('links rows to their points', () => {
    const cp2 = doc.points.find((p) => p.name === 'CP2')!.index;
    expect(html).toContain(`data-point="${cp2}"`);
  });
});
