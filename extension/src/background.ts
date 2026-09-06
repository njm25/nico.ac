// activeTab only: nothing is injected anywhere until the user clicks the icon
// on a specific tab, so the extension needs no host permissions at install time.
chrome.action.onClicked.addListener(async (tab) => {
	if (!tab.id) return;

	try {
		await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['page.css'] });
		await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
		await chrome.tabs.sendMessage(tab.id, { type: 'pgs-toggle' });
	} catch (error) {
		// chrome:// pages, the web store and pdf viewers all refuse injection
		console.warn('page shooter cannot run on this page', error);
	}
});
