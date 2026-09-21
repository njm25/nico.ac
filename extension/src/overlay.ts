import { getLetters } from './letterPhysics';

// Everything the extension draws lives inside one shadow root attached to
// <html>, so the host page's CSS cannot reach it and our styles cannot leak out.
// It hangs off documentElement rather than body because plenty of sites replace
// or re-render body wholesale.

const MAX_HOLES = 120;

type MarkKind = 'hole' | 'scorch';

interface Hole {
	// page coordinates, so marks stay stuck to the spot on the page that was hit
	pageX: number;
	pageY: number;
	angle: number;
	kind: MarkKind;
	// a bullet hole's cracks, or a scorch's debris streaks: angle, bend, length
	cracks: number[];
}

let host: HTMLElement | null = null;
let root: ShadowRoot | null = null;
let canvas: HTMLCanvasElement | null = null;
let ctx: CanvasRenderingContext2D | null = null;
let reticle: HTMLElement | null = null;

const holes: Hole[] = [];
let dirty = false;

const OVERLAY_CSS = `
:host {
	all: initial;
}

#debris {
	position: fixed;
	top: 0;
	left: 0;
	pointer-events: none;
}

#gun-viewmodel {
	position: fixed;
	top: 0;
	left: 0;
	pointer-events: none;
}

#reticle {
	position: fixed;
	top: 0;
	left: 0;
	width: 40px;
	height: 40px;
	margin: -20px 0 0 -20px;
	pointer-events: none;
	color: #fff;
	opacity: 0;
	transition: opacity 0.15s ease;
	filter: drop-shadow(0 0 2px rgba(0, 0, 0, 0.95));
}

:host(.armed) #reticle {
	opacity: 1;
}

/* never animate transform here: the inline transform carries the position and
   a scale would multiply it and throw the reticle off screen */
.ticks,
.dot {
	transform-box: fill-box;
	transform-origin: center;
}

#reticle.firing .ticks {
	animation: kick 0.19s ease-out;
}

#reticle.firing .dot {
	animation: pulse 0.19s ease-out;
}

@keyframes kick {
	0% { transform: scale(1); }
	28% { transform: scale(1.5); }
	100% { transform: scale(1); }
}

@keyframes pulse {
	0% { transform: scale(1); opacity: 1; }
	28% { transform: scale(2.2); opacity: 0.5; }
	100% { transform: scale(1); opacity: 1; }
}
`;

const RETICLE_SVG = `
<svg viewBox="0 0 40 40" width="40" height="40" fill="none" stroke="currentColor" stroke-linecap="round">
	<circle cx="20" cy="20" r="13.5" stroke-width="1" opacity="0.28" />
	<g class="ticks" stroke-width="1.6">
		<path d="M20 4.5 V11" />
		<path d="M20 29 V35.5" />
		<path d="M4.5 20 H11" />
		<path d="M29 20 H35.5" />
	</g>
	<circle class="dot" cx="20" cy="20" r="1.3" fill="currentColor" stroke="none" />
</svg>`;

export function ensureOverlay(): ShadowRoot {
	if (root) return root;

	host = document.createElement('div');
	host.id = 'page-shooter-root';
	// a site with a z-index arms race still cannot get above this
	host.style.cssText =
		'all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;pointer-events:none;';
	document.documentElement.appendChild(host);

	root = host.attachShadow({ mode: 'open' });

	const style = document.createElement('style');
	style.textContent = OVERLAY_CSS;
	root.appendChild(style);

	canvas = document.createElement('canvas');
	canvas.id = 'debris';
	root.appendChild(canvas);
	ctx = canvas.getContext('2d');

	reticle = document.createElement('div');
	reticle.id = 'reticle';
	reticle.innerHTML = RETICLE_SVG;
	reticle.style.transform = `translate(${window.innerWidth / 2}px, ${window.innerHeight / 2}px)`;
	root.appendChild(reticle);

	sizeCanvas();
	window.addEventListener('resize', onResize);
	// holes are stored in page space, so any scroll changes where they land
	window.addEventListener('scroll', requestRender, { passive: true });

	return root;
}

export function overlayRoot(): ShadowRoot {
	return ensureOverlay();
}

function sizeCanvas() {
	if (!canvas) return;
	const ratio = Math.min(window.devicePixelRatio, 2);
	canvas.width = Math.round(window.innerWidth * ratio);
	canvas.height = Math.round(window.innerHeight * ratio);
	canvas.style.width = `${window.innerWidth}px`;
	canvas.style.height = `${window.innerHeight}px`;
	ctx = canvas.getContext('2d');
	ctx?.setTransform(ratio, 0, 0, ratio, 0, 0);
}

function onResize() {
	sizeCanvas();
	requestRender();
}

export function setArmed(armed: boolean) {
	host?.classList.toggle('armed', armed);
}

export function moveReticle(x: number, y: number) {
	if (reticle) reticle.style.transform = `translate(${x}px, ${y}px)`;
}

export function kickReticle() {
	if (!reticle) return;
	reticle.classList.remove('firing');
	void reticle.getBoundingClientRect();
	reticle.classList.add('firing');
}

/* ------------------------------------------------------------------ holes */

export function addHole(clientX: number, clientY: number, kind: MarkKind = 'hole') {
	const cracks: number[] = [];
	// a blast throws far more, and much further, than a bullet cracks
	const count = kind === 'scorch' ? 16 + Math.floor(Math.random() * 8) : 6 + Math.floor(Math.random() * 4);
	for (let i = 0; i < count; i++) {
		const angle = (i / count) * Math.PI * 2 + Math.random() * (kind === 'scorch' ? 0.45 : 0.6);
		const bend = angle + (Math.random() - 0.5) * 0.6;
		cracks.push(
			angle,
			bend,
			kind === 'scorch' ? 18 + Math.random() * 24 : 4.4 + Math.random() * 5.5
		);
	}

	holes.push({
		pageX: clientX + window.scrollX,
		pageY: clientY + window.scrollY,
		angle: Math.random() * Math.PI * 2,
		kind,
		cracks,
	});
	if (holes.length > MAX_HOLES) holes.shift();
	requestRender();
}

export function clearHoles() {
	holes.length = 0;
	requestRender();
}

/* ----------------------------------------------------------------- render */

export function requestRender() {
	if (dirty) return;
	dirty = true;
	requestAnimationFrame(() => {
		dirty = false;
		render();
	});
}

export function render() {
	if (!ctx || !canvas) return;

	ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
	drawHoles(ctx);
	drawLetters(ctx);
}

function drawHoles(target: CanvasRenderingContext2D) {
	const offsetX = window.scrollX;
	const offsetY = window.scrollY;

	for (const hole of holes) {
		const x = hole.pageX - offsetX;
		const y = hole.pageY - offsetY;
		const margin = hole.kind === 'scorch' ? 70 : 30;
		if (
			x < -margin ||
			y < -margin ||
			x > window.innerWidth + margin ||
			y > window.innerHeight + margin
		) {
			continue;
		}

		target.save();
		target.translate(x, y);
		target.rotate(hole.angle);

		if (hole.kind === 'scorch') {
			drawScorch(target, hole);
			target.restore();
			continue;
		}

		target.strokeStyle = 'rgba(215,219,224,0.22)';
		target.lineWidth = 0.7;
		target.lineCap = 'round';
		target.beginPath();
		for (let i = 0; i < hole.cracks.length; i += 3) {
			const [angle, bend, outer] = [hole.cracks[i], hole.cracks[i + 1], hole.cracks[i + 2]];
			target.moveTo(Math.cos(angle) * 3.2, Math.sin(angle) * 3.2);
			target.lineTo(Math.cos(bend) * outer, Math.sin(bend) * outer);
		}
		target.stroke();

		target.fillStyle = '#05060a';
		target.strokeStyle = 'rgba(215,219,224,0.28)';
		target.lineWidth = 0.8;
		target.beginPath();
		target.arc(0, 0, 3.6, 0, Math.PI * 2);
		target.fill();
		target.stroke();

		target.fillStyle = '#000';
		target.beginPath();
		target.arc(0, 0, 2.1, 0, Math.PI * 2);
		target.fill();

		target.restore();
	}
}

function drawScorch(target: CanvasRenderingContext2D, hole: Hole) {
	// soot fading out from the middle, under everything else
	const ground = target.createRadialGradient(0, 0, 0, 0, 0, 50);
	ground.addColorStop(0, 'rgba(5,6,10,0.82)');
	ground.addColorStop(0.36, 'rgba(5,6,10,0.45)');
	ground.addColorStop(0.68, 'rgba(5,6,10,0)');
	target.fillStyle = ground;
	target.beginPath();
	target.arc(0, 0, 50, 0, Math.PI * 2);
	target.fill();

	// debris flung out along the streaks
	target.strokeStyle = 'rgba(8,8,10,0.5)';
	target.lineWidth = 2.6;
	target.lineCap = 'round';
	target.beginPath();
	for (let i = 0; i < hole.cracks.length; i += 3) {
		const angle = hole.cracks[i];
		const bend = hole.cracks[i + 1];
		const outer = hole.cracks[i + 2];
		const inner = 11 + (outer % 9);
		target.moveTo(Math.cos(angle) * inner, Math.sin(angle) * inner);
		target.lineTo(Math.cos(bend) * (inner + outer), Math.sin(bend) * (inner + outer));
	}
	target.stroke();

	target.fillStyle = 'rgba(5,6,10,0.8)';
	target.beginPath();
	target.arc(0, 0, 16, 0, Math.PI * 2);
	target.fill();

	target.fillStyle = '#000';
	target.beginPath();
	target.arc(0, 0, 9, 0, Math.PI * 2);
	target.fill();
}

function drawLetters(target: CanvasRenderingContext2D) {
	target.textAlign = 'center';
	target.textBaseline = 'middle';

	for (const letter of getLetters()) {
		const { x, y } = letter.body.position;
		if (x < -60 || y < -60 || x > window.innerWidth + 60 || y > window.innerHeight + 60) continue;

		target.save();
		target.translate(x, y);
		target.rotate(letter.body.angle);
		target.font = letter.font;
		target.fillStyle = letter.colour;
		target.fillText(letter.glyph, 0, 0);
		target.restore();
	}
}

export function destroyOverlay() {
	window.removeEventListener('resize', onResize);
	window.removeEventListener('scroll', requestRender);
	host?.remove();
	host = null;
	root = null;
	canvas = null;
	ctx = null;
	reticle = null;
	holes.length = 0;
}
