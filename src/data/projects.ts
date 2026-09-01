export interface Project {
	title: string;
	description: string;
	link: string;
	year: string;
}

export const projects: Project[] = [
	{
		title: 'Nicos Jobs',
		description: 'A job board aggregate which scrapes thousands of companies job pages directly and allows users to track application status.',
		link: 'https://nicosjobs.com',
		year: '2026',
	},
	{
		title: 'The Film Archive',
		description: 'A collection of public domain films presented in an easy to stream format.',
		link: 'https://thefilmarchive.org',
		year: '2026',
	},
	{
		title: 'NCCasino',
		description: 'A casino plugin for minecraft servers. Feature rich with many games.',
		link: 'https://www.curseforge.com/minecraft/bukkit-plugins/nccasino',
		year: '2024',
	},
];
