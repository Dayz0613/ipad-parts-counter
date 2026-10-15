/* 端末内の二値画像処理。外部ライブラリ・通信は使いません。 */
self.addEventListener('message', (event) => {
  const { pixels, width, height, settings, jobId } = event.data;
  try {
    const result = detect(new Uint8ClampedArray(pixels), width, height, settings);
    self.postMessage({ jobId, result }, [result.binaryMask.buffer, result.areaFilteredMask.buffer]);
  } catch (error) {
    self.postMessage({ jobId, error: String(error && error.message || error) });
  }
});

function detect(rgba, width, height, settings) {
  const length = width * height;
  const gray = new Uint8Array(length);
  const histogram = new Uint32Array(256);
  for (let p = 0, i = 0; i < length; i++, p += 4) {
    const y = (rgba[p] * 77 + rgba[p + 1] * 150 + rgba[p + 2] * 29) >> 8;
    gray[i] = y;
    histogram[y]++;
  }
  const baseThreshold = otsuThreshold(histogram, length);
  const reference = settings.reference && settings.reference.area > 0 ? settings.reference : null;
  const requestedWidth = Math.max(3, Number(settings.targetWidth) || Math.min(width, height) * 0.028);
  const targetWidth = reference ? Math.max(3, Number(reference.diameter) || 2 * Math.sqrt(reference.area / Math.PI)) : requestedWidth;
  const automatic = !!settings.autoThreshold && !reference;
  const offset = automatic ? 0 : Number(settings.thresholdOffset || 0);
  let threshold = Math.max(0, Math.min(255, baseThreshold + offset));
  let polarity = reference ? reference.polarity : settings.polarity;
  if (automatic) {
    // The image border is usually tray/background, so use its median brightness
    // to decide which side of the threshold represents the parts. This avoids
    // selecting a visually inverted mask just because it creates more blobs.
    const backgroundLevel = borderMedian(gray, width, height);
    const expectedPolarity = backgroundLevel > baseThreshold ? 'dark' : 'bright';
    const optimized = optimizeThreshold(gray, width, height, Number(settings.minArea) || 40, baseThreshold, targetWidth, expectedPolarity);
    threshold = optimized.threshold;
    polarity = optimized.polarity;
  } else if (polarity === 'auto') {
    let darkCount = 0;
    for (let i = 0; i < length; i++) if (gray[i] <= threshold) darkCount++;
    const darkRatio = darkCount / length;
    const brightRatio = 1 - darkRatio;
    polarity = occupancyScore(darkRatio) < occupancyScore(brightRatio) ? 'dark' : 'bright';
  }

  const contrast = reference ? Math.max(7, Math.min(160, Math.abs(reference.meanBackground - reference.meanObject))) : 0;
  const localRadius = reference ? Math.max(6, Math.min(100, Math.round(targetWidth * 1.45))) : 0;
  const integral = reference ? grayscaleIntegral(gray, width, height) : null;
  if (reference) threshold = Math.max(0, Math.min(255, Math.round((reference.meanObject + reference.meanBackground) / 2 + offset)));

  const thresholdMask = new Uint8Array(length);
  let thresholdForeground = 0;
  const darkParts = polarity === 'dark';
  for (let i = 0; i < length; i++) {
    let pixelThreshold = threshold;
    if (reference) {
      const x = i % width;
      const y = (i / width) | 0;
      const localMean = localMeanAt(integral, width, height, x, y, localRadius);
      pixelThreshold = Math.max(0, Math.min(255, localMean + (darkParts ? -1 : 1) * contrast * 0.38 + offset));
    }
    const on = darkParts ? gray[i] <= pixelThreshold : gray[i] > pixelThreshold;
    if (on) { thresholdMask[i] = 1; thresholdForeground++; }
  }

  // Automatically infer the closing radius from the estimated part width.
  const minArea = Math.max(1, Number(settings.minArea) || 12);
  const closing = selectClosing(thresholdMask, width, height, targetWidth);
  // Fill enclosed background pockets so the part interior becomes one solid
  // foreground region after closing has sealed narrow openings.
  const filledMask = fillEnclosedHoles(closing.mask, width, height);
  // Remove isolated one-pixel responses after filling; the configurable minimum
  // area below removes larger speckle clusters.
  const mask = removeIsolatedPixels(filledMask, width, height);
  let foreground = 0;
  for (let i = 0; i < length; i++) if (mask[i]) foreground++;

  const labels = new Int32Array(length);
  const queue = new Int32Array(length);
  const areaFilteredMask = new Uint8Array(length);
  const components = [null];
  let nextLabel = 1;
  let rawComponentCount = 0;
  let filteredComponentCount = 0;
  let rejectedSmallComponentCount = 0;
  for (let start = 0; start < length; start++) {
    if (!mask[start] || labels[start]) continue;
    rawComponentCount++;
    const label = nextLabel++;
    labels[start] = label;
    queue[0] = start;
    let head = 0;
    let tail = 1;
    let sumX = 0;
    let sumY = 0;
    let sumXX = 0;
    let sumYY = 0;
    let sumXY = 0;
    let sumGray = 0;
    let minX = width;
    let minY = height;
    let maxX = 0;
    let maxY = 0;
    while (head < tail) {
      const index = queue[head++];
      const x = index % width;
      const y = (index / width) | 0;
      sumX += x;
      sumY += y;
      sumXX += x * x;
      sumYY += y * y;
      sumXY += x * y;
      sumGray += gray[index];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          const neighbor = ny * width + nx;
          if (mask[neighbor] && labels[neighbor] === 0) {
            labels[neighbor] = label;
            queue[tail++] = neighbor;
          }
        }
      }
    }
    if (tail < minArea) {
      rejectedSmallComponentCount++;
      components.push(null);
      continue;
    }
    filteredComponentCount++;
    for (let i = 0; i < tail; i++) areaFilteredMask[queue[i]] = 1;
    components.push({
      label,
      area: tail,
      cx: sumX / tail,
      cy: sumY / tail,
      sumXX,
      sumYY,
      sumXY,
      meanObject: sumGray / tail,
      minX, minY, maxX, maxY,
      peaks: []
    });
  }

  for (let label = 1; label < components.length; label++) {
    const component = components[label];
    if (!component) continue;
    const varianceX = Math.max(0, component.sumXX / component.area - component.cx * component.cx);
    const varianceY = Math.max(0, component.sumYY / component.area - component.cy * component.cy);
    const covariance = component.sumXY / component.area - component.cx * component.cy;
    const root = Math.sqrt(Math.max(0, (varianceX - varianceY) ** 2 + 4 * covariance * covariance));
    const eigenMajor = Math.max(0.01, (varianceX + varianceY + root) / 2);
    const eigenMinor = Math.max(0.01, (varianceX + varianceY - root) / 2);
    component.angle = Math.atan2(2 * covariance, varianceX - varianceY) * 90 / Math.PI;
    component.aspect = Math.sqrt(eigenMajor / eigenMinor);
    component.majorAxis = 4 * Math.sqrt(eigenMajor);
    component.minorAxis = 4 * Math.sqrt(eigenMinor);
    const pad = Math.max(3, Math.round(targetWidth * 0.28));
    const left = Math.max(0, component.minX - pad);
    const right = Math.min(width - 1, component.maxX + pad);
    const top = Math.max(0, component.minY - pad);
    const bottom = Math.min(height - 1, component.maxY + pad);
    let backgroundSum = 0;
    let backgroundCount = 0;
    for (let y = top; y <= bottom; y++) {
      for (let x = left; x <= right; x++) {
        if (x >= component.minX && x <= component.maxX && y >= component.minY && y <= component.maxY) continue;
        backgroundSum += gray[y * width + x];
        backgroundCount++;
      }
    }
    component.meanBackground = backgroundCount ? backgroundSum / backgroundCount : null;
  }

  const distance = new Uint16Array(length);
  const infinity = 30000;
  for (let i = 0; i < length; i++) distance[i] = mask[i] ? infinity : 0;

  // 3/4 chamfer distance transform: a compact approximation to pixel distance.
  for (let y = 0; y < height; y++) {
    let row = y * width;
    for (let x = 0; x < width; x++) {
      const i = row + x;
      if (!mask[i]) continue;
      let d = distance[i];
      if (x > 0) d = Math.min(d, distance[i - 1] + 3);
      if (y > 0) {
        if (x > 0) d = Math.min(d, distance[i - width - 1] + 4);
        d = Math.min(d, distance[i - width] + 3);
        if (x + 1 < width) d = Math.min(d, distance[i - width + 1] + 4);
      }
      distance[i] = d;
    }
  }
  for (let y = height - 1; y >= 0; y--) {
    let row = y * width;
    for (let x = width - 1; x >= 0; x--) {
      const i = row + x;
      if (!mask[i]) continue;
      let d = distance[i];
      if (x + 1 < width) d = Math.min(d, distance[i + 1] + 3);
      if (y + 1 < height) {
        if (x > 0) d = Math.min(d, distance[i + width - 1] + 4);
        d = Math.min(d, distance[i + width] + 3);
        if (x + 1 < width) d = Math.min(d, distance[i + width + 1] + 4);
      }
      distance[i] = d;
    }
  }

  const minPeakDistance = Math.max(1.1, targetWidth * 0.18) * 3;
  const candidates = [];
  let candidateLimitReached = false;
  for (let y = 1; y < height - 1; y++) {
    const row = y * width;
    for (let x = 1; x < width - 1; x++) {
      const i = row + x;
      const label = labels[i];
      if (!label || !components[label] || components[label].area < minArea) continue;
      const d = distance[i];
      if (d < minPeakDistance) continue;
      let isMaximum = true;
      let hasLower = false;
      for (let dy = -1; dy <= 1; dy++) {
        const nrow = i + dy * width;
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const neighborDistance = distance[nrow + dx];
          if (neighborDistance > d) isMaximum = false;
          if (neighborDistance < d) hasLower = true;
        }
      }
      if (isMaximum && hasLower) {
        if (candidates.length < 50000) candidates.push({ x, y, label, distance: d });
        else candidateLimitReached = true;
      }
    }
  }
  candidates.sort((a, b) => b.distance - a.distance);

  const buckets = new Map();
  const minSeparation = Math.max(4, targetWidth * 0.68);
  const minSeparationSquared = minSeparation * minSeparation;
  for (const candidate of candidates) {
    const component = components[candidate.label];
    if (!component || component.area < minArea) continue;
    const maximumPerComponent = reference
      ? Math.max(1, Math.ceil(component.area / (reference.area * 1.12)))
      : Math.max(1, Math.ceil(component.area / (targetWidth * targetWidth * 0.22)));
    const cellX = Math.floor(candidate.x / minSeparation);
    const cellY = Math.floor(candidate.y / minSeparation);
    let crowded = false;
    for (let oy = -1; oy <= 1 && !crowded; oy++) {
      for (let ox = -1; ox <= 1 && !crowded; ox++) {
        const near = buckets.get(`${candidate.label}:${cellX + ox}:${cellY + oy}`);
        if (!near) continue;
        for (const point of near) {
          const dx = point.x - candidate.x;
          const dy = point.y - candidate.y;
          if (dx * dx + dy * dy < minSeparationSquared) { crowded = true; break; }
        }
      }
    }
    if (crowded || component.peaks.length >= maximumPerComponent) continue;
    component.peaks.push({ x: candidate.x, y: candidate.y, radius: candidate.distance / 3 });
    const key = `${candidate.label}:${cellX}:${cellY}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push({ x: candidate.x, y: candidate.y });
  }

  const detections = [];
  let warningCount = 0;
  const expectedArea = Math.max(9, reference ? reference.area : targetWidth * targetWidth * 0.9);
  const componentSummaries = [];
  for (let label = 1; label < components.length; label++) {
    const component = components[label];
    if (!component) continue;
    if (component.area < minArea) continue;
    if (!component.peaks.length && component.area <= expectedArea * 2.8) {
      component.peaks.push({ x: component.cx, y: component.cy, radius: Math.sqrt(component.area / Math.PI) });
    }
    // First-pass output: one centroid per surviving connected region. Local
    // distance peaks are diagnostics only; screw threads can create many peaks
    // inside one physical screw and must not be counted as separate parts.
    const perItemArea = component.area;
    const unusualArea = component.area > expectedArea * (reference ? 1.75 : 2.3);
    const joined = component.area > expectedArea * 2.3;
    const relativeArea = perItemArea / expectedArea;
    const shapeRatio = reference ? component.aspect / Math.max(0.15, reference.aspect) : 1;
    const shapeMismatch = !!reference && (shapeRatio < 0.52 || shapeRatio > 1.9);
    if (joined || unusualArea || (reference && (relativeArea < 0.42 || relativeArea > 1.9 || shapeMismatch))) warningCount++;
    componentSummaries.push({
      label,
      area: component.area,
      cx: component.cx,
      cy: component.cy,
      angle: component.angle,
      aspect: component.aspect,
      majorAxis: component.majorAxis,
      minorAxis: component.minorAxis,
      meanObject: component.meanObject,
      meanBackground: component.meanBackground,
      peakCount: 1,
      localPeakCount: component.peaks.length
    });
    detections.push({
      x: component.cx,
      y: component.cy,
      label,
      area: component.area,
      angle: component.angle,
      aspect: component.aspect,
      uncertain: joined || unusualArea || (reference && (relativeArea < 0.42 || relativeArea > 1.9 || shapeMismatch))
    });
  }

  return {
    detections,
    threshold,
    polarity,
    autoThresholdUsed: automatic,
    foregroundRatio: foreground / length,
    componentCount: filteredComponentCount,
    rawComponentCount,
    rejectedSmallComponentCount,
    removedNoisePixels: thresholdForeground - foreground,
    minArea,
    warningCount,
    components: componentSummaries,
    candidateLimitReached,
    width,
    height,
    binaryMask: thresholdMask,
    areaFilteredMask,
    closingRadius: closing.radius,
    closingFilledPixels: closing.filledPixels + countForeground(filledMask) - countForeground(closing.mask),
    targetWidth,
    referenceUsed: reference ? { area: reference.area } : null,
    localThreshold: !!reference
  };
}

// Morphological closing (dilation followed by erosion) seals narrow gaps in a
// part's binary silhouette. Kernel size is inferred from the estimated part
// width, and enclosed background pockets are filled afterward.
function selectClosing(source, width, height, targetWidth) {
  const baseline = removeIsolatedPixels(source, width, height);
  const baselineForeground = countForeground(baseline);
  const maxRadius = Math.max(1, Math.min(50, Math.ceil(Math.max(3, targetWidth) * 6)));
  let best = { mask: baseline, radius: 0, filledPixels: 0 };
  const radii = [2, 4, 8, 16, 24, 32, 40, maxRadius].filter((radius, index, all) => radius <= maxRadius && all.indexOf(radius) === index);
  for (const radius of radii) {
    const candidate = removeIsolatedPixels(closeMask(source, width, height, radius), width, height);
    const added = countForeground(candidate) - baselineForeground;
    const growth = added / Math.max(1, baselineForeground);
    // Use the largest inferred radius that keeps the total foreground growth
    // bounded. Joining nearby regions is allowed for the requested fill effect.
    if (growth > 2) break;
    if (added > 0) best = { mask: candidate, radius, filledPixels: added };
  }
  return best;
}

function countForeground(mask) {
  let total = 0;
  for (let i = 0; i < mask.length; i++) total += mask[i];
  return total;
}

function fillEnclosedHoles(mask, width, height) {
  const outside = new Uint8Array(mask.length);
  const queue = new Int32Array(mask.length);
  let head = 0, tail = 0;
  const add = (index) => {
    if (!mask[index] && !outside[index]) {
      outside[index] = 1;
      queue[tail++] = index;
    }
  };
  for (let x = 0; x < width; x++) { add(x); add((height - 1) * width + x); }
  for (let y = 0; y < height; y++) { add(y * width); add(y * width + width - 1); }
  while (head < tail) {
    const index = queue[head++];
    const x = index % width, y = (index / width) | 0;
    for (let dy = -1; dy <= 1; dy++) {
      const ny = y + dy;
      if (ny < 0 || ny >= height) continue;
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx;
        if (nx >= 0 && nx < width) add(ny * width + nx);
      }
    }
  }
  const filled = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) filled[i] = mask[i] || !outside[i] ? 1 : 0;
  return filled;
}

function closeMask(source, width, height, radius) {
  const length = width * height;
  const dilated = new Uint8Array(length);
  const closed = new Uint8Array(length);
  const horizontal = new Uint8Array(length);
  // Rectangular kernels are separable. Sliding sums keep this linear in image
  // size, which matters on older iPads even when the inferred radius is larger.
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let sum = 0;
    for (let xx = 0; xx <= Math.min(radius, width - 1); xx++) sum += source[row + xx];
    for (let x = 0; x < width; x++) {
      horizontal[row + x] = sum > 0 ? 1 : 0;
      const removeX = x - radius;
      const addX = x + radius + 1;
      if (removeX >= 0) sum -= source[row + removeX];
      if (addX < width) sum += source[row + addX];
    }
  }
  for (let x = 0; x < width; x++) {
    let sum = 0;
    for (let yy = 0; yy <= Math.min(radius, height - 1); yy++) sum += horizontal[yy * width + x];
    for (let y = 0; y < height; y++) {
      dilated[y * width + x] = sum > 0 ? 1 : 0;
      const removeY = y - radius;
      const addY = y + radius + 1;
      if (removeY >= 0) sum -= horizontal[removeY * width + x];
      if (addY < height) sum += horizontal[addY * width + x];
    }
  }
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let sum = 0;
    for (let xx = 0; xx <= Math.min(radius, width - 1); xx++) sum += dilated[row + xx];
    for (let x = 0; x < width; x++) {
      const windowWidth = Math.min(width - 1, x + radius) - Math.max(0, x - radius) + 1;
      horizontal[row + x] = sum === windowWidth ? 1 : 0;
      const removeX = x - radius;
      const addX = x + radius + 1;
      if (removeX >= 0) sum -= dilated[row + removeX];
      if (addX < width) sum += dilated[row + addX];
    }
  }
  for (let x = 0; x < width; x++) {
    let sum = 0;
    for (let yy = 0; yy <= Math.min(radius, height - 1); yy++) sum += horizontal[yy * width + x];
    for (let y = 0; y < height; y++) {
      const windowHeight = Math.min(height - 1, y + radius) - Math.max(0, y - radius) + 1;
      closed[y * width + x] = sum === windowHeight ? 1 : 0;
      const removeY = y - radius;
      const addY = y + radius + 1;
      if (removeY >= 0) sum -= horizontal[removeY * width + x];
      if (addY < height) sum += horizontal[addY * width + x];
    }
  }
  return closed;
}

function componentStats(mask, width, height, minArea) {
  const visited = new Uint8Array(mask.length);
  const queue = new Int32Array(mask.length);
  let foreground = 0, components = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i]) foreground++;
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || visited[start]) continue;
    let head = 0, tail = 1;
    queue[0] = start;
    visited[start] = 1;
    while (head < tail) {
      const index = queue[head++];
      const x = index % width, y = (index / width) | 0;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          const neighbor = ny * width + nx;
          if (mask[neighbor] && !visited[neighbor]) {
            visited[neighbor] = 1;
            queue[tail++] = neighbor;
          }
        }
      }
    }
    if (tail >= minArea) components++;
  }
  return { foreground, components };
}

// Search thresholds on a small image, then refine the best band at full
// intensity resolution. The score favors coherent, repeatable components,
// rejects foreground that reaches the tray edge, and penalizes speckle and
// thresholds that turn most of the tray into foreground.
function optimizeThreshold(gray, width, height, minArea, baseThreshold, targetWidth, expectedPolarity) {
  const maxEdge = 240;
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  const sampleWidth = Math.max(1, Math.round(width * scale));
  const sampleHeight = Math.max(1, Math.round(height * scale));
  const sample = new Uint8Array(sampleWidth * sampleHeight);
  for (let sy = 0; sy < sampleHeight; sy++) {
    const y0 = Math.floor(sy * height / sampleHeight);
    const y1 = Math.max(y0 + 1, Math.floor((sy + 1) * height / sampleHeight));
    for (let sx = 0; sx < sampleWidth; sx++) {
      const x0 = Math.floor(sx * width / sampleWidth);
      const x1 = Math.max(x0 + 1, Math.floor((sx + 1) * width / sampleWidth));
      let sum = 0;
      let count = 0;
      for (let y = y0; y < y1; y++) {
        const row = y * width;
        for (let x = x0; x < x1; x++) { sum += gray[row + x]; count++; }
      }
      sample[sy * sampleWidth + sx] = Math.round(sum / Math.max(1, count));
    }
  }

  const sampleTargetWidth = Math.max(1, targetWidth * scale);
  const expectedArea = Math.max(minArea, targetWidth * targetWidth * 2.5) * scale * scale;
  const sampleMinArea = Math.max(2, Math.round(Math.max(minArea * scale * scale, expectedArea * 0.28)));
  // A strong local mode on the part side of Otsu gives a useful anchor when
  // tiny-width settings would otherwise reward many thread/noise fragments.
  const thresholdHint = histogramThresholdHint(gray, baseThreshold, expectedPolarity);
  const scores = new Map();
  const evaluate = (threshold, candidatePolarity) => {
    const key = `${candidatePolarity}:${threshold}`;
    if (!scores.has(key)) scores.set(key, scoreThreshold(sample, sampleWidth, sampleHeight, threshold, candidatePolarity, sampleMinArea, sampleTargetWidth));
    return scores.get(key);
  };

  let best = { score: -Infinity, threshold: baseThreshold, polarity: expectedPolarity };
  for (const candidatePolarity of [expectedPolarity]) {
    for (let threshold = 24; threshold <= 232; threshold += 4) {
      const center = evaluate(threshold, candidatePolarity);
      const before = evaluate(Math.max(0, threshold - 4), candidatePolarity);
      const after = evaluate(Math.min(255, threshold + 4), candidatePolarity);
      const stableScore = center * 0.6 + before * 0.2 + after * 0.2
        + 1.35 * thresholdStability(sample, threshold, candidatePolarity)
        - (thresholdHint === null ? 0 : 0.08 * Math.abs(threshold - thresholdHint));
      if (stableScore > best.score) best = { score: stableScore, threshold, polarity: candidatePolarity };
    }
  }

  const coarse = best.threshold;
  for (let threshold = Math.max(1, coarse - 4); threshold <= Math.min(254, coarse + 4); threshold++) {
    const center = evaluate(threshold, best.polarity);
    const before = evaluate(Math.max(0, threshold - 1), best.polarity);
    const after = evaluate(Math.min(255, threshold + 1), best.polarity);
    const stableScore = center * 0.6 + before * 0.2 + after * 0.2
      + 1.35 * thresholdStability(sample, threshold, best.polarity)
      - (thresholdHint === null ? 0 : 0.08 * Math.abs(threshold - thresholdHint));
    if (stableScore > best.score) best = { score: stableScore, threshold, polarity: best.polarity };
  }
  return best;
}

function thresholdStability(gray, threshold, polarity) {
  let lowerMask = 0;
  let upperMask = 0;
  for (let i = 0; i < gray.length; i++) {
    if (polarity === 'dark') {
      if (gray[i] <= threshold - 4) lowerMask++;
      if (gray[i] <= threshold + 4) upperMask++;
    } else {
      if (gray[i] > threshold - 4) lowerMask++;
      if (gray[i] > threshold + 4) upperMask++;
    }
  }
  return Math.min(lowerMask, upperMask) / Math.max(1, lowerMask, upperMask);
}

function histogramThresholdHint(gray, baseThreshold, polarity) {
  const histogram = new Uint32Array(256);
  for (let i = 0; i < gray.length; i++) {
    const value = polarity === 'dark' ? gray[i] : 255 - gray[i];
    histogram[value]++;
  }
  const smooth = new Uint32Array(256);
  for (let value = 0; value < 256; value++) {
    for (let delta = -4; delta <= 4; delta++) smooth[value] += histogram[Math.max(0, Math.min(255, value + delta))];
  }
  const transformedBase = polarity === 'dark' ? baseThreshold : 255 - baseThreshold;
  const limit = Math.floor(transformedBase * 0.8);
  let peak = 0;
  for (let value = 16; value < limit; value++) {
    if (smooth[value] > smooth[value - 1] && smooth[value] >= smooth[value + 1]) peak = value;
  }
  if (!peak) return null;
  return polarity === 'dark' ? peak : 255 - peak;
}

function borderMedian(gray, width, height) {
  const band = Math.max(1, Math.round(Math.min(width, height) * 0.025));
  const histogram = new Uint32Array(256);
  let count = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (x >= band && x < width - band && y >= band && y < height - band) continue;
      histogram[gray[y * width + x]]++;
      count++;
    }
  }
  const midpoint = Math.floor(count / 2);
  let accumulated = 0;
  for (let value = 0; value < histogram.length; value++) {
    accumulated += histogram[value];
    if (accumulated > midpoint) return value;
  }
  return 127;
}

function scoreThreshold(gray, width, height, threshold, polarity, minArea, targetWidth) {
  const length = gray.length;
  const raw = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    raw[i] = polarity === 'dark' ? (gray[i] <= threshold ? 1 : 0) : (gray[i] > threshold ? 1 : 0);
  }
  const mask = removeIsolatedPixels(raw, width, height);
  const labels = new Uint8Array(length);
  const queue = new Int32Array(length);
  const areas = [];
  let foreground = 0;
  let borderForeground = 0;
  let tinyForeground = 0;
  let thinForeground = 0;
  let soliditySum = 0;
  let measuredComponents = 0;
  const border = Math.max(1, Math.round(Math.min(width, height) * 0.025));

  for (let start = 0; start < length; start++) {
    if (!mask[start] || labels[start]) continue;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    labels[start] = 1;
    let touchesBorder = false;
    let edgePixels = 0;
    let minX = width;
    let minY = height;
    let maxX = 0;
    let maxY = 0;
    while (head < tail) {
      const index = queue[head++];
      const x = index % width;
      const y = (index / width) | 0;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (x < border || y < border || x >= width - border || y >= height - border) {
        touchesBorder = true;
        edgePixels++;
      }
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          const neighbor = ny * width + nx;
          if (mask[neighbor] && !labels[neighbor]) {
            labels[neighbor] = 1;
            queue[tail++] = neighbor;
          }
        }
      }
    }
    foreground += tail;
    if (tail < minArea) tinyForeground += tail;
    else {
      areas.push(tail);
      const boxWidth = maxX - minX + 1;
      const boxHeight = maxY - minY + 1;
      const minorSize = Math.min(boxWidth, boxHeight);
      const boxArea = boxWidth * boxHeight;
      if (minorSize < targetWidth * 0.55) thinForeground += tail;
      soliditySum += Math.min(1, tail / Math.max(1, boxArea));
      measuredComponents++;
      if (touchesBorder) borderForeground += tail;
    }
  }

  const occupancy = foreground / Math.max(1, length);
  if (!areas.length || occupancy < 0.0002 || occupancy > 0.72) return -10 + Math.min(occupancy, 1);
  areas.sort((a, b) => a - b);
  const totalValid = areas.reduce((sum, area) => sum + area, 0);
  const median = areas[Math.floor(areas.length / 2)];
  const logDeviations = areas.map((area) => Math.abs(Math.log(area / Math.max(1, median))));
  logDeviations.sort((a, b) => a - b);
  const logMad = logDeviations[Math.floor(logDeviations.length / 2)];
  const largestShare = areas[areas.length - 1] / Math.max(1, totalValid);
  const tinyRatio = tinyForeground / Math.max(1, foreground);
  const thinRatio = thinForeground / Math.max(1, totalValid);
  const edgeRatio = borderForeground / Math.max(1, foreground);
  const countReward = Math.min(1.25, Math.log1p(areas.length) / Math.log(9));
  const occupancyPenalty = Math.max(0, occupancy - 0.35) * 3;
  const meanSolidity = soliditySum / Math.max(1, measuredComponents);
  return 1.8 * countReward
    + 0.35 * (totalValid / Math.max(1, foreground))
    - 2.8 * tinyRatio
    - 2.2 * thinRatio
    - 5.5 * edgeRatio
    - 0.8 * logMad
    + 0.6 * meanSolidity
    - 1.8 * Math.max(0, largestShare - 0.3)
    - occupancyPenalty;
}

function removeIsolatedPixels(mask, width, height) {
  const cleaned = mask.slice();
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      if (!mask[index]) continue;
      let neighbors = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx;
          if (nx >= 0 && nx < width && mask[ny * width + nx]) neighbors++;
        }
      }
      if (!neighbors) cleaned[index] = 0;
    }
  }
  return cleaned;
}

function grayscaleIntegral(gray, width, height) {
  const stride = width + 1;
  const integral = new Uint32Array(stride * (height + 1));
  for (let y = 1; y <= height; y++) {
    let rowSum = 0;
    const source = (y - 1) * width;
    const target = y * stride;
    const previous = (y - 1) * stride;
    for (let x = 1; x <= width; x++) {
      rowSum += gray[source + x - 1];
      integral[target + x] = integral[previous + x] + rowSum;
    }
  }
  return integral;
}

function localMeanAt(integral, width, height, x, y, radius) {
  const stride = width + 1;
  const left = Math.max(0, x - radius);
  const right = Math.min(width, x + radius + 1);
  const top = Math.max(0, y - radius);
  const bottom = Math.min(height, y + radius + 1);
  const sum = integral[bottom * stride + right] - integral[top * stride + right] - integral[bottom * stride + left] + integral[top * stride + left];
  return sum / Math.max(1, (right - left) * (bottom - top));
}

function occupancyScore(ratio) {
  if (ratio <= 0.0005 || ratio >= 0.92) return 100 + Math.abs(ratio - 0.2);
  return Math.abs(Math.log(ratio / 0.18)) + (ratio > 0.72 ? 2 : 0);
}

function otsuThreshold(histogram, total) {
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * histogram[i];
  let sumBackground = 0;
  let weightBackground = 0;
  let bestVariance = -1;
  let threshold = 127;
  for (let i = 0; i < 256; i++) {
    weightBackground += histogram[i];
    if (!weightBackground) continue;
    const weightForeground = total - weightBackground;
    if (!weightForeground) break;
    sumBackground += i * histogram[i];
    const meanBackground = sumBackground / weightBackground;
    const meanForeground = (sum - sumBackground) / weightForeground;
    const difference = meanBackground - meanForeground;
    const variance = weightBackground * weightForeground * difference * difference;
    if (variance > bestVariance) { bestVariance = variance; threshold = i; }
  }
  return threshold;
}

