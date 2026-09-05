import { initAudio, playGunshot, playCock, playHolster } from './sandboxAudio';
import { tryPopAt } from './beachBall';
import { setActiveTool } from './sandboxState';
import { aimViewmodel, fireViewmodel, mountViewmodel, setViewmodelVisible } from './gunModel';
import {
	addLetters,
	clearLetters,
	ensurePhysics,
	rebuildBounds,
	shoveLetters,
	wakeLetters,
	type LetterSpawn,
} from './letterPhysics';

// cached geometry for every shootable piece: characters, plus whole svg icons,
// which go in as single rigid bodies rather than being split up
interface FragRect {
	el: Element;
	x: number;
	y: number;
	width: number;
	height: number;
	// coordinates are viewport-relative for pieces inside a fixed element (the
	// footer) and page-relative for everything else
	fixed: boolean;
	shot: boolean;
}

const BLAST_RADIUS = 100;
const MAX_HOLES = 160;

let armed = false;
let debrisLayer: HTMLElement | null = null;
let holeLayer: HTMLElement | null = null;
let reticle: HTMLElement | null = null;

let fragRects: FragRect[] = [];
let fixedRoots: HTMLElement[] = [];
let holeCount = 0;
let splitDone = false;
let originalWrapHtml = '';
let resizeTimer = 0;

const reduceMotion = () =>
	typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ---------------------------------------------------------------- layers */

function ensureLayers() {
	if (debrisLayer) return;

	debrisLayer = document.createElement('div');
	debrisLayer.id = 'gun-debris';
	debrisLayer.setAttribute('aria-hidden', 'true');

	// bullet holes live in page coordinates so they stay stuck to the text they hit
	holeLayer = document.createElement('div');
	holeLayer.id = 'gun-holes';
	holeLayer.setAttribute('aria-hidden', 'true');

	document.body.append(holeLayer, debrisLayer);
}

function ensureReticle() {
	if (reticle) return;

	reticle = document.createElement('div');
	reticle.id = 'gun-reticle';
	reticle.setAttribute('aria-hidden', 'true');
	reticle.innerHTML = `
<svg viewBox="0 0 40 40" width="40" height="40" fill="none" stroke="currentColor" stroke-linecap="round">
	<circle cx="20" cy="20" r="13.5" stroke-width="1" opacity="0.28" />
	<g class="reticle-ticks" stroke-width="1.6">
		<path d="M20 4.5 V11" />
		<path d="M20 29 V35.5" />
		<path d="M4.5 20 H11" />
		<path d="M29 20 H35.5" />
	</g>
	<circle class="reticle-dot" cx="20" cy="20" r="1.3" fill="currentColor" stroke="none" />
</svg>`;

	// park it centred until the pointer first moves
	reticle.style.transform = `translate(${window.innerWidth / 2}px, ${window.innerHeight / 2}px)`;
	document.body.appendChild(reticle);
}

function moveReticle(clientX: number, clientY: number) {
	if (reticle) reticle.style.transform = `translate(${clientX}px, ${clientY}px)`;
}

function kickReticle() {
	if (!reticle) return;
	reticle.classList.remove('firing');
	void reticle.getBoundingClientRect();
	reticle.classList.add('firing');
}

/* ----------------------------------------------------------------- split */

function splitPage() {
	if (splitDone) return;
	const wrap = document.querySelector<HTMLElement>('.wrap');
	if (!wrap) return;

	// one snapshot of the whole content area is all undo needs
	originalWrapHtml = wrap.innerHTML;

	// cheap to collect now, while the page is still ~100 elements rather than
	// the few thousand spans it becomes below
	fixedRoots = Array.from(wrap.querySelectorAll<HTMLElement>('*')).filter(
		(el) => getComputedStyle(el).position === 'fixed'
	);

	const walker = document.createTreeWalker(wrap, NodeFilter.SHOW_TEXT, {
		acceptNode(node) {
			if (!node.textContent || !node.textContent.trim()) return NodeFilter.FILTER_REJECT;
			const parent = node.parentElement;
			if (!parent || parent.closest('svg')) return NodeFilter.FILTER_REJECT;
			return NodeFilter.FILTER_ACCEPT;
		},
	});

	const textNodes: Text[] = [];
	let node: Node | null;
	while ((node = walker.nextNode())) textNodes.push(node as Text);

	for (const textNode of textNodes) {
		const parent = textNode.parentNode;
		if (!parent) continue;

		const replacement = document.createDocumentFragment();
		for (const char of textNode.textContent!) {
			if (!char.trim()) {
				replacement.appendChild(document.createTextNode(char));
				continue;
			}
			const span = document.createElement('span');
			span.className = 'gun-frag';
			span.textContent = char;
			replacement.appendChild(span);
		}
		parent.replaceChild(replacement, textNode);
	}

	// icons (github, linkedin, rss) have no text to split, so each whole svg
	// becomes one shootable body
	for (const icon of wrap.querySelectorAll('svg')) {
		icon.classList.add('gun-frag', 'gun-atom');
	}

	splitDone = true;
	measureFragments();
}

// batched read pass; shot characters keep their box (visibility:hidden) so the
// page never reflows and these stay valid until a resize
function measureFragments() {
	if (!splitDone) return;
	const scrollLeft = window.scrollX;
	const scrollTop = window.scrollY;

	fragRects = [];
	for (const el of document.querySelectorAll('.gun-frag')) {
		const rect = el.getBoundingClientRect();
		if (rect.width < 1 || rect.height < 1) continue;

		// a fixed piece stays in viewport coordinates; folding scroll into it
		// would leave the cached position wrong the moment the page moves
		const fixed = fixedRoots.some((root) => root.contains(el));

		fragRects.push({
			el,
			x: rect.left + rect.width / 2 + (fixed ? 0 : scrollLeft),
			y: rect.top + rect.height / 2 + (fixed ? 0 : scrollTop),
			width: rect.width,
			height: rect.height,
			fixed,
			shot: el.classList.contains('shot'),
		});
	}
}

/* ----------------------------------------------------------------- shoot */

function shoot(clientX: number, clientY: number) {
	playGunshot();
	fireViewmodel();
	kickReticle();
	shake();

	// a ball in the way eats the bullet
	if (tryPopAt(clientX, clientY)) return;

	impact(clientX, clientY);
	splitPage();
	blast(clientX, clientY);
	shoveLetters(clientX, clientY, BLAST_RADIUS);
}

function blast(clientX: number, clientY: number) {
	if (!fragRects.length) return;

	const pageX = clientX + window.scrollX;
	const pageY = clientY + window.scrollY;

	const hits: { rect: FragRect; dx: number; dy: number; distance: number }[] = [];
	for (const rect of fragRects) {
		if (rect.shot) continue;
		const dx = rect.x - (rect.fixed ? clientX : pageX);
		const dy = rect.y - (rect.fixed ? clientY : pageY);
		const distance = Math.hypot(dx, dy);
		if (distance <= BLAST_RADIUS) hits.push({ rect, dx, dy, distance });
	}
	if (!hits.length) return;

	ensureLayers();
	const scrollLeft = window.scrollX;
	const scrollTop = window.scrollY;
	const spawns: LetterSpawn[] = [];

	for (const { rect, dx, dy, distance } of hits) {
		const style = getComputedStyle(rect.el);
		const el = document.createElement('span');
		el.className = 'gun-debris-char';
		el.style.width = `${rect.width}px`;
		el.style.height = `${rect.height}px`;
		el.style.color = style.color;

		if (rect.el.classList.contains('gun-atom')) {
			// copy the icon before the original is hidden, or the copy inherits it
			el.classList.add('gun-debris-atom');
			const copy = rect.el.cloneNode(true) as Element;
			copy.classList.remove('gun-frag', 'gun-atom', 'shot');
			el.appendChild(copy);
		} else {
			el.textContent = rect.el.textContent;
			el.style.lineHeight = `${rect.height}px`;
			el.style.font = style.font;
			el.style.textTransform = style.textTransform;
		}

		rect.shot = true;
		rect.el.classList.add('shot');
		debrisLayer!.appendChild(el);

		const falloff = 1 - distance / BLAST_RADIUS;
		const spread = distance < 0.5 ? Math.random() * Math.PI * 2 : Math.atan2(dy, dx);
		const speed = (5 + falloff * 20) * (0.7 + Math.random() * 0.6);

		// spawn in viewport space: debris piles at the bottom of the screen
		spawns.push({
			el,
			x: rect.fixed ? rect.x : rect.x - scrollLeft,
			y: rect.fixed ? rect.y : rect.y - scrollTop,
			width: rect.width,
			height: rect.height,
			vx: Math.cos(spread) * speed,
			vy: Math.sin(spread) * speed - falloff * 7,
			spin: (Math.random() - 0.5) * 0.25,
		});
	}

	addLetters(spawns);
}

/* --------------------------------------------------------------- effects */

function shake() {
	if (reduceMotion()) return;
	// must not be an ancestor of the fixed footer: a transform on .wrap would
	// make it the containing block and drop the footer out of the viewport
	const target = document.querySelector<HTMLElement>('main');
	if (!target) return;
	target.classList.remove('gun-shake');
	void target.getBoundingClientRect();
	target.classList.add('gun-shake');
	target.addEventListener('animationend', () => target.classList.remove('gun-shake'), { once: true });
}

// a cratered hole: dark core, blown rim, and a few radial cracks that differ per shot
function makeHole(): HTMLElement {
	const hole = document.createElement('span');
	hole.className = 'gun-hole';

	const cracks: string[] = [];
	const count = 6 + Math.floor(Math.random() * 4);
	for (let i = 0; i < count; i++) {
		const angle = (i / count) * Math.PI * 2 + Math.random() * 0.6;
		const bend = angle + (Math.random() - 0.5) * 0.6;
		const outer = 4.4 + Math.random() * 5.5;
		cracks.push(
			`M${(13 + Math.cos(angle) * 3.2).toFixed(1)} ${(13 + Math.sin(angle) * 3.2).toFixed(1)}` +
				`L${(13 + Math.cos(bend) * outer).toFixed(1)} ${(13 + Math.sin(bend) * outer).toFixed(1)}`
		);
	}

	hole.innerHTML = `
<svg viewBox="0 0 26 26" width="26" height="26">
	<g stroke="rgba(215,219,224,0.22)" stroke-width="0.7" stroke-linecap="round" fill="none">
		<path d="${cracks.join(' ')}" />
	</g>
	<circle cx="13" cy="13" r="3.6" fill="#05060a" stroke="rgba(215,219,224,0.28)" stroke-width="0.8" />
	<circle cx="13" cy="13" r="2.1" fill="#000" />
</svg>`;
	return hole;
}

function impact(clientX: number, clientY: number) {
	ensureLayers();
	const x = clientX + window.scrollX;
	const y = clientY + window.scrollY;

	const hole = makeHole();
	hole.style.transform = `translate(${x}px, ${y}px) rotate(${Math.random() * 360}deg)`;
	holeLayer!.appendChild(hole);

	if (++holeCount > MAX_HOLES) {
		holeLayer!.querySelector('.gun-hole')?.remove();
		holeCount--;
	}
}

/* -------------------------------------------------------------- handlers */

function onPointerDown(e: PointerEvent) {
	if (!armed || e.button !== 0) return;
	if ((e.target as HTMLElement | null)?.closest('#sandbox-menu')) return;

	e.preventDefault();
	e.stopPropagation();

	// touch has no hover, so the tap itself is the only aim signal we ever get
	moveReticle(e.clientX, e.clientY);
	aimViewmodel(e.clientX, e.clientY, e.pointerType !== 'mouse');
	shoot(e.clientX, e.clientY);
}

function onPointerMove(e: PointerEvent) {
	if (!armed) return;
	moveReticle(e.clientX, e.clientY);
	aimViewmodel(e.clientX, e.clientY);
}

// preventDefault on pointerdown does not reliably stop a link from navigating
function swallow(e: Event) {
	if (!armed) return;
	if ((e.target as HTMLElement | null)?.closest('#sandbox-menu')) return;
	e.preventDefault();
	e.stopPropagation();
}

function onResize() {
	clearTimeout(resizeTimer);
	resizeTimer = window.setTimeout(() => {
		rebuildBounds();
		measureFragments();
		wakeLetters();
	}, 150);
}

/* ---------------------------------------------------------------- public */

export function toggleGun(): boolean {
	if (armed) disarm();
	else arm();
	return armed;
}

function arm() {
	initAudio();
	ensureLayers();
	ensureReticle();
	ensurePhysics();
	mountViewmodel();

	armed = true;
	setActiveTool('gun');
	document.documentElement.dataset.gun = 'armed';
	setViewmodelVisible(true);

	window.addEventListener('pointerdown', onPointerDown, { capture: true });
	window.addEventListener('pointermove', onPointerMove, { capture: true });
	window.addEventListener('click', swallow, { capture: true });
	window.addEventListener('auxclick', swallow, { capture: true });
	window.addEventListener('dragstart', swallow, { capture: true });
	window.addEventListener('resize', onResize);

	playCock();
}

function disarm() {
	armed = false;
	setActiveTool('none');
	delete document.documentElement.dataset.gun;
	setViewmodelVisible(false);

	window.removeEventListener('pointerdown', onPointerDown, { capture: true });
	window.removeEventListener('pointermove', onPointerMove, { capture: true });
	window.removeEventListener('click', swallow, { capture: true });
	window.removeEventListener('auxclick', swallow, { capture: true });
	window.removeEventListener('dragstart', swallow, { capture: true });
	window.removeEventListener('resize', onResize);

	playHolster();
}

export function isGunArmed(): boolean {
	return armed;
}

// undo: drop every fragment, every hole, and put the original markup back
export function restorePage() {
	clearLetters();

	if (debrisLayer) debrisLayer.textContent = '';
	if (holeLayer) holeLayer.textContent = '';
	holeCount = 0;

	if (splitDone) {
		const wrap = document.querySelector<HTMLElement>('.wrap');
		if (wrap) wrap.innerHTML = originalWrapHtml;
		splitDone = false;
		originalWrapHtml = '';
		fragRects = [];
		fixedRoots = [];
	}
}
