// Scrape logic for Shopee Affiliate

function debugLog(msg) {
  console.log(`[Content Script]: ${msg}`);
  try {
    chrome.runtime.sendMessage({ action: "DEBUG_LOG", message: msg });
  } catch (e) {
    // Ignore
  }
}

debugLog("Content Script Loaded");

// Helper: Wait for element
function waitForElement(selector, timeout = 10000) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(selector)) return resolve(document.querySelector(selector));

    const observer = new MutationObserver(() => {
      if (document.querySelector(selector)) {
        observer.disconnect();
        resolve(document.querySelector(selector));
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });

    setTimeout(() => {
      observer.disconnect();
      reject(new Error(`Element ${selector} not found`));
    }, timeout);
  });
}

// Helper: Wait for value in input/textarea
function waitForValue(selector, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const check = () => {
      const el = document.querySelector(selector);
      if (!el) return null;
      const val = el.value || el.textContent || el.innerText;
      if (val && val.trim().length > 0) return val;
      return null;
    };
    if (check()) return resolve(check());

    const interval = setInterval(() => {
      if (check()) { clearInterval(interval); resolve(check()); }
    }, 500);

    setTimeout(() => { clearInterval(interval); resolve(null); }, timeout);
  });
}

// SCENARIO 1: Product Page -> Scrape Details
async function handleProductPage() {
  debugLog("Detected Product Page. Scraping details...");

  // Check if we are on a valid product page
  // (Wait for basic element to ensure load)
  try {
    await waitForElement('.name', 10000);
  } catch (e) {
    debugLog("Could not find .name, maybe not fully loaded?");
  }

  const productData = {};
  const nameEl = document.querySelector('.name');
  if (nameEl) productData.name = nameEl.innerText;

  const soldEl = document.querySelector('.ItemCardSold__wrap span');
  if (soldEl) productData.sold = soldEl.innerText;

  const imgEl = document.querySelector('img.offer-img');
  if (imgEl) productData.image = imgEl.src;

  const priceEl = document.querySelector('.price');
  if (priceEl) productData.price = priceEl.innerText;

  const cashbackEl = document.querySelector('td.comm-table-total-text.ant-table-row-cell-break-word');
  if (cashbackEl) productData.cashback = cashbackEl.innerText;

  debugLog(`Scraped Details: ${JSON.stringify(productData)}`);

  // We do NOT click the button here anymore.
  // We send data to background and let background navigate us to Custom Link page.
  chrome.runtime.sendMessage({
    action: "DETAILS_SCRAPED",
    data: productData
  });
}

// SCENARIO 2: Custom Link Page -> Fill and Generate
async function handleCustomLinkPage(url, subId) {
  debugLog(`Handling Custom Link Page. URL: ${url}, SubID: ${subId}`);

  try {
    // 1. Find textarea.ant-input
    const textarea = await waitForElement('textarea.ant-input');
    debugLog("Found textarea.");

    // React often overrides value setters. We might need to dispatch input events.
    const nativeTextAreaValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
    nativeTextAreaValueSetter.call(textarea, url);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));

    // 2. Find SubID input: input#customLink_sub_id1
    const subIdInput = await waitForElement('input#customLink_sub_id1');
    debugLog("Found SubID input.");

    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    nativeInputValueSetter.call(subIdInput, subId);
    subIdInput.dispatchEvent(new Event('input', { bubbles: true }));

    // 3. Click Button: .ant-btn
    // Note: There might be multiple buttons. Usually the "Get Link" is a primary button or specific one.
    // Assuming .ant-btn-primary or the one near the form
    // Let's try finding the button that submits.
    debugLog("Waiting for button...");
    await new Promise(r => setTimeout(r, 1000)); // Wait for UI update

    const buttons = document.querySelectorAll('.ant-btn-primary');
    let generateBtn = null;
    buttons.forEach(btn => {
      if (btn.innerText.includes('Lấy link') || btn.innerText.includes('Get Link') || btn.innerText.includes('Generate')) {
        generateBtn = btn;
      }
    });

    if (!generateBtn && buttons.length > 0) generateBtn = buttons[0]; // Fallback

    if (generateBtn) {
      debugLog("Clicking Generate button...");
      generateBtn.click();
    } else {
      throw new Error("Generate button not found");
    }

    // 4. Wait for Modal and Result
    // The modal result usually appears in: .ant-modal-root .ant-input
    debugLog("Waiting for result modal...");
    const resultLink = await waitForValue('.ant-modal-root .ant-input', 15000);

    if (resultLink) {
      debugLog(`Generated Link: ${resultLink}`);
      chrome.runtime.sendMessage({
        action: "LINK_GENERATED",
        link: resultLink
      });
    } else {
      debugLog("Failed to generate link (timeout).");
    }

  } catch (e) {
    debugLog(`Error in Custom Link flow: ${e.message}`);
  }
}


// ROUTING LOGIC
const currentUrl = window.location.href;

if (currentUrl.includes('/offer/product_offer/')) {
  // Give a small delay for render
  setTimeout(handleProductPage, 1500);
}
else if (currentUrl.includes('/offer/custom_link')) {
  // Wait for command from background
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "EXECUTE_CUSTOM_LINK_FLOW") {
      handleCustomLinkPage(request.url, request.subId);
    }
  });

  // Notify background we are ready? 
  // Actually background knows we loaded via tabs.onUpdated, so it should send the message.
  debugLog("Ready for Custom Link Flow");
}
