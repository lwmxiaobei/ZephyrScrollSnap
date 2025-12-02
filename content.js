(function () {
    'use strict';

    // 仅初始化一次监听器，避免重复下载
    if (globalThis.__screenshotExtensionInitialized) {
        return;
    }
    globalThis.__screenshotExtensionInitialized = true;
    globalThis.screenshotCaptureActive = false;

    let isSelecting = false;
    let startX = 0;
    let startY = 0;
    let overlay = null;
    let selection = null;
    let sizeInfo = null;
    let toolbar = null;
    let hint = null;
    let autoScrollInterval = null;
    let toolbarPositionUpdater = null;

    // Drawing board state
    let drawingOverlay = null;
    let drawingCanvas = null;
    let drawingCtx = null;
    let drawingScale = 1;
    let drawingPointerId = null;
    let drawingColor = '#FF2D55';
    let drawingSize = 6;
    let drawingHistory = [];
    let drawingBaseImage = null;
    const DRAWING_HISTORY_LIMIT = 15;
    let drawingKeydownHandler = null;

    // 马赛克模式状态
    let mosaicMode = false;
    let mosaicCanvas = null;
    let mosaicCtx = null;
    let mosaicStartPoint = null;
    let mosaicPreviewRect = null;
    let mosaicHistory = []; // 马赛克操作历史记录
    const MOSAIC_HISTORY_LIMIT = 20;

    // 画笔模式状态
    let penMode = false;
    let penCanvas = null;
    let penCtx = null;
    let penColor = '#FF2D55';
    let penSize = 4;
    let isPenDrawing = false;
    let penHistory = [];
    const PEN_HISTORY_LIMIT = 20;
    let penSettingsPanel = null;

    // 矩形模式状态
    let rectMode = false;
    let rectCanvas = null;
    let rectCtx = null;
    let rectColor = '#FF2D55';
    let rectLineWidth = 3;
    let rectStartPoint = null;
    let rectHistory = [];
    const RECT_HISTORY_LIMIT = 20;
    let rectSettingsPanel = null;
    let rectTempCanvas = null;
    let rectTempCtx = null;

    // 箭头模式状态
    let arrowMode = false;
    let arrowCanvas = null;
    let arrowCtx = null;
    let arrowColor = '#FF2D55';
    let arrowLineWidth = 3;
    let arrowStartPoint = null;
    let arrowHistory = [];
    const ARROW_HISTORY_LIMIT = 20;
    let arrowSettingsPanel = null;
    let arrowTempCanvas = null;
    let arrowTempCtx = null;

    // 监听来自popup和background的消息
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.action === 'ping') {
            sendResponse({ ready: true });
            return;
        }

        if (message.action === 'startCapture') {
            initCapture();
            sendResponse({ success: true });
        } else if (message.action === 'cropAndDownload') {
            cropAndDownload(message.dataUrl, message.cropArea, message.mosaicDataUrl, message.penDataUrl, message.rectDataUrl, message.arrowDataUrl)
                .then(() => sendResponse({ success: true }))
                .catch(err => sendResponse({ success: false, error: err.message }));
            return true; // 保持消息通道开启
        } else if (message.action === 'stitchAndDownload') {
            stitchAndDownload(message.captures, message.cropInfo)
                .then(() => sendResponse({ success: true }))
                .catch(err => sendResponse({ success: false, error: err.message }));
            return true; // 保持消息通道开启
        } else if (message.action === 'captureError') {
            alert('截图失败: ' + message.error);
        }
    });

    function initCapture() {
        if (globalThis.screenshotCaptureActive) {
            return;
        }
        globalThis.screenshotCaptureActive = true;

        // 创建覆盖层
        overlay = document.createElement('div');
        overlay.className = 'screenshot-overlay';
        document.body.appendChild(overlay);

        // 创建提示
        hint = document.createElement('div');
        hint.className = 'screenshot-hint';
        hint.textContent = '拖动鼠标选择截图区域';
        document.body.appendChild(hint);

        // 3秒后隐藏提示
        setTimeout(() => {
            if (hint) {
                hint.style.opacity = '0';
                setTimeout(() => {
                    if (hint && hint.parentNode) {
                        hint.parentNode.removeChild(hint);
                        hint = null;
                    }
                }, 300);
            }
        }, 3000);

        // 绑定事件
        overlay.addEventListener('mousedown', handleMouseDown);
        overlay.addEventListener('mousemove', handleMouseMove);
        overlay.addEventListener('mouseup', handleMouseUp);
        document.addEventListener('keydown', handleKeyDown);
    }

    function handleMouseDown(e) {
        isSelecting = true;
        startX = e.clientX + window.scrollX;
        startY = e.clientY + window.scrollY;

        // 创建选择框
        selection = document.createElement('div');
        selection.className = 'screenshot-selection';
        selection.style.left = startX + 'px';
        selection.style.top = startY + 'px';
        document.body.appendChild(selection);

        // 创建尺寸信息
        sizeInfo = document.createElement('div');
        sizeInfo.className = 'screenshot-size-info';
        document.body.appendChild(sizeInfo);
    }

    function handleMouseMove(e) {
        if (!isSelecting) return;

        const currentX = e.clientX + window.scrollX;
        const currentY = e.clientY + window.scrollY;

        const width = Math.abs(currentX - startX);
        const height = Math.abs(currentY - startY);
        const left = Math.min(currentX, startX);
        const top = Math.min(currentY, startY);

        selection.style.left = left + 'px';
        selection.style.top = top + 'px';
        selection.style.width = width + 'px';
        selection.style.height = height + 'px';

        // 更新尺寸信息
        sizeInfo.textContent = `${Math.round(width)} × ${Math.round(height)}`;
        sizeInfo.style.left = (left + width + 10) + 'px';
        sizeInfo.style.top = top + 'px';

        // 自动滚动: 当鼠标靠近屏幕边缘时
        handleAutoScroll(e.clientX, e.clientY);
    }

    function handleMouseUp(e) {
        if (!isSelecting) return;
        isSelecting = false;

        // 清除自动滚动
        stopAutoScroll();

        const currentX = e.clientX + window.scrollX;
        const currentY = e.clientY + window.scrollY;

        const width = Math.abs(currentX - startX);
        const height = Math.abs(currentY - startY);

        // 如果选择区域太小，忽略
        if (width < 10 || height < 10) {
            cleanup();
            return;
        }

        // 显示工具栏
        showToolbar();
    }

    function removeToolbar() {
        if (toolbar) {
            toolbar.remove();
            toolbar = null;
        }
        if (toolbarPositionUpdater) {
            window.removeEventListener('resize', toolbarPositionUpdater);
            window.removeEventListener('scroll', toolbarPositionUpdater, true);
            toolbarPositionUpdater = null;
        }
    }

    function showToolbar() {
        removeToolbar();

        toolbar = document.createElement('div');
        toolbar.className = 'screenshot-toolbar';

        const mosaicBtn = buildToolbarButton('screenshot-btn-mosaic', '▦', '马赛克', toggleMosaicMode);
        const penBtn = buildToolbarButton('screenshot-btn-pen', '✏', '画笔', togglePenMode);
        const rectBtn = buildToolbarButton('screenshot-btn-rect', '□', '矩形', toggleRectMode);
        const arrowBtn = buildToolbarButton('screenshot-btn-arrow', '→', '箭头', toggleArrowMode);
        const undoBtn = buildToolbarButton('screenshot-btn-undo', '↩', '撤销', handleUndo);
        const confirmBtn = buildToolbarButton('screenshot-btn-confirm', '✓', '确认截图', captureScreenshot);
        const cancelBtn = buildToolbarButton('screenshot-btn-cancel', '✕', '取消', handleCancelSelection);

        toolbar.appendChild(mosaicBtn);
        toolbar.appendChild(penBtn);
        toolbar.appendChild(rectBtn);
        toolbar.appendChild(arrowBtn);
        toolbar.appendChild(undoBtn);
        toolbar.appendChild(confirmBtn);
        toolbar.appendChild(cancelBtn);
        document.body.appendChild(toolbar);

        toolbarPositionUpdater = () => updateToolbarPosition();
        updateToolbarPosition();
        window.addEventListener('resize', toolbarPositionUpdater);
        window.addEventListener('scroll', toolbarPositionUpdater, true);
    }

    function handleCancelSelection(event) {
        if (event) {
            event.preventDefault();
            event.stopPropagation();
        }
        cleanup();
    }

    function toggleMosaicMode(event) {
        if (event) {
            event.preventDefault();
            event.stopPropagation();
        }

        // 如果画笔模式激活，先关闭它（但保留画布）
        if (penMode) {
            penMode = false;
            toolbar?.querySelector('.screenshot-btn-pen')?.classList.remove('active');
            hidePenSettings();
            if (penCanvas) {
                penCanvas.style.pointerEvents = 'none';
            }
        }

        // 如果矩形模式激活，先关闭它（但保留画布）
        if (rectMode) {
            rectMode = false;
            toolbar?.querySelector('.screenshot-btn-rect')?.classList.remove('active');
            hideRectSettings();
            if (rectCanvas) {
                rectCanvas.style.pointerEvents = 'none';
            }
        }

        // 如果箭头模式激活，先关闭它（但保留画布）
        if (arrowMode) {
            arrowMode = false;
            toolbar?.querySelector('.screenshot-btn-arrow')?.classList.remove('active');
            hideArrowSettings();
            if (arrowCanvas) {
                arrowCanvas.style.pointerEvents = 'none';
            }
        }

        mosaicMode = !mosaicMode;
        console.log('马赛克模式:', mosaicMode);
        const btn = toolbar?.querySelector('.screenshot-btn-mosaic');

        if (mosaicMode) {
            btn?.classList.add('active');
            // 如果马赛克画布已存在，只需启用交互
            if (mosaicCanvas) {
                mosaicCanvas.style.pointerEvents = 'auto';
            } else {
                initMosaicCanvas();
            }
        } else {
            btn?.classList.remove('active');
            // 禁用马赛克画布的交互，但不删除
            if (mosaicCanvas) {
                mosaicCanvas.style.pointerEvents = 'none';
            }
        }
    }

    function initMosaicCanvas() {
        if (!selection) {
            console.log('selection 不存在');
            return;
        }

        const selX = parseInt(selection.style.left);
        const selY = parseInt(selection.style.top);
        const selWidth = parseInt(selection.style.width);
        const selHeight = parseInt(selection.style.height);

        console.log('创建马赛克画布:', selX, selY, selWidth, selHeight);

        mosaicCanvas = document.createElement('canvas');
        mosaicCanvas.width = selWidth;
        mosaicCanvas.height = selHeight;
        mosaicCanvas.style.cssText = `
            position: absolute;
            left: ${selX}px;
            top: ${selY}px;
            width: ${selWidth}px;
            height: ${selHeight}px;
            cursor: crosshair;
            z-index: 2147483647;
        `;
        mosaicCtx = mosaicCanvas.getContext('2d');
        document.body.appendChild(mosaicCanvas);

        mosaicPreviewRect = document.createElement('div');
        mosaicPreviewRect.style.cssText = `
            position: absolute;
            border: 2px dashed #FF2D55;
            background: rgba(255, 45, 85, 0.1);
            pointer-events: none;
            display: none;
            z-index: 2147483647;
        `;
        document.body.appendChild(mosaicPreviewRect);

        mosaicCanvas.addEventListener('mousedown', handleMosaicMouseDown);
        mosaicCanvas.addEventListener('mousemove', handleMosaicMouseMove);
        mosaicCanvas.addEventListener('mouseup', handleMosaicMouseUp);
        mosaicCanvas.addEventListener('mouseleave', handleMosaicMouseUp);

        // 初始化历史记录（保存空白状态）
        mosaicHistory = [mosaicCanvas.toDataURL('image/png')];
    }

    function removeMosaicCanvas() {
        if (mosaicCanvas) {
            mosaicCanvas.removeEventListener('mousedown', handleMosaicMouseDown);
            mosaicCanvas.removeEventListener('mousemove', handleMosaicMouseMove);
            mosaicCanvas.removeEventListener('mouseup', handleMosaicMouseUp);
            mosaicCanvas.removeEventListener('mouseleave', handleMosaicMouseUp);
            mosaicCanvas.remove();
            mosaicCanvas = null;
            mosaicCtx = null;
        }
        if (mosaicPreviewRect) {
            mosaicPreviewRect.remove();
            mosaicPreviewRect = null;
        }
        mosaicStartPoint = null;
        mosaicHistory = [];
    }

    function handleMosaicMouseDown(e) {
        e.preventDefault();
        const rect = mosaicCanvas.getBoundingClientRect();
        mosaicStartPoint = {
            x: e.clientX - rect.left,
            y: e.clientY - rect.top
        };
    }

    function handleMosaicMouseMove(e) {
        if (!mosaicStartPoint || !mosaicPreviewRect) return;

        const rect = mosaicCanvas.getBoundingClientRect();
        const currentX = e.clientX - rect.left;
        const currentY = e.clientY - rect.top;

        const selX = parseInt(selection.style.left);
        const selY = parseInt(selection.style.top);

        const left = Math.min(mosaicStartPoint.x, currentX);
        const top = Math.min(mosaicStartPoint.y, currentY);
        const width = Math.abs(currentX - mosaicStartPoint.x);
        const height = Math.abs(currentY - mosaicStartPoint.y);

        mosaicPreviewRect.style.display = 'block';
        mosaicPreviewRect.style.left = (selX + left) + 'px';
        mosaicPreviewRect.style.top = (selY + top) + 'px';
        mosaicPreviewRect.style.width = width + 'px';
        mosaicPreviewRect.style.height = height + 'px';
    }

    function handleMosaicMouseUp(e) {
        if (!mosaicStartPoint) return;

        const rect = mosaicCanvas.getBoundingClientRect();
        const endX = e.clientX - rect.left;
        const endY = e.clientY - rect.top;

        const x = Math.max(0, Math.min(mosaicStartPoint.x, endX));
        const y = Math.max(0, Math.min(mosaicStartPoint.y, endY));
        const width = Math.min(Math.abs(endX - mosaicStartPoint.x), mosaicCanvas.width - x);
        const height = Math.min(Math.abs(endY - mosaicStartPoint.y), mosaicCanvas.height - y);

        if (width > 5 && height > 5) {
            applyMosaicEffect(x, y, width, height);
            // 保存到历史记录
            pushMosaicHistory();
        }

        mosaicStartPoint = null;
        if (mosaicPreviewRect) {
            mosaicPreviewRect.style.display = 'none';
        }
    }

    function applyMosaicEffect(x, y, width, height) {
        if (!mosaicCtx) return;
        const mosaicSize = Math.max(8, Math.min(width, height) / 10);
        for (let j = 0; j < height; j += mosaicSize) {
            for (let i = 0; i < width; i += mosaicSize) {
                const gray = Math.floor(Math.random() * 100 + 100);
                mosaicCtx.fillStyle = `rgb(${gray}, ${gray}, ${gray})`;
                mosaicCtx.fillRect(x + i, y + j, mosaicSize, mosaicSize);
            }
        }
    }

    /**
     * 保存马赛克历史记录
     */
    function pushMosaicHistory() {
        if (!mosaicCanvas) return;
        const snapshot = mosaicCanvas.toDataURL('image/png');
        mosaicHistory.push(snapshot);
        if (mosaicHistory.length > MOSAIC_HISTORY_LIMIT) {
            mosaicHistory.shift();
        }
    }

    /**
     * 撤销马赛克操作
     */
    function undoMosaic(event) {
        if (event) {
            event.preventDefault();
            event.stopPropagation();
        }

        if (mosaicHistory.length <= 1 || !mosaicCanvas || !mosaicCtx) {
            return;
        }

        // 移除当前状态
        mosaicHistory.pop();
        // 恢复到上一个状态
        const previous = mosaicHistory.at(-1);
        restoreMosaicFromData(previous);
    }

    /**
     * 从数据恢复马赛克画布
     */
    function restoreMosaicFromData(dataUrl) {
        if (!mosaicCtx || !mosaicCanvas) return;
        const img = new Image();
        img.onload = () => {
            mosaicCtx.clearRect(0, 0, mosaicCanvas.width, mosaicCanvas.height);
            mosaicCtx.drawImage(img, 0, 0);
        };
        img.src = dataUrl;
    }

    /**
     * 统一的撤销函数
     */
    function handleUndo(event) {
        if (event) {
            event.preventDefault();
            event.stopPropagation();
        }
        // 优先撤销箭头，然后矩形，画笔，最后马赛克
        if (arrowHistory.length > 1) {
            undoArrow();
        } else if (rectHistory.length > 1) {
            undoRect();
        } else if (penHistory.length > 1) {
            undoPen();
        } else if (mosaicHistory.length > 1) {
            undoMosaic();
        }
    }

    /**
     * 切换画笔模式
     */
    function togglePenMode(event) {
        if (event) {
            event.preventDefault();
            event.stopPropagation();
        }

        // 如果马赛克模式激活，先关闭它（但保留画布）
        if (mosaicMode) {
            mosaicMode = false;
            toolbar?.querySelector('.screenshot-btn-mosaic')?.classList.remove('active');
            if (mosaicCanvas) {
                mosaicCanvas.style.pointerEvents = 'none';
            }
            if (mosaicPreviewRect) {
                mosaicPreviewRect.style.display = 'none';
            }
        }

        // 如果矩形模式激活，先关闭它（但保留画布）
        if (rectMode) {
            rectMode = false;
            toolbar?.querySelector('.screenshot-btn-rect')?.classList.remove('active');
            hideRectSettings();
            if (rectCanvas) {
                rectCanvas.style.pointerEvents = 'none';
            }
        }

        // 如果箭头模式激活，先关闭它（但保留画布）
        if (arrowMode) {
            arrowMode = false;
            toolbar?.querySelector('.screenshot-btn-arrow')?.classList.remove('active');
            hideArrowSettings();
            if (arrowCanvas) {
                arrowCanvas.style.pointerEvents = 'none';
            }
        }

        penMode = !penMode;
        console.log('画笔模式:', penMode);
        const btn = toolbar?.querySelector('.screenshot-btn-pen');

        if (penMode) {
            btn?.classList.add('active');
            // 如果画笔画布已存在，只需启用交互
            if (penCanvas) {
                penCanvas.style.pointerEvents = 'auto';
            } else {
                initPenCanvas();
            }
            showPenSettings();
        } else {
            btn?.classList.remove('active');
            // 禁用画笔画布的交互，但不删除
            if (penCanvas) {
                penCanvas.style.pointerEvents = 'none';
            }
            hidePenSettings();
        }
    }

    /**
     * 初始化画笔画布
     */
    function initPenCanvas() {
        if (!selection) {
            console.log('selection 不存在');
            return;
        }

        const selX = parseInt(selection.style.left);
        const selY = parseInt(selection.style.top);
        const selWidth = parseInt(selection.style.width);
        const selHeight = parseInt(selection.style.height);

        console.log('创建画笔画布:', selX, selY, selWidth, selHeight);

        penCanvas = document.createElement('canvas');
        penCanvas.width = selWidth;
        penCanvas.height = selHeight;
        penCanvas.style.cssText = `
            position: absolute;
            left: ${selX}px;
            top: ${selY}px;
            width: ${selWidth}px;
            height: ${selHeight}px;
            cursor: crosshair;
            z-index: 2147483647;
        `;
        penCtx = penCanvas.getContext('2d');
        document.body.appendChild(penCanvas);

        penCanvas.addEventListener('mousedown', handlePenMouseDown);
        penCanvas.addEventListener('mousemove', handlePenMouseMove);
        penCanvas.addEventListener('mouseup', handlePenMouseUp);
        penCanvas.addEventListener('mouseleave', handlePenMouseUp);

        // 初始化历史记录
        penHistory = [penCanvas.toDataURL('image/png')];
    }

    /**
     * 移除画笔画布
     */
    function removePenCanvas() {
        if (penCanvas) {
            penCanvas.removeEventListener('mousedown', handlePenMouseDown);
            penCanvas.removeEventListener('mousemove', handlePenMouseMove);
            penCanvas.removeEventListener('mouseup', handlePenMouseUp);
            penCanvas.removeEventListener('mouseleave', handlePenMouseUp);
            penCanvas.remove();
            penCanvas = null;
            penCtx = null;
        }
        isPenDrawing = false;
        penHistory = [];
        hidePenSettings();
    }

    /**
     * 显示画笔设置面板
     */
    function showPenSettings() {
        hidePenSettings();

        penSettingsPanel = document.createElement('div');
        penSettingsPanel.className = 'screenshot-pen-settings';

        // 颜色选择
        const colorWrapper = document.createElement('div');
        colorWrapper.className = 'screenshot-pen-setting-item';
        const colorLabel = document.createElement('span');
        colorLabel.textContent = '颜色';
        const colorInput = document.createElement('input');
        colorInput.type = 'color';
        colorInput.value = penColor;
        colorInput.addEventListener('input', (e) => {
            penColor = e.target.value;
        });
        colorWrapper.appendChild(colorLabel);
        colorWrapper.appendChild(colorInput);

        // 粗细选择
        const sizeWrapper = document.createElement('div');
        sizeWrapper.className = 'screenshot-pen-setting-item';
        const sizeLabel = document.createElement('span');
        sizeLabel.textContent = '粗细';
        const sizeValue = document.createElement('span');
        sizeValue.className = 'screenshot-pen-size-value';
        sizeValue.textContent = `${penSize}px`;
        const sizeInput = document.createElement('input');
        sizeInput.type = 'range';
        sizeInput.min = '1';
        sizeInput.max = '20';
        sizeInput.value = String(penSize);
        sizeInput.addEventListener('input', (e) => {
            penSize = Number(e.target.value);
            sizeValue.textContent = `${penSize}px`;
        });
        sizeWrapper.appendChild(sizeLabel);
        sizeWrapper.appendChild(sizeInput);
        sizeWrapper.appendChild(sizeValue);

        penSettingsPanel.appendChild(colorWrapper);
        penSettingsPanel.appendChild(sizeWrapper);
        document.body.appendChild(penSettingsPanel);

        updatePenSettingsPosition();
    }

    /**
     * 隐藏画笔设置面板
     */
    function hidePenSettings() {
        if (penSettingsPanel) {
            penSettingsPanel.remove();
            penSettingsPanel = null;
        }
    }

    /**
     * 更新画笔设置面板位置
     */
    function updatePenSettingsPosition() {
        if (!penSettingsPanel || !toolbar) return;

        const toolbarRect = toolbar.getBoundingClientRect();
        penSettingsPanel.style.left = `${toolbarRect.left}px`;
        penSettingsPanel.style.top = `${toolbarRect.bottom + 8}px`;
    }

    function handlePenMouseDown(e) {
        e.preventDefault();
        isPenDrawing = true;
        const rect = penCanvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        penCtx.beginPath();
        penCtx.moveTo(x, y);
        penCtx.strokeStyle = penColor;
        penCtx.lineWidth = penSize;
        penCtx.lineCap = 'round';
        penCtx.lineJoin = 'round';
    }

    function handlePenMouseMove(e) {
        if (!isPenDrawing) return;
        e.preventDefault();

        const rect = penCanvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        penCtx.lineTo(x, y);
        penCtx.stroke();
    }

    function handlePenMouseUp(e) {
        if (!isPenDrawing) return;
        e.preventDefault();
        isPenDrawing = false;
        penCtx.closePath();
        pushPenHistory();
    }

    /**
     * 保存画笔历史记录
     */
    function pushPenHistory() {
        if (!penCanvas) return;
        const snapshot = penCanvas.toDataURL('image/png');
        penHistory.push(snapshot);
        if (penHistory.length > PEN_HISTORY_LIMIT) {
            penHistory.shift();
        }
    }

    /**
     * 撤销画笔操作
     */
    function undoPen() {
        if (penHistory.length <= 1 || !penCanvas || !penCtx) {
            return;
        }
        penHistory.pop();
        const previous = penHistory.at(-1);
        restorePenFromData(previous);
    }

    /**
     * 从数据恢复画笔画布
     */
    function restorePenFromData(dataUrl) {
        if (!penCtx || !penCanvas) return;
        const img = new Image();
        img.onload = () => {
            penCtx.clearRect(0, 0, penCanvas.width, penCanvas.height);
            penCtx.drawImage(img, 0, 0);
        };
        img.src = dataUrl;
    }

    /**
     * 切换矩形模式
     */
    function toggleRectMode(event) {
        if (event) {
            event.preventDefault();
            event.stopPropagation();
        }

        // 关闭其他模式
        if (mosaicMode) {
            mosaicMode = false;
            toolbar?.querySelector('.screenshot-btn-mosaic')?.classList.remove('active');
            if (mosaicCanvas) mosaicCanvas.style.pointerEvents = 'none';
            if (mosaicPreviewRect) mosaicPreviewRect.style.display = 'none';
        }
        if (penMode) {
            penMode = false;
            toolbar?.querySelector('.screenshot-btn-pen')?.classList.remove('active');
            hidePenSettings();
            if (penCanvas) penCanvas.style.pointerEvents = 'none';
        }
        if (arrowMode) {
            arrowMode = false;
            toolbar?.querySelector('.screenshot-btn-arrow')?.classList.remove('active');
            hideArrowSettings();
            if (arrowCanvas) arrowCanvas.style.pointerEvents = 'none';
        }

        rectMode = !rectMode;
        console.log('矩形模式:', rectMode);
        const btn = toolbar?.querySelector('.screenshot-btn-rect');

        if (rectMode) {
            btn?.classList.add('active');
            if (rectCanvas) {
                rectCanvas.style.pointerEvents = 'auto';
            } else {
                initRectCanvas();
            }
            showRectSettings();
        } else {
            btn?.classList.remove('active');
            if (rectCanvas) {
                rectCanvas.style.pointerEvents = 'none';
            }
            hideRectSettings();
        }
    }

    /**
     * 初始化矩形画布
     */
    function initRectCanvas() {
        if (!selection) return;

        const selX = parseInt(selection.style.left);
        const selY = parseInt(selection.style.top);
        const selWidth = parseInt(selection.style.width);
        const selHeight = parseInt(selection.style.height);

        // 主画布（保存最终结果）
        rectCanvas = document.createElement('canvas');
        rectCanvas.width = selWidth;
        rectCanvas.height = selHeight;
        rectCanvas.style.cssText = `
            position: absolute;
            left: ${selX}px;
            top: ${selY}px;
            width: ${selWidth}px;
            height: ${selHeight}px;
            cursor: crosshair;
            z-index: 2147483647;
        `;
        rectCtx = rectCanvas.getContext('2d');
        document.body.appendChild(rectCanvas);

        // 临时画布（用于实时预览）
        rectTempCanvas = document.createElement('canvas');
        rectTempCanvas.width = selWidth;
        rectTempCanvas.height = selHeight;
        rectTempCanvas.style.cssText = `
            position: absolute;
            left: ${selX}px;
            top: ${selY}px;
            width: ${selWidth}px;
            height: ${selHeight}px;
            pointer-events: none;
            z-index: 2147483647;
        `;
        rectTempCtx = rectTempCanvas.getContext('2d');
        document.body.appendChild(rectTempCanvas);

        rectCanvas.addEventListener('mousedown', handleRectMouseDown);
        rectCanvas.addEventListener('mousemove', handleRectMouseMove);
        rectCanvas.addEventListener('mouseup', handleRectMouseUp);
        rectCanvas.addEventListener('mouseleave', handleRectMouseUp);

        rectHistory = [rectCanvas.toDataURL('image/png')];
    }

    /**
     * 移除矩形画布
     */
    function removeRectCanvas() {
        if (rectCanvas) {
            rectCanvas.removeEventListener('mousedown', handleRectMouseDown);
            rectCanvas.removeEventListener('mousemove', handleRectMouseMove);
            rectCanvas.removeEventListener('mouseup', handleRectMouseUp);
            rectCanvas.removeEventListener('mouseleave', handleRectMouseUp);
            rectCanvas.remove();
            rectCanvas = null;
            rectCtx = null;
        }
        if (rectTempCanvas) {
            rectTempCanvas.remove();
            rectTempCanvas = null;
            rectTempCtx = null;
        }
        rectStartPoint = null;
        rectHistory = [];
        hideRectSettings();
    }

    /**
     * 显示矩形设置面板
     */
    function showRectSettings() {
        hideRectSettings();

        rectSettingsPanel = document.createElement('div');
        rectSettingsPanel.className = 'screenshot-pen-settings';

        // 颜色选择
        const colorWrapper = document.createElement('div');
        colorWrapper.className = 'screenshot-pen-setting-item';
        const colorLabel = document.createElement('span');
        colorLabel.textContent = '颜色';
        const colorInput = document.createElement('input');
        colorInput.type = 'color';
        colorInput.value = rectColor;
        colorInput.addEventListener('input', (e) => {
            rectColor = e.target.value;
        });
        colorWrapper.appendChild(colorLabel);
        colorWrapper.appendChild(colorInput);

        // 粗细选择
        const sizeWrapper = document.createElement('div');
        sizeWrapper.className = 'screenshot-pen-setting-item';
        const sizeLabel = document.createElement('span');
        sizeLabel.textContent = '粗细';
        const sizeValue = document.createElement('span');
        sizeValue.className = 'screenshot-pen-size-value';
        sizeValue.textContent = `${rectLineWidth}px`;
        const sizeInput = document.createElement('input');
        sizeInput.type = 'range';
        sizeInput.min = '1';
        sizeInput.max = '10';
        sizeInput.value = String(rectLineWidth);
        sizeInput.addEventListener('input', (e) => {
            rectLineWidth = Number(e.target.value);
            sizeValue.textContent = `${rectLineWidth}px`;
        });
        sizeWrapper.appendChild(sizeLabel);
        sizeWrapper.appendChild(sizeInput);
        sizeWrapper.appendChild(sizeValue);

        rectSettingsPanel.appendChild(colorWrapper);
        rectSettingsPanel.appendChild(sizeWrapper);
        document.body.appendChild(rectSettingsPanel);

        updateRectSettingsPosition();
    }

    /**
     * 隐藏矩形设置面板
     */
    function hideRectSettings() {
        if (rectSettingsPanel) {
            rectSettingsPanel.remove();
            rectSettingsPanel = null;
        }
    }

    /**
     * 更新矩形设置面板位置
     */
    function updateRectSettingsPosition() {
        if (!rectSettingsPanel || !toolbar) return;
        const toolbarRect = toolbar.getBoundingClientRect();
        rectSettingsPanel.style.left = `${toolbarRect.left}px`;
        rectSettingsPanel.style.top = `${toolbarRect.bottom + 8}px`;
    }

    function handleRectMouseDown(e) {
        e.preventDefault();
        const rect = rectCanvas.getBoundingClientRect();
        rectStartPoint = {
            x: e.clientX - rect.left,
            y: e.clientY - rect.top
        };
    }

    function handleRectMouseMove(e) {
        if (!rectStartPoint || !rectTempCtx) return;
        e.preventDefault();

        const rect = rectCanvas.getBoundingClientRect();
        const currentX = e.clientX - rect.left;
        const currentY = e.clientY - rect.top;

        // 清除临时画布
        rectTempCtx.clearRect(0, 0, rectTempCanvas.width, rectTempCanvas.height);

        // 绘制预览矩形
        const x = Math.min(rectStartPoint.x, currentX);
        const y = Math.min(rectStartPoint.y, currentY);
        const width = Math.abs(currentX - rectStartPoint.x);
        const height = Math.abs(currentY - rectStartPoint.y);

        rectTempCtx.strokeStyle = rectColor;
        rectTempCtx.lineWidth = rectLineWidth;
        rectTempCtx.strokeRect(x, y, width, height);
    }

    function handleRectMouseUp(e) {
        if (!rectStartPoint) return;
        e.preventDefault();

        const rect = rectCanvas.getBoundingClientRect();
        const endX = e.clientX - rect.left;
        const endY = e.clientY - rect.top;

        const x = Math.min(rectStartPoint.x, endX);
        const y = Math.min(rectStartPoint.y, endY);
        const width = Math.abs(endX - rectStartPoint.x);
        const height = Math.abs(endY - rectStartPoint.y);

        // 清除临时画布
        if (rectTempCtx) {
            rectTempCtx.clearRect(0, 0, rectTempCanvas.width, rectTempCanvas.height);
        }

        // 在主画布上绘制矩形
        if (width > 3 && height > 3 && rectCtx) {
            rectCtx.strokeStyle = rectColor;
            rectCtx.lineWidth = rectLineWidth;
            rectCtx.strokeRect(x, y, width, height);
            pushRectHistory();
        }

        rectStartPoint = null;
    }

    /**
     * 保存矩形历史记录
     */
    function pushRectHistory() {
        if (!rectCanvas) return;
        const snapshot = rectCanvas.toDataURL('image/png');
        rectHistory.push(snapshot);
        if (rectHistory.length > RECT_HISTORY_LIMIT) {
            rectHistory.shift();
        }
    }

    /**
     * 撤销矩形操作
     */
    function undoRect() {
        if (rectHistory.length <= 1 || !rectCanvas || !rectCtx) {
            return;
        }
        rectHistory.pop();
        const previous = rectHistory.at(-1);
        restoreRectFromData(previous);
    }

    /**
     * 从数据恢复矩形画布
     */
    function restoreRectFromData(dataUrl) {
        if (!rectCtx || !rectCanvas) return;
        const img = new Image();
        img.onload = () => {
            rectCtx.clearRect(0, 0, rectCanvas.width, rectCanvas.height);
            rectCtx.drawImage(img, 0, 0);
        };
        img.src = dataUrl;
    }

    /**
     * 切换箭头模式
     */
    function toggleArrowMode(event) {
        if (event) {
            event.preventDefault();
            event.stopPropagation();
        }

        // 关闭其他模式
        if (mosaicMode) {
            mosaicMode = false;
            toolbar?.querySelector('.screenshot-btn-mosaic')?.classList.remove('active');
            if (mosaicCanvas) mosaicCanvas.style.pointerEvents = 'none';
            if (mosaicPreviewRect) mosaicPreviewRect.style.display = 'none';
        }
        if (penMode) {
            penMode = false;
            toolbar?.querySelector('.screenshot-btn-pen')?.classList.remove('active');
            hidePenSettings();
            if (penCanvas) penCanvas.style.pointerEvents = 'none';
        }
        if (rectMode) {
            rectMode = false;
            toolbar?.querySelector('.screenshot-btn-rect')?.classList.remove('active');
            hideRectSettings();
            if (rectCanvas) rectCanvas.style.pointerEvents = 'none';
        }

        arrowMode = !arrowMode;
        console.log('箭头模式:', arrowMode);
        const btn = toolbar?.querySelector('.screenshot-btn-arrow');

        if (arrowMode) {
            btn?.classList.add('active');
            if (arrowCanvas) {
                arrowCanvas.style.pointerEvents = 'auto';
            } else {
                initArrowCanvas();
            }
            showArrowSettings();
        } else {
            btn?.classList.remove('active');
            if (arrowCanvas) {
                arrowCanvas.style.pointerEvents = 'none';
            }
            hideArrowSettings();
        }
    }

    /**
     * 初始化箭头画布
     */
    function initArrowCanvas() {
        if (!selection) return;

        const selX = parseInt(selection.style.left);
        const selY = parseInt(selection.style.top);
        const selWidth = parseInt(selection.style.width);
        const selHeight = parseInt(selection.style.height);

        // 主画布
        arrowCanvas = document.createElement('canvas');
        arrowCanvas.width = selWidth;
        arrowCanvas.height = selHeight;
        arrowCanvas.style.cssText = `
            position: absolute;
            left: ${selX}px;
            top: ${selY}px;
            width: ${selWidth}px;
            height: ${selHeight}px;
            cursor: crosshair;
            z-index: 2147483647;
        `;
        arrowCtx = arrowCanvas.getContext('2d');
        document.body.appendChild(arrowCanvas);

        // 临时画布
        arrowTempCanvas = document.createElement('canvas');
        arrowTempCanvas.width = selWidth;
        arrowTempCanvas.height = selHeight;
        arrowTempCanvas.style.cssText = `
            position: absolute;
            left: ${selX}px;
            top: ${selY}px;
            width: ${selWidth}px;
            height: ${selHeight}px;
            pointer-events: none;
            z-index: 2147483647;
        `;
        arrowTempCtx = arrowTempCanvas.getContext('2d');
        document.body.appendChild(arrowTempCanvas);

        arrowCanvas.addEventListener('mousedown', handleArrowMouseDown);
        arrowCanvas.addEventListener('mousemove', handleArrowMouseMove);
        arrowCanvas.addEventListener('mouseup', handleArrowMouseUp);
        arrowCanvas.addEventListener('mouseleave', handleArrowMouseUp);

        arrowHistory = [arrowCanvas.toDataURL('image/png')];
    }

    /**
     * 移除箭头画布
     */
    function removeArrowCanvas() {
        if (arrowCanvas) {
            arrowCanvas.removeEventListener('mousedown', handleArrowMouseDown);
            arrowCanvas.removeEventListener('mousemove', handleArrowMouseMove);
            arrowCanvas.removeEventListener('mouseup', handleArrowMouseUp);
            arrowCanvas.removeEventListener('mouseleave', handleArrowMouseUp);
            arrowCanvas.remove();
            arrowCanvas = null;
            arrowCtx = null;
        }
        if (arrowTempCanvas) {
            arrowTempCanvas.remove();
            arrowTempCanvas = null;
            arrowTempCtx = null;
        }
        arrowStartPoint = null;
        arrowHistory = [];
        hideArrowSettings();
    }

    /**
     * 显示箭头设置面板
     */
    function showArrowSettings() {
        hideArrowSettings();

        arrowSettingsPanel = document.createElement('div');
        arrowSettingsPanel.className = 'screenshot-pen-settings';

        // 颜色选择
        const colorWrapper = document.createElement('div');
        colorWrapper.className = 'screenshot-pen-setting-item';
        const colorLabel = document.createElement('span');
        colorLabel.textContent = '颜色';
        const colorInput = document.createElement('input');
        colorInput.type = 'color';
        colorInput.value = arrowColor;
        colorInput.addEventListener('input', (e) => {
            arrowColor = e.target.value;
        });
        colorWrapper.appendChild(colorLabel);
        colorWrapper.appendChild(colorInput);

        // 粗细选择
        const sizeWrapper = document.createElement('div');
        sizeWrapper.className = 'screenshot-pen-setting-item';
        const sizeLabel = document.createElement('span');
        sizeLabel.textContent = '粗细';
        const sizeValue = document.createElement('span');
        sizeValue.className = 'screenshot-pen-size-value';
        sizeValue.textContent = `${arrowLineWidth}px`;
        const sizeInput = document.createElement('input');
        sizeInput.type = 'range';
        sizeInput.min = '1';
        sizeInput.max = '10';
        sizeInput.value = String(arrowLineWidth);
        sizeInput.addEventListener('input', (e) => {
            arrowLineWidth = Number(e.target.value);
            sizeValue.textContent = `${arrowLineWidth}px`;
        });
        sizeWrapper.appendChild(sizeLabel);
        sizeWrapper.appendChild(sizeInput);
        sizeWrapper.appendChild(sizeValue);

        arrowSettingsPanel.appendChild(colorWrapper);
        arrowSettingsPanel.appendChild(sizeWrapper);
        document.body.appendChild(arrowSettingsPanel);

        updateArrowSettingsPosition();
    }

    /**
     * 隐藏箭头设置面板
     */
    function hideArrowSettings() {
        if (arrowSettingsPanel) {
            arrowSettingsPanel.remove();
            arrowSettingsPanel = null;
        }
    }

    /**
     * 更新箭头设置面板位置
     */
    function updateArrowSettingsPosition() {
        if (!arrowSettingsPanel || !toolbar) return;
        const toolbarRect = toolbar.getBoundingClientRect();
        arrowSettingsPanel.style.left = `${toolbarRect.left}px`;
        arrowSettingsPanel.style.top = `${toolbarRect.bottom + 8}px`;
    }

    function handleArrowMouseDown(e) {
        e.preventDefault();
        const rect = arrowCanvas.getBoundingClientRect();
        arrowStartPoint = {
            x: e.clientX - rect.left,
            y: e.clientY - rect.top
        };
    }

    function handleArrowMouseMove(e) {
        if (!arrowStartPoint || !arrowTempCtx) return;
        e.preventDefault();

        const rect = arrowCanvas.getBoundingClientRect();
        const currentX = e.clientX - rect.left;
        const currentY = e.clientY - rect.top;

        // 清除临时画布
        arrowTempCtx.clearRect(0, 0, arrowTempCanvas.width, arrowTempCanvas.height);

        // 绘制预览箭头
        drawArrow(arrowTempCtx, arrowStartPoint.x, arrowStartPoint.y, currentX, currentY, arrowColor, arrowLineWidth);
    }

    function handleArrowMouseUp(e) {
        if (!arrowStartPoint) return;
        e.preventDefault();

        const rect = arrowCanvas.getBoundingClientRect();
        const endX = e.clientX - rect.left;
        const endY = e.clientY - rect.top;

        // 清除临时画布
        if (arrowTempCtx) {
            arrowTempCtx.clearRect(0, 0, arrowTempCanvas.width, arrowTempCanvas.height);
        }

        // 计算箭头长度
        const dx = endX - arrowStartPoint.x;
        const dy = endY - arrowStartPoint.y;
        const length = Math.sqrt(dx * dx + dy * dy);

        // 在主画布上绘制箭头
        if (length > 10 && arrowCtx) {
            drawArrow(arrowCtx, arrowStartPoint.x, arrowStartPoint.y, endX, endY, arrowColor, arrowLineWidth);
            pushArrowHistory();
        }

        arrowStartPoint = null;
    }

    /**
     * 绘制箭头
     */
    function drawArrow(ctx, fromX, fromY, toX, toY, color, lineWidth) {
        const headLength = Math.max(10, lineWidth * 4);
        const angle = Math.atan2(toY - fromY, toX - fromX);

        ctx.strokeStyle = color;
        ctx.fillStyle = color;
        ctx.lineWidth = lineWidth;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        // 绘制箭头主线
        ctx.beginPath();
        ctx.moveTo(fromX, fromY);
        ctx.lineTo(toX, toY);
        ctx.stroke();

        // 绘制箭头头部
        ctx.beginPath();
        ctx.moveTo(toX, toY);
        ctx.lineTo(
            toX - headLength * Math.cos(angle - Math.PI / 6),
            toY - headLength * Math.sin(angle - Math.PI / 6)
        );
        ctx.lineTo(
            toX - headLength * Math.cos(angle + Math.PI / 6),
            toY - headLength * Math.sin(angle + Math.PI / 6)
        );
        ctx.closePath();
        ctx.fill();
    }

    /**
     * 保存箭头历史记录
     */
    function pushArrowHistory() {
        if (!arrowCanvas) return;
        const snapshot = arrowCanvas.toDataURL('image/png');
        arrowHistory.push(snapshot);
        if (arrowHistory.length > ARROW_HISTORY_LIMIT) {
            arrowHistory.shift();
        }
    }

    /**
     * 撤销箭头操作
     */
    function undoArrow() {
        if (arrowHistory.length <= 1 || !arrowCanvas || !arrowCtx) {
            return;
        }
        arrowHistory.pop();
        const previous = arrowHistory.at(-1);
        restoreArrowFromData(previous);
    }

    /**
     * 从数据恢复箭头画布
     */
    function restoreArrowFromData(dataUrl) {
        if (!arrowCtx || !arrowCanvas) return;
        const img = new Image();
        img.onload = () => {
            arrowCtx.clearRect(0, 0, arrowCanvas.width, arrowCanvas.height);
            arrowCtx.drawImage(img, 0, 0);
        };
        img.src = dataUrl;
    }

    function buildToolbarButton(className, iconText, labelText, onClick) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = className;

        const icon = document.createElement('span');
        icon.className = 'screenshot-btn-icon';
        icon.textContent = iconText;

        const label = document.createElement('span');
        label.className = 'screenshot-btn-label';
        label.textContent = labelText;

        button.appendChild(icon);
        button.appendChild(label);
        button.addEventListener('click', onClick);
        return button;
    }

    function updateToolbarPosition() {
        if (!toolbar || !selection) {
            return;
        }

        if (selection.style.display === 'none') {
            return;
        }

        const rect = selection.getBoundingClientRect();
        const toolbarRect = toolbar.getBoundingClientRect();
        const padding = 16;
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;

        let left = rect.left + rect.width / 2 - toolbarRect.width / 2;
        left = Math.min(Math.max(left, padding), viewportWidth - toolbarRect.width - padding);

        let top = rect.bottom + 12;
        if (top + toolbarRect.height > viewportHeight - padding) {
            top = rect.top - toolbarRect.height - 12;
        }
        top = Math.min(Math.max(top, padding), viewportHeight - toolbarRect.height - padding);

        toolbar.style.left = `${Math.round(left)}px`;
        toolbar.style.top = `${Math.round(top)}px`;
    }

    function captureScreenshot() {
        // 获取选择区域的坐标
        const rect = selection.getBoundingClientRect();
        const selectionData = {
            x: parseInt(selection.style.left),
            y: parseInt(selection.style.top),
            width: parseInt(selection.style.width),
            height: parseInt(selection.style.height),
            windowWidth: window.innerWidth,
            windowHeight: window.innerHeight,
            scrollX: window.scrollX,
            scrollY: window.scrollY,
            pageWidth: document.documentElement.scrollWidth,
            pageHeight: document.documentElement.scrollHeight,
            devicePixelRatio: window.devicePixelRatio || 1,
            zoom: window.devicePixelRatio / (window.outerWidth / window.innerWidth)
        };

        // 获取马赛克数据（如果有的话）
        let mosaicDataUrl = null;
        if (mosaicCanvas && mosaicCtx) {
            mosaicDataUrl = mosaicCanvas.toDataURL('image/png');
        }

        // 获取画笔数据（如果有的话）
        let penDataUrl = null;
        if (penCanvas && penCtx) {
            penDataUrl = penCanvas.toDataURL('image/png');
        }

        // 获取矩形数据（如果有的话）
        let rectDataUrl = null;
        if (rectCanvas && rectCtx) {
            rectDataUrl = rectCanvas.toDataURL('image/png');
        }

        // 获取箭头数据（如果有的话）
        let arrowDataUrl = null;
        if (arrowCanvas && arrowCtx) {
            arrowDataUrl = arrowCanvas.toDataURL('image/png');
        }

        // 先隐藏所有UI元素，避免被截进图片
        hideUIElements();

        // 等待UI元素完全隐藏后再截图
        setTimeout(() => {
            // 发送消息给background script
            chrome.runtime.sendMessage({
                action: 'capture',
                selection: selectionData,
                mosaicDataUrl: mosaicDataUrl,
                penDataUrl: penDataUrl,
                rectDataUrl: rectDataUrl,
                arrowDataUrl: arrowDataUrl
            });

            // 截图完成后清理
            setTimeout(() => {
                cleanup();
            }, 100);
        }, 100);
    }

    /**
     * 隐藏UI元素（但不删除，以便恢复滚动位置等操作）
     */
    function hideUIElements() {
        if (overlay) overlay.style.display = 'none';
        if (selection) selection.style.display = 'none';
        if (sizeInfo) sizeInfo.style.display = 'none';
        if (toolbar) toolbar.style.display = 'none';
        if (hint) hint.style.display = 'none';
        if (mosaicCanvas) mosaicCanvas.style.display = 'none';
        if (mosaicPreviewRect) mosaicPreviewRect.style.display = 'none';
        if (penCanvas) penCanvas.style.display = 'none';
        if (penSettingsPanel) penSettingsPanel.style.display = 'none';
        if (rectCanvas) rectCanvas.style.display = 'none';
        if (rectTempCanvas) rectTempCanvas.style.display = 'none';
        if (rectSettingsPanel) rectSettingsPanel.style.display = 'none';
        if (arrowCanvas) arrowCanvas.style.display = 'none';
        if (arrowTempCanvas) arrowTempCanvas.style.display = 'none';
        if (arrowSettingsPanel) arrowSettingsPanel.style.display = 'none';
    }

    /**
     * 停止自动滚动
     */
    function stopAutoScroll() {
        if (autoScrollInterval) {
            clearInterval(autoScrollInterval);
            autoScrollInterval = null;
        }
    }

    /**
     * 处理自动滚动
     */
    function handleAutoScroll(mouseX, mouseY) {
        const edgeThreshold = 50; // 距离边缘多少像素开始滚动
        const scrollSpeed = 10; // 滚动速度

        let scrollX = 0;
        let scrollY = 0;

        // 检测鼠标是否接近边缘
        if (mouseY < edgeThreshold) {
            scrollY = -scrollSpeed; // 向上滚动
        } else if (mouseY > window.innerHeight - edgeThreshold) {
            scrollY = scrollSpeed; // 向下滚动
        }

        if (mouseX < edgeThreshold) {
            scrollX = -scrollSpeed; // 向左滚动
        } else if (mouseX > window.innerWidth - edgeThreshold) {
            scrollX = scrollSpeed; // 向右滚动
        }

        // 如果需要滚动
        if (scrollX !== 0 || scrollY !== 0) {
            if (!autoScrollInterval) {
                autoScrollInterval = setInterval(() => {
                    window.scrollBy(scrollX, scrollY);
                }, 16); // 约 60fps
            }
        } else {
            // 停止滚动
            if (autoScrollInterval) {
                clearInterval(autoScrollInterval);
                autoScrollInterval = null;
            }
        }
    }

    function handleKeyDown(e) {
        if (e.key === 'Escape') {
            cleanup();
        } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
            // Ctrl+Z / Cmd+Z 撤销
            e.preventDefault();
            handleUndo();
        }
    }

    /**
     * 裁剪并下载单视口截图
     */
    function cropAndDownload(dataUrl, cropArea, mosaicDataUrl, penDataUrl, rectDataUrl, arrowDataUrl) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => {
                try {
                    const canvas = document.createElement('canvas');
                    const ctx = canvas.getContext('2d');

                    // 获取设备像素比
                    const dpr = window.devicePixelRatio || 1;

                    // Canvas 尺寸使用物理像素（高分辨率）
                    canvas.width = cropArea.width * dpr;
                    canvas.height = cropArea.height * dpr;

                    // 计算源图片上的坐标（已经是物理像素）
                    const srcX = cropArea.x * dpr;
                    const srcY = cropArea.y * dpr;
                    const srcWidth = cropArea.width * dpr;
                    const srcHeight = cropArea.height * dpr;

                    // 直接1:1绘制，保持高分辨率
                    ctx.drawImage(
                        img,
                        srcX, srcY, srcWidth, srcHeight,
                        0, 0, canvas.width, canvas.height
                    );

                    // 合并马赛克、画笔、矩形和箭头数据
                    const overlays = [];
                    if (mosaicDataUrl) overlays.push(mosaicDataUrl);
                    if (penDataUrl) overlays.push(penDataUrl);
                    if (rectDataUrl) overlays.push(rectDataUrl);
                    if (arrowDataUrl) overlays.push(arrowDataUrl);

                    if (overlays.length === 0) {
                        const finalDataUrl = canvas.toDataURL('image/png');
                        downloadImage(finalDataUrl);
                        resolve();
                        return;
                    }

                    let loadedCount = 0;
                    overlays.forEach((overlayUrl) => {
                        const overlayImg = new Image();
                        overlayImg.onload = () => {
                            ctx.drawImage(
                                overlayImg,
                                0, 0, overlayImg.width, overlayImg.height,
                                0, 0, canvas.width, canvas.height
                            );
                            loadedCount++;
                            if (loadedCount === overlays.length) {
                                const finalDataUrl = canvas.toDataURL('image/png');
                                downloadImage(finalDataUrl);
                                resolve();
                            }
                        };
                        overlayImg.onerror = () => {
                            loadedCount++;
                            if (loadedCount === overlays.length) {
                                const finalDataUrl = canvas.toDataURL('image/png');
                                downloadImage(finalDataUrl);
                                resolve();
                            }
                        };
                        overlayImg.src = overlayUrl;
                    });
                } catch (error) {
                    reject(error);
                }
            };
            img.onerror = () => reject(new Error('图片加载失败'));
            img.src = dataUrl;
        });
    }

    /**
     * 拼接并下载长图截图
     */
    function stitchAndDownload(captures, cropInfo) {
        return new Promise((resolve, reject) => {
            try {
                const canvas = document.createElement('canvas');
                const ctx = canvas.getContext('2d');

                // 获取设备像素比
                const dpr = window.devicePixelRatio || 1;

                // Canvas 尺寸使用物理像素（高分辨率）
                canvas.width = cropInfo.width * dpr;
                canvas.height = cropInfo.height * dpr;

                let loadedCount = 0;
                const images = [];

                console.log('开始拼接图片，总段数:', captures.length);
                console.log('目标尺寸:', cropInfo.width, 'x', cropInfo.height);

                captures.forEach((capture, index) => {
                    const img = new Image();
                    img.onload = () => {
                        images[index] = img;
                        loadedCount++;

                        if (loadedCount === captures.length) {
                            try {
                                // 所有图片加载完成，开始拼接
                                captures.forEach((capture, i) => {
                                    // 源坐标（物理像素）
                                    const srcX = cropInfo.x * dpr;
                                    const srcY = capture.cropY * dpr;
                                    const srcWidth = cropInfo.width * dpr;
                                    const srcHeight = capture.cropHeight * dpr;

                                    // 目标坐标（物理像素）
                                    const destX = 0;
                                    const destY = capture.offsetY * dpr;
                                    const destWidth = cropInfo.width * dpr;
                                    const destHeight = capture.cropHeight * dpr;

                                    // 确保不超出画布边界
                                    const maxDestHeight = canvas.height - destY;
                                    const finalDestHeight = Math.min(destHeight, maxDestHeight);
                                    const finalSrcHeight = Math.min(srcHeight, maxDestHeight);

                                    console.log(`拼接段 ${i + 1}:`, {
                                        srcY: srcY / dpr,
                                        srcHeight: srcHeight / dpr,
                                        destY: destY / dpr,
                                        destHeight: finalDestHeight / dpr
                                    });

                                    ctx.drawImage(
                                        images[i],
                                        srcX, srcY, srcWidth, finalSrcHeight,
                                        destX, destY, destWidth, finalDestHeight
                                    );
                                });

                                console.log('拼接完成');
                                const finalDataUrl = canvas.toDataURL('image/png');
                                downloadImage(finalDataUrl);
                                resolve();
                            } catch (error) {
                                reject(error);
                            }
                        }
                    };
                    img.onerror = () => reject(new Error('图片加载失败'));
                    img.src = capture.dataUrl;
                });
            } catch (error) {
                reject(error);
            }
        });
    }

    /**
     * 展示画板，允许在截图上涂鸦
     */
    function openDrawingBoard(imageDataUrl) {
        closeDrawingBoard();

        drawingOverlay = document.createElement('div');
        drawingOverlay.className = 'drawing-board-overlay';

        const panel = document.createElement('div');
        panel.className = 'drawing-board-panel';

        const header = document.createElement('div');
        header.className = 'drawing-board-header';
        header.textContent = '截图涂鸦';

        const canvasWrapper = document.createElement('div');
        canvasWrapper.className = 'drawing-board-canvas-wrapper';

        drawingCanvas = document.createElement('canvas');
        drawingCanvas.className = 'drawing-board-canvas';
        drawingCtx = drawingCanvas.getContext('2d');
        drawingCanvas.style.pointerEvents = 'none';
        canvasWrapper.appendChild(drawingCanvas);

        const toolbarEl = buildDrawingToolbar();

        panel.appendChild(header);
        panel.appendChild(canvasWrapper);
        panel.appendChild(toolbarEl);
        drawingOverlay.appendChild(panel);
        document.body.appendChild(drawingOverlay);

        drawingKeydownHandler = (event) => {
            const key = event.key?.toLowerCase();
            if (key === 'escape') {
                event.preventDefault();
                closeDrawingBoard();
            } else if ((event.metaKey || event.ctrlKey) && key === 'z') {
                event.preventDefault();
                undoDrawing();
            }
        };
        document.addEventListener('keydown', drawingKeydownHandler);

        drawingBaseImage = new Image();
        drawingBaseImage.onload = () => {
            drawingCanvas.width = drawingBaseImage.width;
            drawingCanvas.height = drawingBaseImage.height;
            drawingCtx.drawImage(drawingBaseImage, 0, 0);
            updateDrawingCanvasScale();
            drawingHistory = [drawingCanvas.toDataURL('image/png')];
            drawingCanvas.style.pointerEvents = 'auto';
        };
        drawingBaseImage.onerror = () => {
            alert('无法加载截图用于编辑');
            closeDrawingBoard();
        };
        drawingBaseImage.src = imageDataUrl;

        drawingCanvas.addEventListener('pointerdown', handleDrawingPointerDown);
        drawingCanvas.addEventListener('pointermove', handleDrawingPointerMove);
        drawingCanvas.addEventListener('pointerup', handleDrawingPointerUp);
        drawingCanvas.addEventListener('pointerleave', handleDrawingPointerUp);
        drawingCanvas.addEventListener('pointercancel', handleDrawingPointerUp);

        window.addEventListener('resize', updateDrawingCanvasScale);
    }

    function closeDrawingBoard() {
        if (drawingCanvas) {
            drawingCanvas.removeEventListener('pointerdown', handleDrawingPointerDown);
            drawingCanvas.removeEventListener('pointermove', handleDrawingPointerMove);
            drawingCanvas.removeEventListener('pointerup', handleDrawingPointerUp);
            drawingCanvas.removeEventListener('pointerleave', handleDrawingPointerUp);
            drawingCanvas.removeEventListener('pointercancel', handleDrawingPointerUp);
        }
        window.removeEventListener('resize', updateDrawingCanvasScale);

        drawingOverlay?.remove();
        drawingOverlay = null;
        drawingCanvas = null;
        drawingCtx = null;
        drawingHistory = [];
        drawingBaseImage = null;
        drawingPointerId = null;
        if (drawingKeydownHandler) {
            document.removeEventListener('keydown', drawingKeydownHandler);
            drawingKeydownHandler = null;
        }
    }

    function buildDrawingToolbar() {
        const toolbarEl = document.createElement('div');
        toolbarEl.className = 'drawing-board-toolbar';

        const colorLabel = document.createElement('label');
        colorLabel.textContent = '画笔颜色';
        const colorInput = document.createElement('input');
        colorInput.type = 'color';
        colorInput.value = drawingColor;
        colorInput.addEventListener('input', (e) => {
            drawingColor = e.target.value;
        });
        colorLabel.appendChild(colorInput);

        const sizeLabel = document.createElement('label');
        sizeLabel.className = 'drawing-board-size-label';
        const sizeTitle = document.createElement('span');
        sizeTitle.textContent = '画笔粗细';
        const sizeText = document.createElement('span');
        sizeText.className = 'drawing-board-size-value';
        sizeText.textContent = `${drawingSize}px`;
        const sizeInput = document.createElement('input');
        sizeInput.type = 'range';
        sizeInput.min = '2';
        sizeInput.max = '40';
        sizeInput.value = String(drawingSize);
        sizeInput.addEventListener('input', (e) => {
            drawingSize = Number(e.target.value);
            sizeText.textContent = `${drawingSize}px`;
        });
        sizeLabel.appendChild(sizeTitle);
        sizeLabel.appendChild(sizeInput);
        sizeLabel.appendChild(sizeText);

        const undoBtn = document.createElement('button');
        undoBtn.textContent = '撤销';
        undoBtn.type = 'button';
        undoBtn.addEventListener('click', undoDrawing);

        const clearBtn = document.createElement('button');
        clearBtn.textContent = '清空';
        clearBtn.type = 'button';
        clearBtn.addEventListener('click', resetDrawing);

        const downloadBtn = document.createElement('button');
        downloadBtn.textContent = '保存图片';
        downloadBtn.className = 'drawing-board-btn_primary';
        downloadBtn.type = 'button';
        downloadBtn.addEventListener('click', () => {
            if (!drawingCanvas) return;
            downloadImage(drawingCanvas.toDataURL('image/png'));
            closeDrawingBoard();
        });

        const cancelBtn = document.createElement('button');
        cancelBtn.textContent = '关闭';
        cancelBtn.type = 'button';
        cancelBtn.addEventListener('click', closeDrawingBoard);

        toolbarEl.appendChild(colorLabel);
        toolbarEl.appendChild(sizeLabel);
        toolbarEl.appendChild(undoBtn);
        toolbarEl.appendChild(clearBtn);
        toolbarEl.appendChild(cancelBtn);
        toolbarEl.appendChild(downloadBtn);

        return toolbarEl;
    }

    function updateDrawingCanvasScale() {
        if (!drawingCanvas) return;
        const width = drawingCanvas.width;
        const height = drawingCanvas.height;
        const padding = 200;
        const maxWidth = Math.max(200, window.innerWidth - padding);
        const maxHeight = Math.max(200, window.innerHeight - 240);
        drawingScale = Math.min(1, maxWidth / width, maxHeight / height);
        drawingCanvas.style.width = `${Math.round(width * drawingScale)}px`;
        drawingCanvas.style.height = `${Math.round(height * drawingScale)}px`;
    }

    function handleDrawingPointerDown(event) {
        if (!drawingCanvas || drawingPointerId !== null) {
            return;
        }
        event.preventDefault();
        drawingPointerId = event.pointerId;
        drawingCanvas.setPointerCapture(drawingPointerId);
        const { x, y } = translatePointerToCanvas(event);
        drawingCtx.beginPath();
        drawingCtx.moveTo(x, y);
        drawingCtx.strokeStyle = drawingColor;
        drawingCtx.lineWidth = drawingSize;
        drawingCtx.lineJoin = 'round';
        drawingCtx.lineCap = 'round';
    }

    function handleDrawingPointerMove(event) {
        if (!drawingCanvas || drawingPointerId !== event.pointerId) {
            return;
        }
        event.preventDefault();
        const { x, y } = translatePointerToCanvas(event);
        drawingCtx.lineTo(x, y);
        drawingCtx.stroke();
    }

    function handleDrawingPointerUp(event) {
        if (!drawingCanvas || drawingPointerId !== event.pointerId) {
            return;
        }
        event.preventDefault();
        drawingCanvas.releasePointerCapture(drawingPointerId);
        drawingPointerId = null;
        drawingCtx.closePath();
        pushDrawingHistory();
    }

    function translatePointerToCanvas(event) {
        const rect = drawingCanvas.getBoundingClientRect();
        const scaleX = drawingCanvas.width / rect.width;
        const scaleY = drawingCanvas.height / rect.height;
        return {
            x: (event.clientX - rect.left) * scaleX,
            y: (event.clientY - rect.top) * scaleY
        };
    }

    function pushDrawingHistory() {
        if (!drawingCanvas) return;
        const snapshot = drawingCanvas.toDataURL('image/png');
        drawingHistory.push(snapshot);
        if (drawingHistory.length > DRAWING_HISTORY_LIMIT) {
            drawingHistory.shift();
        }
    }

    function undoDrawing() {
        if (drawingHistory.length <= 1 || !drawingCanvas) {
            return;
        }
        drawingHistory.pop();
        const previous = drawingHistory.at(-1);
        restoreCanvasFromData(previous);
    }

    function resetDrawing() {
        if (!drawingHistory.length || !drawingCanvas) {
            return;
        }
        const original = drawingHistory[0];
        drawingHistory = [original];
        restoreCanvasFromData(original);
    }

    function restoreCanvasFromData(dataUrl) {
        if (!drawingCtx || !drawingCanvas) return;
        const img = new Image();
        img.onload = () => {
            drawingCanvas.width = img.width;
            drawingCanvas.height = img.height;
            drawingCtx.clearRect(0, 0, drawingCanvas.width, drawingCanvas.height);
            drawingCtx.drawImage(img, 0, 0);
            updateDrawingCanvasScale();
        };
        img.src = dataUrl;
    }

    /**
     * 下载图片
     */
    function downloadImage(dataUrl) {
        const link = document.createElement('a');
        const timestamp = new Date().toISOString().replaceAll(/[:.]/g, '-').slice(0, -5);
        link.download = `screenshot_${timestamp}.png`;
        link.href = dataUrl;
        link.click();
    }


    function cleanup() {
        globalThis.screenshotCaptureActive = false;

        // 清除自动滚动
        if (autoScrollInterval) {
            clearInterval(autoScrollInterval);
            autoScrollInterval = null;
        }

        // 清除马赛克相关元素
        removeMosaicCanvas();
        mosaicMode = false;

        // 清除画笔相关元素
        removePenCanvas();
        penMode = false;

        // 清除矩形相关元素
        removeRectCanvas();
        rectMode = false;

        // 清除箭头相关元素
        removeArrowCanvas();
        arrowMode = false;

        overlay?.remove();
        selection?.remove();
        sizeInfo?.remove();
        toolbar?.remove();
        hint?.remove();

        document.removeEventListener('keydown', handleKeyDown);
    }
})();
