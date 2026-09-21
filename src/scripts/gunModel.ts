import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

// fps-style viewmodel: the camera sits at the origin looking down -z, and the gun
// is pinned to the bottom-right of the frustum and swung to point at the cursor.
// default lens; each weapon can pick its own, since a wide angle exaggerates
// anything held close to the camera
const FOV = 70;
// default distance from the camera; each weapon can sit nearer or further
const RIG_DEPTH = 1;
// how fast the discarded weapon drops out of shot, in world units per second
const OUTGOING_FALL = 2.4;
const OUTGOING_LIFE = 0.5;

const HIDDEN_DROP = 1.1;

// the models point down +x, so a quarter turn puts the barrel on the rig's -z
const BASE_YAW = Math.PI / 2;
const BASE_PITCH = 0;

export type WeaponName = 'pistol' | 'rifle' | 'shotgun' | 'rpg';

interface WeaponSpec {
	url: string;
	// longest dimension of the model once scaled, in world units
	targetLength: number;
	fov: number;
	// how much of the true angle to the cursor the weapon actually turns. 1 points
	// the barrel straight at it, which swings the gun fully side on at the edges
	// of the screen and stops it reading as first person
	aimGain: number;
	// resting cant. at zero the barrel lies along the view axis and the weapon is
	// seen end on, which is invisible; a real viewmodel angles in toward the
	// middle of the screen so you see its side
	yawCant: number;
	// gunmetal strips the colour out entirely; natural keeps the model's own
	// hues, which is what the wood furniture on the rifle and shotgun needs
	finish: 'gunmetal' | 'natural';
	// most models point down +x with +y up. this one lies along -z with -x up, so
	// it gets turned into the same frame before anything is measured
	orient?: 'negZForwardNegXUp';
	// this weapon is modelled with its round in it. the round gets separated out
	// of the mesh so the launcher can be shown loaded, fire that very round, and
	// then take a fresh one, rather than carrying one that never leaves.
	projectile?: boolean;
	// a recoilless launcher belches smoke rather than throwing a muzzle flash
	smoke?: boolean;
	// where along the barrel the weapon turns, 0 at the stock and 1 at the
	// muzzle. centring it (0.5) makes the whole rear half swing out of frame
	// when the gun aims across the screen
	grip: number;
	// how far in front of the camera the weapon is held
	depth: number;
	// inset from the bottom-right corner of the frustum at that depth
	anchorInsetX: number;
	anchorInsetY: number;
	baseRoll: number;
	recoilKick: number;
	flashScale: number;
}

// the rifle is roughly twice the pistol's length, so it is pushed further into
// the corner and kicks less per shot - it makes up for it in volume of fire
const WEAPONS: Record<WeaponName, WeaponSpec> = {
	pistol: {
		url: '/models/pistol.glb',
		targetLength: 0.46,
		fov: FOV,
		aimGain: 1,
		yawCant: 0,
		finish: 'gunmetal',
		grip: 0.5,
		depth: RIG_DEPTH,
		anchorInsetX: 0.3,
		anchorInsetY: 0.22,
		baseRoll: -0.05,
		recoilKick: 7,
		flashScale: 1,
	},
	rpg: {
		url: '/models/rpg.glb',
		targetLength: 0.85,
		fov: 52,
		aimGain: 1,
		yawCant: 0,
		// textured, so the colour pass leaves it alone either way
		finish: 'natural',
		orient: 'negZForwardNegXUp',
		// roughly at the pistol grip, a little behind the middle of the tube
		grip: 0.42,
		// held further out than the other weapons: two fifths of a launcher this
		// long sits behind the grip, and any closer buries the tube in the lens
		depth: 0.78,
		anchorInsetX: 0.2,
		anchorInsetY: 0.08,
		baseRoll: -0.03,
		projectile: true,
		smoke: true,
		// a recoilless launcher: the back blast cancels it out
		recoilKick: 0,
		flashScale: 1.4,
	},
	shotgun: {
		url: '/models/shotgun.glb',
		targetLength: 0.62,
		fov: 74,
		aimGain: 1,
		yawCant: 0,
		finish: 'natural',
		// sawn off: barely any weapon behind the grip
		grip: 0.42,
		depth: 0.52,
		anchorInsetX: 0.1,
		anchorInsetY: 0.05,
		baseRoll: -0.03,
		// heaviest kick of the three, and the widest muzzle bloom
		recoilKick: 11,
		flashScale: 1.6,
	},
	rifle: {
		url: '/models/rifle.glb',
		targetLength: 0.92,
		// a narrower lens keeps a long weapon this close from looking bent
		fov: 74,
		aimGain: 1,
		yawCant: 0,
		finish: 'natural',
		// the pistol grip on an ak sits a bit over a third back from the stock
		grip: 0.38,
		// held close and slung low, so it fills the corner of the frame
		depth: 0.46,
		// the insets shrink with the depth: the frustum is smaller this near the
		// camera, so the same numbers would push the weapon back toward the middle
		anchorInsetX: 0.09,
		anchorInsetY: 0.04,
		baseRoll: -0.03,
		recoilKick: 3.6,
		flashScale: 1.2,
	},
};

const WEAPON_ORDER: WeaponName[] = ['pistol', 'rifle', 'shotgun', 'rpg'];

// the rocket is its own object, not part of the launcher: it detaches on firing
// and flies to the cursor under its own steam
const ROCKET_FLIGHT = 0.3;
const ROCKET_RANGE = 3.5;

let weapon: WeaponName = 'pistol';
let holder: THREE.Group | null = null;
// bumped on every weapon change so a load that finishes late is discarded
let loadToken = 0;

const spec = () => WEAPONS[weapon];

// where the crosshair lives in world space; the barrel is aimed at this point
const AIM_DISTANCE = 7;
const AIM_EASE = 14;
// a tap gives no hover to track from, so the gun swings hard for a moment to
// reach the target rather than drifting there long after the shot
const AIM_EASE_QUICK = 34;
const AIM_BOOST_MS = 260;
const BOB_SPEED = 1.6;
const BOB_AMOUNT = 0.006;

const RECOIL_STIFFNESS = 210;
const RECOIL_DAMPING = 14;
const FLASH_TIME = 0.075;

let renderer: THREE.WebGLRenderer | null = null;
let scene: THREE.Scene | null = null;
let camera: THREE.PerspectiveCamera | null = null;
let canvas: HTMLCanvasElement | null = null;
let clock: THREE.Clock | null = null;

let rig: THREE.Group | null = null;
let muzzle: THREE.Object3D | null = null;
// where smoke comes from: the mouth of the tube, which on a launcher is well
// behind the tip of the round sticking out of it
let smokePort: THREE.Object3D | null = null;
let flashGroup: THREE.Group | null = null;
let flashCore: THREE.Mesh | null = null;
let flashStar: THREE.Mesh | null = null;
let flashLight: THREE.PointLight | null = null;

const rest = new THREE.Vector3();
const aimTarget = new THREE.Vector3(0, 0, -AIM_DISTANCE);
const pointerNdc = new THREE.Vector2(0, 0);
const scratch = new THREE.Vector3();

let visible = false;
// a swap stows the old weapon before the new one is loaded, so the change reads
// as putting one away and drawing another rather than a model popping in place
// A swap crosses the two weapons over rather than running them in sequence: the
// outgoing one is detached into the scene and keeps falling under its own
// momentum while the new one is already rising, so the frame is never empty.
// Built weapons are kept, so every swap after the first needs no load at all.
// a list, not a single slot: swapping again before the last one has finished
// falling used to strand it in the scene forever, and a stranded launcher can
// end up parked across the lens
const departing: { holder: THREE.Group; age: number }[] = [];

interface Rocket {
	mesh: THREE.Group;
	from: THREE.Vector3;
	to: THREE.Vector3;
	progress: number;
	screenX: number;
	screenY: number;
}

const rockets: Rocket[] = [];
// how long after a round goes off before the next one starts sliding up, and
// how long it takes to seat, in seconds
const RELOAD_DELAY = 0.18;
const RELOAD_TIME = 0.55;
// The reload runs as three legs that never overlap: any overlap between the
// lift and the insertion drags the round's tail through the bottom of the tube.
// Out along the bottom, up onto the barrel line, then in.
const RELOAD_OUT = 0.35;
const RELOAD_RISE = 0.62;

// the round belonging to the weapon currently in hand, hidden while one is away
let loadedWarheads: THREE.Mesh[] = [];
// where each of those sits when seated, and the reach of the loading arc
let warheadRest: THREE.Vector3[] = [];
let reloadTravel = 0;
let reloadDrop = 0;
// seconds into the reload, or negative when there is nothing to seat
let reloadAge = -1;

interface Puff {
	mesh: THREE.Mesh;
	age: number;
	ttl: number;
	velocity: THREE.Vector3;
}

const puffs: Puff[] = [];
let smokeTexture: THREE.CanvasTexture | null = null;
let onImpact: ((clientX: number, clientY: number) => void) | null = null;
// the flash normally rides the muzzle; a detonation pins it where it went off
let flashAnchor: THREE.Vector3 | null = null;
let flashBoost = 1;

interface Built {
	holder: THREE.Group;
	muzzle: THREE.Vector3;
	rotation: THREE.Euler;
	// the loaded round, if this weapon carries one it can actually fire
	warheads: THREE.Mesh[];
	// how far out past the muzzle a fresh round swings while being loaded
	reloadTravel: number;
	// and how far below the launcher it starts, far enough to be out of frame
	reloadDrop: number;
	// where this weapon's smoke comes from
	smokeAt: THREE.Vector3;
}

const built = new Map<WeaponName, Built>();
let reveal = 0;
let yaw = 0;
let pitch = 0;
let recoil = 0;
let recoilVelocity = 0;
let aimBoostUntil = 0;
let flashTimer = 0;
let flashSeed = 0;
let running = false;
let rafId = 0;

const reduceMotion = () =>
	typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ------------------------------------------------------------------ setup */

export function mountViewmodel() {
	if (renderer) return;

	canvas = document.createElement('canvas');
	canvas.id = 'gun-viewmodel';
	canvas.setAttribute('aria-hidden', 'true');
	document.body.appendChild(canvas);

	renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
	renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
	renderer.setSize(window.innerWidth, window.innerHeight);
	renderer.toneMapping = THREE.ACESFilmicToneMapping;
	renderer.toneMappingExposure = 0.9;

	scene = new THREE.Scene();
	camera = new THREE.PerspectiveCamera(spec().fov, window.innerWidth / window.innerHeight, 0.01, 40);
	clock = new THREE.Clock();

	const pmrem = new THREE.PMREMGenerator(renderer);
	scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

	const key = new THREE.DirectionalLight(0xffffff, 0.9);
	key.position.set(1.4, 1.6, 0.9);
	const fill = new THREE.DirectionalLight(0xffffff, 0.25);
	fill.position.set(-1.6, 0.2, 0.6);
	const rim = new THREE.DirectionalLight(0xffffff, 0.4);
	rim.position.set(-0.6, 0.8, -1.6);
	scene.add(key, fill, rim, new THREE.AmbientLight(0xffffff, 0.4));

	rig = new THREE.Group();
	rig.rotation.order = 'YXZ';
	scene.add(rig);

	muzzle = new THREE.Object3D();
	smokePort = new THREE.Object3D();
	rig.add(muzzle);

	buildFlash();
	layoutRig();
	loadModel(weapon);

	window.addEventListener('resize', onResize);
}

// pins the gun to the bottom-right corner whatever the viewport shape is
function layoutRig() {
	if (!camera) return;
	const depth = spec().depth;
	camera.fov = spec().fov;
	camera.updateProjectionMatrix();
	const halfHeight = Math.tan(THREE.MathUtils.degToRad(spec().fov / 2)) * depth;
	const halfWidth = halfHeight * camera.aspect;
	rest.set(halfWidth - spec().anchorInsetX, -halfHeight + spec().anchorInsetY, -depth);
}

function makeFlashTexture(spikes: number): THREE.CanvasTexture {
	const size = 128;
	const c = document.createElement('canvas');
	c.width = c.height = size;
	const ctx = c.getContext('2d')!;
	const mid = size / 2;

	if (spikes > 0) {
		ctx.fillStyle = '#fff3d0';
		for (let i = 0; i < spikes; i++) {
			const angle = (i / spikes) * Math.PI * 2;
			const length = mid * (i % 2 === 0 ? 0.98 : 0.55);
			const width = 0.12;
			ctx.beginPath();
			ctx.moveTo(mid + Math.cos(angle) * length, mid + Math.sin(angle) * length);
			ctx.lineTo(mid + Math.cos(angle + width) * mid * 0.16, mid + Math.sin(angle + width) * mid * 0.16);
			ctx.lineTo(mid + Math.cos(angle - width) * mid * 0.16, mid + Math.sin(angle - width) * mid * 0.16);
			ctx.closePath();
			ctx.fill();
		}
	}

	const gradient = ctx.createRadialGradient(mid, mid, 0, mid, mid, mid);
	gradient.addColorStop(0, 'rgba(255,255,255,1)');
	gradient.addColorStop(0.16, 'rgba(255,241,199,0.95)');
	gradient.addColorStop(0.36, 'rgba(255,178,64,0.55)');
	gradient.addColorStop(0.65, 'rgba(255,120,20,0.16)');
	gradient.addColorStop(1, 'rgba(255,110,0,0)');
	ctx.globalCompositeOperation = spikes > 0 ? 'lighter' : 'source-over';
	ctx.fillStyle = gradient;
	ctx.fillRect(0, 0, size, size);

	const texture = new THREE.CanvasTexture(c);
	texture.colorSpace = THREE.SRGBColorSpace;
	return texture;
}

function flashPlane(texture: THREE.Texture, size: number): THREE.Mesh {
	return new THREE.Mesh(
		new THREE.PlaneGeometry(size, size),
		new THREE.MeshBasicMaterial({
			map: texture,
			transparent: true,
			opacity: 0,
			blending: THREE.AdditiveBlending,
			depthWrite: false,
			// depth tested so the gun body occludes the flash instead of the
			// flash painting over the slide
			depthTest: true,
			toneMapped: false,
		})
	);
}

function buildFlash() {
	// the flash hangs off the scene rather than the rig so it always faces the
	// camera without having to undo the rig rotation every frame
	flashGroup = new THREE.Group();
	scene!.add(flashGroup);

	flashCore = flashPlane(makeFlashTexture(0), 0.34);
	flashStar = flashPlane(makeFlashTexture(6), 0.62);
	flashLight = new THREE.PointLight(0xffb347, 0, 4, 2);
	flashGroup.add(flashCore, flashStar, flashLight);
	flashGroup.visible = false;
}

// swap the weapon in place, keeping the same renderer, rig and flash
export function setWeapon(next: WeaponName) {
	if (next === weapon && holder) return;

	if (!renderer) {
		weapon = next;
		layoutRig();
		return;
	}

	// the weapon in hand stays put until the new one is actually ready, so a
	// first time load never leaves an empty frame; after that it is instant
	loadModel(next);
}

export function currentWeapon(): WeaponName {
	return weapon;
}

// takes the current weapon rather than reading it: this module only adopts the
// new one once its model is ready, so its own value is stale mid swap and a
// quick run of swaps would keep landing on the same weapon
export function nextWeapon(current: WeaponName): WeaponName {
	return WEAPON_ORDER[(WEAPON_ORDER.indexOf(current) + 1) % WEAPON_ORDER.length];
}

function loadModel(name: WeaponName) {
	const ready = built.get(name);
	if (ready) {
		crossTo(ready, name);
		return;
	}

	const token = ++loadToken;
	const active = WEAPONS[name];

	new GLTFLoader().load(
		active.url,
		(gltf) => {
			const made = make(gltf.scene, active);
			// keep it even if the choice moved on, so it is free next time
			built.set(name, made);
			if (token !== loadToken) return;
			crossTo(made, name);
		},
		undefined,
		(err) => console.error('weapon model failed to load', name, err)
	);
}

// hand off: the old weapon carries on falling on its own while the new one is
// already coming up, so the two overlap instead of queueing
function crossTo(made: Built, name: WeaponName) {
	if (holder && holder !== made.holder) {
		// attach keeps its current world transform, so it drops from where it is
		scene!.attach(holder);
		departing.push({ holder, age: 0 });
		holder = null;
	}

	install(made);
	weapon = name;
	layoutRig();
	// start it below the frame so the same easing lifts it into shot
	reveal = 0;
	startLoop();
}

function subsetOf(source: THREE.BufferGeometry, indices: number[]): THREE.BufferGeometry {
	const geometry = new THREE.BufferGeometry();

	for (const name of Object.keys(source.attributes)) {
		const attribute = source.getAttribute(name);
		const size = attribute.itemSize;
		const data = new Float32Array(indices.length * size);

		indices.forEach((from, i) => {
			for (let c = 0; c < size; c++) data[i * size + c] = attribute.array[from * size + c];
		});

		geometry.setAttribute(name, new THREE.BufferAttribute(data, size));
	}

	return geometry;
}

interface Shell {
	indices: number[];
	front: number;
	back: number;
	// vertical extent, used to start a fresh round clear of the launcher
	top: number;
	bottom: number;
}

// groups triangles into connected surfaces, welding vertices by rounded
// position so a uv seam does not read as a break in the surface
function connectedShells(position: THREE.BufferAttribute): Shell[] {
	const ids = new Map<string, number>();
	const vertex = new Int32Array(position.count);
	for (let v = 0; v < position.count; v++) {
		const key = `${Math.round(position.getX(v) * 2e6)},${Math.round(
			position.getY(v) * 2e6
		)},${Math.round(position.getZ(v) * 2e6)}`;
		let id = ids.get(key);
		if (id === undefined) {
			id = ids.size;
			ids.set(key, id);
		}
		vertex[v] = id;
	}

	const parent = new Int32Array(ids.size);
	for (let i = 0; i < parent.length; i++) parent[i] = i;

	const find = (a: number): number => {
		while (parent[a] !== a) {
			parent[a] = parent[parent[a]];
			a = parent[a];
		}
		return a;
	};
	const join = (a: number, b: number) => {
		const ra = find(a);
		const rb = find(b);
		if (ra !== rb) parent[ra] = rb;
	};

	const triangles = Math.floor(position.count / 3);
	for (let t = 0; t < triangles; t++) {
		join(vertex[t * 3], vertex[t * 3 + 1]);
		join(vertex[t * 3 + 1], vertex[t * 3 + 2]);
	}

	const shells = new Map<number, Shell>();
	for (let t = 0; t < triangles; t++) {
		const root = find(vertex[t * 3]);
		let shell = shells.get(root);
		if (!shell) {
			shell = { indices: [], front: Infinity, back: -Infinity, top: Infinity, bottom: -Infinity };
			shells.set(root, shell);
		}
		for (let k = 0; k < 3; k++) {
			shell.indices.push(t * 3 + k);
			const z = position.getZ(t * 3 + k);
			if (z < shell.front) shell.front = z;
			if (z > shell.back) shell.back = z;
			// -x is up in this frame, so the smaller x is the higher one
			const x = position.getX(t * 3 + k);
			if (x < shell.top) shell.top = x;
			if (x > shell.bottom) shell.bottom = x;
		}
	}

	return [...shells.values()];
}

// The launcher ships as one mesh, so the round has to be found rather than
// named. A flat cut cannot do it: the round's tail runs back inside the tube,
// so along the barrel the two overlap and any plane slices through both. Break
// the mesh into connected shells instead and take the shell reaching furthest
// forward, plus anything sitting entirely ahead of the tube mouth. Forward is
// -z, before the model is turned into the shared frame.
function splitProjectile(model: THREE.Object3D): {
	meshes: THREE.Mesh[];
	travel: number;
	// the centre of the tube's mouth, in the model's own space
	mouth: THREE.Vector3 | null;
} {
	const meshes: THREE.Mesh[] = [];
	model.traverse((child) => {
		if (child instanceof THREE.Mesh) meshes.push(child);
	});

	const found: THREE.Mesh[] = [];
	let travel = 0;
	let mouth: THREE.Vector3 | null = null;

	for (const mesh of meshes) {
		if (!mesh.parent) continue;

		const source = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry;
		const shells = connectedShells(source.getAttribute('position') as THREE.BufferAttribute);
		if (shells.length < 2) continue;

		// the tube is the shell carrying the most triangles, the round the one
		// reaching furthest forward; if they are the same shell there is no round
		const tube = shells.reduce((a, b) => (b.indices.length > a.indices.length ? b : a));
		const nose = shells.reduce((a, b) => (b.front < a.front ? b : a));
		if (tube === nose) continue;

		const round = shells.filter((shell) => shell === nose || shell.back < tube.front);
		const rest = shells.filter((shell) => !round.includes(shell));

		mesh.geometry = subsetOf(
			source,
			rest.flatMap((shell) => shell.indices)
		);

		const warhead = new THREE.Mesh(
			subsetOf(
				source,
				round.flatMap((shell) => shell.indices)
			),
			mesh.material
		);
		warhead.name = 'warhead';
		warhead.position.copy(mesh.position);
		warhead.quaternion.copy(mesh.quaternion);
		warhead.scale.copy(mesh.scale);
		mesh.parent.add(warhead);
		found.push(warhead);

		// far enough forward that the whole round clears the muzzle, tail
		// included: most of its length is buried in the tube when it is seated,
		// and any less would drag the tail back through the barrel wall
		travel = Math.max(travel, (nose.back - tube.front) * 1.2 * mesh.scale.z);

		// on the tube's axis, at its mouth, kept in the model's own space so the
		// later scaling and placement carry it along
		model.updateWorldMatrix(true, true);
		mouth = model.worldToLocal(
			mesh.localToWorld(new THREE.Vector3((tube.top + tube.bottom) / 2, 0, tube.front))
		);
	}

	return { meshes: found, travel, mouth };
}

function make(model: THREE.Object3D, active: WeaponSpec): Built {
	if (active.orient === 'negZForwardNegXUp') {
		// send the model's -z to +x and its -x to +y, so the rest of this
		// function can assume one convention. measured after, not before.
		model.rotation.setFromRotationMatrix(
			new THREE.Matrix4().makeBasis(
				new THREE.Vector3(0, -1, 0),
				new THREE.Vector3(0, 0, 1),
				new THREE.Vector3(-1, 0, 0)
			)
		);
	}

	const projectile = active.projectile
		? splitProjectile(model)
		: { meshes: [] as THREE.Mesh[], travel: 0, mouth: null };

	const box = new THREE.Box3().setFromObject(model);
	const size = box.getSize(new THREE.Vector3());
	const center = box.getCenter(new THREE.Vector3());
	const scale = active.targetLength / Math.max(size.x, size.y, size.z);

	// put the grip, not the bounding box centre, on the rig origin: that is
	// the point the weapon turns about when it tracks the cursor
	const pivotX = box.min.x + size.x * active.grip;
	model.scale.setScalar(scale);
	model.position.set(-pivotX * scale, -center.y * scale, -center.z * scale);

	model.traverse((child) => {
		if (!(child instanceof THREE.Mesh)) return;
		const material = child.material as THREE.MeshStandardMaterial;
		if (!material?.isMeshStandardMaterial) return;
		// a textured model carries its own colour; tinting would multiply into it
		if (material.map) {
			material.metalness = 0.15;
			material.roughness = 0.6;
			material.envMapIntensity = 0.15;
			return;
		}

		// getHSL/setHSL default to the linear working space; pass sRGB
		// explicitly or these numbers land far lighter than they read
		const hsl = { h: 0, s: 0, l: 0 };
		material.color.getHSL(hsl, THREE.SRGBColorSpace);

		if (active.finish === 'gunmetal') {
			// no colour at all, just a black to grey ramp
			material.color.setHSL(hsl.h, 0, 0.08 + hsl.l * 0.55, THREE.SRGBColorSpace);
		} else {
			// keep the hue and push the saturation, so the muted browns the
			// models ship with read as actual wood against a dark page
			material.color.setHSL(
				hsl.h,
				Math.min(hsl.s * 2.6, 0.55),
				0.12 + hsl.l * 0.9,
				THREE.SRGBColorSpace
			);
		}

		// mostly dielectric with a dim environment: at high metalness the
		// gun mirrors the bright RoomEnvironment and reads as white
		material.metalness = 0.15;
		material.roughness = 0.6;
		material.envMapIntensity = 0.15;
	});

	const group = new THREE.Group();
	group.add(model);
	const rotation = new THREE.Euler(BASE_PITCH, BASE_YAW + active.yawCant, active.baseRoll);
	group.rotation.copy(rotation);

	// barrel runs along +x with the slide above centre, so the muzzle is the
	// far +x end, a little above the middle of the box, measured from the pivot
	const half = size.clone().multiplyScalar(scale * 0.5);
	const muzzleAt = new THREE.Vector3((box.max.x - pivotX) * scale * 0.98, half.y * 0.55, 0);

	// model.matrix carries a point in the model's own space into the holder's
	model.updateMatrix();

	return {
		holder: group,
		muzzle: muzzleAt,
		smokeAt: projectile.mouth
			? projectile.mouth.applyMatrix4(model.matrix)
			: muzzleAt.clone(),
		rotation,
		warheads: projectile.meshes,
		reloadTravel: projectile.travel,
		// a fresh round starts out of shot entirely, further down than the whole
		// weapon travels when it is stowed. the drop is in the model's own space,
		// so it is divided back out by the scale the model was fitted at.
		reloadDrop: projectile.meshes.length ? (HIDDEN_DROP * 1.5) / scale : 0,
	};
}

// the outgoing weapon is only detached, never disposed: it is still in the cache
// and goes straight back in next time. detaching bakes its world transform into
// its local one, so anything installed has to be reset first.
function install(made: Built) {
	// picking a weapon that is still falling: rig.add reparents it, so drop the
	// stale entry or the loop would keep dragging it downward in our hands
	for (let i = departing.length - 1; i >= 0; i--) {
		if (departing[i].holder === made.holder) departing.splice(i, 1);
	}

	// whatever was in the old launcher goes back in, seated, as it leaves: it
	// may have been part way through a reload when the weapon was swapped out
	for (let i = 0; i < loadedWarheads.length; i++) {
		loadedWarheads[i].visible = true;
		loadedWarheads[i].position.copy(warheadRest[i]);
	}

	loadedWarheads = made.warheads;
	warheadRest = loadedWarheads.map((warhead) => warhead.position.clone());
	reloadTravel = made.reloadTravel;
	reloadDrop = made.reloadDrop;
	reloadAge = -1;

	holder = made.holder;
	holder.position.set(0, 0, 0);
	holder.rotation.copy(made.rotation);
	holder.scale.set(1, 1, 1);
	rig!.add(holder);
	holder.add(muzzle!);
	muzzle!.position.copy(made.muzzle);
	holder.add(smokePort!);
	smokePort!.position.copy(made.smokeAt);
}

function onResize() {
	if (!renderer || !camera) return;
	camera.aspect = window.innerWidth / window.innerHeight;
	camera.updateProjectionMatrix();
	renderer.setSize(window.innerWidth, window.innerHeight);
	layoutRig();
}

/* ------------------------------------------------------------------- api */

export function setViewmodelVisible(next: boolean) {
	visible = next;
	if (next) {
		if (reduceMotion()) reveal = 1;
		startLoop();
	}
}

// quick asks for a fast swing rather than a jump: used for taps, which arrive
// with no hover history behind them
export function aimViewmodel(clientX: number, clientY: number, quick = false) {
	pointerNdc.set((clientX / window.innerWidth) * 2 - 1, -(clientY / window.innerHeight) * 2 + 1);
	if (quick) aimBoostUntil = performance.now() + AIM_BOOST_MS;
	startLoop();
}

export function fireViewmodel() {
	recoilVelocity += spec().recoilKick;
	flashAnchor = null;
	flashBoost = 1;

	if (spec().smoke) spawnSmoke(smokePort!.getWorldPosition(new THREE.Vector3()), 8);
	else flashTimer = FLASH_TIME;
	flashSeed = Math.random();
	startLoop();
}

/* ------------------------------------------------------------------ loop */

function makeSmokeTexture(): THREE.CanvasTexture {
	const size = 128;
	const c = document.createElement('canvas');
	c.width = c.height = size;
	const ctx = c.getContext('2d')!;
	const mid = size / 2;

	const gradient = ctx.createRadialGradient(mid, mid, 0, mid, mid, mid);
	gradient.addColorStop(0, 'rgba(228,228,232,0.55)');
	gradient.addColorStop(0.45, 'rgba(190,190,198,0.24)');
	gradient.addColorStop(1, 'rgba(170,170,180,0)');
	ctx.fillStyle = gradient;
	ctx.fillRect(0, 0, size, size);

	const texture = new THREE.CanvasTexture(c);
	texture.colorSpace = THREE.SRGBColorSpace;
	return texture;
}

function spawnSmoke(at: THREE.Vector3, count: number) {
	if (!smokeTexture) smokeTexture = makeSmokeTexture();

	for (let i = 0; i < count; i++) {
		const material = new THREE.MeshBasicMaterial({
			map: smokeTexture,
			transparent: true,
			opacity: 0.5,
			depthWrite: false,
			toneMapped: false,
		});
		const mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.1, 0.1), material);
		mesh.position.copy(at);
		mesh.rotation.z = Math.random() * Math.PI * 2;
		scene!.add(mesh);

		puffs.push({
			mesh,
			age: 0,
			ttl: 0.5 + Math.random() * 0.5,
			velocity: new THREE.Vector3(
				(Math.random() - 0.5) * 0.5,
				0.1 + Math.random() * 0.3,
				(Math.random() - 0.5) * 0.5
			),
		});
	}
}

function advancePuffs(dt: number) {
	for (let i = puffs.length - 1; i >= 0; i--) {
		const puff = puffs[i];
		puff.age += dt;
		const t = puff.age / puff.ttl;

		if (t >= 1) {
			scene!.remove(puff.mesh);
			puff.mesh.geometry.dispose();
			(puff.mesh.material as THREE.Material).dispose();
			puffs.splice(i, 1);
			continue;
		}

		puff.mesh.position.addScaledVector(puff.velocity, dt);
		puff.mesh.scale.setScalar(1 + t * 2.4);
		(puff.mesh.material as THREE.MeshBasicMaterial).opacity = 0.5 * (1 - t);
	}
}

// a launcher cannot be fired again until the round it sent has gone off and a
// fresh one has finished being loaded
export function weaponReady(): boolean {
	return !rockets.length && reloadAge < 0;
}

export function setProjectileImpact(callback: (clientX: number, clientY: number) => void) {
	onImpact = callback;
}

// Built rather than loaded: the launcher model is a single mesh with no warhead
// to split out, and a projectile needs its nose on +z with the pivot at its
// centre, which is easier to guarantee by constructing it.
function makeRocket(): THREE.Group {
	const rocket = new THREE.Group();

	const bodyMaterial = new THREE.MeshStandardMaterial({
		color: 0x6b6f52,
		roughness: 0.7,
		metalness: 0.1,
		flatShading: true,
	});
	const noseMaterial = new THREE.MeshStandardMaterial({
		color: 0x8c3b2a,
		roughness: 0.6,
		metalness: 0.1,
		flatShading: true,
	});

	const body = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.1, 10), bodyMaterial);
	body.rotation.x = Math.PI / 2;
	rocket.add(body);

	const nose = new THREE.Mesh(new THREE.ConeGeometry(0.024, 0.06, 10), noseMaterial);
	nose.rotation.x = Math.PI / 2;
	nose.position.z = 0.08;
	rocket.add(nose);

	// three fins spaced around the tail, each on its own pivot so the rotation
	// happens about the body axis rather than the fin's own centre
	for (let i = 0; i < 3; i++) {
		const fin = new THREE.Mesh(new THREE.BoxGeometry(0.004, 0.036, 0.03), bodyMaterial);
		fin.position.set(0, 0.022, -0.045);

		const pivot = new THREE.Group();
		pivot.rotation.z = (i / 3) * Math.PI * 2;
		pivot.add(fin);
		rocket.add(pivot);
	}

	return rocket;
}

export function launchRocket(clientX: number, clientY: number) {
	if (!scene || !camera || !muzzle) return;

	const from = muzzle.getWorldPosition(new THREE.Vector3());
	const direction = new THREE.Vector3(
		(clientX / window.innerWidth) * 2 - 1,
		-(clientY / window.innerHeight) * 2 + 1,
		0.5
	)
		.unproject(camera)
		.normalize();
	const to = direction.multiplyScalar(ROCKET_RANGE);

	let mesh: THREE.Group;
	if (loadedWarheads.length) {
		// fly the actual warhead, already pointed the way the launcher is aimed
		mesh = new THREE.Group();
		const source = loadedWarheads[0];
		source.updateWorldMatrix(true, false);
		mesh.applyMatrix4(source.matrixWorld);
		for (const warhead of loadedWarheads) {
			mesh.add(new THREE.Mesh(warhead.geometry, warhead.material));
			warhead.visible = false;
		}
		mesh.position.copy(from);
		// straight onto the next one, rather than waiting for the round in the
		// air to land: by the time it goes off the launcher is loaded again
		beginReload();
	} else {
		mesh = makeRocket();
		mesh.position.copy(from);
		mesh.lookAt(to);
	}

	scene.add(mesh);

	rockets.push({ mesh, from, to, progress: 0, screenX: clientX, screenY: clientY });
	startLoop();
}

// A fresh round is brought up the outside of the launcher, the way one is
// actually loaded: it starts below the frame entirely, runs forward until it is
// clear of the muzzle, lifts onto the barrel line, and only then slides back
// down the barrel into its seat. Because the legs never overlap, the round is
// either wholly below the launcher or wholly in line with it, and never crosses
// it. Positions are in the model's own frame, where -z is forward and -x is up.
function seatRound(index: number, t: number) {
	let drop: number;
	let forward: number;

	if (t < RELOAD_OUT) {
		// along the bottom, out past the muzzle
		drop = reloadDrop;
		forward = reloadTravel * settle(t / RELOAD_OUT);
	} else if (t < RELOAD_RISE) {
		// up onto the barrel line, still fully ahead of the tube
		drop = reloadDrop * (1 - settle((t - RELOAD_OUT) / (RELOAD_RISE - RELOAD_OUT)));
		forward = reloadTravel;
	} else {
		// and back down the barrel into the seat
		drop = 0;
		forward = reloadTravel * (1 - settle((t - RELOAD_RISE) / (1 - RELOAD_RISE)));
	}

	const rest = warheadRest[index];
	loadedWarheads[index].position.set(rest.x + drop, rest.y, rest.z - forward);
}

// quick away, easing as it arrives
function settle(t: number): number {
	return 1 - Math.pow(1 - t, 3);
}

function beginReload() {
	if (!loadedWarheads.length) return;

	reloadAge = 0;
	for (let i = 0; i < loadedWarheads.length; i++) {
		loadedWarheads[i].visible = true;
		seatRound(i, 0);
	}
}

function advanceReload(dt: number) {
	if (reloadAge < 0) return;
	reloadAge += dt;

	const t = Math.min(Math.max((reloadAge - RELOAD_DELAY) / RELOAD_TIME, 0), 1);
	for (let i = 0; i < loadedWarheads.length; i++) seatRound(i, t);

	if (t >= 1) {
		reloadAge = -1;
		for (let i = 0; i < loadedWarheads.length; i++) {
			loadedWarheads[i].position.copy(warheadRest[i]);
		}
	}
}

function advanceRockets(dt: number) {
	for (let i = rockets.length - 1; i >= 0; i--) {
		const rocket = rockets[i];
		rocket.progress += dt / ROCKET_FLIGHT;

		if (rocket.progress >= 1) {
			scene!.remove(rocket.mesh);
			rockets.splice(i, 1);

			// go off where it landed, then let the page take the damage
			flashAnchor = rocket.to.clone();
			flashBoost = 3.4;
			flashTimer = FLASH_TIME * 2.4;
			flashSeed = Math.random();
			spawnSmoke(rocket.to, 10);
			onImpact?.(rocket.screenX, rocket.screenY);
			continue;
		}

		rocket.mesh.position.lerpVectors(rocket.from, rocket.to, rocket.progress);
	}
}

function startLoop() {
	if (running || !clock) return;
	running = true;
	clock.getDelta();
	rafId = requestAnimationFrame(frame);
}

function frame() {
	if (!running) return;
	rafId = requestAnimationFrame(frame);

	const dt = Math.min(clock!.getDelta(), 1 / 30);
	const time = clock!.getElapsedTime();

	reveal += ((visible ? 1 : 0) - reveal) * Math.min(dt * 7, 1);

	// discarded weapons keep dropping on their own while the new one rises
	for (let i = departing.length - 1; i >= 0; i--) {
		const leaving = departing[i];
		leaving.holder.position.y -= OUTGOING_FALL * dt;
		leaving.age += dt;
		if (leaving.age > OUTGOING_LIFE) {
			scene!.remove(leaving.holder);
			departing.splice(i, 1);
		}
	}

	// the crosshair projected out to a point the barrel can actually track
	scratch.set(pointerNdc.x, pointerNdc.y, 0.5).unproject(camera!).normalize();
	aimTarget.copy(scratch).multiplyScalar(AIM_DISTANCE);

	const bob = reduceMotion() ? 0 : Math.sin(time * BOB_SPEED) * BOB_AMOUNT;
	rig!.position.set(
		rest.x,
		rest.y + bob - (1 - reveal) * HIDDEN_DROP + recoil * 0.045,
		rest.z + recoil * 0.13
	);

	// point the rig's -z (the barrel) straight at the aim point
	scratch.copy(aimTarget).sub(rig!.position).normalize();
	const gain = spec().aimGain;
	const targetPitch = Math.asin(THREE.MathUtils.clamp(scratch.y, -1, 1)) * gain;
	const targetYaw = Math.atan2(-scratch.x, -scratch.z) * gain;
	const rate = performance.now() < aimBoostUntil ? AIM_EASE_QUICK : AIM_EASE;
	const ease = Math.min(dt * rate, 1);
	pitch += (targetPitch - pitch) * ease;
	yaw += shortestAngle(yaw, targetYaw) * ease;

	recoilVelocity += (-RECOIL_STIFFNESS * recoil - RECOIL_DAMPING * recoilVelocity) * dt;
	recoil += recoilVelocity * dt;

	// muzzle climbs and the gun twists slightly as it kicks back
	rig!.rotation.set(pitch + recoil * 0.42, yaw, (1 - reveal) * 0.5 + recoil * 0.11);

	advanceRockets(dt);
	advanceReload(dt);
	advancePuffs(dt);
	updateFlash(dt);
	renderer!.render(scene!, camera!);

	// park the loop once the gun is stowed and nothing is animating
	if (!visible && reveal < 0.002 && Math.abs(recoil) < 0.001 && flashTimer <= 0 && !rockets.length && !puffs.length && reloadAge < 0) {
		running = false;
		cancelAnimationFrame(rafId);
	}
}

function shortestAngle(from: number, to: number): number {
	let delta = (to - from) % (Math.PI * 2);
	if (delta > Math.PI) delta -= Math.PI * 2;
	if (delta < -Math.PI) delta += Math.PI * 2;
	return delta;
}

function updateFlash(dt: number) {
	if (flashTimer <= 0) {
		if (flashGroup!.visible) flashGroup!.visible = false;
		return;
	}

	flashTimer -= dt;
	const strength = Math.max(flashTimer / FLASH_TIME, 0);
	const pop = 0.65 + (1 - strength) * 0.8;

	if (flashAnchor) flashGroup!.position.copy(flashAnchor);
	else muzzle!.getWorldPosition(flashGroup!.position);
	flashGroup!.visible = true;

	(flashCore!.material as THREE.MeshBasicMaterial).opacity = strength;
	const size = spec().flashScale * flashBoost;
	flashCore!.scale.setScalar(size * pop * (0.9 + flashSeed * 0.3));
	flashCore!.rotation.z = flashSeed * Math.PI;

	(flashStar!.material as THREE.MeshBasicMaterial).opacity = strength * 0.85;
	flashStar!.scale.setScalar(size * pop * (1 + flashSeed * 0.5));
	flashStar!.rotation.z = -flashSeed * Math.PI * 2;

	flashLight!.intensity = strength * 14;
}
