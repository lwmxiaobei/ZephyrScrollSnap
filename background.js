// 监听来自content script的消息
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'capture') {
        handleCapture(message.selection, sender.tab.id);
        return true; // 保持消息通道开启
    }
});

/**
 * 处理截图请求
 */
async function handleCapture(selection, tabId) {
    try {
        console.log('开始截图...', selection);

        const { x, y, width, height, windowHeight, scrollY } = selection;
        const endY = y + height;

        // 判断是否需要滚动截图
        if (height <= windowHeight && endY <= scrollY + windowHeight) {
            // 单视口截图
            await captureSingleView(selection, tabId);
        } else {
            // 长图滚动截图
            await captureLongScreenshot(selection, tabId);
        }

        console.log('截图完成');
    } catch (error) {
        console.error('截图失败:', error);
        // 通知content script截图失败
        try {
            await chrome.tabs.sendMessage(tabId, {
                action: 'captureError',
                error: error.message
            });
        } catch (e) {
            console.error('无法发送错误消息:', e);
        }
    }
}

/**
 * 单视口截图
 */
async function captureSingleView(selection, tabId) {
    // 捕获当前视口
    const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: 'png' });

    // 在content script中裁剪图片（因为需要使用Canvas）
    try {
        const response = await chrome.tabs.sendMessage(tabId, {
            action: 'cropAndDownload',
            dataUrl: dataUrl,
            cropArea: {
                x: selection.x - selection.scrollX,
                y: selection.y - selection.scrollY,
                width: selection.width,
                height: selection.height
            }
        });

        if (!response.success) {
            throw new Error(response.error || '图片处理失败');
        }
    } catch (error) {
        console.error('裁剪图片失败:', error);
        throw error;
    }
}

/**
 * 长图滚动截图
 */
async function captureLongScreenshot(selection, tabId) {
    const { x, y, width, height, windowHeight, scrollX, scrollY } = selection;

    const captures = [];
    const startY = y;
    const endY = y + height;

    // 保存原始滚动位置
    const [scrollResult] = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => window.scrollY
    });
    const originalScrollY = scrollResult.result;

    // 固定/粘性元素在滚动截图里会遮挡后续内容，因此在第一次截图前就隐藏
    const fixedElementsHidden = await hideFixedOrStickyElements(tabId);

    // Chrome 限制 captureVisibleTab 每秒最多2次调用
    const CAPTURE_INTERVAL = 600;

    // 计算需要截取的段数
    let currentScrollY = startY; // 当前滚动到的Y位置
    let capturedHeight = 0; // 已经捕获的高度

    while (capturedHeight < height) {
        // 滚动到当前位置
        await chrome.scripting.executeScript({
            target: { tabId },
            func: (sx, sy) => window.scrollTo(sx, sy),
            args: [scrollX, currentScrollY]
        });

        // 等待页面稳定
        await wait(300);

        try {
            // 捕获当前视口
            const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: 'png' });

            // 计算本次截图的参数
            let cropY = 0;
            let cropHeight = 0;

            if (capturedHeight === 0) {
                // 第一段：选择起点可能不在视口顶部
                cropY = startY - currentScrollY;
                cropHeight = Math.min(windowHeight - cropY, height);
            } else {
                // 后续段：从视口顶部开始
                const remainingHeight = height - capturedHeight;
                cropHeight = Math.min(windowHeight, remainingHeight);
            }

            console.log(`段 ${captures.length + 1}: scrollY=${currentScrollY}, cropY=${cropY}, cropHeight=${cropHeight}, offsetY=${capturedHeight}`);

            captures.push({
                dataUrl,
                cropY: cropY,
                cropHeight: cropHeight,
                offsetY: capturedHeight
            });

            // 更新已捕获高度
            capturedHeight += cropHeight;

            // 下一段的滚动位置
            currentScrollY = startY + capturedHeight;

            // 如果还有更多截图，等待避免频率限制
            if (capturedHeight < height) {
                await wait(CAPTURE_INTERVAL);
            }
        } catch (error) {
            // 如果遇到频率限制错误，等待更长时间后重试
            if (error.message.includes('MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND')) {
                console.log('遇到频率限制，等待1秒后重试...');
                await wait(1000);
                continue; // 重试当前位置
            } else {
                throw error;
            }
        }
    }

    console.log(`截图完成，共 ${captures.length} 段，总高度 ${capturedHeight}`);

    // 恢复固定定位元素
    if (fixedElementsHidden) {
        await restoreHiddenFixedElements(tabId);
    }

    // 恢复原始滚动位置
    await chrome.scripting.executeScript({
        target: { tabId },
        func: (sx, sy) => window.scrollTo(sx, sy),
        args: [scrollX, originalScrollY]
    });

    // 在content script中拼接图片
    try {
        const response = await chrome.tabs.sendMessage(tabId, {
            action: 'stitchAndDownload',
            captures: captures,
            cropInfo: {
                x: x - scrollX,
                width: width,
                height: height
            }
        });

        if (!response.success) {
            throw new Error(response.error || '图片拼接失败');
        }
    } catch (error) {
        console.error('拼接图片失败:', error);
        throw error;
    }
}

/**
 * 等待指定时间
 */
function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function hideFixedOrStickyElements(tabId) {
    try {
        const [hideResult] = await chrome.scripting.executeScript({
            target: { tabId },
            func: () => {
                globalThis.__screenshotHiddenElements = [];
                const elements = document.querySelectorAll('*');
                const viewportHeight = globalThis.innerHeight;

                const shouldHideElement = (el, style) => {
                    if (style.position === 'fixed') {
                        return true;
                    }

                    if (style.position !== 'sticky') {
                        return false;
                    }

                    const rect = el.getBoundingClientRect();
                    const touchingTop = rect.top <= 0;
                    const touchingBottom = rect.bottom >= viewportHeight;
                    return touchingTop || touchingBottom;
                };

                for (const el of elements) {
                    const style = globalThis.getComputedStyle(el);
                    if (shouldHideElement(el, style)) {
                        globalThis.__screenshotHiddenElements.push({
                            element: el,
                            originalDisplay: el.style.display,
                            originalVisibility: el.style.visibility,
                            originalOpacity: el.style.opacity
                        });
                        el.style.setProperty('visibility', 'hidden', 'important');
                        el.style.setProperty('opacity', '0', 'important');
                    }
                }
                return globalThis.__screenshotHiddenElements.length;
            }
        });

        if (hideResult?.result > 0) {
            await wait(500);
            console.log('预先隐藏固定/粘性元素:', hideResult.result);
            return true;
        }
    } catch (error) {
        console.warn('隐藏固定元素失败，将继续截图:', error);
    }

    return false;
}

async function restoreHiddenFixedElements(tabId) {
    await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
            if (globalThis.__screenshotHiddenElements) {
                for (const item of globalThis.__screenshotHiddenElements) {
                    item.element.style.display = item.originalDisplay;
                    item.element.style.visibility = item.originalVisibility;
                    item.element.style.opacity = item.originalOpacity;
                }
                console.log('已恢复', globalThis.__screenshotHiddenElements.length, '个固定元素');
                delete globalThis.__screenshotHiddenElements;
            }
        }
    });
}
