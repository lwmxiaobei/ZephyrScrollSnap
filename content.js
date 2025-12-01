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
            cropAndDownload(message.dataUrl, message.cropArea)
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
        if (autoScrollInterval) {
            clearInterval(autoScrollInterval);
            autoScrollInterval = null;
        }

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

    function showToolbar() {
        toolbar = document.createElement('div');
        toolbar.className = 'screenshot-toolbar';

        const confirmBtn = document.createElement('button');
        confirmBtn.className = 'screenshot-btn-confirm';
        confirmBtn.textContent = '✓ 确认截图';
        confirmBtn.onclick = captureScreenshot;

        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'screenshot-btn-cancel';
        cancelBtn.textContent = '✕ 取消';
        cancelBtn.onclick = cleanup;

        toolbar.appendChild(confirmBtn);
        toolbar.appendChild(cancelBtn);
        document.body.appendChild(toolbar);
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

        // 先隐藏所有UI元素，避免被截进图片
        hideUIElements();

        // 等待UI元素完全隐藏后再截图
        setTimeout(() => {
            // 发送消息给background script
            chrome.runtime.sendMessage({
                action: 'capture',
                selection: selectionData
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
        }
    }

    /**
     * 裁剪并下载单视口截图
     */
    function cropAndDownload(dataUrl, cropArea) {
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

                    downloadImage(canvas.toDataURL('image/png'));
                    resolve();
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
                                downloadImage(canvas.toDataURL('image/png'));
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
     * 下载图片
     */
    function downloadImage(dataUrl) {
        const link = document.createElement('a');
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
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

        if (overlay && overlay.parentNode) {
            overlay.parentNode.removeChild(overlay);
        }
        if (selection && selection.parentNode) {
            selection.parentNode.removeChild(selection);
        }
        if (sizeInfo && sizeInfo.parentNode) {
            sizeInfo.parentNode.removeChild(sizeInfo);
        }
        if (toolbar && toolbar.parentNode) {
            toolbar.parentNode.removeChild(toolbar);
        }
        if (hint && hint.parentNode) {
            hint.parentNode.removeChild(hint);
        }

        document.removeEventListener('keydown', handleKeyDown);
    }
})();
