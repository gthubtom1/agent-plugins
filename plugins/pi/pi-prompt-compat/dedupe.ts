/**
 * Content deduplication replicating OMP's prompt block deduplication algorithm.
 * Splits text into paragraph blocks outside code fences and checks if rule blocks
 * are a contiguous subsequence of existing prompt sources (e.g. AGENTS.md, SYSTEM.md).
 */

export function splitComparablePromptBlocks(content: string | null | undefined): string[] {
	if (!content) return [];
	const trimmed = content.trim();
	if (!trimmed) return [];

	const blocks: string[] = [];
	let current: string[] = [];
	let inFence = false;

	for (const line of trimmed.split("\n")) {
		if (/^\s*(```|~~~)/.test(line)) {
			inFence = !inFence;
			current.push(line);
			continue;
		}
		if (!inFence && line.trim() === "" && current.length > 0 && current[current.length - 1].trim() !== "") {
			const block = current.join("\n").trim();
			if (block.length > 0) blocks.push(block);
			current = [];
			continue;
		}
		current.push(line);
	}

	const tail = current.join("\n").trim();
	if (tail.length > 0) blocks.push(tail);
	return blocks;
}

export function promptBlocksContain(sourceBlocks: string[], ruleBlocks: string[]): boolean {
	if (sourceBlocks.length === 0 || ruleBlocks.length === 0 || ruleBlocks.length > sourceBlocks.length) {
		return false;
	}
	for (let start = 0; start <= sourceBlocks.length - ruleBlocks.length; start += 1) {
		if (ruleBlocks.every((block, offset) => sourceBlocks[start + offset] === block)) {
			return true;
		}
	}
	return false;
}

export function promptSourceContainsRule(source: string | null | undefined, ruleContent: string): boolean {
	return promptBlocksContain(splitComparablePromptBlocks(source), splitComparablePromptBlocks(ruleContent));
}
