(() => {
  'use strict';

  const MAX_BYTES = 10 * 1024 * 1024;
  const MAX_PIXELS = 20_000_000;
  const MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
  const AVATAR_EDGE = 128;
  const STAGE_EDGE = 640;
  const PROFILE_START_ZOOM = 125;
  const ARROWS = new Map([
    ['ArrowLeft', [-1, 0]], ['ArrowRight', [1, 0]],
    ['ArrowUp', [0, -1]], ['ArrowDown', [0, 1]],
  ]);

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

  function profileEditor({ fileInput, canvas, controls, ranges }) {
    function element(tag, className, text) {
      const node = document.createElement(tag);
      if (className) node.className = className;
      if (text) node.textContent = text;
      return node;
    }

    const editor = element('div', 'avatar-profile-editor');
    const workspace = element('div', 'avatar-crop-workspace');
    const stage = element('div', 'avatar-crop-stage');
    const board = element('div', 'avatar-crop-board');
    const image = element('canvas', 'avatar-crop-source');
    image.width = image.height = STAGE_EDGE;
    image.setAttribute('aria-hidden', 'true');
    const stageContext = image.getContext('2d');
    const help = element('p', 'hint avatar-crop-hint', '拖动裁切框调整位置，拖动四角调整大小。也可用方向键移动，按住 Shift 再按方向键调整大小。');
    help.id = `${canvas.id}-instructions`;
    const frame = element('div', 'avatar-crop-frame');
    frame.tabIndex = 0;
    frame.setAttribute('role', 'group');
    frame.setAttribute('aria-label', '头像裁切框');
    frame.setAttribute('aria-describedby', help.id);
    frame.setAttribute('aria-keyshortcuts', 'ArrowUp ArrowDown ArrowLeft ArrowRight Shift+ArrowUp Shift+ArrowDown Shift+ArrowLeft Shift+ArrowRight');
    for (const corner of ['nw', 'ne', 'sw', 'se']) {
      const handle = element('span', 'avatar-crop-handle');
      handle.dataset.corner = corner;
      handle.setAttribute('aria-hidden', 'true');
      frame.append(handle);
    }

    const figure = element('figure', 'avatar-profile-preview');
    const caption = element('figcaption', '', '头像预览');
    canvas.setAttribute('aria-label', '裁切后的 128 × 128 头像');
    board.append(image, frame);
    stage.append(board);
    workspace.append(stage, figure);
    editor.append(workspace, help);
    editor.hidden = true;
    canvas.before(editor);
    figure.append(canvas, caption);

    const fine = element('details', 'avatar-crop-fine');
    const fineRanges = element('div', 'avatar-crop-ranges');
    fine.append(element('summary', '', '精细调整'), fineRanges);
    for (const input of ranges) {
      const label = input.labels?.[0];
      if (label) fineRanges.append(label);
      fineRanges.append(input);
    }
    controls.append(fine);

    const pickerLabel = fileInput.labels?.[0];
    const originalPickerLabel = pickerLabel?.textContent;
    const formatHint = document.getElementById(fileInput.id.replace(/-file$/, '-help'));
    if (formatHint) formatHint.textContent = '支持 PNG、JPEG 或 WebP，最大 10 MB。';

    let scale = 1;
    let offsetX = 0;
    let offsetY = 0;
    return {
      frame,
      pixelsPerCssPixel() { return STAGE_EDGE / (board.getBoundingClientRect().width * scale); },
      setImage(source) {
        scale = STAGE_EDGE / Math.max(source.width, source.height);
        const width = source.width * scale;
        const height = source.height * scale;
        offsetX = (STAGE_EDGE - width) / 2;
        offsetY = (STAGE_EDGE - height) / 2;
        stageContext.clearRect(0, 0, STAGE_EDGE, STAGE_EDGE);
        stageContext.fillStyle = '#000';
        stageContext.fillRect(offsetX, offsetY, width, height);
        stageContext.drawImage(source, offsetX, offsetY, width, height);
        editor.hidden = false;
        if (pickerLabel) pickerLabel.textContent = '重新选择图片';
      },
      drawFrame({ left, top, edge }) {
        frame.style.setProperty('--avatar-frame-x', `${(offsetX + left * scale) / STAGE_EDGE * 100}%`);
        frame.style.setProperty('--avatar-frame-y', `${(offsetY + top * scale) / STAGE_EDGE * 100}%`);
        frame.style.setProperty('--avatar-frame-size', `${edge * scale / STAGE_EDGE * 100}%`);
      },
      hide() {
        editor.hidden = true;
        fine.open = false;
        if (pickerLabel) pickerLabel.textContent = originalPickerLabel;
      },
    };
  }

  function create({ fileInput, canvas, controls, xInput, yInput, zoomInput, resetButton, removeButton, status, onChange = () => {}, onError = () => {} }) {
    const ranges = [xInput, yInput, zoomInput];
    const placeholder = document.createElement('span');
    placeholder.className = 'avatar-placeholder';
    placeholder.textContent = '头像预览';
    canvas.insertAdjacentElement('beforebegin', placeholder);
    canvas.hidden = true;
    const preview = canvas.getContext('2d', { alpha: false });
    const crop = document.createElement('canvas');
    crop.width = crop.height = AVATAR_EDGE;
    const cropContext = crop.getContext('2d', { alpha: false });
    const editor = fileInput.closest('.profile-avatar-field') ? profileEditor({ fileInput, canvas, controls, ranges }) : null;
    const dragTarget = editor?.frame || canvas;
    let source = null;
    let selection = null;
    let pointer = null;
    let value = '';
    let original = '';
    let revision = 0;

    function message(text) {
      if (status) status.textContent = text;
    }

    function closeSource() {
      stopDragging();
      if (typeof source?.close === 'function') source.close();
      source = null;
    }

    function rangeSelection() {
      const edge = Math.min(source.width, source.height) / (Number(zoomInput.value) / 100);
      const left = (source.width - edge) * Number(xInput.value) / Number(xInput.max);
      const top = (source.height - edge) * Number(yInput.value) / Number(yInput.max);
      return { left, top, edge };
    }

    function draw(notify = true) {
      if (!source) {
        preview.clearRect(0, 0, canvas.width, canvas.height);
        canvas.hidden = true;
        placeholder.hidden = false;
        editor?.hide();
        return;
      }

      const { left, top, edge } = editor ? selection : rangeSelection();
      cropContext.clearRect(0, 0, AVATAR_EDGE, AVATAR_EDGE);
      cropContext.drawImage(source, left, top, edge, edge, 0, 0, AVATAR_EDGE, AVATAR_EDGE);
      preview.clearRect(0, 0, canvas.width, canvas.height);
      preview.drawImage(crop, 0, 0, canvas.width, canvas.height);
      canvas.hidden = false;
      placeholder.hidden = true;
      controls.hidden = false;
      editor?.drawFrame(selection);
      if (notify) {
        const isWholeImage = edge === source.width && edge === source.height;
        const next = (editor && isWholeImage && original) || crop.toDataURL('image/png');
        const changed = value !== next;
        value = next;
        if (changed || !editor) onChange(value);
      }
    }

    function centerSelection() {
      xInput.value = '500';
      yInput.value = '500';
      zoomInput.value = editor && !original ? String(PROFILE_START_ZOOM) : '100';
      if (editor) selection = rangeSelection();
    }

    function setSource(image, savedValue = '') {
      closeSource();
      source = image;
      original = savedValue;
      centerSelection();
      editor?.setImage(source);
      if (original) value = original;
      draw(!original);
    }

    function minSelectionEdge() {
      return Math.min(source.width, source.height) * 100 / Number(zoomInput.max);
    }

    function updateSelection({ left, top, edge }) {
      const { width, height } = source;
      left = clamp(left, 0, width - edge);
      top = clamp(top, 0, height - edge);
      if (left === selection.left && top === selection.top && edge === selection.edge) return;
      selection = { left, top, edge };
      xInput.value = width === edge ? '500' : String(Math.round(left / (width - edge) * Number(xInput.max)));
      yInput.value = height === edge ? '500' : String(Math.round(top / (height - edge) * Number(yInput.max)));
      zoomInput.value = String(Math.round(Math.min(width, height) / edge * 100));
      draw();
    }

    function resizeAroundCenter(edge) {
      const offset = (selection.edge - edge) / 2;
      updateSelection({ left: selection.left + offset, top: selection.top + offset, edge });
    }

    async function selectFile() {
      const file = fileInput.files?.[0];
      const currentRevision = ++revision;
      if (!file) return;
      fileInput.setAttribute('aria-invalid', 'false');

      try {
        if (!MIME_TYPES.has(file.type) || file.size < 1 || file.size > MAX_BYTES) {
          throw new Error('请选择 10 MB 以内的 PNG、JPEG 或 WebP 图片。');
        }
        if (typeof createImageBitmap !== 'function') throw new Error('此浏览器暂不支持本地头像裁切。');
        const image = await createImageBitmap(file, { imageOrientation: 'from-image' });
        if (currentRevision !== revision) {
          image.close();
          return;
        }
        if (!image.width || !image.height || image.width * image.height > MAX_PIXELS) {
          image.close();
          throw new Error('图片尺寸过大，请选择更小的图片。');
        }
        setSource(image);
        message(editor ? '裁切结果将保存为 128 × 128 PNG。' : '头像已裁切为 128 × 128 PNG。');
      } catch (error) {
        if (currentRevision !== revision) return;
        fileInput.setAttribute('aria-invalid', 'true');
        onError(error.message || '无法读取这张图片。');
        message('无法读取图片。');
      }
    }

    async function setValue(next) {
      const currentRevision = ++revision;
      if (typeof next !== 'string' || !next.startsWith('data:image/')) {
        closeSource();
        value = original = '';
        controls.hidden = true;
        draw();
        message('尚未设置头像。');
        return;
      }
      try {
        const image = new Image();
        image.src = next;
        await image.decode();
        if (currentRevision !== revision) return;
        if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth * image.naturalHeight > MAX_PIXELS) {
          throw new Error('账号头像格式无效。');
        }
        setSource(image, next);
        message('当前头像。选择新图片可重新裁切。');
      } catch (error) {
        if (currentRevision !== revision) return;
        onError(error.message || '无法显示当前头像。');
      }
    }

    function clear() {
      revision += 1;
      closeSource();
      value = original = '';
      fileInput.value = '';
      if (editor) fileInput.setAttribute('aria-invalid', 'false');
      controls.hidden = true;
      draw();
      message('已移除头像。');
      onChange('');
    }

    // Reset before opening the picker so the same file can be selected again.
    if (editor) fileInput.addEventListener('click', () => { fileInput.value = ''; });
    fileInput.addEventListener('change', selectFile);
    xInput.addEventListener('input', () => {
      if (!editor) return draw();
      if (!source) return;
      const left = (source.width - selection.edge) * Number(xInput.value) / Number(xInput.max);
      updateSelection({ ...selection, left });
    });
    yInput.addEventListener('input', () => {
      if (!editor) return draw();
      if (!source) return;
      const top = (source.height - selection.edge) * Number(yInput.value) / Number(yInput.max);
      updateSelection({ ...selection, top });
    });
    zoomInput.addEventListener('input', () => {
      if (!editor) return draw();
      if (source) resizeAroundCenter(rangeSelection().edge);
    });
    resetButton?.addEventListener('click', () => {
      if (!source) return;
      stopDragging();
      centerSelection();
      draw();
      message('已重置裁切位置。');
    });
    removeButton?.addEventListener('click', () => {
      if (editor) fileInput.focus();
      clear();
    });

    dragTarget.addEventListener('pointerdown', event => {
      if (!source || pointer || event.button !== 0 || fileInput.matches(':disabled')) return;
      const factor = editor?.pixelsPerCssPixel() ?? 1;
      if (!Number.isFinite(factor)) return;
      pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, corner: event.target.dataset.corner, start: selection, factor };
      dragTarget.setPointerCapture(event.pointerId);
      dragTarget.classList.add('is-dragging');
      if (editor) dragTarget.focus({ preventScroll: true });
      event.preventDefault();
    });
    dragTarget.addEventListener('pointermove', event => {
      if (!source || pointer?.id !== event.pointerId || fileInput.matches(':disabled')) return;
      const deltaX = event.clientX - pointer.x;
      const deltaY = event.clientY - pointer.y;
      if (editor) {
        const dx = deltaX * pointer.factor;
        const dy = deltaY * pointer.factor;
        const { left, top, edge } = pointer.start;
        if (!pointer.corner) {
          updateSelection({ left: left + dx, top: top + dy, edge });
          return;
        }
        const east = pointer.corner[1] === 'e';
        const south = pointer.corner[0] === 's';
        const anchorX = east ? left : left + edge;
        const anchorY = south ? top : top + edge;
        const maxEdge = Math.min(east ? source.width - anchorX : anchorX, south ? source.height - anchorY : anchorY);
        // Keep the opposite corner fixed and project the drag onto the square's diagonal.
        const delta = ((east ? dx : -dx) + (south ? dy : -dy)) / 2;
        const nextEdge = clamp(edge + delta, minSelectionEdge(), maxEdge);
        updateSelection({ left: east ? anchorX : anchorX - nextEdge, top: south ? anchorY : anchorY - nextEdge, edge: nextEdge });
        return;
      }
      pointer.x = event.clientX;
      pointer.y = event.clientY;
      const zoom = Number(zoomInput.value) / 100;
      const renderedEdge = 256 * zoom;
      const overflowX = Math.max(0, renderedEdge * source.width / Math.min(source.width, source.height) - 256);
      const overflowY = Math.max(0, renderedEdge * source.height / Math.min(source.width, source.height) - 256);
      xInput.value = String(clamp(Number(xInput.value) - (overflowX ? deltaX * 1000 / overflowX : 0), 0, 1000));
      yInput.value = String(clamp(Number(yInput.value) - (overflowY ? deltaY * 1000 / overflowY : 0), 0, 1000));
      draw();
    });
    function stopDragging(event) {
      if (!pointer || (event && pointer.id !== event.pointerId)) return;
      const id = pointer.id;
      pointer = null;
      dragTarget.classList.remove('is-dragging');
      if (dragTarget.hasPointerCapture(id)) dragTarget.releasePointerCapture(id);
    }
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) dragTarget.addEventListener(type, stopDragging);

    editor?.frame.addEventListener('keydown', event => {
      const direction = ARROWS.get(event.key);
      if (!source || pointer || !direction || event.altKey || event.ctrlKey || event.metaKey || fileInput.matches(':disabled')) return;
      event.preventDefault();
      const [x, y] = direction;
      const shortEdge = Math.min(source.width, source.height);
      const step = shortEdge / 80;
      if (event.shiftKey) {
        resizeAroundCenter(clamp(selection.edge + (x || y) * step, minSelectionEdge(), shortEdge));
      } else {
        updateSelection({ ...selection, left: selection.left + x * step, top: selection.top + y * step });
      }
    });

    return {
      get value() { return value; },
      setValue,
      clear,
      dispose() {
        revision += 1;
        closeSource();
      },
    };
  }

  window.AdminAvatar = Object.freeze({ create });
})();
