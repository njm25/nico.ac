// which sandbox tool currently owns pointer input. the beach ball and the gun both
// listen on window in the capture phase, so they need one place to agree on who wins.
export type SandboxTool = 'none' | 'gun' | 'spray';

let activeTool: SandboxTool = 'none';

export function getActiveTool(): SandboxTool {
	return activeTool;
}

export function setActiveTool(tool: SandboxTool) {
	activeTool = tool;
}
