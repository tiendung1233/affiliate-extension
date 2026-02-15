const SERVER_URL = 'http://localhost:5001/api/extension/stream';

// Keep-Alive Mechanism
chrome.alarms.create('keepAlive', { periodInMinutes: 0.5 });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepAlive') {
    chrome.runtime.getPlatformInfo(() => { });
    if (!eventSource || eventSource.readyState === 2) {
      console.log('Connection lost, reconnecting...');
      connectToStream();
    }
  }
});

let eventSource = null;
const tabContextMap = new Map();

// Helper: Remote Log
function remoteLog(msg, level = 'INFO', sender = 'Background') {
  console.log(`[${sender}] ${msg}`);
  fetch('http://localhost:5001/api/extension/log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: msg, level, sender })
  }).catch(() => { });
}

// Helper: Generate SubId
function generateSubId() {
  return Math.random().toString(36).substring(2, 10) + Math.random().toString(36).substring(2, 10);
}

// Function: Resolve and Open URL (Core Logic)
async function resolveAndOpen(url, requestId, userId) {
  try {
    remoteLog(`Resolving URL: ${url} (ReqID: ${requestId}, User: ${userId})`, 'INFO', 'Background');

    let finalUrl = url;

    // Resolve shortlinks if needed
    if (url.includes('shp.ee') || url.includes('/universal-link/')) {
      try {
        const response = await fetch(url, { method: 'GET', redirect: 'follow' });
        finalUrl = response.url;
        remoteLog(`Resolved shortlink to: ${finalUrl}`, 'INFO', 'Background');
      } catch (e) {
        console.error("Fetch resolve failed", e);
      }
    }

    // Attempt to extract Item ID
    let itemId = null;
    const cleanUrl = finalUrl.split('?')[0];

    const match1 = cleanUrl.match(/\/product\/(\d+)\/(\d+)/);
    if (match1) itemId = match1[2];

    if (!itemId) {
      const match2 = cleanUrl.match(/-i\.(\d+)\.(\d+)/);
      if (match2) itemId = match2[2];
    }

    if (!itemId) {
      const match3 = cleanUrl.match(/\/bs\/(\d+)\/(\d+)/);
      if (match3) itemId = match3[2];
    }

    let targetUrl;
    let isDetailsScrapingPossible = false;

    if (itemId) {
      remoteLog(`Extracted Item ID: ${itemId}`);
      targetUrl = `https://affiliate.shopee.vn/offer/product_offer/${itemId}`;
      isDetailsScrapingPossible = true;
    } else {
      remoteLog('Could not extract Item ID. Skipping scraping, going to Custom Link.');
      targetUrl = "https://affiliate.shopee.vn/offer/custom_link";
      isDetailsScrapingPossible = false;
    }

    // Open Tab
    chrome.tabs.create({ url: targetUrl }, (tab) => {
      if (tab.id) {
        const context = {
          requestId: requestId,
          userId: userId,
          productUrl: finalUrl,
          productData: null,
          subId: isDetailsScrapingPossible ? null : generateSubId(),
          isDirectCustomLink: !isDetailsScrapingPossible
        };

        tabContextMap.set(tab.id, context);
        remoteLog(`Mapped Tab ${tab.id} to Request ${requestId}`);
      }
    });

  } catch (err) {
    remoteLog(`Fatal resolve error: ${err}`, 'ERROR');
  }
}

// Function: Connect to SSE
function connectToStream() {
  if (eventSource && eventSource.readyState !== 2) return;

  console.log('Connecting to SSE stream...');
  eventSource = new EventSource(SERVER_URL);

  eventSource.onopen = () => {
    console.log('Connected to Affiliate Server SSE stream.');
  };

  eventSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === 'open_url' && data.url) {
        resolveAndOpen(data.url, data.requestId, data.userId);
      } else if (data.type === 'connected') {
        console.log('Handshake successful.');
      }
    } catch (e) {
      console.error('Error parsing SSE message:', e);
    }
  };

  eventSource.onerror = (err) => {
    if (eventSource.readyState === 0) return;
    console.log('Connection closed. Retrying in 5s...');
    eventSource.close();
    eventSource = null;
    setTimeout(connectToStream, 5000);
  };
}

// Listener: Message from Content Script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "DEBUG_LOG") {
    remoteLog(request.message, 'DEBUG', `CS-${sender.tab?.id}`);
    return;
  }

  const tabId = sender.tab?.id;
  if (!tabId) return;

  // STEP 1: Details Scraped
  if (request.action === "DETAILS_SCRAPED") {
    remoteLog(`Step 1 Complete: Details Scraped for Tab ${tabId}`);

    const context = tabContextMap.get(tabId) || {};
    context.productData = request.data;
    context.subId = generateSubId();
    tabContextMap.set(tabId, context);

    remoteLog(`Navigating Tab ${tabId} to Custom Link Page...`);
    chrome.tabs.update(tabId, { url: "https://affiliate.shopee.vn/offer/custom_link" });
  }

  // STEP 2: Link Generated
  if (request.action === "LINK_GENERATED" && request.link) {
    remoteLog(`Step 2 Complete: Link Generated for Tab ${tabId}`);

    const context = tabContextMap.get(tabId);
    if (!context) {
      remoteLog(`No context found for Tab ${tabId}`, 'ERROR');
      return;
    }

    // Send to server
    fetch('http://localhost:5001/api/extension/result', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        link: request.link,
        data: context.productData,
        requestId: context.requestId,
        subId: context.subId,
        originalUrl: context.productUrl,
        userId: context.userId
      })
    })
      .then(response => response.json())
      .then(data => remoteLog("Result sent to server successfully."))
      .catch(err => remoteLog(`Failed to send result to server: ${err}`, 'ERROR'));

    // Cleanup
    tabContextMap.delete(tabId);
    chrome.tabs.remove(tabId);
  }
});

// Listener: Tab Updated (for Direct Link fallback or Page Load detection)
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url && tab.url.includes('/offer/custom_link')) {
    const context = tabContextMap.get(tabId);
    if (context) {
      remoteLog(`Custom Link Page Loaded for Tab ${tabId}. Executing Flow...`, 'INFO', 'Background');

      if (!context.subId) {
        context.subId = generateSubId();
        tabContextMap.set(tabId, context);
      }

      chrome.tabs.sendMessage(tabId, {
        action: "EXECUTE_CUSTOM_LINK_FLOW",
        url: context.productUrl,
        subId: context.subId
      });
    }
  }
});

// Start
connectToStream();
