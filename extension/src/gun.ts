import { initAudio, playCock, playGunshot, playHolster } from './audio';
import { aimViewmodel, fireViewmodel, mountViewmodel, setViewmodelVisible } from './gunModel';
import {
	addLetters,
	clearLetters,
	ensurePhysics,
	rebuildBounds,
	setRenderer,
	shoveLetters,
	wakeLetters,
} from './letterPhysics';
import {
	addHole,
	clearHoles,
	ensureOverlay,
	kickReticle,
	moveReticle,
	overlayRoot,
	render,
	requestRender,
	setArmed,
} from './overlay';
import { restoreText, shatterAt } from './shatter';

const BLAST_RADIUS = 100;

let armed = false;
let resizeTimer = 0;

function shoot(clientX: number, clientY: number) {
	playGunshot();
	fireViewmodel();
	kickReticle();
	addHole(clientX, clientY);

	const spawns = shatterAt(clientX, clientY, BLAST_RADIUS);
	if (spawns.length) addLetters(spawns);

	// letters already lying in the pile are still fair game
	shoveLetters(clientX, clientY, BLAST_RADIUS);
	requestRender();
}

/* --------------------------------------------------------------- handlers */

function onPointerDown(e: PointerEvent) {
	if (!armed || e.button !== 0) return;
	e.preventDefault();
	e.stopPropagation();

	// touch has no hover, so the tap itself is the only aim signal we get
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
	e.preventDefault();
	e.stopPropagation();
}

function onKeyDown(e: KeyboardEvent) {
	if (!armed) return;
	if (e.key === 'Escape') {
		e.preventDefault();
		e.stopPropagation();
		disarm();
	}
}

function onResize() {
	clearTimeout(resizeTimer);
	resizeTimer = window.setTimeout(() => {
		rebuildBounds();
		wakeLetters();
	}, 150);
}

const CAPTURE = { capture: true } as const;

function listen(on: boolean) {
	const method = on ? 'addEventListener' : 'removeEventListener';
	window[method]('pointerdown', onPointerDown as EventListener, CAPTURE);
	window[method]('pointermove', onPointerMove as EventListener, CAPTURE);
	window[method]('click', swallow, CAPTURE);
	window[method]('auxclick', swallow, CAPTURE);
	window[method]('dragstart', swallow, CAPTURE);
	window[method]('keydown', onKeyDown as EventListener, CAPTURE);
	window[method]('resize', onResize);
}

/* ---------------------------------------------------------------- public */

export function isArmed(): boolean {
	return armed;
}

export function arm() {
	if (armed) return;

	initAudio();
	ensureOverlay();
	ensurePhysics();
	setRenderer(render);
	mountViewmodel(overlayRoot());

	armed = true;
	setArmed(true);
	document.documentElement.classList.add('pgs-armed');
	setViewmodelVisible(true);
	listen(true);
	playCock();
}

export function disarm() {
	if (!armed) return;

	armed = false;
	setArmed(false);
	document.documentElement.classList.remove('pgs-armed');
	setViewmodelVisible(false);
	listen(false);
	playHolster();
}

export function toggle(): boolean {
	if (armed) disarm();
	else arm();
	return armed;
}

// put the page back: every character returned, every hole and letter dropped
export function reset() {
	clearLetters();
	clearHoles();
	restoreText();
	requestRender();
}
