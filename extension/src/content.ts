import { disarm, reset, toggle } from './gun';

// The action re-injects this file on every click, so the first run claims the
// page and later runs no-op; messages keep going to the listener the first run
// registered.
declare global {
	interface Window {
		__pageShooter?: { toggle: () => boolean; reset: () => void; disarm: () => void };
	}
}

if (!window.__pageShooter) {
	window.__pageShooter = { toggle, reset, disarm };

	chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
		if (message?.type === 'pgs-toggle') sendResponse({ armed: toggle() });
		else if (message?.type === 'pgs-reset') {
			reset();
			sendResponse({ ok: true });
		}
		return true;
	});
}
