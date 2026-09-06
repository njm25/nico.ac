import { initAudio, startSprayHiss, stopSprayHiss, playShake } from './sandboxAudio';
import { setActiveTool } from './sandboxState';

// Tag the page. Paint lands on a canvas sized to the whole document rather than
// the viewport, so it sticks to the page and scrolls with it like real paint on
// a wall. Holding still lets paint pool until it runs.

const PALETTE = ['#7cc4ff', '#ff4d8d', '#6ee787', '#ffa657', '#f2f2ef'];

const NOZZLE_RADIUS = 19;
// movement lays paint per unit of distance; dwelling adds more each frame, so
// holding still keeps building instead of stopping dead
const DOTS_PER_STEP = 10;
const DOTS_PER_DWELL = 26;
// a fast pass sprays a tighter line: the nozzle is unchanged, but the faint
// outer edge of the cone stops landing densely enough to register
const SPEED_NARROWING = 0.35;
const MIN_RADIUS_SCALE = 0.12;
const RADIUS_SMOOTHING = 0.35;
const DOT_ALPHA = 0.055;
const STEP_SPACING = 3;

const DRIP_CELL = 12;
const DRIP_THRESHOLD = 26;
const MAX_DRIPS = 40;

interface Drip {
	x: number;
	y: number;
	speed: number;
	width: number;
	remaining: number;
	colour: string;
}

let active = false;
let canvas: HTMLCanvasElement | null = null;
let ctx: CanvasRenderingContext2D | null = null;
let cursor: HTMLElement | null = null;
let footerCanvas: HTMLCanvasElement | null = null;
let footerCtx: CanvasRenderingContext2D | null = null;

let colourIndex = 0;
let spraying = false;
let pointer = { x: 0, y: 0 };
let previous: { x: number; y: number } | null = null;
let lastMove = 0;
let radiusScale = 1;

const density = new Map<string, number>();
const drips: Drip[] = [];
let rafId = 0;
let running = false;

const colour = () => PALETTE[colourIndex];

/* ----------------------------------------------------------------- canvas */

function documentSize() {
	const root = document.documentElement;

	// hide our own layer while measuring: it is absolutely positioned, so it
	// counts toward scroll size and would otherwise ratchet bigger every resize
	const visible = canvas && canvas.style.display !== 'none';
	if (visible) canvas!.style.display = 'none';

	// clientWidth, not innerWidth: innerWidth includes the scrollbar, and a
	// canvas that wide overflows the content box and forces a horizontal one
	const size = {
		width: Math.max(root.scrollWidth, root.clientWidth),
		height: Math.max(root.scrollHeight, root.clientHeight),
	};

	if (visible) canvas!.style.display = '';
	return size;
}

function ensureCanvas() {
	if (canvas) return;

	canvas = document.createElement('canvas');
	canvas.id = 'spray-layer';
	canvas.setAttribute('aria-hidden', 'true');
	document.body.appendChild(canvas);
	sizeCanvas();
	ensureFooterLayer();
	// the footer is fixed, so scrolling changes which slice of the page it covers
	window.addEventListener('scroll', drawFooterCopy, { passive: true });
}

// The paint canvas sits behind the beach balls, which puts it behind the fixed
// footer's opaque background too. This is the same fix the balls use: a second
// copy of the paint, clipped to the footer, layered above its background.
function ensureFooterLayer() {
	if (footerCanvas) return;
	const footer = document.querySelector('footer');
	if (!footer) return;

	footerCanvas = document.createElement('canvas');
	footerCanvas.className = 'spray-footer-layer';
	footerCanvas.setAttribute('aria-hidden', 'true');
	footer.insertBefore(footerCanvas, footer.firstChild);
	footerCtx = footerCanvas.getContext('2d');
	sizeFooterLayer();
}

function sizeFooterLayer() {
	const footer = document.querySelector('footer');
	if (!footer || !footerCanvas) return;
	const ratio = Math.min(window.devicePixelRatio, 2);
	footerCanvas.width = Math.max(Math.round(footer.clientWidth * ratio), 1);
	footerCanvas.height = Math.max(Math.round(footer.clientHeight * ratio), 1);
}

function drawFooterCopy() {
	const footer = document.querySelector('footer');
	if (!footer || !footerCtx || !footerCanvas || !canvas) return;

	footerCtx.clearRect(0, 0, footerCanvas.width, footerCanvas.height);

	// inset:0 covers the padding box, and the paint canvas is in page space
	const box = footer.getBoundingClientRect();
	const ratio = Math.min(window.devicePixelRatio, 2);
	footerCtx.drawImage(
		canvas,
		(box.left + footer.clientLeft + window.scrollX) * ratio,
		(box.top + footer.clientTop + window.scrollY) * ratio,
		footer.clientWidth * ratio,
		footer.clientHeight * ratio,
		0,
		0,
		footerCanvas.width,
		footerCanvas.height
	);
}

// resizing a canvas wipes it, so the old paint is copied across by hand
function sizeCanvas() {
	if (!canvas) return;
	const { width, height } = documentSize();
	const ratio = Math.min(window.devicePixelRatio, 2);

	const previousPixels =
		canvas.width && canvas.height ? document.createElement('canvas') : null;
	if (previousPixels) {
		previousPixels.width = canvas.width;
		previousPixels.height = canvas.height;
		previousPixels.getContext('2d')!.drawImage(canvas, 0, 0);
	}

	canvas.width = Math.round(width * ratio);
	canvas.height = Math.round(height * ratio);
	canvas.style.width = `${width}px`;
	canvas.style.height = `${height}px`;

	ctx = canvas.getContext('2d');
	ctx!.scale(ratio, ratio);
	if (previousPixels) {
		ctx!.save();
		ctx!.setTransform(1, 0, 0, 1, 0, 0);
		ctx!.drawImage(previousPixels, 0, 0);
		ctx!.restore();
	}
}

function ensureCursor() {
	if (cursor) return;
	cursor = document.createElement('div');
	cursor.id = 'spray-cursor';
	cursor.setAttribute('aria-hidden', 'true');
	cursor.style.setProperty('--nozzle', `${NOZZLE_RADIUS * 2}px`);
	cursor.style.color = colour();
	document.body.appendChild(cursor);
}

/* ------------------------------------------------------------------ paint */

// airbrush: scatter low-alpha dots with a bias toward the middle, so passes
// build up gradually instead of laying down a hard disc
function spray(x: number, y: number, dots: number, radiusScale = 1) {
	if (!ctx || dots <= 0) return;
	ctx.fillStyle = colour();
	const radius = NOZZLE_RADIUS * radiusScale;

	for (let i = 0; i < dots; i++) {
		const angle = Math.random() * Math.PI * 2;
		const spread = Math.sqrt(Math.random()) * radius;
		const dotX = x + Math.cos(angle) * spread;
		const dotY = y + Math.sin(angle) * spread;
		const fade = 1 - spread / radius;

		ctx.globalAlpha = DOT_ALPHA * (0.35 + fade);
		ctx.beginPath();
		ctx.arc(dotX, dotY, 0.5 + Math.random() * 1.5, 0, Math.PI * 2);
		ctx.fill();
	}
	ctx.globalAlpha = 1;

	accumulate(x, y);
}

// track how much paint has pooled in each cell so runs start where it is thickest
function accumulate(x: number, y: number) {
	const key = `${Math.round(x / DRIP_CELL)},${Math.round(y / DRIP_CELL)}`;
	const amount = (density.get(key) ?? 0) + 1;
	density.set(key, amount);

	if (amount < DRIP_THRESHOLD || drips.length >= MAX_DRIPS) return;
	if (Math.random() > 0.25) return;

	density.set(key, 0);
	drips.push({
		x: x + (Math.random() - 0.5) * NOZZLE_RADIUS,
		y: y + NOZZLE_RADIUS * 0.4,
		speed: 0.25 + Math.random() * 0.4,
		width: 1.6 + Math.random() * 1.8,
		remaining: 30 + Math.random() * 90,
		colour: colour(),
	});
}

function advanceDrips(dt: number) {
	if (!ctx) return;

	for (let i = drips.length - 1; i >= 0; i--) {
		const drip = drips[i];
		const step = Math.min(drip.speed * dt, drip.remaining);

		ctx.strokeStyle = drip.colour;
		ctx.globalAlpha = 0.5;
		ctx.lineCap = 'round';
		ctx.lineWidth = drip.width;
		ctx.beginPath();
		ctx.moveTo(drip.x, drip.y);
		ctx.lineTo(drip.x, drip.y + step);
		ctx.stroke();
		ctx.globalAlpha = 1;

		drip.y += step;
		drip.remaining -= step;
		// runs slow and narrow as they exhaust the paint behind them
		drip.speed *= 0.995;
		drip.width = Math.max(drip.width * 0.992, 0.4);

		if (drip.remaining <= 0 || drip.width <= 0.45) drips.splice(i, 1);
	}
}

/* ------------------------------------------------------------------- loop */

let lastFrame = 0;

function startLoop() {
	if (running) return;
	running = true;
	lastFrame = 0;
	rafId = requestAnimationFrame(frame);
}

function frame(now: number) {
	if (!running) return;
	rafId = requestAnimationFrame(frame);

	if (!lastFrame) lastFrame = now;
	const dt = Math.min(now - lastFrame, 50);
	lastFrame = now;

	// dwell: a stationary can sprays its full cone
	if (spraying && previous) {
		radiusScale += (1 - radiusScale) * RADIUS_SMOOTHING;
		spray(previous.x, previous.y, DOTS_PER_DWELL, radiusScale);
	}

	advanceDrips(dt);
	if (drips.length) drawFooterCopy();

	if (!spraying && !drips.length) {
		running = false;
		cancelAnimationFrame(rafId);
	}
}

/* --------------------------------------------------------------- handlers */

function moveCursor() {
	if (cursor) cursor.style.transform = `translate(${pointer.x}px, ${pointer.y}px)`;
}

function onPointerDown(e: PointerEvent) {
	if (!active) return;
	if ((e.target as HTMLElement | null)?.closest('#sandbox-menu')) return;

	e.preventDefault();
	e.stopPropagation();

	if (e.button === 2) return;

	spraying = true;
	previous = null;
	radiusScale = 1;
	pointer = { x: e.clientX, y: e.clientY };
	strokeTo(pointer.x + window.scrollX, pointer.y + window.scrollY, performance.now());
	cursor?.classList.add('spraying');
	startSprayHiss();
	startLoop();
}

function onPointerMove(e: PointerEvent) {
	if (!active) return;
	pointer = { x: e.clientX, y: e.clientY };
	moveCursor();
	if (spraying) strokeTo(pointer.x + window.scrollX, pointer.y + window.scrollY, performance.now());
}

// walk along the stroke so a fast drag does not leave gaps, and so a stroke
// that begins and ends inside a single frame still leaves a mark
function strokeTo(x: number, y: number, now: number) {
	if (!previous) {
		spray(x, y, DOTS_PER_STEP);
		previous = { x, y };
		lastMove = now;
		return;
	}

	const dx = x - previous.x;
	const dy = y - previous.y;
	const distance = Math.hypot(dx, dy);
	const steps = Math.min(Math.max(Math.floor(distance / STEP_SPACING), 1), 240);

	// px per ms; smoothed, or the line width flickers with jittery event timing
	const speed = distance / Math.max(now - lastMove, 1);
	const target = Math.max(1 - speed * SPEED_NARROWING, MIN_RADIUS_SCALE);
	radiusScale += (target - radiusScale) * RADIUS_SMOOTHING;

	for (let i = 1; i <= steps; i++) {
		spray(previous.x + (dx * i) / steps, previous.y + (dy * i) / steps, DOTS_PER_STEP, radiusScale);
	}

	previous = { x, y };
	lastMove = now;
	drawFooterCopy();
}

function onPointerUp() {
	if (!spraying) return;
	spraying = false;
	previous = null;
	cursor?.classList.remove('spraying');
	stopSprayHiss();
}

// right click racks the can to the next colour
function onContextMenu(e: MouseEvent) {
	if (!active) return;
	if ((e.target as HTMLElement | null)?.closest('#sandbox-menu')) return;
	e.preventDefault();
	colourIndex = (colourIndex + 1) % PALETTE.length;
	if (cursor) cursor.style.color = colour();
	playShake();
}

function swallow(e: Event) {
	if (!active) return;
	if ((e.target as HTMLElement | null)?.closest('#sandbox-menu')) return;
	e.preventDefault();
	e.stopPropagation();
}

let resizeTimer = 0;
function onResize() {
	clearTimeout(resizeTimer);
	resizeTimer = window.setTimeout(() => {
		sizeCanvas();
		sizeFooterLayer();
		drawFooterCopy();
	}, 200);
}

/* ---------------------------------------------------------------- public */

export function isSprayOn(): boolean {
	return active;
}

export function currentColour(): string {
	return colour();
}

export function toggleSpray(): boolean {
	if (active) {
		active = false;
		spraying = false;
		stopSprayHiss();
		setActiveTool('none');
		document.documentElement.classList.remove('spray-on');

		window.removeEventListener('pointerdown', onPointerDown, { capture: true });
		window.removeEventListener('pointermove', onPointerMove, { capture: true });
		window.removeEventListener('pointerup', onPointerUp, { capture: true });
		window.removeEventListener('click', swallow, { capture: true });
		window.removeEventListener('contextmenu', onContextMenu, { capture: true });
		window.removeEventListener('resize', onResize);
		return false;
	}

	initAudio();
	ensureCanvas();
	ensureCursor();

	active = true;
	setActiveTool('spray');
	document.documentElement.classList.add('spray-on');
	playShake();

	window.addEventListener('pointerdown', onPointerDown, { capture: true });
	window.addEventListener('pointermove', onPointerMove, { capture: true });
	window.addEventListener('pointerup', onPointerUp, { capture: true });
	window.addEventListener('click', swallow, { capture: true });
	window.addEventListener('contextmenu', onContextMenu, { capture: true });
	window.addEventListener('resize', onResize);
	return true;
}

export function clearPaint() {
	drips.length = 0;
	density.clear();
	if (ctx && canvas) {
		ctx.save();
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.clearRect(0, 0, canvas.width, canvas.height);
		ctx.restore();
	}
	drawFooterCopy();
}
