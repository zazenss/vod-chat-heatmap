"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const model = require("../heatmap-model.js");

test("sample offsets cover the full VOD without excessive requests", () => {
  const offsets = model.createSampleOffsets(14400, 480, 10);
  assert.equal(offsets[0], 0);
  assert.equal(offsets.at(-1), 14399);
  assert.ok(offsets.length <= 482);
});

test("chat rate uses message density within the replay window", () => {
  assert.equal(model.estimateRate([10, 11, 12, 13]), 1);
  assert.equal(model.estimateRate([]), 0);
  assert.ok(model.estimateRate([10, 10.1, 10.2, 10.3]) > 5);
});

test("top peaks are ranked and kept a minimum distance apart", () => {
  const peaks = model.findTopPeaks([0, 9, 8, 7, 8, 10, 7, 1, 6, 1], 3, 3);
  assert.deepEqual(peaks.map((peak) => peak.index), [5, 1, 8]);
  assert.deepEqual(peaks.map((peak) => peak.rank), [1, 2, 3]);
});

test("heatmap exposes ten distinct ranked moments", () => {
  const samples = Array.from({ length: 120 }, (_, index) => ({ offset: index * 20, timestamps: [index * 20, index * 20 + 8] }));
  const spikeIndexes = [5, 16, 27, 38, 49, 60, 71, 82, 93, 104];
  spikeIndexes.forEach((index, rankIndex) => {
    const spacing = 0.08 + rankIndex * 0.015;
    samples[index].timestamps = [samples[index].offset, samples[index].offset + spacing, samples[index].offset + spacing * 2];
  });
  const heatmap = model.rateSamplesToHeatmap(samples);
  assert.equal(heatmap.series.length, samples.length);
  assert.equal(heatmap.peaks.length, 10);
  assert.deepEqual(heatmap.peaks.map((peak) => peak.rank), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.ok(heatmap.peaks.every((peak) => Number.isFinite(peak.timeSeconds)));
  assert.ok(heatmap.peaks.every((peak, index, peaks) => peaks.slice(index + 1).every((other) => Math.abs(other.index - peak.index) >= 4)));
});
test("messages beyond a sample window do not bleed backward", () => {
  const samples = [
    { offset: 0, timestamps: [55, 55.1, 55.2] }, { offset: 20, timestamps: [] },
    { offset: 40, timestamps: [40, 40.1, 40.2] }, { offset: 60, timestamps: [] },
    { offset: 80, timestamps: [] }, { offset: 100, timestamps: [] }
  ];
  const series = model.rateSamplesToSeries(samples);
  assert.ok(series[2] > series[0]);
});




