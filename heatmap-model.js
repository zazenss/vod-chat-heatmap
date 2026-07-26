(function attachHeatmapModel(globalScope) {
  "use strict";
  function clamp(value, minimum, maximum) { return Math.min(maximum, Math.max(minimum, value)); }
  function smooth(points, radius) {
    if (!Array.isArray(points) || points.length === 0) return [];
    return points.map((_, index) => {
      let weightedTotal = 0;
      let totalWeight = 0;
      for (let offset = -radius; offset <= radius; offset += 1) {
        const sourceIndex = clamp(index + offset, 0, points.length - 1);
        const weight = radius + 1 - Math.abs(offset);
        weightedTotal += points[sourceIndex] * weight;
        totalWeight += weight;
      }
      return weightedTotal / totalWeight;
    });
  }
  function normalize(points) {
    if (!Array.isArray(points) || points.length === 0) return [];
    const sorted = [...points].sort((left, right) => left - right);
    const low = sorted[Math.floor((sorted.length - 1) * 0.05)];
    const high = sorted[Math.floor((sorted.length - 1) * 0.98)];
    const range = Math.max(high - low, 0.0001);
    return points.map((point) => clamp((point - low) / range, 0.025, 1));
  }
  function createSampleOffsets(durationSeconds, maximumSamples, minimumInterval) {
    const duration = Math.max(1, Number(durationSeconds) || 1);
    const maxSamples = Math.max(10, Number(maximumSamples) || 480);
    const minInterval = Math.max(5, Number(minimumInterval) || 10);
    const interval = Math.max(minInterval, duration / maxSamples);
    const offsets = [];
    for (let offset = 0; offset < duration; offset += interval) offsets.push(Math.floor(offset));
    const finalOffset = Math.max(0, Math.floor(duration - 1));
    if (offsets[offsets.length - 1] !== finalOffset) offsets.push(finalOffset);
    return [...new Set(offsets)];
  }
  function estimateRate(timestamps) {
    const clean = (timestamps || []).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
    if (clean.length < 2) return 0;
    const span = Math.max(0.25, clean[clean.length - 1] - clean[0]);
    return (clean.length - 1) / span;
  }
  function buildSmoothedRates(samples) {
    const ordered = [...(samples || [])].sort((left, right) => left.offset - right.offset);
    const loggedRates = ordered.map((sample, index) => {
      const previousInterval = index > 0 ? sample.offset - ordered[index - 1].offset : 10;
      const windowEnd = ordered[index + 1]?.offset ?? sample.offset + Math.max(5, previousInterval);
      const localTimestamps = (sample.timestamps || []).filter((timestamp) => timestamp >= sample.offset - 1 && timestamp < windowEnd);
      const interval = Math.max(1, windowEnd - sample.offset);
      const rate = localTimestamps.length < 2 ? localTimestamps.length / interval : estimateRate(localTimestamps);
      return Math.log1p(rate);
    });
    return smooth(loggedRates, 2);
  }
  function findTopPeaks(values, count, minimumDistance) {
    const safeCount = Math.max(0, Number(count) || 0);
    if (!Array.isArray(values) || values.length === 0 || safeCount === 0) return [];
    const distance = Math.max(1, Number(minimumDistance) || Math.round(values.length * 0.015));
    const candidates = values
      .map((value, index) => ({ index, value }))
      .filter((candidate) => {
        const left = values[Math.max(0, candidate.index - 1)];
        const right = values[Math.min(values.length - 1, candidate.index + 1)];
        return candidate.value >= left && candidate.value >= right;
      })
      .sort((left, right) => right.value - left.value || left.index - right.index);
    const selected = [];
    for (const candidate of candidates) {
      if (selected.every((peak) => Math.abs(peak.index - candidate.index) >= distance)) selected.push(candidate);
      if (selected.length === safeCount) break;
    }
    return selected.map((peak, index) => ({ ...peak, rank: index + 1 }));
  }
  function rateSamplesToHeatmap(samples) {
    const ordered = [...(samples || [])].sort((left, right) => left.offset - right.offset);
    const smoothedRates = buildSmoothedRates(ordered);
    const peaks = findTopPeaks(smoothedRates, 10, Math.max(4, Math.round(smoothedRates.length * 0.015)))
      .map((peak) => ({ ...peak, timeSeconds: Number(ordered[peak.index]?.offset) || 0 }));
    return { series: normalize(smoothedRates), peaks };
  }
  function rateSamplesToSeries(samples) { return rateSamplesToHeatmap(samples).series; }
  const api = { createSampleOffsets, estimateRate, findTopPeaks, normalize, rateSamplesToHeatmap, rateSamplesToSeries, smooth };
  globalScope.TwitchChatHeatmapModel = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);




