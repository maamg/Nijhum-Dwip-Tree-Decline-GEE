// ============================================================
// NIJHUM DWIP | EXPLORATORY FOREST DISTURBANCE ANALYSIS
// Md. Abdul Aziz | Aziz Research Code Style v2.0
// ============================================================
// Platform: Google Earth Engine JavaScript Code Editor
// Study area: Nijhum Dwip National Park (WDPA SITE_ID 317318)
// Data: Dynamic World V1; Sentinel-2 SR Harmonized; Cloud Score+
// Period: November-December annual composites, 2016-2025
// Research inspiration: Li, Ota & Mizoue (2024), forest disturbance
// attribution using Dynamic World class probabilities in Myanmar.
//
// STATUS: Exploratory research workflow; NOT a validated inventory.
// This is a method-inspired adaptation, not a full replication of
// the original paper's disturbance attribution/accuracy framework.
//
// Definitions: 2017 trees probability > 0.60 is the baseline screen.
// A subsequent decline > 0.25 relative to that baseline is flagged.
// 'Persistent' means this screen is met in >=2 adjacent years;
// it does NOT mean a monotonic decline or verified forest loss.
//
// Interpretation: Other class-probability gains are potential
// transitions, not causal attribution. Sentinel-2 NDVI/MNDWI checks
// are supporting context, not independent accuracy validation,
// since Dynamic World is derived from Sentinel-2.
// Annual coverage, tidal/coastal conditions, thresholds, and
// independent reference data require further scrutiny.
//
// RUN / QC: Execute in GEE Code Editor. Review console output,
// annual image counts, maps and sensitivity comparisons (T25/B60).
// Do not report area totals as validated deforestation.
// ============================================================


// ------------------------------------------------------------
// 1. LOAD AOI
// ------------------------------------------------------------
var wdpa = ee.FeatureCollection('WCMC/WDPA/current/polygons');
var nijhum = wdpa.filter(ee.Filter.eq('SITE_ID', 317318));
var aoi = nijhum.geometry();

Map.centerObject(aoi, 11);
Map.addLayer(nijhum, { color: 'yellow' }, 'Nijhum Dwip Boundary', false);

print('Nijhum Dwip:', nijhum);
print('Matched features:', nijhum.size());

// ------------------------------------------------------------
// 2. LOAD DYNAMIC WORLD
// ------------------------------------------------------------
var dw = ee.ImageCollection('GOOGLE/DYNAMICWORLD/V1')
    .filterBounds(aoi)
    .filterDate('2016-01-01', '2026-01-01')
    .filter(ee.Filter.calendarRange(11, 12, 'month'));

var probabilityBands = [
    'water', 'trees', 'grass', 'flooded_vegetation',
    'crops', 'shrub_and_scrub', 'built', 'bare', 'snow_and_ice'
];

var dw9 = dw.select(probabilityBands);

// ------------------------------------------------------------
// 3. CREATE ANNUAL 9-BAND PROBABILITY COLLECTION
// ------------------------------------------------------------
var years = ee.List.sequence(2016, 2025);

var annualDW9 = ee.ImageCollection.fromImages(
    years.map(function (year) {
        year = ee.Number(year);
        var start = ee.Date.fromYMD(year, 11, 1);
        var end = ee.Date.fromYMD(year.add(1), 1, 1);

        var yearlyDW = dw9.filterDate(start, end);
        var annualImage = yearlyDW.median().clip(aoi);

        return annualImage
            .set('year', year)
            .set('system:time_start', ee.Date.fromYMD(year, 12, 1).millis())
            .set('image_count', yearlyDW.size());
    })
);

print('Annual 9-band Dynamic World collection:', annualDW9);

// Convert images to a server-side list for FeatureCollection summaries.
var annualDWList = annualDW9.toList(annualDW9.size());

// ------------------------------------------------------------
// 4. RECONSTRUCT 2017 HIGH-TREE BASELINE
// ------------------------------------------------------------
var baselineYear = 2017;
var baselineImage = ee.Image(annualDW9.filter(ee.Filter.eq('year', baselineYear)).first());
var baselineTree = baselineImage.select('trees').rename('baseline_tree');

var baselineTreeThreshold = 0.60;
var baselineForestMask = baselineTree.gt(baselineTreeThreshold);

Map.addLayer(baselineForestMask.selfMask(), { palette: ['darkgreen'] }, '2017 High-Tree Baseline (>0.60)', false);

// ------------------------------------------------------------
// 5. CREATE POST-2017 TREE-DROP COLLECTION
// ------------------------------------------------------------
var post2017 = annualDW9.filter(ee.Filter.gt('year', baselineYear));

var annualDrops = post2017.map(function (image) {
    var year = ee.Number(image.get('year'));
    var currentTree = image.select('trees');
    var treeDrop = baselineTree.subtract(currentTree).rename('tree_drop');
    var yearBand = ee.Image.constant(year).rename('drop_year').toInt16();

    return image
        .addBands(treeDrop)
        .addBands(yearBand)
        .set('year', year)
        .copyProperties(image, ['system:time_start']);
});

// ------------------------------------------------------------
// 6. FIND MAXIMUM TREE DROP
// ------------------------------------------------------------
var maxDropComposite = annualDrops.qualityMosaic('tree_drop');
var maxTreeDrop = maxDropComposite.select('tree_drop').updateMask(baselineForestMask);
var maxDropYear = maxDropComposite.select('drop_year').updateMask(baselineForestMask);

// ------------------------------------------------------------
// 7. CANDIDATE + REPEATED + PERSISTENT DECLINE MASKS
// ------------------------------------------------------------
var dropThreshold = 0.25;

// 7A. ANY SUBSTANTIAL DECLINE
var candidateDisturbance = baselineForestMask.and(maxTreeDrop.gt(dropThreshold));

// 7B. COUNT YEARS WITH SUBSTANTIAL DECLINE
var declineFlags = annualDrops.map(function (image) {
    return image.select('tree_drop').gt(dropThreshold)
        .rename('substantial_decline')
        .toByte()
        .set('year', image.get('year'));
}).sort('year');

var declineYearCount = declineFlags.sum()
    .rename('decline_year_count')
    .updateMask(baselineForestMask);

// 7C. REPEATED DECLINE
var repeatedCandidate = candidateDisturbance.and(declineYearCount.gte(2));

// 7D. TEST CONSECUTIVE-YEAR DECLINE
var declineList = declineFlags.toList(declineFlags.size());

var consecutivePairImages = ee.ImageCollection.fromImages(
    ee.List.sequence(0, declineFlags.size().subtract(2)).map(function (i) {
        i = ee.Number(i);
        var firstImage = ee.Image(declineList.get(i));
        var secondImage = ee.Image(declineList.get(i.add(1)));

        var consecutiveDecline = firstImage.and(secondImage)
            .rename('consecutive_decline')
            .toByte();

        return consecutiveDecline
            .set('start_year', firstImage.get('year'))
            .set('end_year', secondImage.get('year'));
    })
);

// 7E. TRUE PERSISTENT CANDIDATE
var persistentCandidate = consecutivePairImages.max().eq(1)
    .and(baselineForestMask)
    .rename('persistent_candidate');

// 7F. MAP COMPARISON
Map.addLayer(repeatedCandidate.selfMask(), { palette: ['orange'] }, 'Repeated Decline (>=2 years, any years)', false);
Map.addLayer(persistentCandidate.selfMask(), { palette: ['magenta'] }, 'Persistent Decline (>=2 consecutive years)', true);

// ------------------------------------------------------------
// 8. RECREATE SELECTED EXPLORATORY CANDIDATE POINT
// ------------------------------------------------------------
var candidateImage = maxTreeDrop.rename('max_tree_drop')
    .addBands(maxDropYear.rename('max_drop_year'))
    .addBands(declineYearCount)
    .updateMask(candidateDisturbance);

var candidateSamples = candidateImage.sample({
    region: aoi,
    scale: 10,
    numPixels: 100,
    seed: 42,
    geometries: true
});

var rankedCandidates = candidateSamples.sort('max_tree_drop', false);
var candidatePointFeature = ee.Feature(rankedCandidates.first());
var candidatePoint = candidatePointFeature.geometry();

Map.addLayer(candidatePoint, { color: 'cyan' }, 'Selected Candidate Point', true);
print('Selected candidate:', candidatePointFeature);

// ============================================================
// PART A: CANDIDATE-POINT ATTRIBUTION
// ============================================================

// 9. ALL IMPORTANT PROBABILITIES THROUGH TIME
var candidateChart = ui.Chart.image.series({
    imageCollection: annualDW9.select([
        'trees', 'water', 'grass', 'flooded_vegetation',
        'crops', 'shrub_and_scrub', 'built', 'bare'
    ]),
    region: candidatePoint,
    reducer: ee.Reducer.mean(),
    scale: 10,
    xProperty: 'system:time_start'
}).setOptions({
    title: 'Dynamic World Probabilities — Candidate Disturbance Pixel',
    hAxis: { title: 'Year' },
    vAxis: { title: 'Probability', viewWindow: { min: 0, max: 1 } },
    lineWidth: 2,
    pointSize: 5
});

print(candidateChart);

// 10. PRINT YEAR-BY-YEAR CANDIDATE VALUES
var candidateSeries = ee.FeatureCollection(
    annualDWList.map(function (image) {
        image = ee.Image(image);
        var values = image.reduceRegion({
            reducer: ee.Reducer.mean(),
            geometry: candidatePoint,
            scale: 10,
            bestEffort: true
        });

        return ee.Feature(null, {
            year: image.get('year'),
            trees: values.get('trees'),
            water: values.get('water'),
            grass: values.get('grass'),
            flooded_vegetation: values.get('flooded_vegetation'),
            crops: values.get('crops'),
            shrub_and_scrub: values.get('shrub_and_scrub'),
            built: values.get('built'),
            bare: values.get('bare')
        });
    })
);

print('Candidate annual probability table:', candidateSeries);

// 11. FOCUS ON 2023, 2024 AND 2025
var candidateRecent = candidateSeries.filter(ee.Filter.gte('year', 2023));
print('Candidate values — 2023 to 2025:', candidateRecent);

// ============================================================
// PART B: PERSISTENT-CANDIDATE PATCH ANALYSIS
// ============================================================

// 12. MASK ANNUAL IMAGES TO PERSISTENT CANDIDATES
var persistentAnnual = annualDW9.map(function (image) {
    return image.updateMask(persistentCandidate)
        .copyProperties(image, ['year', 'system:time_start']);
});

// 13. MEAN TRAJECTORY ACROSS ALL PERSISTENT PIXELS
var trajectoryBands = ['trees', 'water', 'flooded_vegetation', 'crops', 'shrub_and_scrub', 'bare'];

var persistentSeries = ee.FeatureCollection(
    annualDWList.map(function (image) {
        image = ee.Image(image);
        var stats = image.select(trajectoryBands)
            .updateMask(persistentCandidate)
            .reduceRegion({
                reducer: ee.Reducer.mean(),
                geometry: aoi,
                scale: 10,
                maxPixels: 1e9,
                tileScale: 4
            });

        return ee.Feature(null, stats)
            .set('year', image.get('year'))
            .set('system:time_start', image.get('system:time_start'));
    })
);

print('Annual mean probabilities — persistent candidate pixels:', persistentSeries);

var persistentPatchChart = ui.Chart.feature.byFeature(
    persistentSeries, 'year', trajectoryBands
).setChartType('LineChart')
    .setOptions({
        title: 'Mean Probability Trajectory — Persistent Candidate Pixels',
        hAxis: { title: 'Year' },
        vAxis: { title: 'Mean Probability', viewWindow: { min: 0, max: 1 } },
        lineWidth: 2,
        pointSize: 5
    });

print(persistentPatchChart);

// ============================================================
// PART C: PRE- VS POST-DISTURBANCE COMPARISON
// ============================================================

// 14. GET 2023, 2024, 2025 ANNUAL IMAGES
var image2023 = ee.Image(annualDW9.filter(ee.Filter.eq('year', 2023)).first());
var image2024 = ee.Image(annualDW9.filter(ee.Filter.eq('year', 2024)).first());
var image2025 = ee.Image(annualDW9.filter(ee.Filter.eq('year', 2025)).first());

// 15. CREATE POST-DISTURBANCE MEAN
var postDisturbance = ee.ImageCollection.fromImages([image2024, image2025]).mean();

// 16. TREE CHANGE: POST - 2023
var treeChange = postDisturbance.select('trees')
    .subtract(image2023.select('trees'))
    .rename('tree_change')
    .updateMask(persistentCandidate);

Map.addLayer(treeChange, {
    min: -0.60,
    max: 0.20,
    palette: ['darkred', 'red', 'orange', 'white', 'green']
}, 'Tree Change: 2023 → mean(2024-2025)', true);

// 17. CALCULATE CHANGES IN POSSIBLE ATTRIBUTION CLASSES
var attributionBands = ['water', 'grass', 'flooded_vegetation', 'crops', 'shrub_and_scrub', 'built', 'bare'];

var classChanges = postDisturbance.select(attributionBands)
    .subtract(image2023.select(attributionBands))
    .updateMask(persistentCandidate);

print('Post-minus-pre class change image:', classChanges);

// 18. MEAN CLASS CHANGES ACROSS PERSISTENT PIXELS
var meanClassChanges = classChanges.reduceRegion({
    reducer: ee.Reducer.mean(),
    geometry: aoi,
    scale: 10,
    maxPixels: 1e9
});

print('MEAN CLASS CHANGES across persistent candidates:', meanClassChanges);

// 19. VISUALIZE INDIVIDUAL CLASS GAINS
Map.addLayer(classChanges.select('water'), { min: -0.30, max: 0.30, palette: ['red', 'white', 'blue'] }, 'Water Change — Post vs 2023', false);
Map.addLayer(classChanges.select('flooded_vegetation'), { min: -0.30, max: 0.30, palette: ['red', 'white', 'green'] }, 'Flooded Vegetation Change — Post vs 2023', false);
Map.addLayer(classChanges.select('crops'), { min: -0.30, max: 0.30, palette: ['red', 'white', 'yellow'] }, 'Crops Change — Post vs 2023', false);
Map.addLayer(classChanges.select('shrub_and_scrub'), { min: -0.30, max: 0.30, palette: ['red', 'white', 'green'] }, 'Shrub/Scrub Change — Post vs 2023', false);
Map.addLayer(classChanges.select('bare'), { min: -0.30, max: 0.30, palette: ['green', 'white', 'brown'] }, 'Bare Change — Post vs 2023', false);

// ============================================================
// PART D: EXPLORATORY DOMINANT-TRANSITION ATTRIBUTION
// ============================================================

// 20. FIND CLASS WITH LARGEST PROBABILITY INCREASE
var dominantGainCode = classChanges.toArray()
    .arrayArgmax()
    .arrayGet([0])
    .add(1)
    .rename('dominant_gain_class')
    .updateMask(persistentCandidate);

print('Dominant gain class codes:', '1=water, 2=grass, 3=flooded vegetation, 4=crops, 5=shrub/scrub, 6=built, 7=bare');

Map.addLayer(dominantGainCode, {
    min: 1,
    max: 7,
    palette: ['blue', 'lightgreen', 'cyan', 'yellow', 'green', 'red', 'brown']
}, 'Dominant Probability Gain Class', true);

// 21. DOMINANT GAIN CLASS AT SELECTED CANDIDATE POINT
var dominantAtPoint = dominantGainCode.reduceRegion({
    reducer: ee.Reducer.first(),
    geometry: candidatePoint,
    scale: 10,
    bestEffort: true
});

print('Dominant post-disturbance gain class at candidate point:', dominantAtPoint);

// ============================================================
// PART E: SENTINEL-2 VISUAL CHECK
// ============================================================

// 22. LOAD SENTINEL-2 + CLOUD SCORE+
var s2 = ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
    .filterBounds(aoi)
    .filterDate('2023-01-01', '2026-01-01');

var csPlus = ee.ImageCollection('GOOGLE/CLOUD_SCORE_PLUS/V1/S2_HARMONIZED');

var s2Linked = s2.linkCollection(csPlus, ['cs_cdf']);

var s2Clean = s2Linked.map(function (image) {
    return image.updateMask(image.select('cs_cdf').gte(0.60));
});

// 23. CREATE NOV-DEC SENTINEL-2 COMPOSITES
var getS2Composite = function (year) {
    var start = ee.Date.fromYMD(year, 11, 1);
    var end = ee.Date.fromYMD(year + 1, 1, 1);
    return s2Clean.filterDate(start, end).median().clip(aoi);
};

var s2_2023 = getS2Composite(2023);
var s2_2024 = getS2Composite(2024);
var s2_2025 = getS2Composite(2025);

// 24. TRUE-COLOR VISUALIZATION
var trueColor = { bands: ['B4', 'B3', 'B2'], min: 0, max: 3000 };

Map.addLayer(s2_2023, trueColor, 'Sentinel-2 True Color — Nov-Dec 2023', false);
Map.addLayer(s2_2024, trueColor, 'Sentinel-2 True Color — Nov-Dec 2024', false);
Map.addLayer(s2_2025, trueColor, 'Sentinel-2 True Color — Nov-Dec 2025', false);

// 25. FALSE-COLOR VEGETATION VISUALIZATION
var falseColor = { bands: ['B8', 'B4', 'B3'], min: 0, max: 4000 };

Map.addLayer(s2_2023, falseColor, 'Sentinel-2 False Color — 2023', false);
Map.addLayer(s2_2024, falseColor, 'Sentinel-2 False Color — 2024', false);
Map.addLayer(s2_2025, falseColor, 'Sentinel-2 False Color — 2025', false);

// ============================================================
// PART F: NDVI + MNDWI VERIFICATION
// ============================================================

// 26. FUNCTION TO ADD NDVI + MNDWI
var addIndices = function (image) {
    var ndvi = image.normalizedDifference(['B8', 'B4']).rename('NDVI');
    var mndwi = image.normalizedDifference(['B3', 'B11']).rename('MNDWI');
    return image.addBands(ndvi).addBands(mndwi);
};

// 27. ADD INDICES TO 2023, 2024, 2025 COMPOSITES
var index2023 = addIndices(s2_2023);
var index2024 = addIndices(s2_2024);
var index2025 = addIndices(s2_2025);

// 28. VISUALIZE NDVI
var ndviVis = { min: 0, max: 0.8, palette: ['white', 'yellow', 'lightgreen', 'darkgreen'] };

Map.addLayer(index2023.select('NDVI'), ndviVis, 'NDVI — 2023', false);
Map.addLayer(index2024.select('NDVI'), ndviVis, 'NDVI — 2024', false);
Map.addLayer(index2025.select('NDVI'), ndviVis, 'NDVI — 2025', false);

// 29. VISUALIZE MNDWI
var mndwiVis = { min: -0.5, max: 0.5, palette: ['brown', 'white', 'lightblue', 'blue'] };

Map.addLayer(index2023.select('MNDWI'), mndwiVis, 'MNDWI — 2023', false);
Map.addLayer(index2024.select('MNDWI'), mndwiVis, 'MNDWI — 2024', false);
Map.addLayer(index2025.select('MNDWI'), mndwiVis, 'MNDWI — 2025', false);

// ============================================================
// PART G: SELECTED CANDIDATE POINT
// ============================================================

// 30. EXTRACT NDVI + MNDWI AT CANDIDATE POINT
var candidateIndexSeries = ee.FeatureCollection([
    ee.Feature(null, index2023.select(['NDVI', 'MNDWI']).reduceRegion({
        reducer: ee.Reducer.mean(), geometry: candidatePoint, scale: 10, bestEffort: true
    })).set('year', 2023),
    ee.Feature(null, index2024.select(['NDVI', 'MNDWI']).reduceRegion({
        reducer: ee.Reducer.mean(), geometry: candidatePoint, scale: 10, bestEffort: true
    })).set('year', 2024),
    ee.Feature(null, index2025.select(['NDVI', 'MNDWI']).reduceRegion({
        reducer: ee.Reducer.mean(), geometry: candidatePoint, scale: 10, bestEffort: true
    })).set('year', 2025)
]);

print('Candidate-point NDVI + MNDWI:', candidateIndexSeries);

// 31. CANDIDATE-POINT INDEX CHART
var candidateIndexChart = ui.Chart.feature.byFeature(candidateIndexSeries, 'year', ['NDVI', 'MNDWI'])
    .setChartType('LineChart')
    .setOptions({
        title: 'NDVI and MNDWI — Candidate Disturbance Pixel',
        hAxis: { title: 'Year' },
        vAxis: { title: 'Index Value', viewWindow: { min: -1, max: 1 } },
        lineWidth: 2,
        pointSize: 7
    });

print(candidateIndexChart);

// ============================================================
// PART H: PERSISTENT-CANDIDATE PATCH
// ============================================================

// 32. FUNCTION FOR PATCH-WIDE INDEX STATISTICS
var getPatchStats = function (image, year) {
    var stats = image.select(['NDVI', 'MNDWI'])
        .updateMask(persistentCandidate)
        .reduceRegion({
            reducer: ee.Reducer.mean(),
            geometry: aoi,
            scale: 10,
            maxPixels: 1e9,
            tileScale: 4
        });
    return ee.Feature(null, stats).set('year', year);
};

// 33. CREATE PATCH-WIDE INDEX SERIES
var patchIndexSeries = ee.FeatureCollection([
    getPatchStats(index2023, 2023),
    getPatchStats(index2024, 2024),
    getPatchStats(index2025, 2025)
]);

print('Persistent-candidate patch NDVI + MNDWI:', patchIndexSeries);

// 34. PATCH-WIDE INDEX CHART
var patchIndexChart = ui.Chart.feature.byFeature(patchIndexSeries, 'year', ['NDVI', 'MNDWI'])
    .setChartType('LineChart')
    .setOptions({
        title: 'Mean NDVI and MNDWI — Persistent Candidate Pixels',
        hAxis: { title: 'Year' },
        vAxis: { title: 'Mean Index Value', viewWindow: { min: -1, max: 1 } },
        lineWidth: 2,
        pointSize: 7
    });

print(patchIndexChart);

// ============================================================
// PART I: PRE- VS POST-DISTURBANCE INDEX CHANGE
// ============================================================

// 35. CREATE MEAN POST-DISTURBANCE NDVI + MNDWI
var postIndices = ee.ImageCollection.fromImages([
    index2024.select(['NDVI', 'MNDWI']),
    index2025.select(['NDVI', 'MNDWI'])
]).mean();

// 36. NDVI CHANGE: POST(2024–2025) - 2023
var ndviChange = postIndices.select('NDVI')
    .subtract(index2023.select('NDVI'))
    .rename('NDVI_change')
    .updateMask(persistentCandidate);

Map.addLayer(ndviChange, {
    min: -0.5, max: 0.5,
    palette: ['red', 'orange', 'white', 'lightgreen', 'darkgreen']
}, 'NDVI Change: 2023 → mean(2024-2025)', true);

// 37. MNDWI CHANGE: POST(2024–2025) - 2023
var mndwiChange = postIndices.select('MNDWI')
    .subtract(index2023.select('MNDWI'))
    .rename('MNDWI_change')
    .updateMask(persistentCandidate);

Map.addLayer(mndwiChange, {
    min: -0.5, max: 0.5,
    palette: ['brown', 'white', 'lightblue', 'blue']
}, 'MNDWI Change: 2023 → mean(2024-2025)', true);

// 38. MEAN INDEX CHANGES ACROSS PERSISTENT PATCHES
var meanNDVIChange = ndviChange.reduceRegion({
    reducer: ee.Reducer.mean(), geometry: aoi, scale: 10, maxPixels: 1e9, tileScale: 4
});

var meanMNDWIChange = mndwiChange.reduceRegion({
    reducer: ee.Reducer.mean(), geometry: aoi, scale: 10, maxPixels: 1e9, tileScale: 4
});

print('Mean NDVI change across persistent candidates:', meanNDVIChange);
print('Mean MNDWI change across persistent candidates:', meanMNDWIChange);

// ============================================================
// PART J: FULL NDVI + MNDWI TRAJECTORY: 2017–2025
// ============================================================

// 39. LOAD LONG-TERM SENTINEL-2 SR COLLECTION
var s2Long = ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
    .filterBounds(aoi)
    .filterDate('2017-01-01', '2026-01-01');

var csPlusLong = ee.ImageCollection('GOOGLE/CLOUD_SCORE_PLUS/V1/S2_HARMONIZED');

var s2LongLinked = s2Long.linkCollection(csPlusLong, ['cs_cdf']);

var s2LongClean = s2LongLinked.map(function (image) {
    return image.updateMask(image.select('cs_cdf').gte(0.60));
});

// 40. FUNCTION TO ADD NDVI + MNDWI
var addLongIndices = function (image) {
    var ndvi = image.normalizedDifference(['B8', 'B4']).rename('NDVI');
    var mndwi = image.normalizedDifference(['B3', 'B11']).rename('MNDWI');
    return image.addBands(ndvi).addBands(mndwi);
};

// 41. CREATE YEAR LIST
var indexYears = ee.List.sequence(2017, 2025);
print('Sentinel-2 index years:', indexYears);

// 42. CREATE ONE NOV-DEC COMPOSITE PER YEAR
var annualIndexCollection = ee.ImageCollection.fromImages(
    indexYears.map(function (year) {
        year = ee.Number(year);
        var start = ee.Date.fromYMD(year, 11, 1);
        var end = ee.Date.fromYMD(year.add(1), 1, 1);

        var yearlyS2 = s2LongClean.filterDate(start, end);
        var annualComposite = yearlyS2.median().clip(aoi);
        var annualIndices = addLongIndices(annualComposite).select(['NDVI', 'MNDWI']);

        return annualIndices
            .set('year', year)
            .set('system:time_start', ee.Date.fromYMD(year, 12, 1).millis())
            .set('image_count', yearlyS2.size());
    })
);

print('Annual NDVI + MNDWI collection:', annualIndexCollection);

var annualIndexList = annualIndexCollection.toList(annualIndexCollection.size());

// 43. CHECK SOURCE IMAGE COUNT EACH YEAR
var indexImageCounts = ee.FeatureCollection(
    annualIndexList.map(function (image) {
        image = ee.Image(image);
        return ee.Feature(null, {
            year: image.get('year'),
            image_count: image.get('image_count')
        });
    })
);

print('Sentinel-2 observations used per year:', indexImageCounts);

// ============================================================
// PART K: LONG-TERM TRAJECTORY AT SELECTED CANDIDATE POINT
// ============================================================

// 44. EXTRACT INDEX VALUES AT CANDIDATE POINT
var analysisScale = 20;

var candidateLongSeries = ee.FeatureCollection(
    annualIndexList.map(function (image) {
        image = ee.Image(image);
        var values = image.reduceRegion({
            reducer: ee.Reducer.mean(),
            geometry: candidatePoint,
            scale: analysisScale,
            bestEffort: true
        });

        return ee.Feature(null, values)
            .set('year', image.get('year'))
            .set('image_count', image.get('image_count'));
    })
);

print('Candidate-point NDVI + MNDWI — 2017–2025:', candidateLongSeries);

// 45. CANDIDATE-POINT LONG-TERM CHART
var candidateLongChart = ui.Chart.feature.byFeature(candidateLongSeries, 'year', ['NDVI', 'MNDWI'])
    .setChartType('LineChart')
    .setOptions({
        title: 'NDVI and MNDWI — Candidate Pixel (2017–2025)',
        hAxis: { title: 'Year' },
        vAxis: { title: 'Index Value', viewWindow: { min: -1, max: 1 } },
        lineWidth: 2,
        pointSize: 6
    });

print(candidateLongChart);

// ============================================================
// PART L: LONG-TERM TRAJECTORY ACROSS PERSISTENT CANDIDATE PATCHES
// ============================================================

// 46. EXTRACT PATCH-WIDE ANNUAL MEAN INDICES
var persistentLongSeries = ee.FeatureCollection(
    annualIndexList.map(function (image) {
        image = ee.Image(image);
        var stats = image.updateMask(persistentCandidate).reduceRegion({
            reducer: ee.Reducer.mean(),
            geometry: aoi,
            scale: analysisScale,
            maxPixels: 1e9,
            tileScale: 4
        });

        return ee.Feature(null, stats)
            .set('year', image.get('year'))
            .set('image_count', image.get('image_count'));
    })
);

print('Persistent-candidate NDVI + MNDWI — 2017–2025:', persistentLongSeries);

// 47. PATCH-WIDE LONG-TERM CHART
var persistentLongChart = ui.Chart.feature.byFeature(persistentLongSeries, 'year', ['NDVI', 'MNDWI'])
    .setChartType('LineChart')
    .setOptions({
        title: 'Mean NDVI and MNDWI — Persistent Candidate Pixels (2017–2025)',
        hAxis: { title: 'Year' },
        vAxis: { title: 'Mean Index Value', viewWindow: { min: -1, max: 1 } },
        lineWidth: 2,
        pointSize: 6
    });

print(persistentLongChart);

// 48. PRINT CLEAN VALUE LISTS
print('Candidate years:', candidateLongSeries.aggregate_array('year'));
print('Candidate NDVI:', candidateLongSeries.aggregate_array('NDVI'));
print('Candidate MNDWI:', candidateLongSeries.aggregate_array('MNDWI'));
print('Persistent patch years:', persistentLongSeries.aggregate_array('year'));
print('Persistent patch NDVI:', persistentLongSeries.aggregate_array('NDVI'));
print('Persistent patch MNDWI:', persistentLongSeries.aggregate_array('MNDWI'));

// ============================================================
// PART M: AREA QUANTIFICATION OF TREE-DECLINE CANDIDATES
// ============================================================

// 49. CREATE PIXEL-AREA IMAGE IN HECTARES
var pixelAreaHa = ee.Image.pixelArea().divide(10000).rename('area_ha');

// 50. HELPER FUNCTION: CALCULATE AREA UNDER A BOOLEAN MASK
var calculateAreaHa = function (maskImage) {
    var area = pixelAreaHa.updateMask(maskImage).reduceRegion({
        reducer: ee.Reducer.sum(),
        geometry: aoi,
        scale: 10,
        maxPixels: 1e9,
        tileScale: 4
    });
    return ee.Number(area.get('area_ha'));
};

// 51. TOTAL PROTECTED-AREA SIZE
var totalAOIAreaHa = ee.Number(aoi.area()).divide(10000);
print('Total Nijhum Dwip AOI area (ha):', totalAOIAreaHa);

// 52. 2017 HIGH-TREE BASELINE AREA
var baselineHighTreeAreaHa = calculateAreaHa(baselineForestMask);
print('2017 high-tree baseline area (ha):', baselineHighTreeAreaHa);

// 53. CANDIDATE TREE-DECLINE AREA
var candidateDeclineAreaHa = calculateAreaHa(candidateDisturbance);
print('Candidate tree-decline area (ha):', candidateDeclineAreaHa);

// 54. PERSISTENT TREE-DECLINE CANDIDATE AREA
var persistentDeclineAreaHa = calculateAreaHa(persistentCandidate);
print('Persistent tree-decline candidate area (ha):', persistentDeclineAreaHa);

// 55. CANDIDATE AREA AS % OF BASELINE HIGH-TREE AREA
var candidatePercentBaseline = candidateDeclineAreaHa.divide(baselineHighTreeAreaHa).multiply(100);
print('Candidate decline area (% of 2017 high-tree baseline):', candidatePercentBaseline);

// 56. PERSISTENT AREA AS % OF BASELINE HIGH-TREE AREA
var persistentPercentBaseline = persistentDeclineAreaHa.divide(baselineHighTreeAreaHa).multiply(100);
print('Persistent decline area (% of 2017 high-tree baseline):', persistentPercentBaseline);

// 57. PERSISTENT AREA AS % OF WHOLE PROTECTED AREA
var persistentPercentAOI = persistentDeclineAreaHa.divide(totalAOIAreaHa).multiply(100);
print('Persistent decline area (% of total AOI):', persistentPercentAOI);

// 58. CREATE ONE CLEAN SUMMARY TABLE
var areaSummary = ee.FeatureCollection([
    ee.Feature(null, {
        total_AOI_ha: totalAOIAreaHa,
        baseline_high_tree_2017_ha: baselineHighTreeAreaHa,
        candidate_tree_decline_ha: candidateDeclineAreaHa,
        persistent_tree_decline_ha: persistentDeclineAreaHa,
        candidate_pct_of_baseline: candidatePercentBaseline,
        persistent_pct_of_baseline: persistentPercentBaseline,
        persistent_pct_of_AOI: persistentPercentAOI
    })
]);

print('TREE-DECLINE AREA SUMMARY:', areaSummary);

// ============================================================
// PART N: YEAR-OF-MAXIMUM-TREE-DROP SUMMARY
// ============================================================

// 59. CREATE POST-BASELINE YEAR LIST
var changeYears = ee.List.sequence(2018, 2025);

// 60. CALCULATE AREA BY YEAR OF MAXIMUM TREE DROP
var yearOfMaxDropSummary = ee.FeatureCollection(
    changeYears.map(function (year) {
        year = ee.Number(year);
        var yearMask = maxDropYear.eq(year).and(persistentCandidate);

        var areaDict = pixelAreaHa.updateMask(yearMask).reduceRegion({
            reducer: ee.Reducer.sum(),
            geometry: aoi,
            scale: 10,
            maxPixels: 1e9,
            tileScale: 4
        });

        var areaHa = ee.Number(ee.Algorithms.If(areaDict.contains('area_ha'), areaDict.get('area_ha'), 0));
        var percentPersistent = areaHa.divide(persistentDeclineAreaHa).multiply(100);

        return ee.Feature(null, {
            year: year,
            area_ha: areaHa,
            pct_of_persistent_area: percentPersistent
        });
    })
);

print('YEAR OF MAXIMUM TREE DROP — AREA SUMMARY:', yearOfMaxDropSummary);

// 61. CLEAN YEAR LIST
print('Years:', yearOfMaxDropSummary.aggregate_array('year'));
print('Area by maximum-drop year (ha):', yearOfMaxDropSummary.aggregate_array('area_ha'));
print('% of persistent area by year:', yearOfMaxDropSummary.aggregate_array('pct_of_persistent_area'));

// 62. QC: SUM ALL YEAR-SPECIFIC AREAS
var summedYearAreaHa = ee.Number(yearOfMaxDropSummary.aggregate_sum('area_ha'));
print('Sum of year-specific persistent areas (ha):', summedYearAreaHa);
print('Previously calculated persistent area (ha):', persistentDeclineAreaHa);

// 63. DIFFERENCE FOR QC
var yearAreaDifference = summedYearAreaHa.subtract(persistentDeclineAreaHa);
print('QC difference (ha):', yearAreaDifference);

// 64. BAR CHART
var yearOfMaxDropChart = ui.Chart.feature.byFeature(yearOfMaxDropSummary, 'year', ['area_ha'])
    .setChartType('ColumnChart')
    .setOptions({
        title: 'Persistent Tree-Decline Area by Year of Maximum Drop',
        hAxis: { title: 'Year' },
        vAxis: { title: 'Area (ha)' },
        legend: { position: 'none' }
    });

print(yearOfMaxDropChart);

// ============================================================
// PART O: FIRST PERSISTENT TREE-DECLINE YEAR
// ============================================================

// 65. CONVERT EACH CONSECUTIVE PAIR INTO ITS START YEAR
var firstPersistentDeclineYearCollection = consecutivePairImages.map(function (image) {
    var startYear = ee.Number(image.get('start_year')).toInt();
    return ee.Image.constant(startYear)
        .rename('first_persistent_decline_year')
        .toInt16()
        .updateMask(image.eq(1))
        .updateMask(persistentCandidate);
});

// 66. FIND EARLIEST PERSISTENT-DECLINE ONSET
var firstPersistentDeclineYear = firstPersistentDeclineYearCollection.min()
    .rename('first_persistent_decline_year')
    .toInt16();

var firstDeclineYear = firstPersistentDeclineYear;

// 67. VISUALIZE FIRST PERSISTENT DECLINE YEAR
Map.addLayer(firstPersistentDeclineYear, {
    min: 2018, max: 2024,
    palette: ['blue', 'cyan', 'green', 'yellow', 'orange', 'red', 'magenta']
}, 'First Persistent Tree-Decline Year', true);

// 68. AREA SUMMARY USING ONE GROUPED REDUCTION
var firstPersistentAreaImage = pixelAreaHa.addBands(firstPersistentDeclineYear);

var firstPersistentGroupedResult = firstPersistentAreaImage.reduceRegion({
    reducer: ee.Reducer.sum().group({ groupField: 1, groupName: 'year' }),
    geometry: aoi,
    scale: 10,
    maxPixels: 1e9,
    tileScale: 4
});

// 69. CONVERT GROUPED RESULT TO TABLE
var firstPersistentGroups = ee.List(firstPersistentGroupedResult.get('groups'));

var firstPersistentDeclineSummary = ee.FeatureCollection(
    firstPersistentGroups.map(function (item) {
        item = ee.Dictionary(item);
        var year = ee.Number(item.get('year')).toInt();
        var areaHa = ee.Number(item.get('sum'));
        var percentage = areaHa.divide(persistentDeclineAreaHa).multiply(100);

        return ee.Feature(null, {
            year: year,
            area_ha: areaHa,
            pct_of_persistent_area: percentage
        });
    })
).sort('year');

print('FIRST PERSISTENT DECLINE YEAR — AREA SUMMARY:', firstPersistentDeclineSummary);

// 70. QC CHECK
var firstPersistentAreaTotal = ee.Number(firstPersistentDeclineSummary.aggregate_sum('area_ha'));
print('First-persistent-onset area total (ha):', firstPersistentAreaTotal);
print('Persistent candidate area (ha):', persistentDeclineAreaHa);
print('QC difference (ha):', firstPersistentAreaTotal.subtract(persistentDeclineAreaHa));

// 71. BAR CHART
var firstPersistentDeclineChart = ui.Chart.feature.byFeature(firstPersistentDeclineSummary, 'year', ['area_ha'])
    .setChartType('ColumnChart')
    .setOptions({
        title: 'Persistent Tree-Decline Area by First Persistent Decline Year',
        hAxis: { title: 'First Year of Consecutive Decline' },
        vAxis: { title: 'Area (ha)' },
        legend: { position: 'none' }
    });

print(firstPersistentDeclineChart);

// ============================================================
// PART O-B: MAXIMUM TREE DROP WITHIN THE PERSISTENT DECLINE EPISODE
// ============================================================

// A. MASK EACH ANNUAL DROP IMAGE TO YEARS AT OR AFTER PERSISTENT ONSET
var persistentEpisodeDrops = annualDrops.map(function (image) {
    var year = ee.Number(image.get('year'));
    var yearImage = ee.Image.constant(year).toInt16();
    var afterOnsetMask = yearImage.gte(firstPersistentDeclineYear);

    return image.updateMask(afterOnsetMask)
        .updateMask(persistentCandidate)
        .copyProperties(image, ['year', 'system:time_start']);
});

// B. FIND MAXIMUM TREE DROP WITHIN PERSISTENT EPISODE
var persistentEpisodeMaxComposite = persistentEpisodeDrops.qualityMosaic('tree_drop');

// C. MAXIMUM DROP MAGNITUDE
var persistentEpisodeMaxTreeDrop = persistentEpisodeMaxComposite.select('tree_drop')
    .rename('persistent_episode_max_tree_drop')
    .updateMask(persistentCandidate);

// D. YEAR OF MAXIMUM DROP WITHIN PERSISTENT EPISODE
var persistentEpisodeMaxDropYear = persistentEpisodeMaxComposite.select('drop_year')
    .rename('persistent_episode_max_drop_year')
    .toInt16()
    .updateMask(persistentCandidate);

// E. VISUALIZE
Map.addLayer(persistentEpisodeMaxDropYear, {
    min: 2018, max: 2025,
    palette: ['blue', 'cyan', 'green', 'yellow', 'orange', 'red', 'purple', 'magenta']
}, 'Maximum Drop Year — Persistent Episode', false);

// F. DIAGNOSTIC: AREA WHERE OLD MAXIMUM OCCURRED BEFORE PERSISTENT ONSET
var oldMaximumBeforePersistentOnset = maxDropYear.lt(firstPersistentDeclineYear).and(persistentCandidate);
var oldMaximumBeforeOnsetAreaHa = calculateAreaHa(oldMaximumBeforePersistentOnset);
print('Area where OLD maximum occurred before persistent onset (ha):', oldMaximumBeforeOnsetAreaHa);

// G. CHECK NEW LAG RANGE
var persistentEpisodeLagCheck = persistentEpisodeMaxDropYear.subtract(firstPersistentDeclineYear)
    .rename('persistent_episode_lag');

var lagCheckStats = persistentEpisodeLagCheck.reduceRegion({
    reducer: ee.Reducer.minMax(),
    geometry: aoi,
    scale: 10,
    maxPixels: 1e9,
    tileScale: 4
});

print('Persistent-episode lag min/max:', lagCheckStats);

// ============================================================
// PART P: ONSET-TO-MAXIMUM DECLINE LAG
// ============================================================

// 70. CALCULATE LAG IMAGE
var declineLagYears = persistentEpisodeMaxDropYear.subtract(firstPersistentDeclineYear)
    .rename('lag_years')
    .toInt16()
    .updateMask(persistentCandidate);

Map.addLayer(declineLagYears, {
    min: 0, max: 7,
    palette: ['red', 'orange', 'yellow', 'lightgreen', 'green', 'cyan', 'blue', 'purple']
}, 'Onset-to-Maximum Decline Lag', true);

// 71. CREATE LAG LIST
var lagValues = ee.List.sequence(0, 7);

// 72. AREA SUMMARY BY LAG
var lagSummary = ee.FeatureCollection(
    lagValues.map(function (lag) {
        lag = ee.Number(lag);
        var lagMask = declineLagYears.eq(lag);

        var areaDict = pixelAreaHa.updateMask(lagMask).reduceRegion({
            reducer: ee.Reducer.sum(),
            geometry: aoi,
            scale: 10,
            maxPixels: 1e9,
            tileScale: 4
        });

        var areaHa = ee.Number(ee.Algorithms.If(areaDict.contains('area_ha'), areaDict.get('area_ha'), 0));
        var percentPersistent = areaHa.divide(persistentDeclineAreaHa).multiply(100);

        return ee.Feature(null, {
            lag_years: lag,
            area_ha: areaHa,
            pct_of_persistent_area: percentPersistent
        });
    })
);

print('ONSET-TO-MAXIMUM LAG SUMMARY:', lagSummary);

// 73. QC CHECK
var lagAreaSum = ee.Number(lagSummary.aggregate_sum('area_ha'));
print('Sum of lag-class areas (ha):', lagAreaSum);
print('Persistent candidate area (ha):', persistentDeclineAreaHa);

// 74. BAR CHART
var lagChart = ui.Chart.feature.byFeature(lagSummary, 'lag_years', ['area_ha'])
    .setChartType('ColumnChart')
    .setOptions({
        title: 'Persistent Tree-Decline Area by Onset-to-Maximum Lag',
        hAxis: { title: 'Lag (years)' },
        vAxis: { title: 'Area (ha)' },
        legend: { position: 'none' }
    });

print(lagChart);

// ============================================================
// PART Q: OPERATIONAL DISTURBANCE-PROCESS CLASSES
// ============================================================

// 75. CREATE PROCESS-CLASS IMAGE
var processClass = ee.Image(0)
    .where(declineLagYears.eq(0), 1)
    .where(declineLagYears.eq(1), 2)
    .where(declineLagYears.gte(2).and(declineLagYears.lte(3)), 3)
    .where(declineLagYears.gte(4), 4)
    .rename('process_class')
    .updateMask(persistentCandidate)
    .toInt8();

Map.addLayer(processClass, {
    min: 1, max: 4,
    palette: ['red', 'orange', 'green', 'blue']
}, 'Decline Process Class', false);

// 76. PROCESS CLASS SUMMARY
var processCodes = ee.List.sequence(1, 4);
var processLabels = ee.List(['Abrupt', 'Rapid', 'Progressive', 'Prolonged progressive']);

var processSummary = ee.FeatureCollection(
    processCodes.map(function (code) {
        code = ee.Number(code).toInt();
        var classMask = processClass.eq(code);

        var areaDict = pixelAreaHa.updateMask(classMask).reduceRegion({
            reducer: ee.Reducer.sum(),
            geometry: aoi,
            scale: 10,
            maxPixels: 1e9,
            tileScale: 4
        });

        var areaHa = ee.Number(ee.Algorithms.If(areaDict.contains('area_ha'), areaDict.get('area_ha'), 0));
        var percentage = areaHa.divide(persistentDeclineAreaHa).multiply(100);
        var label = processLabels.get(code.subtract(1));

        return ee.Feature(null, {
            process_code: code,
            process: label,
            area_ha: areaHa,
            pct_of_persistent_area: percentage
        });
    })
);

print('DECLINE PROCESS SUMMARY:', processSummary);

var processAreaTotal = ee.Number(processSummary.aggregate_sum('area_ha'));
print('Process-area QC total (ha):', processAreaTotal);

// ============================================================
// PART R — OPTIMIZED: FIRST-DECLINE YEAR × MAXIMUM-DROP YEAR TRANSITION MATRIX
// ============================================================

// 77. CREATE TRANSITION-CODE IMAGE
var transitionCode = firstDeclineYear.toInt32().multiply(10000)
    .add(persistentEpisodeMaxDropYear.toInt32())
    .rename('transition_code')
    .updateMask(persistentCandidate);

// 78. COMBINE PIXEL AREA + TRANSITION CODE
var transitionAreaImage = pixelAreaHa.addBands(transitionCode);

// 79. ONE GROUPED AREA REDUCTION
var transitionGroupedResult = transitionAreaImage.reduceRegion({
    reducer: ee.Reducer.sum().group({ groupField: 1, groupName: 'transition_code' }),
    geometry: aoi,
    scale: 10,
    maxPixels: 1e9,
    tileScale: 4
});

// 80. CONVERT GROUPED RESULT TO FEATURE COLLECTION
var transitionGroups = ee.List(transitionGroupedResult.get('groups'));

var transitionSummary = ee.FeatureCollection(
    transitionGroups.map(function (item) {
        item = ee.Dictionary(item);
        var code = ee.Number(item.get('transition_code')).toInt();
        var firstYear = code.divide(10000).floor().toInt();
        var maxYear = code.mod(10000).toInt();
        var areaHa = ee.Number(item.get('sum'));
        var lagYears = maxYear.subtract(firstYear);
        var percentage = areaHa.divide(persistentDeclineAreaHa).multiply(100);

        return ee.Feature(null, {
            first_decline_year: firstYear,
            max_drop_year: maxYear,
            lag_years: lagYears,
            area_ha: areaHa,
            pct_of_persistent_area: percentage
        });
    })
);

print('NON-ZERO ONSET → MAXIMUM-DROP TRANSITIONS:', transitionSummary);

// 81. QC TOTAL
var transitionAreaTotal = ee.Number(transitionSummary.aggregate_sum('area_ha'));
print('Transition-matrix QC total (ha):', transitionAreaTotal);
print('Persistent candidate area (ha):', persistentDeclineAreaHa);

// 82. PIXELS REACHING MAXIMUM DECLINE IN 2025
var transitionsTo2025 = transitionSummary.filter(ee.Filter.eq('max_drop_year', 2025));
print('ONSET YEARS OF PIXELS WITH MAXIMUM DECLINE IN 2025:', transitionsTo2025);

// 83. STACKED TRANSITION CHART
var transitionChart = ui.Chart.feature.groups(
    transitionSummary, 'first_decline_year', 'area_ha', 'max_drop_year'
).setChartType('ColumnChart')
    .setOptions({
        title: 'Tree-Decline Pathways: First Decline → Maximum Decline',
        hAxis: { title: 'First Substantial Decline Year' },
        vAxis: { title: 'Area (ha)' },
        isStacked: true,
        legend: { position: 'right' }
    });

print(transitionChart);

// 84. ONSET YEARS FOR 2025-MAXIMUM PIXELS
var onsetTo2025Chart = ui.Chart.feature.byFeature(transitionsTo2025, 'first_decline_year', ['area_ha'])
    .setChartType('ColumnChart')
    .setOptions({
        title: 'Onset Years of Pixels Reaching Maximum Decline in 2025',
        hAxis: { title: 'First Substantial Decline Year' },
        vAxis: { title: 'Area (ha)' },
        legend: { position: 'none' }
    });

print(onsetTo2025Chart);

// ============================================================
// PART S: DROP-THRESHOLD SENSITIVITY ANALYSIS
// ============================================================

// 85. FUNCTION TO BUILD ONE THRESHOLD CASE
var buildSensitivityCase = function (threshold, tag) {
    var flags = annualDrops.map(function (image) {
        return image.select('tree_drop').gt(threshold)
            .rename('substantial_decline')
            .toByte()
            .set('year', image.get('year'));
    }).sort('year');

    var flagList = flags.toList(flags.size());

    var pairCollection = ee.ImageCollection.fromImages(
        ee.List.sequence(0, flags.size().subtract(2)).map(function (i) {
            i = ee.Number(i);
            var firstImage = ee.Image(flagList.get(i));
            var secondImage = ee.Image(flagList.get(i.add(1)));

            return firstImage.and(secondImage)
                .rename('consecutive_decline')
                .toByte()
                .set('start_year', firstImage.get('year'))
                .set('end_year', secondImage.get('year'));
        })
    );

    var persistent = pairCollection.max().eq(1)
        .and(baselineForestMask)
        .rename('persistent_' + tag);

    var onsetCollection = pairCollection.map(function (image) {
        var startYear = ee.Number(image.get('start_year')).toInt();
        return ee.Image.constant(startYear)
            .rename('persistent_onset')
            .toInt16()
            .updateMask(image.eq(1))
            .updateMask(persistent);
    });

    var onset = onsetCollection.min().rename('persistent_onset').toInt16();

    var episodeDrops = annualDrops.map(function (image) {
        var year = ee.Number(image.get('year'));
        var yearImage = ee.Image.constant(year).toInt16();
        var afterOnset = yearImage.gte(onset);

        return image.updateMask(afterOnset).updateMask(persistent);
    });

    var episodeMaxComposite = episodeDrops.qualityMosaic('tree_drop');

    var episodeMaxYear = episodeMaxComposite.select('drop_year')
        .rename('episode_max_year')
        .toInt16()
        .updateMask(persistent);

    var lag = episodeMaxYear.subtract(onset).rename('lag_years').toInt16().updateMask(persistent);
    var candidate = baselineForestMask.and(maxTreeDrop.gt(threshold));

    var lag2Plus = persistent.and(lag.gte(2));
    var maxIn2025 = persistent.and(episodeMaxYear.eq(2025));

    var areaBands = ee.Image.cat([
        pixelAreaHa.updateMask(candidate).rename(tag + '_candidate_ha'),
        pixelAreaHa.updateMask(persistent).rename(tag + '_persistent_ha'),
        pixelAreaHa.updateMask(lag2Plus).rename(tag + '_lag2plus_ha'),
        pixelAreaHa.updateMask(maxIn2025).rename(tag + '_max2025_ha')
    ]);

    return {
        areaBands: areaBands,
        persistent: persistent,
        onset: onset,
        episodeMaxYear: episodeMaxYear,
        lag: lag
    };
};

// 86. BUILD THREE THRESHOLD CASES
var sensitivity20 = buildSensitivityCase(0.20, 'T20');
var sensitivity25 = buildSensitivityCase(0.25, 'T25');
var sensitivity30 = buildSensitivityCase(0.30, 'T30');

// 87. COMBINE ALL AREA BANDS
var sensitivityAreaImage = ee.Image.cat([
    sensitivity20.areaBands,
    sensitivity25.areaBands,
    sensitivity30.areaBands
]);

// 88. ONE AREA REDUCTION FOR ALL THREE THRESHOLDS
var sensitivityAreaStats = sensitivityAreaImage.reduceRegion({
    reducer: ee.Reducer.sum(),
    geometry: aoi,
    scale: 10,
    maxPixels: 1e9,
    tileScale: 4
});

print('RAW THRESHOLD-SENSITIVITY AREA STATISTICS:', sensitivityAreaStats);

// 89. SAFE AREA-EXTRACTION HELPER
var getSensitivityArea = function (key) {
    return ee.Number(ee.Algorithms.If(sensitivityAreaStats.contains(key), sensitivityAreaStats.get(key), 0));
};

// 90. FUNCTION TO CREATE ONE SUMMARY ROW
var makeSensitivityRow = function (threshold, tag) {
    var candidateArea = getSensitivityArea(tag + '_candidate_ha');
    var persistentArea = getSensitivityArea(tag + '_persistent_ha');
    var lag2PlusArea = getSensitivityArea(tag + '_lag2plus_ha');
    var max2025Area = getSensitivityArea(tag + '_max2025_ha');

    var persistentPctBaseline = persistentArea.divide(baselineHighTreeAreaHa).multiply(100);
    var persistentPctCandidate = persistentArea.divide(candidateArea).multiply(100);
    var lag2PlusPct = lag2PlusArea.divide(persistentArea).multiply(100);
    var max2025Pct = max2025Area.divide(persistentArea).multiply(100);

    return ee.Feature(null, {
        drop_threshold: threshold,
        candidate_area_ha: candidateArea,
        persistent_area_ha: persistentArea,
        persistent_pct_of_baseline: persistentPctBaseline,
        persistent_pct_of_candidate: persistentPctCandidate,
        lag_2plus_area_ha: lag2PlusArea,
        lag_2plus_pct_of_persistent: lag2PlusPct,
        max_2025_area_ha: max2025Area,
        max_2025_pct_of_persistent: max2025Pct
    });
};

// 91. FINAL SENSITIVITY TABLE
var thresholdSensitivitySummary = ee.FeatureCollection([
    makeSensitivityRow(0.20, 'T20'),
    makeSensitivityRow(0.25, 'T25'),
    makeSensitivityRow(0.30, 'T30')
]);

print('DROP-THRESHOLD SENSITIVITY SUMMARY:', thresholdSensitivitySummary);

// 92. QC: DOES THE 0.25 CASE REPRODUCE THE MAIN ANALYSIS?
var sensitivityT25PersistentArea = getSensitivityArea('T25_persistent_ha');
print('QC — T25 persistent area (ha):', sensitivityT25PersistentArea);
print('QC — Main persistent area (ha):', persistentDeclineAreaHa);
print('QC — T25 minus main analysis (ha):', sensitivityT25PersistentArea.subtract(persistentDeclineAreaHa));

// 93. PERSISTENT AREA CHART
var sensitivityAreaChart = ui.Chart.feature.byFeature(thresholdSensitivitySummary, 'drop_threshold', ['persistent_area_ha'])
    .setChartType('ColumnChart')
    .setOptions({
        title: 'Sensitivity of Persistent Tree-Decline Area to Drop Threshold',
        hAxis: { title: 'Tree-Probability Drop Threshold' },
        vAxis: { title: 'Persistent Candidate Area (ha)' },
        legend: { position: 'none' }
    });

print(sensitivityAreaChart);

// ============================================================
// PART T: BASELINE TREE-THRESHOLD SENSITIVITY ANALYSIS
// ============================================================

// 94. FIX DROP THRESHOLD
var sensitivityDropThreshold = 0.25;

// 95. USE RAW MAXIMUM DROP WITHOUT THE ORIGINAL >0.60 MASK
var rawMaxTreeDrop = maxDropComposite.select('tree_drop').rename('raw_max_tree_drop');

// 96. CREATE DECLINE FLAGS ONCE
var baselineSensitivityFlags = annualDrops.map(function (image) {
    return image.select('tree_drop').gt(sensitivityDropThreshold)
        .rename('substantial_decline')
        .toByte()
        .set('year', image.get('year'));
}).sort('year');

var baselineSensitivityFlagList = baselineSensitivityFlags.toList(baselineSensitivityFlags.size());

// 97. CREATE CONSECUTIVE DECLINE PAIRS ONCE
var baselineSensitivityPairs = ee.ImageCollection.fromImages(
    ee.List.sequence(0, baselineSensitivityFlags.size().subtract(2)).map(function (i) {
        i = ee.Number(i);
        var firstImage = ee.Image(baselineSensitivityFlagList.get(i));
        var secondImage = ee.Image(baselineSensitivityFlagList.get(i.add(1)));

        return firstImage.and(secondImage)
            .rename('consecutive_decline')
            .toByte()
            .set('start_year', firstImage.get('year'))
            .set('end_year', secondImage.get('year'));
    })
);

// 98. FUNCTION TO BUILD ONE BASELINE-THRESHOLD CASE
var buildBaselineSensitivityCase = function (treeThreshold, tag) {
    var baselineMask = baselineTree.gt(treeThreshold).rename('baseline_' + tag);
    var candidate = baselineMask.and(rawMaxTreeDrop.gt(sensitivityDropThreshold));

    var persistent = baselineSensitivityPairs.max().eq(1)
        .and(baselineMask)
        .rename('persistent_' + tag);

    var onsetCollection = baselineSensitivityPairs.map(function (image) {
        var startYear = ee.Number(image.get('start_year')).toInt();
        return ee.Image.constant(startYear)
            .rename('persistent_onset')
            .toInt16()
            .updateMask(image.eq(1))
            .updateMask(persistent);
    });

    var onset = onsetCollection.min().rename('persistent_onset').toInt16();

    var episodeDrops = annualDrops.map(function (image) {
        var year = ee.Number(image.get('year'));
        var yearImage = ee.Image.constant(year).toInt16();
        var afterOnset = yearImage.gte(onset);

        return image.updateMask(afterOnset).updateMask(persistent);
    });

    var episodeMaxComposite = episodeDrops.qualityMosaic('tree_drop');

    var episodeMaxYear = episodeMaxComposite.select('drop_year')
        .rename('episode_max_year')
        .toInt16()
        .updateMask(persistent);

    var lag = episodeMaxYear.subtract(onset).rename('lag_years').toInt16().updateMask(persistent);

    var lag2Plus = persistent.and(lag.gte(2));
    var maxIn2025 = persistent.and(episodeMaxYear.eq(2025));

    var areaBands = ee.Image.cat([
        pixelAreaHa.updateMask(baselineMask).rename(tag + '_baseline_ha'),
        pixelAreaHa.updateMask(candidate).rename(tag + '_candidate_ha'),
        pixelAreaHa.updateMask(persistent).rename(tag + '_persistent_ha'),
        pixelAreaHa.updateMask(lag2Plus).rename(tag + '_lag2plus_ha'),
        pixelAreaHa.updateMask(maxIn2025).rename(tag + '_max2025_ha')
    ]);

    return {
        areaBands: areaBands,
        baselineMask: baselineMask,
        persistent: persistent,
        onset: onset,
        episodeMaxYear: episodeMaxYear,
        lag: lag
    };
};

// 99. BUILD THREE BASELINE CASES
var baseline55 = buildBaselineSensitivityCase(0.55, 'B55');
var baseline60 = buildBaselineSensitivityCase(0.60, 'B60');
var baseline65 = buildBaselineSensitivityCase(0.65, 'B65');

// 100. COMBINE ALL AREA BANDS
var baselineSensitivityAreaImage = ee.Image.cat([
    baseline55.areaBands,
    baseline60.areaBands,
    baseline65.areaBands
]);

// 101. ONE REDUCTION FOR ALL THREE CASES
var baselineSensitivityStats = baselineSensitivityAreaImage.reduceRegion({
    reducer: ee.Reducer.sum(),
    geometry: aoi,
    scale: 10,
    maxPixels: 1e9,
    tileScale: 4
});

print('RAW BASELINE-THRESHOLD SENSITIVITY STATISTICS:', baselineSensitivityStats);

// 102. SAFE AREA HELPER
var getBaselineSensitivityArea = function (key) {
    return ee.Number(ee.Algorithms.If(baselineSensitivityStats.contains(key), baselineSensitivityStats.get(key), 0));
};

// 103. CREATE ONE SUMMARY ROW
var makeBaselineSensitivityRow = function (treeThreshold, tag) {
    var baselineArea = getBaselineSensitivityArea(tag + '_baseline_ha');
    var candidateArea = getBaselineSensitivityArea(tag + '_candidate_ha');
    var persistentArea = getBaselineSensitivityArea(tag + '_persistent_ha');
    var lag2PlusArea = getBaselineSensitivityArea(tag + '_lag2plus_ha');
    var max2025Area = getBaselineSensitivityArea(tag + '_max2025_ha');

    return ee.Feature(null, {
        baseline_tree_threshold: treeThreshold,
        baseline_area_ha: baselineArea,
        candidate_area_ha: candidateArea,
        persistent_area_ha: persistentArea,
        persistent_pct_of_baseline: persistentArea.divide(baselineArea).multiply(100),
        persistent_pct_of_candidate: persistentArea.divide(candidateArea).multiply(100),
        lag_2plus_area_ha: lag2PlusArea,
        lag_2plus_pct_of_persistent: lag2PlusArea.divide(persistentArea).multiply(100),
        max_2025_area_ha: max2025Area,
        max_2025_pct_of_persistent: max2025Area.divide(persistentArea).multiply(100)
    });
};

// 104. FINAL BASELINE-SENSITIVITY TABLE
var baselineThresholdSensitivitySummary = ee.FeatureCollection([
    makeBaselineSensitivityRow(0.55, 'B55'),
    makeBaselineSensitivityRow(0.60, 'B60'),
    makeBaselineSensitivityRow(0.65, 'B65')
]);

print('BASELINE TREE-THRESHOLD SENSITIVITY SUMMARY:', baselineThresholdSensitivitySummary);

// 105. MAIN-ANALYSIS QC
var baseline60PersistentArea = getBaselineSensitivityArea('B60_persistent_ha');
print('QC — B60 persistent area (ha):', baseline60PersistentArea);
print('QC — Main persistent area (ha):', persistentDeclineAreaHa);
print('QC — B60 minus main analysis (ha):', baseline60PersistentArea.subtract(persistentDeclineAreaHa));

// 106. PERSISTENT-AREA CHART
var baselineSensitivityChart = ui.Chart.feature.byFeature(
    baselineThresholdSensitivitySummary, 'baseline_tree_threshold', ['persistent_area_ha']
).setChartType('ColumnChart')
    .setOptions({
        title: 'Sensitivity of Persistent Tree-Decline Area to 2017 Baseline Threshold',
        hAxis: { title: '2017 Tree-Probability Threshold' },
        vAxis: { title: 'Persistent Candidate Area (ha)' },
        legend: { position: 'none' }
    });

print(baselineSensitivityChart);



// ====== Presentation Map Preparation ============
// AOI boundary outline
var aoiOutline = ee.Image().byte().paint({
    featureCollection: nijhum,
    color: 1,
    width: 2
});


var whiteBg = ee.Image.constant(1).visualize({
    min: 0,
    max: 1,
    palette: ['ffffff']
});


// Map 01: 2017 High-Tree baseline
var map01 = ee.ImageCollection([
    whiteBg,
    baselineForestMask.selfMask().visualize({
        palette: ['1b7837']   // dark green
    }),
    aoiOutline.visualize({
        palette: ['000000']   // black boundary
    })
]).mosaic();

Map.addLayer(map01, {}, 'Map01_Baseline_2017');


// Map 01 export

Export.image.toDrive({
    image: map01,
    description: 'Map01_Baseline_2017_HighTree',
    folder: 'GEE_Exports',
    fileNamePrefix: 'Map01_Baseline_2017_HighTree',
    region: aoi.bounds(),
    scale: 10,
    maxPixels: 1e13
});


// Map 02: Persistent tree-decline candidates
var map02 = ee.ImageCollection([
    whiteBg,
    persistentCandidate.selfMask().visualize({
        palette: ['d73027']   // red
    }),
    aoiOutline.visualize({
        palette: ['000000']
    })
]).mosaic();

Map.addLayer(map02, {}, 'Map02_Persistent_Decline');


Export.image.toDrive({
    image: map02,
    description: 'Map02_Persistent_Decline_Candidates',
    folder: 'GEE_Exports',
    fileNamePrefix: 'Map02_Persistent_Decline_Candidates',
    region: aoi.bounds(),
    scale: 10,
    maxPixels: 1e13
});

