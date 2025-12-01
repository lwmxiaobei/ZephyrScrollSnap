document.getElementById('startCapture').addEventListener('click', async () => {
    try {
        // 获取当前活动标签页
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

        // 检查是否是特殊页面
        if (!tab || !tab.url) {
            showError('无法获取当前页面信息');
            return;
        }

        // 检查URL是否是受限页面
        const restrictedProtocols = ['chrome://', 'chrome-extension://', 'edge://', 'about:', 'view-source:'];
        const isRestricted = restrictedProtocols.some(protocol => tab.url.startsWith(protocol));

        if (isRestricted) {
            showError('此页面不支持截图\n\n请在普通网页上使用此扩展\n(chrome:// 等特殊页面无法截图)');
            return;
        }

        // 注入内容脚本
        await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ['content.js']
        });

        // 注入样式
        await chrome.scripting.insertCSS({
            target: { tabId: tab.id },
            files: ['styles.css']
        });

        // 发送消息启动截图模式
        chrome.tabs.sendMessage(tab.id, { action: 'startCapture' });

        // 关闭popup
        window.close();
    } catch (error) {
        console.error('启动截图失败:', error);
        showError('启动截图失败\n\n' + error.message);
    }
});

/**
 * 显示错误消息
 */
function showError(message) {
    const button = document.getElementById('startCapture');
    const container = document.querySelector('.container');

    // 隐藏按钮
    button.style.display = 'none';

    // 创建错误提示
    const errorDiv = document.createElement('div');
    errorDiv.style.cssText = `
    margin-top: 12px;
    padding: 12px;
    background: rgba(255, 59, 48, 0.15);
    border: 1px solid rgba(255, 59, 48, 0.3);
    border-radius: 8px;
    color: white;
    font-size: 13px;
    line-height: 1.5;
    white-space: pre-line;
    text-align: left;
  `;
    errorDiv.textContent = '⚠️ ' + message;

    container.appendChild(errorDiv);

    // 3秒后恢复
    setTimeout(() => {
        errorDiv.remove();
        button.style.display = 'block';
    }, 4000);
}
