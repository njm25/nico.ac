import Matter from 'matter-js';
import { initAudio, playGunshot, playCock, playHolster } from './sandboxAudio';
import { tryPopAt } from './beachBall';
import { setActiveTool } from './sandboxState';
import { aimViewmodel, fireViewmodel, mountViewmodel, setViewmodelVisible } from './gunModel';

const { Bodies, Body, Composite, Engine, Sleeping } = Matter;

interface Fragment {
	el: HTMLElement;
	body: Matter.Body;
	settled: boolean;
	width: number;
	height: number;
}

// cached geometry for every splittable character, in page coordinates
interface FragRect {
	el: HTMLElement;
	x: number;
	y: number;
	width: number;
	height: number;
	shot: boolean;
}

const BLAST_RADIUS = 100;
const MAX_FRAGMENTS = 700;
const MAX_HOLES = 160;
const WALL = 400;
const STEP = 1000 / 60;
const MAX_STEPS_PER_FRAME = 4;

let armed = false;
let engine: Matter.Engine | null = null;
let bounds: Matter.Body[] = [];
let debrisLayer: HTMLElement | null = null;
let holeLayer: HTMLElement | null = null;
let reticle: HTMLElement | null = null;

const fragments: Fragment[] = [];
let fragRects: FragRect[] = [];
let holeCount = 0;
let splitDone = false;
let originalWrapHtml = '';

let running = false;
let rafId = 0;
let lastTime = 0;
let accumulator = 0;
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

/* --------------------------------------------------------------- physics */

function ensureEngine(): Matter.Engine {
	if (engine) return engine;
	// sleeping matters here: piles are permanent, so settled letters have to cost nothing
	engine = Engine.create({ enableSleeping: true });
	engine.gravity.y = 1;
	buildBounds();
	return engine;
}

function buildBounds() {
	if (!engine) return;
	if (bounds.length) Composite.remove(engine.world, bounds);

	const w = window.innerWidth;
	const h = window.innerHeight;
	const options = { isStatic: true, restitution: 0.1, friction: 0.6 };

	// thick, so a fast letter cannot tunnel through
	bounds = [
		Bodies.rectangle(w / 2, h + WALL / 2, w + WALL * 2, WALL, options),
		Bodies.rectangle(-WALL / 2, h / 2, WALL, h * 3, options),
		Bodies.rectangle(w + WALL / 2, h / 2, WALL, h * 3, options),
	];
	Composite.add(engine.world, bounds);
}

function startLoop() {
	if (running) return;
	running = true;
	lastTime = 0;
	accumulator = 0;
	rafId = requestAnimationFrame(frame);
}

function frame(now: number) {
	if (!running) return;
	rafId = requestAnimationFrame(frame);

	if (!lastTime) lastTime = now;
	accumulator += Math.min(now - lastTime, 100);
	lastTime = now;

	let steps = 0;
	while (accumulator >= STEP && steps < MAX_STEPS_PER_FRAME) {
		Engine.update(engine!, STEP);
		accumulator -= STEP;
		steps++;
	}
	if (steps === MAX_STEPS_PER_FRAME) accumulator = 0;

	syncFragments();

	// everything has come to rest: park the loop until the next shot disturbs it
	if (fragments.every((f) => f.settled)) {
		running = false;
		cancelAnimationFrame(rafId);
	}
}

function syncFragments() {
	for (const fragment of fragments) {
		if (fragment.body.isSleeping && fragment.settled) continue;

		const { x, y } = fragment.body.position;
		fragment.el.style.transform =
			`translate(${x - fragment.width / 2}px, ${y - fragment.height / 2}px) rotate(${fragment.body.angle}rad)`;
		fragment.settled = fragment.body.isSleeping;
	}
}

/* ----------------------------------------------------------------- split */

function splitPage() {
	if (splitDone) return;
	const wrap = document.querySelector<HTMLElement>('.wrap');
	if (!wrap) return;

	// one snapshot of the whole content area is all undo needs
	originalWrapHtml = wrap.innerHTML;

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
	for (const el of document.querySelectorAll<HTMLElement>('.gun-frag')) {
		const rect = el.getBoundingClientRect();
		if (rect.width < 1 || rect.height < 1) continue;
		fragRects.push({
			el,
			x: rect.left + scrollLeft + rect.width / 2,
			y: rect.top + scrollTop + rect.height / 2,
			width: rect.width,
			height: rect.height,
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
	shoveDebris(clientX, clientY);
}

function blast(clientX: number, clientY: number) {
	if (!fragRects.length) return;

	const originX = clientX + window.scrollX;
	const originY = clientY + window.scrollY;

	const hits: { rect: FragRect; dx: number; dy: number; distance: number }[] = [];
	for (const rect of fragRects) {
		if (rect.shot) continue;
		const dx = rect.x - originX;
		const dy = rect.y - originY;
		const distance = Math.hypot(dx, dy);
		if (distance <= BLAST_RADIUS) hits.push({ rect, dx, dy, distance });
	}
	if (!hits.length) return;

	ensureLayers();
	const world = ensureEngine().world;
	const scrollLeft = window.scrollX;
	const scrollTop = window.scrollY;

	for (const { rect, dx, dy, distance } of hits) {
		rect.shot = true;
		rect.el.classList.add('shot');

		const style = getComputedStyle(rect.el);
		const el = document.createElement('span');
		el.className = 'gun-debris-char';
		el.textContent = rect.el.textContent;
		el.style.width = `${rect.width}px`;
		el.style.height = `${rect.height}px`;
		el.style.lineHeight = `${rect.height}px`;
		el.style.font = style.font;
		el.style.color = style.color;
		el.style.textTransform = style.textTransform;
		debrisLayer!.appendChild(el);

		// spawn in viewport space: debris piles at the bottom of the screen
		const body = Bodies.rectangle(rect.x - scrollLeft, rect.y - scrollTop, rect.width, rect.height, {
			restitution: 0.18,
			friction: 0.55,
			frictionAir: 0.012,
			density: 0.0016,
		});

		const falloff = 1 - distance / BLAST_RADIUS;
		const spread = distance < 0.5 ? Math.random() * Math.PI * 2 : Math.atan2(dy, dx);
		const speed = (5 + falloff * 20) * (0.7 + Math.random() * 0.6);

		Body.setVelocity(body, {
			x: Math.cos(spread) * speed,
			y: Math.sin(spread) * speed - falloff * 7,
		});
		Body.setAngularVelocity(body, (Math.random() - 0.5) * 0.25);

		Composite.add(world, body);
		fragments.push({ el, body, settled: false, width: rect.width, height: rect.height });
	}

	cullFragments();
	syncFragments();
	startLoop();
}

// letters already lying in the pile are still fair game
function shoveDebris(clientX: number, clientY: number) {
	if (!fragments.length) return;
	let disturbed = false;

	for (const fragment of fragments) {
		const dx = fragment.body.position.x - clientX;
		const dy = fragment.body.position.y - clientY;
		const distance = Math.hypot(dx, dy);
		if (distance > BLAST_RADIUS) continue;

		const falloff = 1 - distance / BLAST_RADIUS;
		const spread = distance < 0.5 ? Math.random() * Math.PI * 2 : Math.atan2(dy, dx);
		const speed = (4 + falloff * 15) * (0.7 + Math.random() * 0.6);

		// setVelocity alone will not rouse a sleeping body
		Sleeping.set(fragment.body, false);
		Body.setVelocity(fragment.body, {
			x: Math.cos(spread) * speed,
			y: Math.sin(spread) * speed - falloff * 6,
		});
		Body.setAngularVelocity(fragment.body, (Math.random() - 0.5) * 0.3);
		fragment.settled = false;
		disturbed = true;
	}

	if (disturbed) startLoop();
}

function cullFragments() {
	const excess = fragments.length - MAX_FRAGMENTS;
	if (excess <= 0) return;

	for (const fragment of fragments.splice(0, excess)) {
		Composite.remove(engine!.world, fragment.body);
		fragment.el.classList.add('fading');
		setTimeout(() => fragment.el.remove(), 400);
	}
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
		buildBounds();
		measureFragments();
		if (fragments.length) {
			for (const fragment of fragments) fragment.settled = false;
			startLoop();
		}
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
	ensureEngine();
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
	running = false;
	cancelAnimationFrame(rafId);

	if (engine && fragments.length) {
		Composite.remove(
			engine.world,
			fragments.map((f) => f.body)
		);
	}
	fragments.length = 0;

	if (debrisLayer) debrisLayer.textContent = '';
	if (holeLayer) holeLayer.textContent = '';
	holeCount = 0;

	if (splitDone) {
		const wrap = document.querySelector<HTMLElement>('.wrap');
		if (wrap) wrap.innerHTML = originalWrapHtml;
		splitDone = false;
		originalWrapHtml = '';
		fragRects = [];
	}
}
