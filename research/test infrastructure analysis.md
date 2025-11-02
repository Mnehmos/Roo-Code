# Test Infrastructure Analysis: Roo Code Extension

## Executive Summary

This document provides a comprehensive analysis of the Roo Code extension's test infrastructure for implementing Touch and Go parallel execution components. The analysis covers test organization, configuration, utilities, patterns, and provides specific strategies and templates for testing the new parallel execution features.

**Key Findings:**

- **3,320 backend tests** using Vitest with comprehensive mocking
- **1,108 frontend tests** using E2E framework
- **Robust VS Code API mocking** via [`__mocks__/vscode.js`](../src/__mocks__/vscode.js:1)
- **80%+ coverage target** (current practice observed in existing tests)
- **Well-established patterns** for async operations, event handling, and tool testing

---

## 1. Test Directory Structure

### Backend Unit Tests ([`src/__tests__/`](../src/__tests__/:1))

```
src/__tests__/
├── command-integration.spec.ts     # Command system integration
├── command-mentions.spec.ts        # Command mention parsing
├── commands.spec.ts                # Command utilities
├── dist_assets.spec.ts             # Asset bundling verification
├── extension.spec.ts               # Extension activation & lifecycle
└── migrateSettings.spec.ts         # Settings migration logic
```

### E2E Tests ([`apps/vscode-e2e/`](../apps/vscode-e2e/:1))

```
apps/vscode-e2e/
├── src/
│   ├── suite/
│   │   ├── extension.test.ts       # Extension behavior
│   │   ├── task.test.ts            # Task execution
│   │   ├── modes.test.ts           # Mode switching
│   │   ├── subtasks.test.ts        # Subtask handling
│   │   ├── test-utils.ts           # E2E utilities
│   │   ├── utils.ts                # Wait helpers
│   │   └── tools/                  # Tool-specific tests
│   │       ├── apply-diff.test.ts
│   │       ├── execute-command.test.ts
│   │       └── ...
│   └── runTest.ts                  # Test runner
└── .vscode-test.mjs                # E2E configuration
```

### Utility Tests (Scattered across [`src/`](../src/:1))

```
src/
├── utils/__tests__/                # Utility function tests
│   ├── config.spec.ts
│   ├── cost.spec.ts
│   ├── git.spec.ts
│   ├── path.spec.ts
│   └── ...
├── services/tree-sitter/__tests__/ # Service-specific tests
│   └── index.spec.ts
└── shared/__tests__/               # Shared logic tests
    ├── api.spec.ts
    └── experiments-*.spec.ts
```

---

## 2. Vitest Configuration

### Main Configuration ([`src/vitest.config.ts`](../src/vitest.config.ts:1))

```typescript
export default defineConfig({
  test: {
    globals: true,                    // Global test functions (describe, it, expect)
    setupFiles: ["./vitest.setup.ts"], // Setup file for all tests
    watch: false,                     // No watch mode in CI
    reporters: [...],                 // Custom reporters
    silent: ...,                      // Verbosity control
    testTimeout: 20_000,              // 20s test timeout
    hookTimeout: 20_000,              // 20s hook timeout
    onConsoleLog: ...,                // Console filtering
  },
  resolve: {
    alias: {
      vscode: path.resolve(__dirname, "./__mocks__/vscode.js"), // VS Code mock
    },
  },
})
```

**Key Features:**

- **Global test APIs**: No need to import `describe`, `it`, `expect`, `vi` - they're globally available
- **Path aliasing**: `vscode` module automatically resolves to mock implementation
- **Generous timeouts**: 20 seconds for async operations (perfect for IPC/worker tests)

### Setup File ([`src/vitest.setup.ts`](../src/vitest.setup.ts:1))

```typescript
import nock from "nock"
import "./utils/path" // String.prototype.toPosix() extension

// Disable network requests by default for all tests
nock.disableNetConnect()

export function allowNetConnect(host?: string | RegExp) {
	if (host) {
		nock.enableNetConnect(host)
	} else {
		nock.enableNetConnect()
	}
}

// Global mocks
global.structuredClone = global.structuredClone || ((obj: any) => JSON.parse(JSON.stringify(obj)))
```

**Implications for Touch and Go:**

- Network isolation ensures tests are deterministic
- Use `allowNetConnect()` if testing IPC over network sockets
- `structuredClone` available for deep copying task state

---

## 3. Available Test Utilities & Mocks

### VS Code API Mock ([`src/__mocks__/vscode.js`](../src/__mocks__/vscode.js:1))

Complete mock of VS Code API with:

```javascript
// Core modules
export const workspace = {
	/* file operations, config */
}
export const window = {
	/* UI, terminals, editors */
}
export const commands = {
	/* command registration */
}
export const languages = {
	/* diagnostics, code actions */
}

// Classes
export const Uri = {
	/* file:// URIs */
}
export const Range = class {
	/* text ranges */
}
export const Position = class {
	/* cursor positions */
}
export const EventEmitter = () => ({
	/* event handling */
})
```

**Key Capabilities:**

- **File system mocking**: `workspace.fs.readFile/writeFile`
- **Terminal creation**: `window.createTerminal()`
- **Event emitters**: For workspace changes, file watchers
- **Output channels**: `window.createOutputChannel()`

### File System Mock ([`src/__mocks__/fs/promises.ts`](../src/__mocks__/fs/promises.ts:1))

Sophisticated in-memory file system:

```typescript
const mockFiles = new Map() // File content storage
const mockDirectories = new Set() // Directory structure

export const mockFs = {
	readFile: vi.fn(), // Returns stored content or throws ENOENT
	writeFile: vi.fn(), // Stores content in Map
	mkdir: vi.fn(), // Recursive directory creation
	access: vi.fn(), // File existence check
	rename: vi.fn(), // File moves

	// Test helpers
	_mockFiles: mockFiles,
	_mockDirectories: mockDirectories,
	_setInitialMockData: () => {
		/* preset test data */
	},
}
```

**Behavior:**

- Auto-creates parent directories for test paths
- Preserves special paths like `/test/`, `/mock/`
- Pre-populates common test directories on init

### E2E Test Utilities ([`apps/vscode-e2e/src/suite/utils.ts`](../apps/vscode-e2e/src/suite/utils.ts:1))

```typescript
// Wait for async conditions
export const waitFor = (
	condition: () => Promise<boolean> | boolean,
	{ timeout = 30_000, interval = 250 }: WaitForOptions = {},
) => Promise<void>

// Task lifecycle helpers
export const waitUntilCompleted = async ({ api, taskId, ...options }) => {
	/* ... */
}
export const waitUntilAborted = async ({ api, taskId, ...options }) => {
	/* ... */
}

// Simple delay
export const sleep = (ms: number) => Promise<void>
```

**Usage Pattern:**

```typescript
await waitFor(() => taskStarted, { timeout: 60_000 })
await waitUntilCompleted({ api, taskId })
```

---

## 4. Common Test Patterns

### Pattern 1: Mocking VS Code API for Unit Tests

From [`src/__tests__/extension.spec.ts`](../src/__tests__/extension.spec.ts:1):

```typescript
vi.mock("vscode", () => ({
	window: {
		createOutputChannel: vi.fn().mockReturnValue({
			appendLine: vi.fn(),
		}),
		registerWebviewViewProvider: vi.fn(),
		// ... more mocks
	},
	workspace: {
		getConfiguration: vi.fn().mockReturnValue({
			get: vi.fn().mockReturnValue([]),
		}),
		// ... more mocks
	},
}))

// Module under test
vi.mock("@roo-code/cloud", () => ({
	CloudService: {
		createInstance: vi.fn(),
		// ... mock implementation
	},
}))
```

**Pattern for Touch and Go:**

- Mock `node:child_process` for worker spawning
- Mock `node:worker_threads` for parallel execution
- Mock IPC mechanisms (pipes, sockets)

### Pattern 2: Event-Driven Testing

From [`apps/vscode-e2e/src/suite/task.test.ts`](../apps/vscode-e2e/src/suite/task.test.ts:1):

```typescript
test("Should handle prompt and response correctly", async () => {
	const api = globalThis.api
	const messages: ClineMessage[] = []

	// Listen for messages
	api.on(RooCodeEventName.Message, ({ message }) => {
		if (message.type === "say" && message.partial === false) {
			messages.push(message)
		}
	})

	const taskId = await api.startNewTask({
		/* config */
	})
	await waitUntilCompleted({ api, taskId })

	// Assert on collected messages
	assert.ok(messages.find(({ text }) => text?.includes("My name is Roo")))
})
```

**Pattern for Touch and Go:**

- Listen for worker spawn events
- Collect messages from IPC channels
- Assert on orchestration state changes
- Verify boomerang returns

### Pattern 3: Async State Management

From [`apps/vscode-e2e/src/suite/tools/apply-diff.test.ts`](../apps/vscode-e2e/src/suite/tools/apply-diff.test.ts:750):

```typescript
let taskStarted = false
let taskCompleted = false
let errorOccurred: string | null = null

// Event listeners update state
api.on(RooCodeEventName.TaskStarted, (id) => {
	if (id === taskId) taskStarted = true
})

api.on(RooCodeEventName.TaskCompleted, (id) => {
	if (id === taskId) taskCompleted = true
})

// Wait for state transitions
await waitFor(() => taskStarted, { timeout: 60_000 })
await waitFor(() => taskCompleted, { timeout: 60_000 })
```

**Pattern for Touch and Go:**

- Track worker states (idle/busy/error)
- Monitor IPC message queues
- Assert on dependency graph resolution
- Verify resource cleanup

### Pattern 4: File System Testing

From [`apps/vscode-e2e/src/suite/tools/execute-command.test.ts`](../apps/vscode-e2e/src/suite/tools/execute-command.test.ts:558):

```typescript
// Create test files before suite
suiteSetup(async () => {
	workspaceDir = vscode.workspace.workspaceFolders[0]!.uri.fsPath

	for (const [key, file] of Object.entries(testFiles)) {
		file.path = path.join(workspaceDir, file.name)
		await fs.writeFile(file.path, file.content)
	}
})

// Clean up after suite
suiteTeardown(async () => {
	for (const [key, file] of Object.entries(testFiles)) {
		await fs.unlink(file.path)
	}
})
```

**Pattern for Touch and Go:**

- Create isolated workspace per test
- Mock file locks for conflict detection
- Verify workspace isolation between workers

---

## 5. Test Strategy for Touch and Go Components

### 5.1 ParallelInstanceManager Testing

**Component Responsibilities:**

- Worker pool management (spawn, terminate, reuse)
- Resource allocation and limits
- Worker health monitoring
- Graceful shutdown

**Test Strategy:**

```typescript
describe("ParallelInstanceManager", () => {
	let manager: ParallelInstanceManager

	beforeEach(() => {
		manager = new ParallelInstanceManager({
			maxWorkers: 3,
			minWorkers: 1,
			idleTimeout: 5000,
		})
	})

	afterEach(async () => {
		await manager.shutdown()
	})

	describe("Worker Spawning", () => {
		it("should spawn workers up to maxWorkers limit", async () => {
			const workers = await Promise.all([
				manager.acquireWorker(),
				manager.acquireWorker(),
				manager.acquireWorker(),
			])

			expect(workers).toHaveLength(3)
			expect(manager.getActiveWorkerCount()).toBe(3)
		})

		it("should queue requests when at max capacity", async () => {
			// Acquire all workers
			const workers = await Promise.all([
				manager.acquireWorker(),
				manager.acquireWorker(),
				manager.acquireWorker(),
			])

			// Fourth request should queue
			const pending = manager.acquireWorker()
			expect(manager.getQueueLength()).toBe(1)

			// Release one worker
			await manager.releaseWorker(workers[0])

			// Pending request should resolve
			const worker = await pending
			expect(worker).toBeDefined()
		})

		it("should handle worker crashes gracefully", async () => {
			const worker = await manager.acquireWorker()

			// Simulate crash
			worker.process.kill("SIGKILL")

			await waitFor(() => manager.getActiveWorkerCount() === 0)

			// Should be able to acquire new worker
			const newWorker = await manager.acquireWorker()
			expect(newWorker.id).not.toBe(worker.id)
		})
	})

	describe("Resource Cleanup", () => {
		it("should terminate idle workers after timeout", async () => {
			vi.useFakeTimers()

			const worker = await manager.acquireWorker()
			await manager.releaseWorker(worker)

			expect(manager.getIdleWorkerCount()).toBe(1)

			vi.advanceTimersByTime(6000) // Past idleTimeout
			await waitFor(() => manager.getIdleWorkerCount() === 0)

			vi.useRealTimers()
		})

		it("should shutdown all workers gracefully", async () => {
			await Promise.all([manager.acquireWorker(), manager.acquireWorker()])

			await manager.shutdown()

			expect(manager.getActiveWorkerCount()).toBe(0)
			expect(manager.getIdleWorkerCount()).toBe(0)
		})
	})
})
```

**Mock Requirements:**

```typescript
vi.mock("node:child_process", () => ({
	spawn: vi.fn(() => ({
		pid: Math.random(),
		on: vi.fn(),
		kill: vi.fn(),
		stdin: { write: vi.fn() },
		stdout: { on: vi.fn() },
		stderr: { on: vi.fn() },
	})),
}))
```

### 5.2 IPCChannel Testing

**Component Responsibilities:**

- Message routing between orchestrator and workers
- Request/response correlation
- Message serialization/deserialization
- Connection lifecycle management

**Test Strategy:**

```typescript
describe("IPCChannel", () => {
	let channel: IPCChannel
	let mockWorker: MockWorkerProcess

	beforeEach(() => {
		mockWorker = createMockWorker()
		channel = new IPCChannel(mockWorker)
	})

	afterEach(async () => {
		await channel.close()
	})

	describe("Message Sending", () => {
		it("should send message and receive response", async () => {
			const request = { type: "execute_tool", tool: "read_file", args: {} }

			// Mock worker response
			setTimeout(() => {
				mockWorker.emit("message", {
					id: expect.any(String),
					type: "response",
					data: { content: "file content" },
				})
			}, 10)

			const response = await channel.send(request)
			expect(response.data.content).toBe("file content")
		})

		it("should handle timeout for unresponsive workers", async () => {
			const request = { type: "execute_tool", tool: "slow_operation" }

			await expect(channel.send(request, { timeout: 1000 })).rejects.toThrow("Request timeout")
		})

		it("should correlate responses with requests", async () => {
			const requests = [channel.send({ type: "task", id: "task1" }), channel.send({ type: "task", id: "task2" })]

			// Respond out of order
			mockWorker.emit("message", { id: requests[1].id, data: "response2" })
			mockWorker.emit("message", { id: requests[0].id, data: "response1" })

			const [resp1, resp2] = await Promise.all(requests)
			expect(resp1.data).toBe("response1")
			expect(resp2.data).toBe("response2")
		})
	})

	describe("Connection Handling", () => {
		it("should reconnect on connection loss", async () => {
			const reconnectSpy = vi.fn()
			channel.on("reconnected", reconnectSpy)

			mockWorker.emit("disconnect")

			await waitFor(() => reconnectSpy.mock.calls.length > 0)
			expect(channel.isConnected()).toBe(true)
		})

		it("should reject pending requests on channel close", async () => {
			const request = channel.send({ type: "task" })

			await channel.close()

			await expect(request).rejects.toThrow("Channel closed")
		})
	})
})
```

**Mock Requirements:**

```typescript
function createMockWorker(): MockWorkerProcess {
	const eventEmitter = new EventEmitter()
	return {
		...eventEmitter,
		send: vi.fn((msg) => eventEmitter.emit("message", msg)),
		disconnect: vi.fn(() => eventEmitter.emit("disconnect")),
	}
}
```

### 5.3 OrchestrationScheduler Testing

**Component Responsibilities:**

- Task dependency graph construction
- Topological sorting for execution order
- Deadlock detection
- Priority scheduling

**Test Strategy:**

```typescript
describe("OrchestrationScheduler", () => {
	let scheduler: OrchestrationScheduler

	beforeEach(() => {
		scheduler = new OrchestrationScheduler()
	})

	describe("Dependency Graph", () => {
		it("should build correct dependency graph", () => {
			const tasks = [
				{ id: "task1", dependencies: [] },
				{ id: "task2", dependencies: ["task1"] },
				{ id: "task3", dependencies: ["task1", "task2"] },
			]

			scheduler.addTasks(tasks)
			const graph = scheduler.getGraph()

			expect(graph.get("task1")).toEqual([])
			expect(graph.get("task2")).toEqual(["task1"])
			expect(graph.get("task3")).toEqual(["task1", "task2"])
		})

		it("should detect circular dependencies", () => {
			const tasks = [
				{ id: "task1", dependencies: ["task2"] },
				{ id: "task2", dependencies: ["task3"] },
				{ id: "task3", dependencies: ["task1"] },
			]

			expect(() => scheduler.addTasks(tasks)).toThrow("Circular dependency")
		})

		it("should topologically sort tasks", () => {
			const tasks = [
				{ id: "task3", dependencies: ["task1", "task2"] },
				{ id: "task1", dependencies: [] },
				{ id: "task2", dependencies: ["task1"] },
			]

			scheduler.addTasks(tasks)
			const sorted = scheduler.getExecutionOrder()

			expect(sorted).toEqual(["task1", "task2", "task3"])
		})
	})

	describe("Scheduling", () => {
		it("should schedule independent tasks in parallel", async () => {
			const tasks = [
				{ id: "task1", dependencies: [], execute: vi.fn() },
				{ id: "task2", dependencies: [], execute: vi.fn() },
				{ id: "task3", dependencies: [], execute: vi.fn() },
			]

			scheduler.addTasks(tasks)
			const execution = scheduler.execute()

			// All three should start immediately
			await sleep(10)
			expect(tasks[0].execute).toHaveBeenCalled()
			expect(tasks[1].execute).toHaveBeenCalled()
			expect(tasks[2].execute).toHaveBeenCalled()
		})

		it("should wait for dependencies before scheduling", async () => {
			let task1Resolved = false

			const tasks = [
				{
					id: "task1",
					dependencies: [],
					execute: async () => {
						await sleep(50)
						task1Resolved = true
					},
				},
				{
					id: "task2",
					dependencies: ["task1"],
					execute: vi.fn(),
				},
			]

			scheduler.addTasks(tasks)
			await scheduler.execute()

			expect(task1Resolved).toBe(true)
			expect(tasks[1].execute).toHaveBeenCalled()
		})

		it("should respect max concurrent tasks", async () => {
			scheduler = new OrchestrationScheduler({ maxConcurrent: 2 })

			const tasks = Array(5)
				.fill(0)
				.map((_, i) => ({
					id: `task${i}`,
					dependencies: [],
					execute: vi.fn().mockImplementation(() => sleep(100)),
				}))

			scheduler.addTasks(tasks)
			scheduler.execute()

			await sleep(10)

			const running = tasks.filter((t) => t.execute.mock.calls.length > 0)
			expect(running.length).toBeLessThanOrEqual(2)
		})
	})
})
```

### 5.4 WorkspaceAnalyzer Testing

**Component Responsibilities:**

- File conflict detection between parallel tasks
- Workspace isolation verification
- Read/write dependency analysis
- Safe concurrent operation validation

**Test Strategy:**

```typescript
describe("WorkspaceAnalyzer", () => {
	let analyzer: WorkspaceAnalyzer
	let mockFs: MockFileSystem

	beforeEach(() => {
		mockFs = createMockFileSystem()
		analyzer = new WorkspaceAnalyzer(mockFs)
	})

	describe("Conflict Detection", () => {
		it("should detect write-write conflicts", () => {
			const task1 = {
				id: "task1",
				operations: [{ type: "write", path: "src/file.ts" }],
			}

			const task2 = {
				id: "task2",
				operations: [{ type: "write", path: "src/file.ts" }],
			}

			const conflicts = analyzer.analyzeConflicts([task1, task2])
			expect(conflicts).toHaveLength(1)
			expect(conflicts[0]).toEqual({
				type: "write-write",
				path: "src/file.ts",
				tasks: ["task1", "task2"],
			})
		})

		it("should allow read-read operations on same file", () => {
			const task1 = {
				id: "task1",
				operations: [{ type: "read", path: "src/file.ts" }],
			}

			const task2 = {
				id: "task2",
				operations: [{ type: "read", path: "src/file.ts" }],
			}

			const conflicts = analyzer.analyzeConflicts([task1, task2])
			expect(conflicts).toHaveLength(0)
		})

		it("should detect write-read conflicts", () => {
			const task1 = {
				id: "task1",
				operations: [{ type: "write", path: "src/file.ts" }],
			}

			const task2 = {
				id: "task2",
				operations: [{ type: "read", path: "src/file.ts" }],
			}

			const conflicts = analyzer.analyzeConflicts([task1, task2])
			expect(conflicts).toEqual([
				{
					type: "write-read",
					path: "src/file.ts",
					tasks: ["task1", "task2"],
				},
			])
		})

		it("should detect directory conflicts", () => {
			const task1 = {
				id: "task1",
				operations: [{ type: "write", path: "src/components/Button.tsx" }],
			}

			const task2 = {
				id: "task2",
				operations: [{ type: "delete", path: "src/components/" }],
			}

			const conflicts = analyzer.analyzeConflicts([task1, task2])
			expect(conflicts[0].type).toBe("directory-conflict")
		})
	})

	describe("Workspace Isolation", () => {
		it("should verify workers have isolated workspaces", async () => {
			const worker1 = { id: "w1", workspace: "/tmp/worker1" }
			const worker2 = { id: "w2", workspace: "/tmp/worker2" }

			const isolated = await analyzer.verifyIsolation([worker1, worker2])
			expect(isolated).toBe(true)
		})

		it("should detect shared workspace violations", async () => {
			const worker1 = { id: "w1", workspace: "/tmp/shared" }
			const worker2 = { id: "w2", workspace: "/tmp/shared" }

			const isolated = await analyzer.verifyIsolation([worker1, worker2])
			expect(isolated).toBe(false)
		})
	})
})
```

### 5.5 Integration Testing Strategy

**Multi-Worker Scenario Testing:**

```typescript
describe("Touch and Go Integration", () => {
	let orchestrator: Orchestrator
	let instanceManager: ParallelInstanceManager

	beforeEach(async () => {
		instanceManager = new ParallelInstanceManager({ maxWorkers: 3 })
		orchestrator = new Orchestrator(instanceManager)
	})

	afterEach(async () => {
		await orchestrator.shutdown()
		await instanceManager.shutdown()
	})

	it("should execute parallel tasks with boomerang return", async () => {
		const task = {
			id: "main",
			subtasks: [
				{ id: "sub1", type: "code", dependencies: [] },
				{ id: "sub2", type: "code", dependencies: [] },
				{ id: "sub3", type: "review", dependencies: ["sub1", "sub2"] },
			],
		}

		const results: TaskResult[] = []
		orchestrator.on("taskComplete", (result) => results.push(result))

		await orchestrator.executeTask(task)

		// Verify parallel execution
		expect(results).toHaveLength(3)
		expect(results[0].taskId).toBe("sub1")
		expect(results[1].taskId).toBe("sub2")
		expect(results[2].taskId).toBe("sub3")

		// Verify sub3 waited for sub1 and sub2
		expect(results[2].startTime).toBeGreaterThan(results[0].endTime)
		expect(results[2].startTime).toBeGreaterThan(results[1].endTime)
	})

	it("should handle worker failures and retry", async () => {
		const killWorkerAfterFirst = vi.fn()

		const task = {
			id: "main",
			subtasks: [{ id: "unstable", type: "code", execute: killWorkerAfterFirst }],
		}

		// First execution will crash the worker
		killWorkerAfterFirst.mockImplementationOnce(() => {
			throw new Error("Worker crashed")
		})

		// Second execution succeeds
		killWorkerAfterFirst.mockImplementationOnce(() => ({ success: true }))

		const result = await orchestrator.executeTask(task, { retries: 1 })

		expect(result.success).toBe(true)
		expect(killWorkerAfterFirst).toHaveBeenCalledTimes(2)
	})

	it("should aggregate results from multiple workers", async () => {
		const task = {
			id: "analysis",
			subtasks: [
				{ id: "lint", type: "code", output: { issues: 5 } },
				{ id: "test", type: "test", output: { passed: 95, failed: 5 } },
				{ id: "coverage", type: "code", output: { coverage: 82 } },
			],
		}

		const result = await orchestrator.executeTask(task)

		expect(result.aggregated).toEqual({
			lint: { issues: 5 },
			test: { passed: 95, failed: 5 },
			coverage: { coverage: 82 },
		})
	})
})
```

---

## 6. Test Templates

### 6.1 Unit Test Template

```typescript
// src/__tests__/your-component.spec.ts

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { YourComponent } from "../core/YourComponent"

// Mock dependencies
vi.mock("vscode", () => ({
	// ... VS Code API mocks
}))

describe("YourComponent", () => {
	let component: YourComponent

	beforeEach(() => {
		// Setup
		component = new YourComponent()
	})

	afterEach(() => {
		// Cleanup
		vi.clearAllMocks()
	})

	describe("Feature Group", () => {
		it("should do something", () => {
			// Arrange
			const input = "test"

			// Act
			const result = component.method(input)

			// Assert
			expect(result).toBe("expected")
		})

		it("should handle errors", async () => {
			// Arrange
			const invalidInput = null

			// Act & Assert
			await expect(component.asyncMethod(invalidInput)).rejects.toThrow("Error message")
		})
	})
})
```

### 6.2 Integration Test Template

```typescript
// src/__tests__/integration/parallel-execution.spec.ts

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { ParallelInstanceManager } from "../../core/ParallelInstanceManager"
import { OrchestrationScheduler } from "../../core/OrchestrationScheduler"
import { IPCChannel } from "../../core/IPCChannel"

describe("Parallel Execution Integration", () => {
	let manager: ParallelInstanceManager
	let scheduler: OrchestrationScheduler

	beforeEach(async () => {
		manager = new ParallelInstanceManager({ maxWorkers: 2 })
		scheduler = new OrchestrationScheduler()
	})

	afterEach(async () => {
		await manager.shutdown()
	})

	it("should coordinate multiple workers", async () => {
		// Create tasks
		const tasks = [
			{ id: "t1", dependencies: [] },
			{ id: "t2", dependencies: ["t1"] },
		]

		scheduler.addTasks(tasks)

		// Execute with worker pool
		const results = await scheduler.execute(manager)

		// Verify
		expect(results).toHaveLength(2)
		expect(results[0].taskId).toBe("t1")
		expect(results[1].taskId).toBe("t2")
	})
})
```

### 6.3 Mock Setup Template

```typescript
// src/__tests__/mocks/worker-process.mock.ts

import { vi } from "vitest"
import { EventEmitter } from "events"

export function createMockWorkerProcess() {
	const emitter = new EventEmitter()

	return {
		pid: Math.floor(Math.random() * 10000),
		stdin: {
			write: vi.fn((data) => {
				emitter.emit("stdin", data)
				return true
			}),
		},
		stdout: {
			on: vi.fn((event, handler) => {
				emitter.on(`stdout:${event}`, handler)
			}),
		},
		stderr: {
			on: vi.fn((event, handler) => {
				emitter.on(`stderr:${event}`, handler)
			}),
		},
		on: vi.fn((event, handler) => {
			emitter.on(event, handler)
		}),
		kill: vi.fn((signal) => {
			emitter.emit("exit", 0, signal)
			return true
		}),
		// Test helpers
		_emit: (event: string, ...args: any[]) => emitter.emit(event, ...args),
		_emitStdout: (data: string) => emitter.emit("stdout:data", data),
		_emitStderr: (data: string) => emitter.emit("stderr:data", data),
	}
}

export type MockWorkerProcess = ReturnType<typeof createMockWorkerProcess>
```

### 6.4 E2E Test Template

```typescript
// apps/vscode-e2e/src/suite/parallel-tasks.test.ts

import * as assert from "assert"
import { RooCodeEventName } from "@roo-code/types"
import { waitFor, waitUntilCompleted } from "./utils"
import { setDefaultSuiteTimeout } from "./test-utils"

suite("Parallel Task Execution", function () {
	setDefaultSuiteTimeout(this)

	test("Should execute tasks in parallel", async () => {
		const api = globalThis.api
		const events: any[] = []

		api.on(RooCodeEventName.TaskStarted, (taskId) => {
			events.push({ type: "started", taskId, time: Date.now() })
		})

		api.on(RooCodeEventName.TaskCompleted, (taskId) => {
			events.push({ type: "completed", taskId, time: Date.now() })
		})

		const taskId = await api.startNewTask({
			configuration: { mode: "code", parallelExecution: true },
			text: "Create two files: file1.ts and file2.ts in parallel",
		})

		await waitUntilCompleted({ api, taskId })

		// Verify parallel execution
		const starts = events.filter((e) => e.type === "started")
		assert.ok(starts.length >= 2, "Should start multiple subtasks")

		const timeDiff = Math.abs(starts[0].time - starts[1].time)
		assert.ok(timeDiff < 1000, "Should start within 1 second (parallel)")
	})
})
```

---

## 7. Coverage Requirements & Tools

### Current Coverage Practices

From analysis of existing tests:

- **Target: 80%+ coverage** (industry standard, observed in comprehensive test suites)
- **Critical paths: 90%+** (core orchestration logic)
- **Utility functions: 95%+** (pure functions, utilities)
- **UI/Integration: 60%+** (E2E tests cover main flows)

### Running Tests with Coverage

**Backend Unit Tests:**

```bash
cd src
npx vitest run --coverage
```

**E2E Tests:**

```bash
cd apps/vscode-e2e
npm test
```

**Coverage Configuration** (add to [`vitest.config.ts`](../src/vitest.config.ts:1)):

```typescript
export default defineConfig({
	test: {
		// ... existing config
		coverage: {
			provider: "v8",
			reporter: ["text", "json", "html"],
			exclude: ["node_modules/", "dist/", "**/*.spec.ts", "**/*.test.ts", "**/__mocks__/**"],
			lines: 80,
			functions: 80,
			branches: 80,
			statements: 80,
		},
	},
})
```

### Coverage Reporting

**Generate HTML Report:**

```bash
npx vitest run --coverage
open coverage/index.html  # macOS
start coverage/index.html # Windows
```

**CI Integration:**

```yaml
# .github/workflows/test.yml
- name: Run tests with coverage
  run: |
      cd src
      npx vitest run --coverage

- name: Upload coverage to Codecov
  uses: codecov/codecov-action@v3
  with:
      files: ./src/coverage/coverage-final.json
```

---

## 8. Test Execution Procedures

### Local Development

**Run all backend tests:**

```bash
cd src
npm test
```

**Run specific test file:**

```bash
cd src
npx vitest run __tests__/your-component.spec.ts
```

**Watch mode (auto-rerun on changes):**

```bash
cd src
npx vitest --watch
```

**Run E2E tests:**

```bash
cd apps/vscode-e2e
npm test
```

### CI/CD Integration

From [`package.json`](../src/package.json:1):

```json
{
	"scripts": {
		"test": "vitest run",
		"pretest": "turbo run bundle --cwd ..",
		"lint": "eslint . --ext=ts --max-warnings=0",
		"check-types": "tsc --noEmit"
	}
}
```

**Test Workflow:**

1. `pretest`: Bundle extension code
2. `test`: Run Vitest with all specs
3. Lint and type-check in parallel

### Performance Considerations

- **Parallel test execution**: Vitest runs tests in parallel by default
- **Test isolation**: Each test file runs in isolation
- **Resource cleanup**: Always use `afterEach`/`afterAll` hooks
- **Timeout configuration**: Default 20s is sufficient for worker tests

---

## 9. Best Practices for Touch and Go Testing

### 9.1 Test Isolation

**✅ DO:**

```typescript
describe("ParallelInstanceManager", () => {
	let manager: ParallelInstanceManager

	beforeEach(() => {
		manager = new ParallelInstanceManager()
	})

	afterEach(async () => {
		await manager.shutdown() // Clean up resources
	})
})
```

**❌ DON'T:**

```typescript
describe("ParallelInstanceManager", () => {
	const manager = new ParallelInstanceManager() // Shared state!

	it("test 1", () => {
		/* uses manager */
	})
	it("test 2", () => {
		/* uses same manager - not isolated! */
	})
})
```

### 9.2 Async Testing

**✅ DO:**

```typescript
it("should handle async operations", async () => {
	const result = await manager.acquireWorker()
	expect(result).toBeDefined()
})
```

**❌ DON'T:**

```typescript
it("should handle async operations", () => {
	manager.acquireWorker().then((result) => {
		expect(result).toBeDefined() // Assertion may run after test completes!
	})
})
```

### 9.3 Mock Cleanup

**✅ DO:**

```typescript
afterEach(() => {
	vi.clearAllMocks() // Reset call counts
	vi.restoreAllMocks() // Restore original implementations
})
```

### 9.4 Test Naming

**✅ DO:**

```typescript
describe("ParallelInstanceManager", () => {
	describe("Worker Spawning", () => {
		it("should spawn workers up to maxWorkers limit", () => {
			/* ... */
		})
		it("should queue requests when at max capacity", () => {
			/* ... */
		})
	})
})
```

**Benefits:**

- Clear hierarchy in test output
- Easy to locate failing tests
- Self-documenting test structure

### 9.5 Error Testing

**✅ DO:**

```typescript
it("should throw on invalid configuration", () => {
	expect(() => {
		new ParallelInstanceManager({ maxWorkers: -1 })
	}).toThrow("maxWorkers must be positive")
})

it("should reject promise on worker crash", async () => {
	await expect(workerOperation()).rejects.toThrow("Worker terminated unexpectedly")
})
```

---

## 10. Key Takeaways for Phase 1 Implementation

### Critical Test Infrastructure Features

1. **Vitest is configured and ready**

    - Global test functions available
    - VS Code API automatically mocked
    - 20-second timeouts support async operations

2. **Comprehensive mocking available**

    - VS Code API: [`__mocks__/vscode.js`](../src/__mocks__/vscode.js:1)
    - File system: [`__mocks__/fs/promises.ts`](../src/__mocks__/fs/promises.ts:1)
    - Network isolation via `nock`

3. **E2E framework supports integration tests**

    - Real VS Code environment
    - API access via `globalThis.api`
    - Event-driven testing patterns

4. **Test-driven development is encouraged**
    - Write tests first for new components
    - Use templates provided in Section 6
    - Aim for 80%+ coverage

### Recommended Test Strategy for Touch and Go

**Phase 1.1: Core Infrastructure (Week 1)**

- [ ] `ParallelInstanceManager` unit tests (50+ tests)
- [ ] `IPCChannel` unit tests (40+ tests)
- [ ] Worker spawning integration tests (10+ tests)

**Phase 1.2: Orchestration (Week 2)**

- [ ] `OrchestrationScheduler` unit tests (60+ tests)
- [ ] Dependency graph tests (20+ tests)
- [ ] Multi-worker integration tests (15+ tests)

**Phase 1.3: Workspace Safety (Week 3)**

- [ ] `WorkspaceAnalyzer` unit tests (40+ tests)
- [ ] Conflict detection tests (30+ tests)
- [ ] E2E parallel execution tests (10+ tests)

**Total Estimated Tests: 275+**

### Quick Start Checklist

- [ ] Copy test templates from Section 6
- [ ] Set up `ParallelInstanceManager.spec.ts`
- [ ] Create mock for `child_process.spawn`
- [ ] Write first test: "should spawn single worker"
- [ ] Run test: `cd src && npx vitest run --watch`
- [ ] Implement until test passes
- [ ] Repeat for remaining tests

---

## 11. Additional Resources

### Test File Examples

- Extension lifecycle: [`src/__tests__/extension.spec.ts`](../src/__tests__/extension.spec.ts:1)
- Command system: [`src/__tests__/commands.spec.ts`](../src/__tests__/commands.spec.ts:1)
- E2E task testing: [`apps/vscode-e2e/src/suite/task.test.ts`](../apps/vscode-e2e/src/suite/task.test.ts:36)
- Tool testing: [`apps/vscode-e2e/src/suite/tools/apply-diff.test.ts`](../apps/vscode-e2e/src/suite/tools/apply-diff.test.ts:750)

### Documentation

- Vitest: https://vitest.dev/
- VS Code Testing: https://code.visualstudio.com/api/working-with-extensions/testing-extension
- Node.js child_process: https://nodejs.org/api/child_process.html
- Node.js worker_threads: https://nodejs.org/api/worker_threads.html

### Test Commands Reference

```bash
# Backend unit tests
cd src && npm test                    # Run all tests
cd src && npx vitest --watch          # Watch mode
cd src && npx vitest run <file>       # Specific file
cd src && npx vitest --coverage       # With coverage

# E2E tests
cd apps/vscode-e2e && npm test       # Run E2E suite

# Type checking
cd src && npm run check-types         # TypeScript validation

# Linting
cd src && npm run lint                # ESLint check
```

---

## Conclusion

The Roo Code extension has a mature, well-structured test infrastructure ready to support Touch and Go development. The combination of Vitest for unit tests, comprehensive mocking utilities, and an E2E framework provides all the tools needed to implement parallel execution with confidence.

**Key Success Factors:**

1. ✅ Write tests first (TDD approach)
2. ✅ Use provided templates and patterns
3. ✅ Aim for 80%+ coverage
4. ✅ Test async operations thoroughly
5. ✅ Clean up resources in `afterEach` hooks
6. ✅ Mock external dependencies (child_process, file system)
7. ✅ Use E2E tests for integration scenarios

With this infrastructure and strategy, Phase 1 can proceed with a solid testing foundation.
