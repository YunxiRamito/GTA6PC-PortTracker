(() => {
  'use strict';

  const MAX_BYTES = 10 * 1024 * 1024;
  const MAX_PIXELS = 20_000_000;
  const MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

  function create({ fileInput, canvas, controls, xInput, yInput, zoomInput, resetButton, removeButton, status, onChange = () => {}, onError = () => {} }) {
    const placeholder = document.createElement('span');
    placeholder.className = 'avatar-placeholder';
    placeholder.textContent = '头像预览';
    canvas.insertAdjacentElement('beforebegin', placeholder);
    canvas.hidden = true;
    const preview = canvas.getContext('2d', { alpha: false });
    const crop = document.createElement('canvas');
    crop.width = crop.height = 128;
    const cropContext = crop.getContext('2d', { alpha: false });
    let source = null;
    let pointer = null;
    let value = '';
    let revision = 0;

    function message(text) {
      if (status) status.textContent = text;
    }

    function closeSource() {
      if (typeof source?.close === 'function') source.close();
      source = null;
    }

    function draw() {
      if (!source) {
        preview.clearRect(0, 0, canvas.width, canvas.height);
        canvas.hidden = true;
        placeholder.hidden = false;
        return;
      }

      const edge = Math.min(source.width, source.height) / (Number(zoomInput.value) / 100);
      const left = (source.width - edge) * Number(xInput.value) / Number(xInput.max);
      const top = (source.height - edge) * Number(yInput.value) / Number(yInput.max);
      cropContext.clearRect(0, 0, 128, 128);
      cropContext.drawImage(source, left, top, edge, edge, 0, 0, 128, 128);
      preview.clearRect(0, 0, canvas.width, canvas.height);
      preview.drawImage(crop, 0, 0, canvas.width, canvas.height);
      canvas.hidden = false;
      placeholder.hidden = true;
      value = crop.toDataURL('image/png');
      controls.hidden = false;
      onChange(value);
    }

    function setSource(image) {
      closeSource();
      source = image;
      xInput.value = '500';
      yInput.value = '500';
      zoomInput.value = '100';
      draw();
      message('头像已裁切为 128 × 128 PNG。');
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
        value = '';
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
        closeSource();
        source = image;
        xInput.value = '500';
        yInput.value = '500';
        zoomInput.value = '100';
        const edge = Math.min(source.naturalWidth, source.naturalHeight);
        cropContext.clearRect(0, 0, 128, 128);
        cropContext.drawImage(source, (source.naturalWidth - edge) / 2, (source.naturalHeight - edge) / 2, edge, edge, 0, 0, 128, 128);
        preview.clearRect(0, 0, canvas.width, canvas.height);
        preview.drawImage(crop, 0, 0, canvas.width, canvas.height);
        canvas.hidden = false;
        placeholder.hidden = true;
        value = next;
        controls.hidden = false;
        message('当前头像。选择新图片可重新裁切。');
      } catch (error) {
        if (currentRevision !== revision) return;
        onError(error.message || '无法显示当前头像。');
      }
    }

    function clear() {
      revision += 1;
      closeSource();
      value = '';
      fileInput.value = '';
      controls.hidden = true;
      draw();
      message('已移除头像。');
      onChange('');
    }

    fileInput.addEventListener('change', selectFile);
    for (const input of [xInput, yInput, zoomInput]) input.addEventListener('input', draw);
    resetButton?.addEventListener('click', () => {
      if (!source) return;
      xInput.value = '500';
      yInput.value = '500';
      zoomInput.value = '100';
      draw();
      message('已重置裁切位置。');
    });
    removeButton?.addEventListener('click', clear);
    canvas.addEventListener('pointerdown', event => {
      if (!source) return;
      pointer = { id: event.pointerId, x: event.clientX, y: event.clientY };
      canvas.setPointerCapture(event.pointerId);
      canvas.classList.add('is-dragging');
      event.preventDefault();
    });
    canvas.addEventListener('pointermove', event => {
      if (!source || pointer?.id !== event.pointerId) return;
      const deltaX = event.clientX - pointer.x;
      const deltaY = event.clientY - pointer.y;
      pointer.x = event.clientX;
      pointer.y = event.clientY;
      const zoom = Number(zoomInput.value) / 100;
      const renderedEdge = 256 * zoom;
      const overflowX = Math.max(0, renderedEdge * source.width / Math.min(source.width, source.height) - 256);
      const overflowY = Math.max(0, renderedEdge * source.height / Math.min(source.width, source.height) - 256);
      xInput.value = String(Math.max(0, Math.min(1000, Number(xInput.value) - (overflowX ? deltaX * 1000 / overflowX : 0))));
      yInput.value = String(Math.max(0, Math.min(1000, Number(yInput.value) - (overflowY ? deltaY * 1000 / overflowY : 0))));
      draw();
    });
    const stopDragging = event => {
      if (pointer?.id !== event.pointerId) return;
      pointer = null;
      canvas.classList.remove('is-dragging');
    };
    canvas.addEventListener('pointerup', stopDragging);
    canvas.addEventListener('pointercancel', stopDragging);

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
