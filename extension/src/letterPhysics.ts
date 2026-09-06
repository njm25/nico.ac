import Matter from 'matter-js';

const { Bodies, Body, Composite, Engine, Sleeping } = Matter;

// Same world as the portfolio version, but the debris is drawn to a canvas
// instead of being a DOM node per letter. On an arbitrary page a span per
// character - with a transform written to each one every frame - is far too
// much DOM to be pushing around, so each body just carries the glyph and the
// styling needed to paint it.
export interface LetterSpawn {
	glyph: string;
	font: string;
	colour: string;
	x: number;
	y: number;
	width: number;
	height: number;
	vx: number;
	vy: number;
	spin: number;
}

export interface Letter {
	body: Matter.Body;
	glyph: string;
	font: string;
	colour: string;
	width: number;
	height: number;
	settled: boolean;
}

const WALL = 400;
const STEP = 1000 / 60;
const MAX_STEPS_PER_FRAME = 4;
const MAX_LETTERS = 600;

let engine: Matter.Engine | null = null;
let bounds: Matter.Body[] = [];
const letters: Letter[] = [];

let running = false;
let rafId = 0;
let lastTime = 0;
let accumulator = 0;
let onFrame: (() => void) | null = null;

export function setRenderer(callback: () => void) {
	onFrame = callback;
}

export function ensurePhysics(): Matter.Engine {
	if (engine) return engine;
	// sleeping keeps settled piles free
	engine = Engine.create({ enableSleeping: true });
	engine.gravity.y = 1;
	rebuildBounds();
	return engine;
}

export function rebuildBounds() {
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

export function getLetters(): readonly Letter[] {
	return letters;
}

export function letterCount(): number {
	return letters.length;
}

export function addLetters(spawns: LetterSpawn[]) {
	if (!spawns.length) return;
	const world = ensurePhysics().world;

	for (const spawn of spawns) {
		const body = Bodies.rectangle(spawn.x, spawn.y, spawn.width, spawn.height, {
			restitution: 0.18,
			friction: 0.55,
			frictionAir: 0.012,
			density: 0.0016,
		});
		Body.setVelocity(body, { x: spawn.vx, y: spawn.vy });
		Body.setAngularVelocity(body, spawn.spin);

		Composite.add(world, body);
		letters.push({
			body,
			glyph: spawn.glyph,
			font: spawn.font,
			colour: spawn.colour,
			width: spawn.width,
			height: spawn.height,
			settled: false,
		});
	}

	cull();
	startLoop();
}

// a blast near the pile: wake anything in range and throw it outward
export function shoveLetters(x: number, y: number, radius: number) {
	if (!letters.length) return;
	let disturbed = false;

	for (const letter of letters) {
		const dx = letter.body.position.x - x;
		const dy = letter.body.position.y - y;
		const distance = Math.hypot(dx, dy);
		if (distance > radius) continue;

		const falloff = 1 - distance / radius;
		const spread = distance < 0.5 ? Math.random() * Math.PI * 2 : Math.atan2(dy, dx);
		const speed = (4 + falloff * 15) * (0.7 + Math.random() * 0.6);

		// setVelocity alone will not rouse a sleeping body
		Sleeping.set(letter.body, false);
		Body.setVelocity(letter.body, {
			x: Math.cos(spread) * speed,
			y: Math.sin(spread) * speed - falloff * 6,
		});
		Body.setAngularVelocity(letter.body, (Math.random() - 0.5) * 0.3);
		letter.settled = false;
		disturbed = true;
	}

	if (disturbed) startLoop();
}

export function wakeLetters() {
	for (const letter of letters) {
		Sleeping.set(letter.body, false);
		letter.settled = false;
	}
	if (letters.length) startLoop();
}

export function clearLetters() {
	if (engine && letters.length) {
		Composite.remove(
			engine.world,
			letters.map((l) => l.body)
		);
	}
	letters.length = 0;
	stopLoop();
}

/* ------------------------------------------------------------------ loop */

function startLoop() {
	if (running) return;
	running = true;
	lastTime = 0;
	accumulator = 0;
	rafId = requestAnimationFrame(frame);
}

function stopLoop() {
	running = false;
	cancelAnimationFrame(rafId);
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

	for (const letter of letters) letter.settled = letter.body.isSleeping;
	onFrame?.();

	// park once everything has come to rest
	if (letters.every((l) => l.settled)) stopLoop();
}

function cull() {
	const excess = letters.length - MAX_LETTERS;
	if (excess <= 0) return;
	const dropped = letters.splice(0, excess);
	Composite.remove(
		engine!.world,
		dropped.map((l) => l.body)
	);
}
