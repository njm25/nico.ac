import * as esbuild from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';

// every weapon the viewmodel can rack; each is also declared web accessible
const MODELS = ['pistol.glb', 'rifle.glb', 'shotgun.glb', 'rpg.glb'];

const watch = process.argv.includes('--watch');
const outdir = 'dist';

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

// static files sit next to the bundles so manifest paths stay flat
await cp('manifest.json', `${outdir}/manifest.json`);
for (const model of MODELS) await cp(`public/${model}`, `${outdir}/${model}`);
await cp('src/page.css', `${outdir}/page.css`);

const options = {
	entryPoints: ['src/content.ts', 'src/background.ts'],
	bundle: true,
	format: 'iife',
	target: 'chrome110',
	outdir,
	logLevel: 'info',
	minify: !watch,
	sourcemap: watch ? 'inline' : false,
};

if (watch) {
	const context = await esbuild.context(options);
	await context.watch();
	console.log('watching...');
} else {
	await esbuild.build(options);
	console.log('built to ./dist - load that folder as an unpacked extension');
}
