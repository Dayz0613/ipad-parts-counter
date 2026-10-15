(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const els = {
    cameraInput: $('cameraInput'), photoInput: $('photoInput'), cameraButton: $('cameraButton'), photoButton: $('photoButton'),
    analyzeButton: $('analyzeButton'), analyzeLabel: $('analyzeLabel'), canvas: $('imageCanvas'), stage: $('stage'), emptyState: $('emptyState'),
    originalView: $('originalView'), binaryView: $('binaryView'), cleanedView: $('cleanedView'),
    countValue: $('countValue'), positionCount: $('positionCount'), areaCandidateCount: $('areaCandidateCount'), uncertainCount: $('uncertainCount'), resultBadge: $('resultBadge'),
    exportButton: $('exportButton'), statusLine: $('statusLine'), warningBanner: $('warningBanner'), warningTitle: $('warningTitle'), warningText: $('warningText'),
    viewMode: $('viewMode'), referenceMode: $('referenceMode'), addMode: $('addMode'), deleteMode: $('deleteMode'), modeHint: $('modeHint'), referenceSummary: $('referenceSummary'), clearReferenceButton: $('clearReferenceButton'), undoButton: $('undoButton'), clearEditsButton: $('clearEditsButton'),
    partName: $('partName'), sizeRange: $('sizeRange'), sizeValue: $('sizeValue'), autoThreshold: $('autoThreshold'), thresholdRange: $('thresholdRange'), thresholdValue: $('thresholdValue'),
    polaritySelect: $('polaritySelect'), noiseRange: $('noiseRange'), noiseValue: $('noiseValue'), labelsCheck: $('labelsCheck'), saveSettingsButton: $('saveSettingsButton'), savedNote: $('savedNote'),
    zoomIn: $('zoomIn'), zoomOut: $('zoomOut'), zoomFit: $('zoomFit'), zoomReadout: $('zoomReadout'), offlineState: $('offlineState'), offlineText: $('offlineText')
  };

    const SETTINGS_KEY = 'partsCounter.settings.v1';
  const MAX_IMAGE_EDGE = 1400;
  const ctx = els.canvas.getContext('2d', { alpha: false });
  const baseCanvas = document.createElement('canvas');
  const baseCtx = baseCanvas.getContext('2d', { willReadFrequently: true });
  const binaryCanvas = document.createElement('canvas');
  const binaryCtx = binaryCanvas.getContext('2d', { willReadFrequently: true });
  const cleanedCanvas = document.createElement('canvas');
  const cleanedCtx = cleanedCanvas.getContext('2d', { willReadFrequently: true });
  let currentImage = null;
  let currentFileName = '';
  let imageUrl = '';
  let originalWidth = 0;
  let originalHeight = 0;
  let basePoints = [];
  let visiblePoints = [];
  let analysisResult = null;
  let analysisComplete = false;
  let processing = false;
  let zoom = 1;
  let mode = 'view';
  let previewMode = 'original';
  let worker = null;
  let activeJob = 0;
  let history = [];
  let adjustments = { removed: [], added: [] };
  let referenceProfile = null;

  loadSettings();
  updateSettingsLabels();
  bindEvents();
  updateMode();
  updateCount();
  registerWorker();
  registerOfflineShell();

  function bindEvents() {
    els.cameraButton.addEventListener('click', () => els.cameraInput.click());
    els.photoButton.addEventListener('click', () => els.photoInput.click());
    els.cameraInput.addEventListener('change', onFileSelected);
    els.photoInput.addEventListener('change', onFileSelected);
    els.analyzeButton.addEventListener('click', analyze);
    els.originalView.addEventListener('click', () => setPreviewMode('original'));
    els.binaryView.addEventListener('click', () => setPreviewMode('binary'));
    els.cleanedView.addEventListener('click', () => setPreviewMode('cleaned'));
    els.exportButton.addEventListener('click', exportCsv);
    els.canvas.addEventListener('click', onCanvasClick);
    els.viewMode.addEventListener('click', () => setMode('view'));
    els.referenceMode.addEventListener('click', () => {
      if (!analysisComplete) {
        els.statusLine.textContent = '先に画像を解析してください。検出結果から、1個だけ離れて写った部品を基準に選びます。';
        return;
      }
      setMode('reference');
    });
    els.addMode.addEventListener('click', () => setMode('add'));
    els.deleteMode.addEventListener('click', () => setMode('delete'));
    els.undoButton.addEventListener('click', undoEdit);
    els.clearEditsButton.addEventListener('click', clearEdits);
    els.clearReferenceButton.addEventListener('click', clearReference);
    els.zoomIn.addEventListener('click', () => setZoom(Math.min(4, zoom * 1.25)));
    els.zoomOut.addEventListener('click', () => setZoom(Math.max(.5, zoom / 1.25)));
    els.zoomFit.addEventListener('click', () => setZoom(1));
    els.saveSettingsButton.addEventListener('click', () => saveSettings(true));
    [els.partName, els.sizeRange, els.thresholdRange, els.polaritySelect, els.noiseRange, els.labelsCheck, els.autoThreshold].forEach((el) => {
      el.addEventListener('input', onSettingsChanged);
      el.addEventListener('change', onSettingsChanged);
    });
    els.autoThreshold.addEventListener('change', updateThresholdControls);
    window.addEventListener('resize', updateCanvasSize);
    if ('ResizeObserver' in window) new ResizeObserver(updateCanvasSize).observe(els.stage);
  }

  function registerWorker() {
    try {
      worker = new Worker('./detector-worker.js?v=20');
      worker.addEventListener('message', (event) => {
        const { jobId, result, error } = event.data || {};
        if (jobId !== activeJob) return;
        processing = false;
        els.analyzeButton.disabled = !currentImage;
        els.analyzeLabel.textContent = analysisComplete ? '再解析' : '画像を解析';
        if (error || !result) {
          els.statusLine.textContent = `解析できませんでした: ${error || '不明なエラー'}`;
          return;
        }
        analysisResult = result;
        renderMaskPreview(binaryCanvas, binaryCtx, result.binaryMask, result.width, result.height);
        renderMaskPreview(cleanedCanvas, cleanedCtx, result.areaFilteredMask, result.width, result.height);
        els.binaryView.disabled = false;
        els.cleanedView.disabled = false;
        basePoints = result.detections.map((point, index) => ({
          id: `auto-${index}`,
          x: point.x,
          y: point.y,
          label: point.label,
          area: point.area,
          angle: point.angle,
          aspect: point.aspect,
          firstPart: point.label === result.firstPartLabel,
          uncertain: point.uncertain,
          source: '自動検出'
        }));
        analysisComplete = true;
        applyAdjustments();
        els.resultBadge.textContent = '解析済み';
        els.resultBadge.classList.add('ready');
        els.exportButton.disabled = false;
        const level = result.polarity === 'dark' ? '暗い部品' : '明るい部品';
        const referenceNote = result.referenceUsed
          ? ` · 選択形状を基準（面積 ${Math.round(result.referenceUsed.area).toLocaleString()} px²・${result.localThreshold ? '局所コントラスト二値化' : '明暗方向と面積比に反映'}）`
          : '';
        const countReferenceLabel = result.referenceUsed
          ? '選択した基準部品'
          : result.countReferenceMethod === 'shape-consensus' ? '似た形の領域群の中央値' : '最小の有効領域';
        const firstPartNote = result.countReferenceArea ? ` · ${countReferenceLabel} ${Math.round(result.countReferenceArea).toLocaleString()} px²・形状特徴を1個基準として換算（推定${result.estimatedQuantity}個）` : '';
        els.areaCandidateCount.textContent = result.componentCount.toLocaleString();
        const binarization = result.localThreshold ? '局所コントラスト二値化' : result.autoThresholdUsed ? '自動最適化' : '全体二値化';
        const previewNoiseNote = result.binaryPreviewRemovedPixels ? ` · 二値画像の小領域ノイズ ${result.binaryPreviewRemovedPixels.toLocaleString()}画素を除去` : '';
        const closingNote = result.closingRadius ? ` · 自動膨張収縮 半径${result.closingRadius}px（領域数の安定から選択）・塗り足し${result.closingFilledPixels.toLocaleString()}画素` : ' · 自動膨張収縮 なし（合体・膨張を避けました）';
        const smallNoiseNote = result.autoNoiseComponentCount ? ` · 小さなノイズ候補を自動除外 ${result.autoNoiseComponentCount}領域` : '';
        els.statusLine.textContent = `解析完了 · ${binarization} ${result.threshold}${previewNoiseNote} · 孤立ノイズ ${result.removedNoisePixels.toLocaleString()}画素を除去${closingNote} · 面積 ${result.minArea} px²未満 ${result.rejectedSmallComponentCount.toLocaleString()}領域を除外${smallNoiseNote} · 輪郭候補 ${result.componentCount.toLocaleString()}件${firstPartNote} · ${level}${referenceNote}`;
        if (result.foregroundRatio > .72) {
          els.statusLine.textContent += ' · 背景まで選ばれている可能性があります。明暗設定・境界を調整してください。';
        }
        updateWarning();
        renderCanvas();
        updateCount();
      });
      worker.addEventListener('error', () => {
        processing = false;
        els.analyzeButton.disabled = !currentImage;
        els.analyzeLabel.textContent = analysisComplete ? '再解析' : '画像を解析';
        els.statusLine.textContent = '画像処理を開始できません。ページを再読み込みしてからお試しください。';
      });
    } catch (error) {
      worker = null;
      els.statusLine.textContent = 'このブラウザでは画像処理を開始できません。Safariで開き直してください。';
    }
  }

  function onFileSelected(event) {
    const file = event.target.files && event.target.files[0];
    event.target.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      els.statusLine.textContent = '画像ファイルを選択してください。';
      return;
    }
    if (imageUrl) URL.revokeObjectURL(imageUrl);
    imageUrl = URL.createObjectURL(file);
    currentFileName = file.name || '撮影画像';
    analysisComplete = false;
    analysisResult = null;
    previewMode = 'original';
    els.binaryView.disabled = true;
    els.cleanedView.disabled = true;
    updatePreviewButtons();
    basePoints = [];
    visiblePoints = [];
    adjustments = { removed: [], added: [] };
    history = [];
    const image = new Image();
    image.onload = () => {
      currentImage = image;
      originalWidth = image.naturalWidth;
      originalHeight = image.naturalHeight;
      prepareCanvas();
      els.emptyState.hidden = true;
      els.canvas.classList.add('visible');
      els.analyzeButton.disabled = false;
      els.analyzeLabel.textContent = '画像を解析';
      els.exportButton.disabled = true;
      els.resultBadge.textContent = '未解析';
      els.resultBadge.classList.remove('ready');
      els.warningBanner.hidden = true;
      els.countValue.textContent = '—';
      els.positionCount.textContent = '0';
      els.areaCandidateCount.textContent = '—';
      els.uncertainCount.textContent = '—';
      zoom = 1;
      updateCanvasSize();
      renderCanvas();
      updateCount();
      els.statusLine.textContent = `画像を読み込みました · ${originalWidth.toLocaleString()} × ${originalHeight.toLocaleString()} px · 「画像を解析」を押してください。`;
    };
    image.onerror = () => {
      currentImage = null;
      els.statusLine.textContent = '画像を読み込めません。JPEGまたはPNG画像でお試しください。';
    };
    image.src = imageUrl;
  }

  function prepareCanvas() {
    const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(originalWidth, originalHeight));
    const width = Math.max(1, Math.round(originalWidth * scale));
    const height = Math.max(1, Math.round(originalHeight * scale));
    baseCanvas.width = width;
    baseCanvas.height = height;
    els.canvas.width = width;
    els.canvas.height = height;
    baseCtx.clearRect(0, 0, width, height);
    baseCtx.drawImage(currentImage, 0, 0, width, height);
  }

  function analyze() {
    if (!currentImage || !worker || processing) return;
    processing = true;
    activeJob++;
    const jobId = activeJob;
    els.analyzeButton.disabled = true;
    els.analyzeLabel.textContent = '解析中…';
    els.statusLine.textContent = '画像を端末内で解析しています。写真の大きさにより数秒かかることがあります。';
    window.requestAnimationFrame(() => {
      try {
        const pixels = baseCtx.getImageData(0, 0, baseCanvas.width, baseCanvas.height).data;
        const shortEdge = Math.min(baseCanvas.width, baseCanvas.height);
        worker.postMessage({
          jobId,
          pixels: pixels.buffer,
          width: baseCanvas.width,
          height: baseCanvas.height,
          settings: {
            targetWidth: Math.max(3, shortEdge * Number(els.sizeRange.value) / 100),
            thresholdOffset: Number(els.thresholdRange.value),
            polarity: els.polaritySelect.value,
            autoThreshold: els.autoThreshold.checked,
            minArea: Number(els.noiseRange.value),
            reference: referenceProfile
          }
        }, [pixels.buffer]);
      } catch (error) {
        processing = false;
        els.analyzeButton.disabled = false;
        els.analyzeLabel.textContent = analysisComplete ? '再解析' : '画像を解析';
        els.statusLine.textContent = '画像を解析できませんでした。画像サイズを小さくしてお試しください。';
      }
    });
  }

  function onCanvasClick(event) {
    if (!analysisComplete || mode === 'view' || processing) return;
    const rect = els.canvas.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width * els.canvas.width;
    const y = (event.clientY - rect.top) / rect.height * els.canvas.height;
    if (mode === 'reference') {
      selectReference(x, y);
      return;
    }
    if (mode === 'add') {
      pushHistory();
      adjustments.added.push({ id: `manual-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, nx: x / els.canvas.width, ny: y / els.canvas.height });
      applyAdjustments();
      els.statusLine.textContent = '手動で1個追加しました。';
    } else if (mode === 'delete') {
      const target = nearestPoint(x, y);
      if (!target) {
        els.statusLine.textContent = '近くに検出位置がありません。拡大してから位置を選んでください。';
        return;
      }
      pushHistory();
      if (target.source === '手動追加') {
        adjustments.added = adjustments.added.filter((point) => point.id !== target.id);
      } else {
        adjustments.removed.push({ nx: target.x / els.canvas.width, ny: target.y / els.canvas.height });
      }
      applyAdjustments();
      els.statusLine.textContent = '検出位置を1個削除しました。';
    }
    renderCanvas();
    updateCount();
    updateEditButtons();
  }

  function nearestPoint(x, y) {
    if (!visiblePoints.length) return null;
    const targetWidth = analysisResult ? analysisResult.targetWidth : 10;
    const canvasScale = els.canvas.width / Math.max(1, els.canvas.clientWidth);
    const radius = Math.max(targetWidth * .55, canvasScale * 18);
    let nearest = null;
    let nearestDistance = radius * radius;
    for (const point of visiblePoints) {
      const dx = point.x - x;
      const dy = point.y - y;
      const distance = dx * dx + dy * dy;
      if (distance <= nearestDistance) { nearest = point; nearestDistance = distance; }
    }
    return nearest;
  }

  function applyAdjustments() {
    const shortEdge = Math.min(els.canvas.width || 1, els.canvas.height || 1);
    const tolerance = Math.max(5, (analysisResult ? analysisResult.targetWidth : 12) * .42);
    const toleranceSquared = tolerance * tolerance;
    visiblePoints = basePoints.filter((point) => !adjustments.removed.some((removed) => {
      const dx = point.x - removed.nx * els.canvas.width;
      const dy = point.y - removed.ny * els.canvas.height;
      return dx * dx + dy * dy <= toleranceSquared;
    })).map((point) => ({ ...point }));
    for (const point of adjustments.added) {
      visiblePoints.push({ id: point.id, x: point.nx * els.canvas.width, y: point.ny * els.canvas.height, uncertain: false, source: '手動追加' });
    }
    els.clearEditsButton.disabled = !adjustments.removed.length && !adjustments.added.length;
    updateEditButtons();
  }

  function pushHistory() {
    history.push(JSON.stringify(adjustments));
    if (history.length > 40) history.shift();
  }

  function undoEdit() {
    const previous = history.pop();
    if (!previous) return;
    adjustments = JSON.parse(previous);
    applyAdjustments();
    renderCanvas();
    updateCount();
    updateEditButtons();
    els.statusLine.textContent = '直前の手動修正を戻しました。';
  }

  function clearEdits() {
    if (!adjustments.removed.length && !adjustments.added.length) return;
    pushHistory();
    adjustments = { removed: [], added: [] };
    applyAdjustments();
    renderCanvas();
    updateCount();
    updateEditButtons();
    els.statusLine.textContent = '手動修正をすべて戻しました。';
  }

  function renderCanvas() {
    if (!baseCanvas.width) return;
    ctx.clearRect(0, 0, els.canvas.width, els.canvas.height);
    const sourceCanvas = previewMode === 'binary' ? binaryCanvas : previewMode === 'cleaned' ? cleanedCanvas : baseCanvas;
    ctx.drawImage(sourceCanvas, 0, 0);
    if (previewMode !== 'original') return;
    const markerRadius = Math.max(4, Math.min(9, Math.min(els.canvas.width, els.canvas.height) * .006));
    for (let index = 0; index < visiblePoints.length; index++) {
      const point = visiblePoints[index];
      const color = point.source === '手動追加' ? '#7a9cff' : point.firstPart ? '#ff66a3' : point.uncertain ? '#ffc365' : '#47d4b0';
      ctx.beginPath();
      ctx.arc(point.x, point.y, markerRadius, 0, Math.PI * 2);
      ctx.fillStyle = `${color}38`;
      ctx.fill();
      ctx.lineWidth = Math.max(1.5, markerRadius * .32);
      ctx.strokeStyle = color;
      ctx.stroke();
      if (els.labelsCheck.checked) {
        ctx.font = `600 ${Math.max(8, markerRadius * 1.55)}px -apple-system, BlinkMacSystemFont, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#07111d';
        ctx.fillText(String(index + 1), point.x, point.y + .4);
      }
    }
  }

  function renderMaskPreview(canvas, context, mask, width, height) {
    if (!mask || mask.length !== width * height) return;
    canvas.width = width;
    canvas.height = height;
    const image = context.createImageData(width, height);
    for (let i = 0, p = 0; i < mask.length; i++, p += 4) {
      const value = mask[i] ? 0 : 255;
      image.data[p] = value;
      image.data[p + 1] = value;
      image.data[p + 2] = value;
      image.data[p + 3] = 255;
    }
    context.putImageData(image, 0, 0);
  }

  function setPreviewMode(nextMode) {
    if (nextMode !== 'original' && !analysisResult) return;
    previewMode = nextMode;
    updatePreviewButtons();
    renderCanvas();
  }

  function updatePreviewButtons() {
    for (const [name, button] of [['original', els.originalView], ['binary', els.binaryView], ['cleaned', els.cleanedView]]) {
      const active = previewMode === name;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    }
  }

  function updateCanvasSize() {
    if (!baseCanvas.width) return;
    const available = Math.max(120, els.stage.clientWidth - 2);
    const fitWidth = Math.min(available, baseCanvas.width);
    const displayWidth = Math.max(1, Math.round(fitWidth * zoom));
    els.canvas.style.width = `${displayWidth}px`;
    els.canvas.style.height = 'auto';
    els.zoomReadout.textContent = `${Math.round(zoom * 100)}%`;
  }

  function setZoom(value) {
    zoom = Math.max(.5, Math.min(4, value));
    updateCanvasSize();
  }

  function setMode(nextMode) {
    mode = nextMode;
    updateMode();
  }

  function updateMode() {
    const modes = [['view', els.viewMode], ['reference', els.referenceMode], ['add', els.addMode], ['delete', els.deleteMode]];
    for (const [name, button] of modes) {
      const active = mode === name;
      button.classList.toggle('active', active);
      button.classList.toggle('adding', active && name === 'add');
      button.classList.toggle('deleting', active && name === 'delete');
      button.setAttribute('aria-pressed', String(active));
    }
    els.canvas.style.cursor = mode === 'add' ? 'copy' : mode === 'delete' ? 'not-allowed' : mode === 'reference' ? 'crosshair' : 'grab';
      els.modeHint.textContent = mode === 'add' ? '画像上の部品の中心をタップすると1個追加します。' : mode === 'delete' ? '削除する検出位置をタップします。細かい場所は拡大してください。' : mode === 'reference' ? '1個だけ離れて写った自動検出位置をタップして形状基準にします。' : '検出位置を拡大して確認できます。';
  }

  function selectReference(x, y) {
    const point = nearestPoint(x, y);
    if (!point || point.source !== '自動検出') {
      els.statusLine.textContent = '自動検出された、1個だけ離れて写っている部品を選んでください。接触部品や手動追加は基準にできません。';
      return;
    }
    const component = analysisResult && analysisResult.components && analysisResult.components.find((item) => item.label === point.label);
    if (!component || component.peakCount !== 1 || component.area < 8 || component.meanBackground === null) {
      els.statusLine.textContent = '1個だけ離れて写り、背景との明暗差がある部品を選んでください。要確認の位置は基準に向きません。';
      return;
    }
    const contrast = Math.abs(component.meanBackground - component.meanObject);
    if (contrast < 7) {
      els.statusLine.textContent = '選んだ部品と周囲の明るさが近すぎます。影や反射の少ない部品を選び直してください。';
      return;
    }
    referenceProfile = {
      area: component.area,
      angle: component.angle,
      aspect: component.aspect,
      majorAxis: component.majorAxis,
      minorAxis: component.minorAxis,
      width: component.width,
      height: component.height,
      solidity: component.solidity,
      holeRatio: component.holeRatio,
      diameter: Math.max(3, 2 * Math.sqrt(component.area / Math.PI)),
      meanObject: component.meanObject,
      meanBackground: component.meanBackground,
      polarity: analysisResult.polarity
    };
    updateReferenceSummary();
    saveSettings(false);
    setMode('view');
    els.statusLine.textContent = `基準を記録しました · 面積 ${Math.round(component.area).toLocaleString()} px² · 寸法 ${component.width}×${component.height} px · 穴の割合 ${(component.holeRatio * 100).toFixed(1)}%。形状基準に合わせて再解析します。`;
    analyze();
  }

  function clearReference() {
    if (!referenceProfile) return;
    referenceProfile = null;
    updateReferenceSummary();
    saveSettings(false);
    if (analysisComplete) {
      els.statusLine.textContent = '基準を解除しました。「再解析」を押すと通常の全体しきい値に戻ります。';
      els.analyzeLabel.textContent = '再解析';
      els.analyzeButton.disabled = !currentImage;
    }
  }

  function updateReferenceSummary() {
    if (!referenceProfile) {
      els.referenceSummary.textContent = '基準部品なし · 解析後、はっきり写った1個を選べます。';
      els.clearReferenceButton.disabled = true;
      return;
    }
    const holeText = Number(referenceProfile.holeRatio) > 0.04 ? '穴あり' : '穴は検出されず';
    const dimensions = referenceProfile.width && referenceProfile.height ? ` · 寸法 ${referenceProfile.width}×${referenceProfile.height} px` : '';
    els.referenceSummary.textContent = `形状基準あり · 面積 ${Math.round(referenceProfile.area).toLocaleString()} px²${dimensions} · 縦横比 ${Number(referenceProfile.aspect || 1).toFixed(2)} · ${holeText}`;
    els.clearReferenceButton.disabled = false;
  }

  function updateEditButtons() {
    els.undoButton.disabled = history.length === 0;
    els.clearEditsButton.disabled = !adjustments.removed.length && !adjustments.added.length;
  }

  function updateCount() {
    els.positionCount.textContent = visiblePoints.length.toLocaleString();
    if (analysisComplete) els.countValue.textContent = visiblePoints.length.toLocaleString();
  }

  function updateWarning() {
    if (!analysisResult) {
      els.warningBanner.hidden = true;
      return;
    }
    const warnings = analysisResult.warningCount;
    const dense = analysisResult.foregroundRatio > .72;
    els.warningBanner.hidden = warnings === 0 && !dense && !analysisResult.candidateLimitReached;
    if (dense) {
      els.warningTitle.textContent = '背景まで検出している可能性があります';
      els.warningText.textContent = '明暗設定や「明るさの境界」を調整して再解析してください。検出位置が全体に広がっているときは、特に確認が必要です。';
    } else if (warnings > 0) {
      els.warningTitle.textContent = `接触・重なりの可能性がある領域: ${warnings.toLocaleString()}箇所`;
      els.warningText.textContent = '黄色の位置を拡大して確認してください。1個の基準部品から面積・寸法・縦横比・穴の特徴を取り、領域の分割位置を推定しています。接触や重なりが強い箇所は誤差が出ることがあります。';
    } else if (analysisResult.candidateLimitReached) {
      els.warningTitle.textContent = '検出候補が多すぎます';
      els.warningText.textContent = '画像にノイズや模様が多く、処理上限に達しました。部品の幅、明暗設定、ノイズ除去を調整して再解析してください。';
    }
    els.uncertainCount.textContent = warnings.toLocaleString();
  }

  function updateSettingsLabels() {
    els.sizeValue.textContent = `${Number(els.sizeRange.value).toFixed(1)}%`;
    els.thresholdValue.textContent = els.autoThreshold.checked ? '自動' : `${Number(els.thresholdRange.value) > 0 ? '+' : ''}${els.thresholdRange.value}`;
    els.noiseValue.textContent = `${els.noiseRange.value} px²`;
  }

  function updateThresholdControls() {
    const automatic = els.autoThreshold.checked;
    els.thresholdRange.disabled = automatic;
    els.polaritySelect.disabled = automatic;
  }

  function onSettingsChanged() {
    updateSettingsLabels();
    saveSettings(false);
    if (analysisComplete) {
      els.statusLine.textContent = '設定を変更しました。「再解析」を押すと新しい設定が反映されます。';
      els.analyzeLabel.textContent = '再解析';
      els.analyzeButton.disabled = false;
    }
    renderCanvas();
  }

  function saveSettings(showMessage) {
    const settings = {
      partName: els.partName.value,
      sizePct: els.sizeRange.value,
      thresholdOffset: els.thresholdRange.value,
      polarity: els.polaritySelect.value,
      autoThreshold: els.autoThreshold.checked,
      minArea: els.noiseRange.value,
      labels: els.labelsCheck.checked,
      reference: referenceProfile
    };
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
      els.savedNote.textContent = showMessage ? '設定をこの端末に保存しました。' : '設定はこの端末に自動保存されます。';
    } catch (error) {
      els.savedNote.textContent = 'このブラウザでは設定を保存できません。';
    }
  }

  function loadSettings() {
    try {
      const settings = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
      if (settings.partName) els.partName.value = settings.partName;
      if (settings.sizePct) els.sizeRange.value = settings.sizePct;
      if (settings.thresholdOffset !== undefined) els.thresholdRange.value = settings.thresholdOffset;
      if (settings.polarity) els.polaritySelect.value = settings.polarity;
      els.autoThreshold.checked = settings.autoThreshold !== false;
      if (settings.minArea) els.noiseRange.value = settings.minArea;
      if (settings.labels !== undefined) els.labelsCheck.checked = settings.labels;
      if (settings.reference && settings.reference.area > 0 && settings.reference.meanObject !== undefined && settings.reference.meanBackground !== undefined) referenceProfile = settings.reference;
    } catch (error) { /* 初回または保存値が壊れている場合は標準値を使う */ }
    updateThresholdControls();
    updateReferenceSummary();
  }

  function exportCsv() {
    if (!analysisComplete) return;
    const timestamp = new Date().toISOString();
    const rows = [[
      '部品名', '元画像', '最終数量', '番号', '元画像X(px)', '元画像Y(px)', 'X(%)', 'Y(%)', '検出方法', '検出領域面積(px²)', '検出角度(度)', '縦横比', '基準面積(px²)', '基準2値化', '要確認', '解析日時', '明るさ境界', '明暗設定'
    ]];
    const scaleX = originalWidth / Math.max(1, els.canvas.width);
    const scaleY = originalHeight / Math.max(1, els.canvas.height);
    visiblePoints.forEach((point, index) => {
      const x = point.x * scaleX;
      const y = point.y * scaleY;
      rows.push([
        els.partName.value || '', currentFileName, visiblePoints.length, index + 1,
        Math.round(x), Math.round(y), (x / originalWidth * 100).toFixed(2), (y / originalHeight * 100).toFixed(2),
        point.source, point.area ? Math.round(point.area) : '', point.angle !== undefined ? point.angle.toFixed(1) : '', point.aspect ? point.aspect.toFixed(2) : '',
        referenceProfile ? Math.round(referenceProfile.area) : '', analysisResult.localThreshold ? '局所しきい値' : '全体しきい値',
        point.uncertain ? '要確認' : '', timestamp, analysisResult.threshold,
        analysisResult.polarity === 'dark' ? '暗い部品' : '明るい部品'
      ]);
    });
    const csv = '\ufeff' + rows.map((row) => row.map(csvCell).join(',')).join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    const safeName = (els.partName.value || '部品').replace(/[\\/:*?"<>|]/g, '_').slice(0, 30);
    anchor.href = url;
    anchor.download = `部品カウント_${safeName}_${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  function csvCell(value) {
    const text = String(value ?? '');
    return `"${text.replace(/"/g, '""')}"`;
  }

  function registerOfflineShell() {
    if (!('serviceWorker' in navigator) || location.protocol === 'file:') {
      els.offlineState.classList.add('pending');
      els.offlineText.textContent = 'HTTPSで開くとオフライン利用可';
      return;
    }
    navigator.serviceWorker.register('./service-worker.js?v=20').then(() => navigator.serviceWorker.ready).then(() => {
      els.offlineState.classList.add('ready');
      els.offlineText.textContent = 'オフライン利用の準備OK';
    }).catch(() => {
      els.offlineState.classList.add('failed');
      els.offlineText.textContent = 'オフライン準備に失敗';
    });
  }
})();
