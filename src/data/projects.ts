export interface Project {
	title: string;
	description: string;
	link: string;
	year: string;
}

export const projects: Project[] = [
	{
		title: 'Leon County Value',
		description: 'A simple GIS map for visualizing Leon County parcel value',
		link: 'https://leonvalue.com',
		year: '2026',
	},
	{
		title: 'Nicos Jobs',
		description: 'A job board aggregate which scrapes thousands of companies job pages directly and allows users to track application status',
		link: 'https://nicosjobs.com',
		year: '2026',
	},
	{
		title: 'The Film Archive',
		description: 'A collection of public domain films presented in an easy to stream format',
		link: 'https://thefilmarchive.org',
		year: '2026',
	},
	{
		title: 'Speaker Swimmer',
		description: 'An infinite runner game built for Mini Jame Gam #51',
		link: 'https://runkman.itch.io/speaker-swimmer',
		year: '2026',
	},
	{
		title: 'Wither Chunks',
		description: 'A minecraft plugin for enhancing wither skeleton spawn rates in specified chunks',
		link: 'https://github.com/njm25/WitherChunks',
		year: '2025',
	},
	{
		title: 'NCCasino',
		description: 'A casino plugin for minecraft servers. Feature rich with many games',
		link: 'https://www.curseforge.com/minecraft/bukkit-plugins/nccasino',
		year: '2024',
	},
];
