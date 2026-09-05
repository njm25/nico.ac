import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

// fps-style viewmodel: the camera sits at the origin looking down -z, and the gun
// is pinned to the bottom-right of the frustum and swung to point at the cursor.
const MODEL_URL = '/models/pistol.glb';
const FOV = 70;
const TARGET_LENGTH = 0.46;
const RIG_DEPTH = 1;

// inset from the bottom-right corner of the frustum, in world units at RIG_DEPTH
const ANCHOR_INSET_X = 0.3;
const ANCHOR_INSET_Y = 0.22;
const HIDDEN_DROP = 1.1;

// the model points down +x, so a quarter turn puts the barrel on the rig's -z
const BASE_YAW = Math.PI / 2;
const BASE_PITCH = 0;
const BASE_ROLL = -0.05;

// where the crosshair lives in world space; the barrel is aimed at this point
const AIM_DISTANCE = 7;
const AIM_EASE = 14;
const BOB_SPEED = 1.6;
const BOB_AMOUNT = 0.006;

const RECOIL_KICK = 7;
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
let flashGroup: THREE.Group | null = null;
let flashCore: THREE.Mesh | null = null;
let flashStar: THREE.Mesh | null = null;
let flashLight: THREE.PointLight | null = null;

const rest = new THREE.Vector3();
const aimTarget = new THREE.Vector3(0, 0, -AIM_DISTANCE);
const pointerNdc = new THREE.Vector2(0, 0);
const scratch = new THREE.Vector3();

let visible = false;
let reveal = 0;
let yaw = 0;
let pitch = 0;
let recoil = 0;
let recoilVelocity = 0;
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
	camera = new THREE.PerspectiveCamera(FOV, window.innerWidth / window.innerHeight, 0.01, 40);
	clock = new THREE.Clock();

	const pmrem = new THREE.PMREMGenerator(renderer);
	scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

	const key = new THREE.DirectionalLight(0xfff3e0, 0.9);
	key.position.set(1.4, 1.6, 0.9);
	const fill = new THREE.DirectionalLight(0x7cc4ff, 0.25);
	fill.position.set(-1.6, 0.2, 0.6);
	const rim = new THREE.DirectionalLight(0xffffff, 0.4);
	rim.position.set(-0.6, 0.8, -1.6);
	scene.add(key, fill, rim, new THREE.AmbientLight(0xffffff, 0.4));

	rig = new THREE.Group();
	rig.rotation.order = 'YXZ';
	scene.add(rig);

	muzzle = new THREE.Object3D();
	rig.add(muzzle);

	buildFlash();
	layoutRig();
	loadModel();

	window.addEventListener('resize', onResize);
}

// pins the gun to the bottom-right corner whatever the viewport shape is
function layoutRig() {
	if (!camera) return;
	const halfHeight = Math.tan(THREE.MathUtils.degToRad(FOV / 2)) * RIG_DEPTH;
	const halfWidth = halfHeight * camera.aspect;
	rest.set(halfWidth - ANCHOR_INSET_X, -halfHeight + ANCHOR_INSET_Y, -RIG_DEPTH);
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

function loadModel() {
	new GLTFLoader().load(
		MODEL_URL,
		(gltf) => {
			const model = gltf.scene;

			const box = new THREE.Box3().setFromObject(model);
			const size = box.getSize(new THREE.Vector3());
			const center = box.getCenter(new THREE.Vector3());
			const scale = TARGET_LENGTH / Math.max(size.x, size.y, size.z);

			// recentre in scaled units: position is not affected by the object's own scale
			model.scale.setScalar(scale);
			model.position.copy(center).multiplyScalar(-scale);

			const holder = new THREE.Group();
			holder.add(model);
			holder.rotation.set(BASE_PITCH, BASE_YAW, BASE_ROLL);
			rig!.add(holder);

			// barrel runs along +x with the slide above centre, so the muzzle is the
			// far +x end, a little above the middle of the box
			const half = size.clone().multiplyScalar(scale * 0.5);
			holder.add(muzzle!);
			muzzle!.position.set(half.x * 0.98, half.y * 0.55, 0);

			model.traverse((child) => {
				if (!(child instanceof THREE.Mesh)) return;
				const material = child.material as THREE.MeshStandardMaterial;
				if (!material?.isMeshStandardMaterial) return;
				// fully desaturate (the stock grip is brown) and spread the near-black
				// source lightnesses across a black-to-grey gunmetal ramp
				// getHSL/setHSL default to the linear working space; pass sRGB
				// explicitly or these numbers land far lighter than they read
				const hsl = { h: 0, s: 0, l: 0 };
				material.color.getHSL(hsl, THREE.SRGBColorSpace);
				material.color.setHSL(hsl.h, 0, 0.08 + hsl.l * 0.55, THREE.SRGBColorSpace);
				// mostly dielectric with a dim environment: at high metalness the
				// gun mirrors the bright RoomEnvironment and reads as white
				material.metalness = 0.15;
				material.roughness = 0.6;
				material.envMapIntensity = 0.15;
			});
		},
		undefined,
		(err) => console.error('gun model failed to load', err)
	);
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

export function aimViewmodel(clientX: number, clientY: number) {
	pointerNdc.set((clientX / window.innerWidth) * 2 - 1, -(clientY / window.innerHeight) * 2 + 1);
	startLoop();
}

export function fireViewmodel() {
	recoilVelocity += RECOIL_KICK;
	flashTimer = FLASH_TIME;
	flashSeed = Math.random();
	startLoop();
}

/* ------------------------------------------------------------------ loop */

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
	const targetPitch = Math.asin(THREE.MathUtils.clamp(scratch.y, -1, 1));
	const targetYaw = Math.atan2(-scratch.x, -scratch.z);
	const ease = Math.min(dt * AIM_EASE, 1);
	pitch += (targetPitch - pitch) * ease;
	yaw += shortestAngle(yaw, targetYaw) * ease;

	recoilVelocity += (-RECOIL_STIFFNESS * recoil - RECOIL_DAMPING * recoilVelocity) * dt;
	recoil += recoilVelocity * dt;

	// muzzle climbs and the gun twists slightly as it kicks back
	rig!.rotation.set(pitch + recoil * 0.42, yaw, (1 - reveal) * 0.5 + recoil * 0.11);

	updateFlash(dt);
	renderer!.render(scene!, camera!);

	// park the loop once the gun is stowed and nothing is animating
	if (!visible && reveal < 0.002 && Math.abs(recoil) < 0.001 && flashTimer <= 0) {
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

	muzzle!.getWorldPosition(flashGroup!.position);
	flashGroup!.visible = true;

	(flashCore!.material as THREE.MeshBasicMaterial).opacity = strength;
	flashCore!.scale.setScalar(pop * (0.9 + flashSeed * 0.3));
	flashCore!.rotation.z = flashSeed * Math.PI;

	(flashStar!.material as THREE.MeshBasicMaterial).opacity = strength * 0.85;
	flashStar!.scale.setScalar(pop * (1 + flashSeed * 0.5));
	flashStar!.rotation.z = -flashSeed * Math.PI * 2;

	flashLight!.intensity = strength * 14;
}
