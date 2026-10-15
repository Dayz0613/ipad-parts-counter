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
  let threshold = Math.max(0, Math.min(255, baseThreshold + Number(settings.thresholdOffset || 0)));

  let polarity = reference ? reference.polarity : settings.polarity;
  if (polarity === 'auto') {
    let darkCount = 0;
    for (let i = 0; i < length; i++) if (gray[i] <= threshold) darkCount++;
    const darkRatio = darkCount / length;
    const brightRatio = 1 - darkRatio;
    polarity = occupancyScore(darkRatio) < occupancyScore(brightRatio) ? 'dark' : 'bright';
  }

  const requestedWidth = Math.max(3, Number(settings.targetWidth) || Math.min(width, height) * 0.028);
  const targetWidth = reference ? Math.max(3, Number(reference.diameter) || 2 * Math.sqrt(reference.area / Math.PI)) : requestedWidth;
  const offset = Number(settings.thresholdOffset || 0);
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

  // Remove isolated one-pixel responses before measuring regions. Keep thin lines
  // intact; the configurable minimum area below removes larger speckle clusters.
  const mask = removeIsolatedPixels(thresholdMask, width, height);
  let foreground = 0;
  for (let i = 0; i < length; i++) if (mask[i]) foreground++;

  const minArea = Math.max(1, Number(settings.minArea) || 12);
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
    targetWidth,
    referenceUsed: reference ? { area: reference.area } : null,
    localThreshold: !!reference
  };
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
