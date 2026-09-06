import { initAudio, playCock, playGunshot, playHolster } from './audio';
import {
	aimViewmodel,
	fireViewmodel,
	launchRocket,
	mountViewmodel,
	nextWeapon,
	setProjectileImpact,
	setViewmodelVisible,
	setWeapon,
	weaponReady,
} from './gunModel';
import type { WeaponName } from './gunModel';
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
// a shotgun throws its pellets over a wider area than one bullet touches
const SHOTGUN_PELLETS = 13;
const SHOTGUN_SPREAD = 120;
// the angle successive points on a sunflower spiral are separated by
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
// a rocket goes off over a much bigger patch than anything else reaches
const RPG_RADIUS = 350;
// how fast the rifle keeps firing while the button is held, in milliseconds
const AUTO_INTERVAL = 145;

let armed = false;
let resizeTimer = 0;
let weapon: WeaponName = 'pistol';
let autoTimer = 0;
let pointer = { x: 0, y: 0 };

// one shot's worth of damage at a point: the mark, the characters it knocks
// loose, and a shove for anything already lying in the pile
function damage(clientX: number, clientY: number, radius: number, mark: 'hole' | 'scorch') {
	addHole(clientX, clientY, mark);

	const spawns = shatterAt(clientX, clientY, radius);
	if (spawns.length) addLetters(spawns);

	shoveLetters(clientX, clientY, radius);
}

function shoot(clientX: number, clientY: number) {
	// a launcher with nothing in it does nothing at all: no report, no recoil
	if (weapon === 'rpg' && !weaponReady()) return;

	playGunshot(weapon);
	fireViewmodel();
	kickReticle();

	if (weapon === 'rpg') {
		// nothing happens here: the damage waits for the rocket to arrive
		launchRocket(clientX, clientY);
		requestRender();
		return;
	}

	if (weapon === 'shotgun') {
		// Pellets are laid out on a sunflower spiral rather than drawn at random:
		// the golden angle keeps successive pellets as far apart as they can be,
		// so the pattern covers the cone evenly instead of clumping the way pure
		// chance does. The whole pattern is spun at random and each pellet is
		// nudged off its station, so no two shots land the same.
		const spin = Math.random() * Math.PI * 2;
		for (let i = 0; i < SHOTGUN_PELLETS; i++) {
			// sqrt spreads the rings evenly over the area of the cone rather than
			// over its width, which would bunch them at the middle
			const ring = Math.sqrt((i + 0.5) / SHOTGUN_PELLETS);
			const distance = ring * SHOTGUN_SPREAD * (1 + (Math.random() - 0.5) * 0.22);
			const angle = spin + i * GOLDEN_ANGLE + (Math.random() - 0.5) * 0.55;
			damage(
				clientX + Math.cos(angle) * distance,
				clientY + Math.sin(angle) * distance,
				BLAST_RADIUS,
				'hole'
			);
		}
		requestRender();
		return;
	}

	damage(clientX, clientY, BLAST_RADIUS, 'hole');
	requestRender();
}

// the rocket has landed: this is where an rpg shot actually does its damage
function detonate(clientX: number, clientY: number) {
	playGunshot('explosion');
	damage(clientX, clientY, RPG_RADIUS, 'scorch');
	requestRender();
}

/* --------------------------------------------------------------- handlers */

function onPointerDown(e: PointerEvent) {
	if (!armed || e.button !== 0) return;
	e.preventDefault();
	e.stopPropagation();

	// touch has no hover, so the tap itself is the only aim signal we get
	pointer = { x: e.clientX, y: e.clientY };
	moveReticle(e.clientX, e.clientY);
	aimViewmodel(e.clientX, e.clientY, e.pointerType !== 'mouse');
	shoot(e.clientX, e.clientY);

	// the rifle keeps firing at wherever the pointer is until it is released
	if (weapon === 'rifle') {
		stopAuto();
		autoTimer = window.setInterval(() => shoot(pointer.x, pointer.y), AUTO_INTERVAL);
	}
}

function stopAuto() {
	if (!autoTimer) return;
	clearInterval(autoTimer);
	autoTimer = 0;
}

function onPointerUp() {
	stopAuto();
}

// right click anywhere on the page racks the next weapon
function onContextMenu(e: MouseEvent) {
	if (!armed) return;
	e.preventDefault();
	e.stopPropagation();

	weapon = nextWeapon(weapon);
	setWeapon(weapon);
	stopAuto();
	playCock();
}

function onPointerMove(e: PointerEvent) {
	if (!armed) return;
	pointer = { x: e.clientX, y: e.clientY };
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
	window[method]('pointerup', onPointerUp as EventListener, CAPTURE);
	window[method]('pointercancel', onPointerUp as EventListener, CAPTURE);
	window[method]('contextmenu', onContextMenu as EventListener, CAPTURE);
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
	setProjectileImpact(detonate);
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

	stopAuto();
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
