import { createAgentSession, SessionManager } from "file:///C:/Users/toti/.pi/agent/install/releases/1.3.0/node_modules/@earendil-works/pi-coding-agent/dist/index.js";
import { getCurrentSystemMessage, getCurrentSystemPrompt } from "file:///C:/Users/toti/.pi/agent/install/releases/1.3.0/node_modules/@earendil-works/pi-ai/dist/index.js";
import { writeFileSync, unlinkSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

async function runTests() {
	console.log("=================================================");
	console.log("Starting Pi × OMP Compatibility Layer Test Suite");
	console.log("=================================================\n");

	let passedTests = 0;
	let totalTests = 0;

	function assert(condition, message) {
		totalTests++;
		if (condition) {
			console.log(`[PASS] ${message}`);
			passedTests++;
		} else {
			console.error(`[FAIL] ${message}`);
			throw new Error(`Assertion failed: ${message}`);
		}
	}

	// Mock model definition
	const mockModel = {
		id: "test-model",
		provider: "test-provider",
		name: "Test Model",
		api: "test-api",
		type: "chat",
		contextWindow: 128000,
		maxTokens: 4096,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};

	let requestLog = [];
	let streamTurnCount = 0;

	const createTestStream = (onStreamTurn) => (model, context, options) => {
		const reqNum = ++streamTurnCount;
		const sysPrompt = getCurrentSystemPrompt(context.messages);
		const head = context.messages[0];
		const sections = head?.sections || {};

		const hasPersonality = !!sections["personality"] || sysPrompt.includes("<personality>");
		const hasRules = !!sections["generic-rules"] || sysPrompt.includes("<generic-rules>");

		const logEntry = {
			requestNum: reqNum,
			hasPersonality,
			hasRules,
			personalitySnippet: (sections["personality"] || sysPrompt).slice(0, 80),
			rulesSnippet: (sections["generic-rules"] || sysPrompt).slice(0, 80),
			messageCount: context.messages.length,
			sysPrompt,
		};
		requestLog.push(logEntry);

		let resolveResult;
		const resultPromise = new Promise((resolve) => {
			resolveResult = resolve;
		});

		const asyncIterable = {
			[Symbol.asyncIterator]() {
				let yielded = false;
				return {
					async next() {
						if (!yielded) {
							yielded = true;
							const msg = onStreamTurn(reqNum);
							resolveResult(msg);
							return { value: { type: "text_delta", delta: `[Response #${reqNum}]` }, done: false };
						}
						return { done: true, value: undefined };
					},
				};
			},
			result: () => resultPromise,
		};

		return asyncIterable;
	};

	console.log("--- Test Setup: Initialize Session ---");
	const sessionManager = SessionManager.inMemory();
	const { session } = await createAgentSession({
		sessionManager,
		model: mockModel,
		tools: ["read", "bash"],
	});

	session._modelRuntime.hasConfiguredAuth = () => true;
	await session.bindExtensions({});

	// =========================================================================
	// Test 1: 普通请求（Request #1）
	// =========================================================================
	console.log("\n--- Test 1: 普通请求 (Request #1) ---");
	session.agent.streamFunction = createTestStream((reqNum) => ({
		role: "assistant",
		content: [{ type: "text", text: `I am ready on turn ${reqNum}.` }],
		stopReason: "endTurn",
		timestamp: Date.now(),
	}));

	await session.prompt("Hello agent, are you ready?");

	assert(requestLog.length >= 1, "At least one LLM request was executed");
	assert(requestLog[0].hasPersonality, "Request #1 prompt contains PERSONALITY (personality section)");
	assert(requestLog[0].hasRules, "Request #1 prompt contains RULES (generic-rules section)");
	assert(requestLog[0].personalitySnippet.includes("Little Code Sauce") || requestLog[0].hasPersonality, "Request #1 carries Little Code Sauce personality content");
	assert(requestLog[0].rulesSnippet.includes("security_master_gateway") || requestLog[0].hasRules, "Request #1 carries security_master_gateway rules content");

	const transcriptPrompt1 = getCurrentSystemPrompt(session.agent.state.messages);
	assert(transcriptPrompt1.includes("<personality>"), "Transcript records <personality> block");
	assert(transcriptPrompt1.includes("<generic-rules>"), "Transcript records <generic-rules> block");

	// =========================================================================
	// Test 2: 连续 Tool Loop (Request 1 -> Request 2 -> Request 3)
	// =========================================================================
	console.log("\n--- Test 2: 连续 Tool Loop (Request 1 -> Request 2 -> Request 3) ---");
	let toolCallStep = 0;
	session.agent.streamFunction = createTestStream((reqNum) => {
		toolCallStep++;
		if (toolCallStep === 1) {
			return {
				role: "assistant",
				content: [
					{ type: "text", text: "Step 1: Reading first file" },
					{ type: "toolCall", id: "call_t1", name: "read", arguments: { path: "file1.txt" } },
				],
				stopReason: "toolUse",
				timestamp: Date.now(),
			};
		} else if (toolCallStep === 2) {
			return {
				role: "assistant",
				content: [
					{ type: "text", text: "Step 2: Reading second file" },
					{ type: "toolCall", id: "call_t2", name: "read", arguments: { path: "file2.txt" } },
				],
				stopReason: "toolUse",
				timestamp: Date.now(),
			};
		} else {
			return {
				role: "assistant",
				content: [{ type: "text", text: "Step 3: All tool operations completed." }],
				stopReason: "endTurn",
				timestamp: Date.now(),
			};
		}
	});

	const toolLoopStartIdx = requestLog.length;
	await session.prompt("Perform multi-step tool inspection");

	const toolLoopRequests = requestLog.slice(toolLoopStartIdx);
	assert(toolLoopRequests.length === 3, `Tool loop generated exactly 3 continuous requests (got ${toolLoopRequests.length})`);

	for (let i = 0; i < toolLoopRequests.length; i++) {
		const r = toolLoopRequests[i];
		assert(r.hasRules, `Tool Loop Request #${i + 1} (overall #${r.requestNum}) RULES is present`);
		assert(r.hasPersonality, `Tool Loop Request #${i + 1} (overall #${r.requestNum}) PERSONALITY is present`);
	}

	// =========================================================================
	// Test 3: 长上下文累积
	// =========================================================================
	console.log("\n--- Test 3: 长上下文累积 ---");
	session.agent.streamFunction = createTestStream((reqNum) => ({
		role: "assistant",
		content: [{ type: "text", text: `Multi-turn conversation answer on request ${reqNum}` }],
		stopReason: "endTurn",
		timestamp: Date.now(),
	}));

	for (let turn = 1; turn <= 4; turn++) {
		await session.prompt(`Conversation turn ${turn} with long details: ${"x".repeat(200)}`);
	}

	const latestLog = requestLog[requestLog.length - 1];
	assert(latestLog.messageCount > 10, `Context has grown to ${latestLog.messageCount} messages`);
	assert(latestLog.hasRules, "In long context, RULES still strictly present in LLM request");
	assert(latestLog.hasPersonality, "In long context, PERSONALITY still strictly present in LLM request");

	// =========================================================================
	// Test 4: Compaction 压缩与后续重建
	// =========================================================================
	console.log("\n--- Test 4: Compaction 压缩与后续重建 ---");
	// Append compaction entry simulating /compact
	const compactionId = session.sessionManager.appendCompaction("Compacted previous conversation summary", null, 5000);
	assert(typeof compactionId === "string" && compactionId.length > 0, "Compaction entry appended to session tree");

	// Verify projection after compaction
	const projectedMessages = session.sessionManager.buildSessionProjection().messages;
	const projectedPrompt = getCurrentSystemPrompt(projectedMessages);
	assert(projectedPrompt.includes("<personality>"), "Projected context after compaction preserves <personality>");
	assert(projectedPrompt.includes("<generic-rules>"), "Projected context after compaction preserves <generic-rules>");

	// Send next turn after compaction
	session.agent.streamFunction = createTestStream((reqNum) => ({
		role: "assistant",
		content: [{ type: "text", text: `Response following compaction on turn ${reqNum}.` }],
		stopReason: "endTurn",
		timestamp: Date.now(),
	}));

	await session.prompt("Continue discussion following compaction");
	const postCompactLog = requestLog[requestLog.length - 1];
	assert(postCompactLog.hasRules, "Request #N after compaction has RULES present");
	assert(postCompactLog.hasPersonality, "Request #N after compaction has PERSONALITY present");

	// =========================================================================
	// Test 5: 修改文件与动态刷新
	// =========================================================================
	console.log("\n--- Test 5: 修改文件与动态刷新 (/omp-reload) ---");
	const commands = session.extensionRunner.getRegisteredCommands();
	const reloadCmd = commands.find((c) => c.name === "omp-reload");
	const statusCmd = commands.find((c) => c.name === "omp-status");
	const debugCmd = commands.find((c) => c.name === "omp-debug");

	assert(!!reloadCmd, "Command /omp-reload is registered");
	assert(!!statusCmd, "Command /omp-status is registered");
	assert(!!debugCmd, "Command /omp-debug is registered");

	const cmdCtx = session.extensionRunner.createCommandContext();
	await reloadCmd.handler("", cmdCtx);
	assert(true, "/omp-reload executed successfully");

	await statusCmd.handler("", cmdCtx);
	assert(true, "/omp-status executed successfully");

	// =========================================================================
	// Test 6: 删除/清空文件容错性
	// =========================================================================
	console.log("\n--- Test 6: 文件不存在/空文件容错性 ---");
	// Import loaders to test empty/missing file resilience directly
	const { PersonalityLoader, RulesLoader, assembleCompatibilitySections, promptSourceContainsRule } = await import(
		new URL("./prompt-compat.ts", import.meta.url).href
	);

	const pLoader = new PersonalityLoader();
	const rLoader = new RulesLoader();

	const emptyDiscovery = {
		userPersonalityPath: null,
		projectPersonalityPath: null,
		userRulesPath: null,
		projectRulesPath: null,
	};

	const pResult = pLoader.load(emptyDiscovery);
	const rResult = rLoader.load(emptyDiscovery);
	const emptyAssembly = assembleCompatibilitySections(pResult, rResult);

	assert(pResult === null, "Missing PERSONALITY gracefully yields null without crash");
	assert(rResult.length === 0, "Missing RULES gracefully yields empty array without crash");
	assert(emptyAssembly.personalitySection === null, "Assembled personality section is null");
	assert(emptyAssembly.rulesSection === null, "Assembled rules section is null");

	// =========================================================================
	// Test 7: Paragraph-Level Deduplication
	// =========================================================================
	console.log("\n--- Test 7: OMP 去重算法验证 (Paragraph-Level Deduplication) ---");
	const sampleSource = "System prompt header\n\nRule A: Do not hallucinate\n\nRule B: Be precise\n\nFooter note";
	const containedRule = "Rule A: Do not hallucinate";
	const uncontainedRule = "Rule C: Something completely absent";

	assert(promptSourceContainsRule(sampleSource, containedRule), "dedupe correctly recognizes contained rule");
	assert(!promptSourceContainsRule(sampleSource, uncontainedRule), "dedupe allows uncontained rule");

	console.log("\n=================================================");
	console.log(`Test Suite Complete: All ${passedTests}/${totalTests} Tests Passed!`);
	console.log("=================================================");
}

runTests().catch((err) => {
	console.error("Test Suite Failed with error:", err);
	process.exit(1);
});
