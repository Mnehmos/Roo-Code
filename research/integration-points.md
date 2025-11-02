# Integration Points Guide

**Task 0.2**: Practical guide for integrating Touch and Go parallel execution components into Roo Code.

**Last Updated**: 2025-11-01  
**Author**: Roo (Architect Mode)  
**Version**: 1.0

---

## Table of Contents

1. [Quick Start](#quick-start)
2. [Spawning Agent Instances](#spawning-agent-instances)
3. [WebSocket Message Routing](#websocket-message-routing)
4. [Task Lifecycle Management](#task-lifecycle-management)
5. [Mode System Integration](#mode-system-integration)
6. [MCP Tool Registration](#mcp-tool-registration)
7. [Webview Communication](#webview-communication)
8. [Extension Points for Touch and Go](#extension-points-for-touch-and-go)

---

## Quick Start

### Integration Checklist for Parallel Execution

✅ **Ready to Use** (No Modification Needed):

- Task execution engine ([`Task.ts`](src/core/task/Task.ts:1))
- Tool execution pipeline ([`presentAssistantMessage.ts`](src/core/assistant-message/presentAssistantMessage.ts:1))
- MCP tool integration ([`McpHub.ts`](src/services/mcp/McpHub.ts:1))
- BridgeOrchestrator sync ([`BridgeOrchestrator.ts`](packages/cloud/src/bridge/BridgeOrchestrator.ts:1))
- Message persistence ([`task-persistence/`](src/core/task-persistence/))

⚠️ **Needs Extension** (Touch and Go Implementation):

- Multi-task state management in ClineProvider
- Parallel task pool coordination
- Webview UI for multi-agent display
- Task result aggregation logic

---

## Spawning Agent Instances

### Current Single-Agent Pattern

**File**: [`src/core/webview/ClineProvider.ts:2519`](src/core/webview/ClineProvider.ts:2519)

```typescript
// Sequential task creation - blocks parent until completion
async createTask(
    text?: string,
    images?: string[],
    parentTask?: Task,
    options: CreateTaskOptions = {},
    configuration: RooCodeSettings = {}
): Promise<Task> {
    // Apply configuration overrides
    if (configuration) {
        await this.setValues(configuration)
    }

    // Get current state
    const { apiConfiguration, experiments, cloudUserInfo, remoteControlEnabled } =
        await this.getState()

    // Validate organization allow list
    if (!ProfileValidator.isProfileAllowed(apiConfiguration, organizationAllowList)) {
        throw new OrganizationAllowListViolationError("Violated organization allowlist")
    }

    // Create new task instance
    const task = new Task({
        provider: this,
        apiConfiguration,
        enableDiff: state.diffEnabled,
        enableCheckpoints: state.enableCheckpoints,
        checkpointTimeout: state.checkpointTimeout,
        consecutiveMistakeLimit: apiConfiguration.consecutiveMistakeLimit,
        task: text,
        images,
        experiments,
        rootTask: this.clineStack.length > 0 ? this.clineStack[0] : undefined,
        parentTask,
        taskNumber: this.clineStack.length + 1,
        onCreated: this.taskCreationCallback,  // Event binding
        enableBridge: BridgeOrchestrator.isEnabled(cloudUserInfo, remoteControlEnabled),
        initialTodos: options.initialTodos,
        ...options
    })

    // Add to stack - THIS BLOCKS until task completes
    await this.addClineToStack(task)

    return task
}
```

### Parallel Task Spawning Pattern (Touch and Go)

**Recommended Implementation**:

```typescript
// NEW: Add to ClineProvider class
class ClineProvider {
    // Existing
    private clineStack: Task[] = []

    // NEW: Parallel task management
    private parallelTasks: Map<string, Task> = new Map()
    private parallelTaskGroups: Map<string, Set<string>> = new Map()
}

/**
 * Spawn a task that runs in parallel without blocking the caller.
 * Used for Touch and Go parallel execution.
 *
 * @param text Task instruction
 * @param images Optional images
 * @param parallelGroupId Optional group ID for coordinated parallel execution
 * @param options Task creation options
 * @returns Task instance (already running)
 */
async spawnParallelTask(
    text: string,
    images?: string[],
    parallelGroupId?: string,
    options: CreateTaskOptions = {}
): Promise<Task> {
    const { apiConfiguration, experiments, cloudUserInfo, remoteControlEnabled } =
        await this.getState()

    // Create task with unique identity
    const task = new Task({
        provider: this,
        apiConfiguration,
        task: text,
        images,
        experiments,
        // For parallel tasks, rootTask is the coordinator, not the first in stack
        rootTask: options.rootTask || this.getCurrentTask(),
        parentTask: options.parentTask,
        taskNumber: this.parallelTasks.size + 1,
        onCreated: this.taskCreationCallback,
        enableBridge: BridgeOrchestrator.isEnabled(cloudUserInfo, remoteControlEnabled),
        startTask: true,  // Immediately start execution
        ...options
    })

    // Track in parallel pool (not stack)
    this.parallelTasks.set(task.taskId, task)

    // Optional: Track in group for coordinated execution
    if (parallelGroupId) {
        if (!this.parallelTaskGroups.has(parallelGroupId)) {
            this.parallelTaskGroups.set(parallelGroupId, new Set())
        }
        this.parallelTaskGroups.get(parallelGroupId)!.add(task.taskId)
    }

    // Setup completion handler
    task.once(RooCodeEventName.TaskCompleted, async (taskId, tokenUsage, toolUsage) => {
        this.parallelTasks.delete(taskId)

        // Remove from group
        if (parallelGroupId) {
            this.parallelTaskGroups.get(parallelGroupId)?.delete(taskId)
        }

        // Emit parallel task completion event
        this.emit("parallelTaskCompleted", { taskId, tokenUsage, toolUsage })
    })

    // Setup error handler
    task.once(RooCodeEventName.TaskAborted, async () => {
        this.parallelTasks.delete(task.taskId)
        if (parallelGroupId) {
            this.parallelTaskGroups.get(parallelGroupId)?.delete(task.taskId)
        }
    })

    this.log(`[spawnParallelTask] Spawned parallel task ${task.taskId}.${task.instanceId}`)

    return task
}

/**
 * Wait for all tasks in a parallel group to complete.
 *
 * @param groupId Group identifier
 * @param timeoutMs Optional timeout in milliseconds
 * @returns Map of taskId to final messages
 */
async waitForParallelGroup(
    groupId: string,
    timeoutMs?: number
): Promise<Map<string, ClineMessage[]>> {
    const taskIds = this.parallelTaskGroups.get(groupId)
    if (!taskIds || taskIds.size === 0) {
        return new Map()
    }

    const results = new Map<string, ClineMessage[]>()
    const promises = Array.from(taskIds).map(taskId => {
        return new Promise<void>((resolve, reject) => {
            const task = this.parallelTasks.get(taskId)
            if (!task) {
                resolve()
                return
            }

            // Wait for completion
            task.once(RooCodeEventName.TaskCompleted, () => {
                results.set(taskId, task.clineMessages)
                resolve()
            })

            // Handle abort
            task.once(RooCodeEventName.TaskAborted, () => {
                results.set(taskId, task.clineMessages)
                resolve()
            })
        })
    })

    if (timeoutMs) {
        await Promise.race([
            Promise.all(promises),
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error("Parallel group timeout")), timeoutMs)
            )
        ])
    } else {
        await Promise.all(promises)
    }

    return results
}
```

### Usage Example (Touch and Go Orchestrator Mode)

```typescript
// In orchestrator mode tool handler
async function executeParallelTasks(provider: ClineProvider, tasks: Array<{ description: string; mode: string }>) {
	const groupId = crypto.randomUUID()
	const spawnedTasks: Task[] = []

	// Spawn all tasks in parallel
	for (const { description, mode } of tasks) {
		const task = await provider.spawnParallelTask(
			description,
			undefined, // no images
			groupId,
			{ mode }, // Override mode for each task
		)
		spawnedTasks.push(task)
	}

	// Wait for all to complete
	const results = await provider.waitForParallelGroup(groupId, 300000) // 5min timeout

	// Aggregate results
	const aggregatedResults = Array.from(results.entries()).map(([taskId, messages]) => {
		const lastMessage = messages[messages.length - 1]
		return {
			taskId,
			result: lastMessage?.text || "No result",
			success: lastMessage?.ask === "completion_result",
		}
	})

	return aggregatedResults
}
```

---

## WebSocket Message Routing

### BridgeOrchestrator Architecture

**Files**:

- [`packages/cloud/src/bridge/BridgeOrchestrator.ts`](packages/cloud/src/bridge/BridgeOrchestrator.ts:1) - Coordinator
- [`packages/cloud/src/bridge/SocketTransport.ts`](packages/cloud/src/bridge/SocketTransport.ts:1) - Socket.io wrapper
- [`packages/cloud/src/bridge/ExtensionChannel.ts`](packages/cloud/src/bridge/ExtensionChannel.ts:1) - Extension state
- [`packages/cloud/src/bridge/TaskChannel.ts`](packages/cloud/src/bridge/TaskChannel.ts:1) - Task messaging

### Connection Initialization

```typescript
// From ClineProvider.ts initialization
if (CloudService.hasInstance() && CloudService.instance.isAuthenticated()) {
	const config = await CloudService.instance.cloudAPI?.bridgeConfig()

	await BridgeOrchestrator.connectOrDisconnect(userInfo, remoteControlEnabled, {
		userId: userInfo.id,
		socketBridgeUrl: config.socketBridgeUrl,
		token: config.token,
		provider: this,
		sessionId: vscode.env.sessionId,
		isCloudAgent: CloudService.instance.isCloudAgent,
	})
}
```

### Task Subscription Pattern

```typescript
// From Task.ts:startTask()
if (this.enableBridge) {
    try {
        await BridgeOrchestrator.subscribeToTask(this)
    } catch (error) {
        console.error(`BridgeOrchestrator.subscribeToTask() failed: ${error}`)
    }
}

// BridgeOrchestrator handles subscription internally
static async subscribeToTask(task: TaskLike): Promise<void> {
    const instance = BridgeOrchestrator.instance

    if (instance && instance.socketTransport.isConnected()) {
        await instance.subscribeToTask(task)
    } else {
        // Queue for later when connected
        BridgeOrchestrator.pendingTask = task
    }
}
```

### Extension-Level Events

**ExtensionChannel Event Mapping**:

```typescript
// From ExtensionChannel.ts
private setupListeners(): void {
    const eventMapping = [
        { from: RooCodeEventName.TaskCreated, to: ExtensionBridgeEventName.TaskCreated },
        { from: RooCodeEventName.TaskStarted, to: ExtensionBridgeEventName.TaskStarted },
        { from: RooCodeEventName.TaskCompleted, to: ExtensionBridgeEventName.TaskCompleted },
        { from: RooCodeEventName.TaskAborted, to: ExtensionBridgeEventName.TaskAborted },
        // ... 10+ more events
    ]

    eventMapping.forEach(({ from, to }) => {
        const listener = async () => {
            this.publish(ExtensionSocketEvents.EVENT, {
                type: to,
                instance: await this.updateInstance(),
                timestamp: Date.now()
            })
        }

        this.provider.on(from, listener)
    })
}
```

**ExtensionInstance State**:

```typescript
// Broadcast to cloud on every heartbeat (30s interval)
interface ExtensionInstance {
	instanceId: string
	userId: string
	workspacePath: string
	appProperties: StaticAppProperties
	gitProperties?: GitProperties
	lastHeartbeat: number
	task: {
		// Current task only
		taskId: string
		taskStatus: TaskStatus
		parentTaskId?: string
		childTaskId?: string
		// ... task metadata
	}
	taskHistory: string[] // Recent task IDs
	mode: string // Current mode
	providerProfile: string // Current API profile
}
```

### Task-Level Events

**TaskChannel Event Mapping**:

```typescript
// From TaskChannel.ts
private readonly eventMapping = [
    {
        from: RooCodeEventName.Message,
        to: TaskBridgeEventName.Message,
        createPayload: (task, data: { action: string; message: ClineMessage }) => ({
            type: TaskBridgeEventName.Message,
            taskId: task.taskId,
            action: data.action,
            message: data.message
        })
    },
    {
        from: RooCodeEventName.TaskModeSwitched,
        to: TaskBridgeEventName.TaskModeSwitched,
        createPayload: (task, mode: string) => ({
            type: TaskBridgeEventName.TaskModeSwitched,
            taskId: task.taskId,
            mode
        })
    },
    // ... more event mappings
]
```

**Receiving Remote Commands**:

```typescript
// TaskChannel handles incoming commands per task
protected async handleCommandImplementation(command: TaskBridgeCommand): Promise<void> {
    const task = this.subscribedTasks.get(command.taskId)
    if (!task) return

    switch (command.type) {
        case TaskBridgeCommandName.Message:
            await task.submitUserMessage(
                command.payload.text,
                command.payload.images,
                command.payload.mode,
                command.payload.providerProfile
            )
            break

        case TaskBridgeCommandName.ApproveAsk:
            task.approveAsk(command.payload)
            break

        case TaskBridgeCommandName.DenyAsk:
            task.denyAsk(command.payload)
            break
    }
}
```

### Extending for Parallel Tasks

**Current Limitation**: ExtensionInstance only tracks single `task` field.

**Extension Strategy**:

```typescript
// NEW: Enhanced ExtensionInstance for parallel tasks
interface ParallelExtensionInstance extends ExtensionInstance {
    // Existing single task field (for backward compatibility)
    task: { taskId: string; taskStatus: TaskStatus; ... }

    // NEW: Parallel tasks field
    parallelTasks?: Array<{
        taskId: string
        taskStatus: TaskStatus
        parentTaskId?: string
        mode: string
        metadata: TaskMetadata
    }>

    // NEW: Parallel operation tracking
    parallelOperations?: Array<{
        operationId: string
        coordinatorTaskId: string
        subtaskIds: string[]
        completedCount: number
        status: "running" | "completed" | "failed"
    }>
}

// Modify ExtensionChannel.updateInstance()
private async updateInstance(): Promise<ParallelExtensionInstance> {
    const currentTask = this.provider?.getCurrentTask()
    const parallelTasks = Array.from(this.provider?.parallelTasks?.values() || [])
        .map(task => ({
            taskId: task.taskId,
            taskStatus: task.taskStatus,
            parentTaskId: task.parentTaskId,
            mode: task.taskMode,
            metadata: task.metadata
        }))

    return {
        ...this.extensionInstance,
        lastHeartbeat: Date.now(),
        task: currentTask ? { /* current task */ } : { taskId: "", taskStatus: TaskStatus.None },
        parallelTasks: parallelTasks.length > 0 ? parallelTasks : undefined
    }
}
```

---

## Task Lifecycle Management

### Task Creation from History

**File**: [`src/core/webview/ClineProvider.ts:859`](src/core/webview/ClineProvider.ts:859)

```typescript
async createTaskWithHistoryItem(
    historyItem: HistoryItem & { rootTask?: Task; parentTask?: Task }
) {
    // Clear current task
    await this.removeClineFromStack()

    // Restore mode from history
    if (historyItem.mode) {
        await this.updateGlobalState("mode", historyItem.mode)

        // Load saved API config for this mode
        const savedConfigId = await this.providerSettingsManager.getModeConfigId(historyItem.mode)
        if (savedConfigId) {
            const profile = listApiConfig.find(({ id }) => id === savedConfigId)
            if (profile?.name) {
                await this.activateProviderProfile({ name: profile.name })
            }
        }
    }

    // Create task from history
    const task = new Task({
        provider: this,
        apiConfiguration,
        enableDiff: state.diffEnabled,
        historyItem,  // Contains saved messages
        experiments,
        rootTask: historyItem.rootTask,
        parentTask: historyItem.parentTask,
        taskNumber: historyItem.number,
        workspacePath: historyItem.workspace,
        onCreated: this.taskCreationCallback,
        enableBridge: BridgeOrchestrator.isEnabled(cloudUserInfo, remoteControlEnabled)
    })

    await this.addClineToStack(task)
    return task
}
```

**What Gets Restored**:

1. **Mode**: Task-specific mode from history
2. **API Configuration**: Mode's saved provider profile
3. **Messages**: Both `api-conversation-history.json` and `ui-messages.json`
4. **Todo List**: Restored from last `update_todo_list` message
5. **Workspace Path**: Original workspace location

**Task History Structure**:

```typescript
// From task-persistence/metadata.ts
async function taskMetadata(options: {
	taskId: string
	rootTaskId?: string
	parentTaskId?: string
	taskNumber?: number
	messages: ClineMessage[]
	globalStoragePath: string
	workspace?: string
	mode?: string
}): Promise<{ historyItem: HistoryItem; tokenUsage: TokenUsage }> {
	const metrics = getApiMetrics(combineMessages(messages))

	return {
		historyItem: {
			id: options.taskId,
			ts: Date.now(),
			task: extractUserTask(messages),
			tokensIn: metrics.totalTokensIn,
			tokensOut: metrics.totalTokensOut,
			cacheWrites: metrics.totalCacheWrites,
			cacheReads: metrics.totalCacheReads,
			totalCost: metrics.totalCost,
			mode: options.mode,
			workspace: options.workspace,
			number: options.taskNumber,
			rootTaskId: options.rootTaskId,
			parentTaskId: options.parentTaskId,
		},
		tokenUsage: metrics,
	}
}
```

### Task Abortion and Cleanup

```typescript
// From Task.ts:1528
public async abortTask(isAbandoned = false) {
    if (isAbandoned) {
        this.abandoned = true  // Skip cleanup in running promises
    }

    this.abort = true
    this.emit(RooCodeEventName.TaskAborted)

    try {
        this.dispose()  // Centralized cleanup
    } catch (error) {
        console.error(`Error during task disposal:`, error)
    }

    await this.saveClineMessages()
}

public dispose(): void {
    // Cleanup in order
    1. Remove message queue listeners
    2. Remove all event listeners (this.removeAllListeners())
    3. Clear pause interval (for subtask waiting)
    4. Unsubscribe from BridgeOrchestrator
    5. Release terminals (TerminalRegistry.releaseTerminalsForTask)
    6. Close browsers (urlContentFetcher, browserSession)
    7. Dispose file controllers (rooIgnoreController, fileContextTracker)
    8. Revert diff changes if streaming
}
```

**Critical for Parallel Execution**:

- Each task cleanup is **independent** - no shared state
- Terminals are **task-scoped** via [`TerminalRegistry`](src/integrations/terminal/TerminalRegistry.ts:1)
- File watchers are **task-scoped** via [`FileContextTracker`](src/core/context-tracking/FileContextTracker.ts:1)
- Browsers are **task-scoped** via [`BrowserSession`](src/services/browser/BrowserSession.ts:1)

---

## Mode System Integration

### Mode Loading and Caching

**File**: [`src/core/config/CustomModesManager.ts:355`](src/core/config/CustomModesManager.ts:355)

```typescript
public async getCustomModes(): Promise<ModeConfig[]> {
    // Check 10-second cache
    const now = Date.now()
    if (this.cachedModes && now - this.cachedAt < 10_000) {
        return this.cachedModes
    }

    // Load from files
    const settingsPath = await this.getCustomModesFilePath()
    const settingsModes = await this.loadModesFromFile(settingsPath)

    const roomodesPath = await this.getWorkspaceRoomodes()
    const roomodesModes = roomodesPath ? await this.loadModesFromFile(roomodesPath) : []

    // Project modes override global modes
    const mergedModes = await this.mergeCustomModes(roomodesModes, settingsModes)

    // Cache and persist
    this.cachedModes = mergedModes
    this.cachedAt = now
    await this.context.globalState.update("customModes", mergedModes)

    return mergedModes
}
```

### Mode Switching

**File**: [`src/core/webview/ClineProvider.ts:1177`](src/core/webview/ClineProvider.ts:1177)

```typescript
public async handleModeSwitch(newMode: Mode) {
    const task = this.getCurrentTask()

    if (task) {
        // Update task history with new mode
        const history = this.getGlobalState("taskHistory") ?? []
        const taskHistoryItem = history.find(item => item.id === task.taskId)

        if (taskHistoryItem) {
            taskHistoryItem.mode = newMode
            await this.updateTaskHistory(taskHistoryItem)
        }

        // Update in-memory task mode
        (task as any)._taskMode = newMode

        // Emit events
        TelemetryService.instance.captureModeSwitch(task.taskId, newMode)
        task.emit(RooCodeEventName.TaskModeSwitched, task.taskId, newMode)
    }

    // Update global mode
    await this.updateGlobalState("mode", newMode)
    this.emit(RooCodeEventName.ModeChanged, newMode)

    // Load saved API config for new mode
    const savedConfigId = await this.providerSettingsManager.getModeConfigId(newMode)
    if (savedConfigId) {
        const profile = listApiConfig.find(({ id }) => id === savedConfigId)
        if (profile?.name) {
            await this.activateProviderProfile({ name: profile.name })
        }
    }

    await this.postStateToWebview()
}
```

**Mode-API Profile Association**:

```typescript
// Each mode can have its own saved API configuration
// Stored in: modeApiConfigs: Record<Mode, string>  // mode -> configId

// When switching modes:
const savedConfigId = await providerSettingsManager.getModeConfigId("architect")
// → "profile-uuid-for-architect-mode"

// Activate that profile
await activateProviderProfile({ id: savedConfigId })
```

### File Restrictions Enforcement

**File**: [`src/shared/modes.ts:167`](src/shared/modes.ts:167)

```typescript
export function isToolAllowedForMode(
	tool: string,
	modeSlug: string,
	customModes: ModeConfig[],
	toolRequirements?: Record<string, boolean>,
	toolParams?: Record<string, any>,
	experiments?: Record<string, boolean>,
): boolean {
	const mode = getModeBySlug(modeSlug, customModes)
	if (!mode) return false

	// Check each group
	for (const group of mode.groups) {
		const groupName = getGroupName(group)
		const options = getGroupOptions(group)

		const groupConfig = TOOL_GROUPS[groupName]
		if (!groupConfig.tools.includes(tool)) continue

		// Apply file restrictions for edit group
		if (groupName === "edit" && options?.fileRegex) {
			const filePath = toolParams?.path

			// Check if this is an actual edit operation
			const EDIT_OPERATION_PARAMS = ["diff", "content", "operations", "args", "line"]
			const isEditOperation = EDIT_OPERATION_PARAMS.some((param) => toolParams?.[param])

			if (filePath && isEditOperation && !doesFileMatchRegex(filePath, options.fileRegex)) {
				throw new FileRestrictionError(mode.name, options.fileRegex, options.description, filePath, tool)
			}
		}

		return true
	}

	return false
}
```

**Integration Point**:

- Called from [`presentAssistantMessage.ts:368`](src/core/assistant-message/presentAssistantMessage.ts:368) before tool execution
- Throws `FileRestrictionError` which is caught and shown to user
- No changes needed for parallel execution

---

## MCP Tool Registration

### Server Configuration Schema

**File**: [`src/services/mcp/McpHub.ts:61`](src/services/mcp/McpHub.ts:61)

```typescript
// Discriminated union for three server types
const ServerConfigSchema = z.union([
	// stdio: Local process
	BaseConfigSchema.extend({
		type: z.enum(["stdio"]).optional(),
		command: z.string().min(1),
		args: z.array(z.string()).optional(),
		cwd: z.string().default(() => vscode.workspace.workspaceFolders?.at(0)?.uri.fsPath ?? process.cwd()),
		env: z.record(z.string()).optional(),
	}),

	// sse: Server-Sent Events
	BaseConfigSchema.extend({
		type: z.enum(["sse"]).optional(),
		url: z.string().url(),
		headers: z.record(z.string()).optional(),
	}),

	// streamable-http: HTTP streaming
	BaseConfigSchema.extend({
		type: z.enum(["streamable-http"]).optional(),
		url: z.string().url(),
		headers: z.record(z.string()).optional(),
	}),
])

const BaseConfigSchema = z.object({
	disabled: z.boolean().optional(),
	timeout: z.number().min(1).max(3600).default(60),
	alwaysAllow: z.array(z.string()).default([]),
	watchPaths: z.array(z.string()).optional(),
	disabledTools: z.array(z.string()).default([]),
})
```

### Server Connection Lifecycle

```typescript
// From McpHub.ts:622
private async connectToServer(
    name: string,
    config: z.infer<typeof ServerConfigSchema>,
    source: "global" | "project" = "global"
): Promise<void> {
    // 1. Remove existing connection if present
    await this.deleteConnection(name, source)

    // 2. Check if MCP is globally enabled
    if (!await this.isMcpEnabled()) {
        const connection = this.createPlaceholderConnection(name, config, source, DisableReason.MCP_DISABLED)
        this.connections.push(connection)
        return
    }

    // 3. Skip disabled servers
    if (config.disabled) {
        const connection = this.createPlaceholderConnection(name, config, source, DisableReason.SERVER_DISABLED)
        this.connections.push(connection)
        return
    }

    // 4. Create MCP client
    const client = new Client({
        name: "Roo Code",
        version: this.providerRef.deref()?.context.extension?.packageJSON?.version ?? "1.0.0"
    }, {
        capabilities: {}
    })

    // 5. Create transport based on type
    let transport: StdioClientTransport | SSEClientTransport | StreamableHTTPClientTransport

    if (config.type === "stdio") {
        transport = new StdioClientTransport({
            command: config.command,
            args: config.args,
            env: { ...getDefaultEnvironment(), ...config.env }
        })

        // Monitor stderr for errors
        transport.stderr?.on("data", (data: Buffer) => {
            const output = data.toString()
            if (!/INFO/i.test(output)) {
                this.appendErrorMessage(connection, output)
            }
        })
    } else if (config.type === "sse") {
        transport = new SSEClientTransport(new URL(config.url), {
            requestInit: { headers: config.headers }
        })
    } else {  // streamable-http
        transport = new StreamableHTTPClientTransport(new URL(config.url), {
            requestInit: { headers: config.headers }
        })
    }

    // 6. Connect and fetch capabilities
    const connection: ConnectedMcpConnection = {
        type: "connected",
        server: {
            name,
            config: JSON.stringify(config),
            status: "connecting",
            source,
            errorHistory: []
        },
        client,
        transport
    }
    this.connections.push(connection)

    await client.connect(transport)
    connection.server.status = "connected"

    // 7. Fetch tools and resources
    connection.server.tools = await this.fetchToolsList(name, source)
    connection.server.resources = await this.fetchResourcesList(name, source)
    connection.server.resourceTemplates = await this.fetchResourceTemplatesList(name, source)
}
```

### Tool Discovery

```typescript
// From McpHub.ts:913
private async fetchToolsList(serverName: string, source?: "global" | "project"): Promise<McpTool[]> {
    const connection = this.findConnection(serverName, source)
    if (!connection || connection.type !== "connected") return []

    // Request tools from MCP server
    const response = await connection.client.request(
        { method: "tools/list" },
        ListToolsResultSchema
    )

    // Read configuration for this server
    const configPath = source === "project"
        ? await this.getProjectMcpPath()
        : await this.getMcpSettingsFilePath()

    const content = await fs.readFile(configPath, "utf-8")
    const serverConfig = JSON.parse(content).mcpServers?.[serverName] || {}

    // Apply configuration to tools
    return (response?.tools || []).map(tool => ({
        ...tool,
        alwaysAllow: serverConfig.alwaysAllow?.includes(tool.name) || false,
        enabledForPrompt: !serverConfig.disabledTools?.includes(tool.name)
    }))
}
```

### System Prompt Integration

**File**: [`src/core/prompts/system.ts`](src/core/prompts/system.ts:1)

```typescript
export async function SYSTEM_PROMPT(
	context: vscode.ExtensionContext,
	cwd: string,
	supportsComputerUse: boolean,
	mcpHub?: McpHub,
	diffStrategy?: DiffStrategy,
	browserViewportSize?: string,
	mode?: string,
	customModePrompts?: CustomModePrompts,
	customModes?: ModeConfig[],
	customInstructions?: string,
	// ... more parameters
): Promise<string> {
	let prompt = ""

	// 1. Add mode-specific content
	const modeConfig = await getFullModeDetails(mode || defaultModeSlug, customModes, customModePrompts)
	prompt += modeConfig.roleDefinition + "\n\n"
	prompt += modeConfig.customInstructions + "\n\n"

	// 2. Add tool descriptions (filtered by mode)
	prompt += "# Tools\n\n"
	const availableTools = getToolsForMode(modeConfig.groups)
	for (const tool of availableTools) {
		prompt += getToolDescription(tool) + "\n\n"
	}

	// 3. Add MCP servers
	if (mcpHub) {
		prompt += "# MCP SERVERS\n\n"
		const servers = mcpHub.getServers() // Only enabled servers

		for (const server of servers) {
			prompt += `## ${server.name}\n\n`

			// Add tools
			const enabledTools = server.tools?.filter((t) => t.enabledForPrompt) || []
			if (enabledTools.length > 0) {
				prompt += "### Available Tools\n"
				for (const tool of enabledTools) {
					prompt += `- ${tool.name}: ${tool.description}\n`
					prompt += `    Input Schema:\n\t\t${JSON.stringify(tool.inputSchema)}\n\n`
				}
			}

			// Add resources
			if (server.resources?.length > 0) {
				prompt += "### Direct Resources\n"
				for (const resource of server.resources) {
					prompt += `- ${resource.uri}: ${resource.description}\n`
				}
			}
		}
	}

	// 4. Add environment-specific rules
	prompt += await getRooIgnoreInstructions(cwd)

	return prompt
}
```

**Dynamic Prompt Generation Per Task**:

- Each task calls [`getSystemPrompt()`](src/core/task/Task.ts:2453) which generates fresh prompt
- Mode can change mid-task via `switch_mode` tool
- MCP servers can be added/removed while tasks run
- Custom instructions can be workspace-specific

---

## Webview Communication

### Message Handler Architecture

**File**: [`src/core/webview/webviewMessageHandler.ts:64`](src/core/webview/webviewMessageHandler.ts:64)

**Handler Structure**:

```typescript
export const webviewMessageHandler = async (
	provider: ClineProvider,
	message: WebviewMessage,
	marketplaceManager?: MarketplaceManager,
) => {
	// Utility closures
	const getGlobalState = <K extends keyof GlobalState>(key: K) => provider.contextProxy.getValue(key)

	const updateGlobalState = async <K extends keyof GlobalState>(key: K, value: GlobalState[K]) =>
		await provider.contextProxy.setValue(key, value)

	const getCurrentCwd = () => provider.getCurrentTask()?.cwd || provider.cwd

	// 50+ message type handlers
	switch (message.type) {
		case "newTask":
			await provider.createTask(message.text, message.images)
			break

		case "askResponse":
			provider.getCurrentTask()?.handleWebviewAskResponse(message.askResponse, message.text, message.images)
			break

		case "mode":
			await provider.handleModeSwitch(message.text as Mode)
			break

		// ... 50+ more cases
	}
}
```

### State Broadcasting

```typescript
// From ClineProvider.ts:2084
async getState(): Promise<ExtensionState> {
    const stateValues = this.contextProxy.getValues()
    const customModes = await this.customModesManager.getCustomModes()

    return {
        // API Configuration
        apiConfiguration: this.contextProxy.getProviderSettings(),
        currentApiConfigName: stateValues.currentApiConfigName ?? "default",
        listApiConfigMeta: stateValues.listApiConfigMeta ?? [],

        // Mode Configuration
        mode: stateValues.mode ?? defaultModeSlug,
        customModes,
        customModePrompts: stateValues.customModePrompts ?? {},

        // Current Task
        // NOTE: This assumes single task - needs extension for parallel
        currentTaskItem: this.getCurrentTask()?.taskId
            ? taskHistory.find(item => item.id === this.getCurrentTask()?.taskId)
            : undefined,
        clineMessages: this.getCurrentTask()?.clineMessages || [],
        currentTaskTodos: this.getCurrentTask()?.todoList || [],
        messageQueue: this.getCurrentTask()?.messageQueueService?.messages,

        // Task History
        taskHistory: (taskHistory || [])
            .filter(item => item.ts && item.task)
            .sort((a, b) => b.ts - a.ts),

        // MCP
        mcpServers: this.mcpHub?.getAllServers() ?? [],
        mcpEnabled: stateValues.mcpEnabled ?? true,

        // Settings
        // ... 50+ more fields
    }
}
```

### Extending State for Parallel Tasks

```typescript
// NEW: Enhanced state structure
interface ParallelExtensionState extends ExtensionState {
    // Existing fields remain unchanged

    // NEW: Parallel task tracking
    parallelTasks?: Array<{
        taskId: string
        taskItem: HistoryItem
        messages: ClineMessage[]
        todos: TodoItem[]
        queuedMessages: QueuedMessage[]
        status: TaskStatus
        mode: string
    }>

    // NEW: Parallel operation metadata
    currentParallelOperation?: {
        operationId: string
        coordinatorTaskId: string
        subtasks: Array<{
            taskId: string
            description: string
            status: "pending" | "running" | "completed" | "failed"
        }>
    }
}

// NEW: Method to collect parallel task state
private getParallelTasksState(): ParallelTaskState[] {
    return Array.from(this.parallelTasks.values()).map(task => ({
        taskId: task.taskId,
        taskItem: {
            id: task.taskId,
            ts: Date.now(),
            task: task.metadata.task || "",
            mode: task.taskMode,
            workspace: task.workspacePath
        },
        messages: task.clineMessages,
        todos: task.todoList || [],
        queuedMessages: task.queuedMessages,
        status: task.taskStatus,
        mode: task.taskMode
    }))
}
```

---

## Extension Points for Touch and Go

### 1. Parallel Task Pool Management

**Location**: [`src/core/webview/ClineProvider.ts`](src/core/webview/ClineProvider.ts:1)

**Add These Properties**:

```typescript
export class ClineProvider {
	// Existing
	private clineStack: Task[] = []

	// NEW: Parallel execution support
	private parallelTasks: Map<string, Task> = new Map()
	private parallelTaskGroups: Map<string, Set<string>> = new Map()
	private parallelOperations: Map<string, ParallelOperation> = new Map()
}

interface ParallelOperation {
	operationId: string
	coordinatorTaskId: string
	subtaskIds: string[]
	strategy: "all" | "race" | "sequential"
	results: Map<string, TaskResult>
	status: "pending" | "running" | "completed" | "failed"
}

interface TaskResult {
	taskId: string
	messages: ClineMessage[]
	tokenUsage: TokenUsage
	toolUsage: ToolUsage
	success: boolean
	error?: string
}
```

**Add These Methods**:

```typescript
/**
 * Execute multiple tasks in parallel and wait for all to complete.
 * Returns aggregated results from all tasks.
 */
async executeParallelTasks(
    tasks: Array<{ text: string; mode?: string; images?: string[] }>,
    strategy: "all" | "race" = "all"
): Promise<Map<string, TaskResult>> {
    const operationId = crypto.randomUUID()
    const groupId = crypto.randomUUID()

    // Spawn all tasks
    const spawnPromises = tasks.map(({ text, mode, images }) =>
        this.spawnParallelTask(text, images, groupId, { mode })
    )

    const spawnedTasks = await Promise.all(spawnPromises)

    // Track operation
    this.parallelOperations.set(operationId, {
        operationId,
        coordinatorTaskId: this.getCurrentTask()?.taskId || "",
        subtaskIds: spawnedTasks.map(t => t.taskId),
        strategy,
        results: new Map(),
        status: "running"
    })

    // Wait for completion
    if (strategy === "all") {
        await this.waitForParallelGroup(groupId)
    } else if (strategy === "race") {
        await this.waitForFirstCompletion(groupId)
    }

    // Collect results
    const results = new Map<string, TaskResult>()
    for (const task of spawnedTasks) {
        results.set(task.taskId, {
            taskId: task.taskId,
            messages: task.clineMessages,
            tokenUsage: task.getTokenUsage(),
            toolUsage: task.toolUsage,
            success: task.clineMessages.some(m => m.ask === "completion_result"),
            error: task.abortReason
        })
    }

    // Update operation
    const operation = this.parallelOperations.get(operationId)!
    operation.results = results
    operation.status = "completed"

    return results
}

/**
 * Wait for first task in group to complete (race condition).
 */
async waitForFirstCompletion(groupId: string): Promise<string> {
    const taskIds = this.parallelTaskGroups.get(groupId)
    if (!taskIds || taskIds.size === 0) {
        throw new Error("No tasks in group")
    }

    return new Promise<string>((resolve) => {
        const checkCompletion = (taskId: string) => {
            const task = this.parallelTasks.get(taskId)
            if (!task) return

            // Listen for completion
            task.once(RooCodeEventName.TaskCompleted, () => {
                resolve(taskId)
                // Abort remaining tasks
                this.abortParallelGroup(groupId, taskId)
            })
        }

        taskIds.forEach(checkCompletion)
    })
}

/**
 * Abort all tasks in a group except the winner.
 */
async abortParallelGroup(groupId: string, excludeTaskId?: string): Promise<void> {
    const taskIds = this.parallelTaskGroups.get(groupId)
    if (!taskIds) return

    for (const taskId of taskIds) {
        if (taskId === excludeTaskId) continue

        const task = this.parallelTasks.get(taskId)
        if (task) {
            await task.abortTask(true)  // Mark as abandoned
        }
    }
}
```

---

### 2. Message Routing to Specific Tasks

**Current Pattern** (Routes to current task only):

```typescript
// From webviewMessageHandler.ts:582
case "askResponse":
    provider.getCurrentTask()?.handleWebviewAskResponse(
        message.askResponse,
        message.text,
        message.images
    )
    break
```

**Extension for Parallel Routing**:

```typescript
// NEW: Add taskId to WebviewMessage types
interface AskResponseMessage {
    type: "askResponse"
    askResponse: ClineAskResponse
    text?: string
    images?: string[]
    taskId?: string  // NEW: Target specific task
}

// NEW: Message routing logic
case "askResponse":
    if (message.taskId) {
        // Route to specific task
        const task = provider.getTaskById(message.taskId)
        if (task) {
            task.handleWebviewAskResponse(message.askResponse, message.text, message.images)
        } else {
            console.error(`Task ${message.taskId} not found for askResponse`)
        }
    } else {
        // Backward compatibility: route to current task
        provider.getCurrentTask()?.handleWebviewAskResponse(
            message.askResponse,
            message.text,
            message.images
        )
    }
    break

// NEW: Helper method in ClineProvider
public getTaskById(taskId: string): Task | undefined {
    // Check stack (current/parent tasks)
    const stackTask = this.clineStack.find(t => t.taskId === taskId)
    if (stackTask) return stackTask

    // Check parallel tasks
    return this.parallelTasks.get(taskId)
}
```

---

### 3. Workspace Isolation (Already Implemented)

**No Changes Needed** - Each Task instance already has complete workspace isolation:

```typescript
class Task {
	readonly workspacePath: string

	// Isolated per task
	rooIgnoreController: RooIgnoreController // .rooignore rules
	rooProtectedController: RooProtectedController // .rooprotected rules
	fileContextTracker: FileContextTracker // Open files tracking
	urlContentFetcher: UrlContentFetcher // URL content cache
	terminalProcess?: RooTerminalProcess // Task terminal
	browserSession: BrowserSession // Task browser
	diffViewProvider: DiffViewProvider // Diff viewer

	// These are per-task and don't interfere
	toolRepetitionDetector: ToolRepetitionDetector
	messageQueueService: MessageQueueService
	checkpointService?: RepoPerTaskCheckpointService
}
```

**Terminal Isolation**:

```typescript
// From TerminalRegistry.ts
class TerminalRegistry {
	private static taskTerminals: Map<string, vscode.Terminal[]> = new Map()

	static registerTerminal(taskId: string, terminal: vscode.Terminal) {
		if (!this.taskTerminals.has(taskId)) {
			this.taskTerminals.set(taskId, [])
		}
		this.taskTerminals.get(taskId)!.push(terminal)
	}

	static releaseTerminalsForTask(taskId: string) {
		const terminals = this.taskTerminals.get(taskId) || []
		terminals.forEach((t) => t.dispose())
		this.taskTerminals.delete(taskId)
	}
}
```

**File Context Tracking**:

```typescript
// Each task tracks its own file context
class FileContextTracker {
	constructor(
		private provider: ClineProvider,
		private readonly taskId: string, // Scoped to task
	) {}

	// Tracks files opened/modified by THIS task only
	private trackedFiles: Set<string> = new Set()

	trackFile(filePath: string) {
		this.trackedFiles.add(filePath)
	}
}
```

---

### 4. Event System Extension

**Current Events** ([`packages/types/src/events.ts`](packages/types/src/events.ts:1)):

```typescript
export enum RooCodeEventName {
	// Task Events
	TaskCreated = "taskCreated",
	TaskStarted = "taskStarted",
	TaskCompleted = "taskCompleted",
	TaskAborted = "taskAborted",
	TaskFocused = "taskFocused",
	TaskUnfocused = "taskUnfocused",
	TaskActive = "taskActive",
	TaskInteractive = "taskInteractive",
	TaskResumable = "taskResumable",
	TaskIdle = "taskIdle",
	TaskPaused = "taskPaused",
	TaskUnpaused = "taskUnpaused",
	TaskSpawned = "taskSpawned",
	// ... more events
}
```

**Extension for Parallel Execution**:

```typescript
// Add to RooCodeEventName enum
export enum RooCodeEventName {
	// ... existing events

	// NEW: Parallel execution events
	ParallelTaskCreated = "parallelTaskCreated",
	ParallelTaskCompleted = "parallelTaskCompleted",
	ParallelGroupStarted = "parallelGroupStarted",
	ParallelGroupCompleted = "parallelGroupCompleted",
	ParallelGroupPartialResult = "parallelGroupPartialResult",
}

// NEW: Parallel event payloads
export type TaskProviderEvents = {
	// ... existing events

	// NEW
	parallelTaskCreated: [task: TaskLike, groupId?: string]
	parallelTaskCompleted: [result: { taskId: string; tokenUsage: TokenUsage; toolUsage: ToolUsage }]
	parallelGroupStarted: [groupId: string, taskIds: string[]]
	parallelGroupCompleted: [groupId: string, results: Map<string, TaskResult>]
	parallelGroupPartialResult: [groupId: string, taskId: string, result: TaskResult]
}
```

**Integration in ClineProvider**:

```typescript
// Emit parallel events
async spawnParallelTask(...): Promise<Task> {
    const task = new Task({ /* config */ })

    this.parallelTasks.set(task.taskId, task)

    // Emit with group info
    this.emit(RooCodeEventName.ParallelTaskCreated, task, parallelGroupId)

    // Listen for completion
    task.once(RooCodeEventName.TaskCompleted, (taskId, tokenUsage, toolUsage) => {
        this.emit(RooCodeEventName.ParallelTaskCompleted, { taskId, tokenUsage, toolUsage })
    })

    return task
}
```

---

### 5. State Persistence Extension

**Current History Item**:

```typescript
interface HistoryItem {
	id: string
	ts: number
	task: string
	tokensIn: number
	tokensOut: number
	totalCost: number
	mode?: string
	workspace?: string
	number?: number
	rootTaskId?: string // For subtasks
	parentTaskId?: string // For subtasks
}
```

**Extension for Parallel Tasks**:

```typescript
interface HistoryItem {
	// ... existing fields

	// NEW: Parallel execution metadata
	isParallel?: boolean // Flag for parallel execution
	parallelGroupId?: string // Group this task belongs to
	parallelSiblings?: string[] // Other tasks in same group
	parallelCoordinatorId?: string // Task that spawned this group
}

// NEW: Save parallel operation metadata
interface ParallelOperationRecord {
	operationId: string
	coordinatorTaskId: string
	createdAt: number
	completedAt?: number
	strategy: "all" | "race" | "sequential"
	subtasks: Array<{
		taskId: string
		description: string
		mode: string
		status: "completed" | "failed" | "aborted"
		result?: string
	}>
}
```

**Persistence Location**:

```
{globalStoragePath}/
└── tasks/
    ├── {taskId}/                           # Individual task data
    │   ├── api-conversation-history.json
    │   └── ui-messages.json
    └── parallel-operations/                # NEW: Parallel operation tracking
        └── {operationId}.json
```

---

### 6. Tool Execution in Parallel Context

**No Changes to Core Tool Logic** - Tools execute identically in parallel tasks.

**Integration Pattern**:

```typescript
// From presentAssistantMessage.ts:57
export async function presentAssistantMessage(cline: Task) {
	// Lock prevents concurrent execution within same task
	if (cline.presentAssistantMessageLocked) {
		cline.presentAssistantMessageHasPendingUpdates = true
		return
	}

	cline.presentAssistantMessageLocked = true

	try {
		const block = cline.assistantMessageContent[cline.currentStreamingContentIndex]

		switch (block.type) {
			case "tool_use":
				// Validate tool is allowed for current mode
				validateToolUse(
					block.name,
					cline.taskMode, // Each task has independent mode
					customModes,
					{ apply_diff: cline.diffEnabled },
					block.params,
				)

				// Request approval (task-specific ask)
				const approved = await askApproval("tool", toolJSON)

				// Execute tool (isolated to this task)
				await executeTool(cline, block, pushToolResult)
				break
		}
	} finally {
		cline.presentAssistantMessageLocked = false
	}
}
```

**Key Insight**: Tools execute **within the task's context** - no global state dependencies. This means parallel tasks can execute tools simultaneously without conflicts.

---

### 7. Checkpoint System Integration

**File**: [`src/services/checkpoints/RepoPerTaskCheckpointService.ts`](src/services/checkpoints/RepoPerTaskCheckpointService.ts:1)

**Architecture**: Each task gets isolated Git repository for checkpoints.

```typescript
class RepoPerTaskCheckpointService {
	private taskId: string
	private shadowRepoPath: string // {globalStorage}/shadow-repos/{taskId}

	async initialize() {
		// Create isolated Git repo for this task
		await this.git.init(this.shadowRepoPath, { bare: false })
		await this.git.config("user.name", "Roo Code Checkpoint")
		await this.git.config("user.email", "checkpoint@roocode.com")
	}

	async saveCheckpoint(force: boolean = false): Promise<string | null> {
		// Copy workspace files to shadow repo
		await this.syncWorkspaceToShadow()

		// Create commit
		await this.git.add(".")
		const hash = await this.git.commit(`Checkpoint ${Date.now()}`)

		return hash
	}

	async restoreCheckpoint(hash: string) {
		// Reset shadow repo to checkpoint
		await this.git.checkout(hash, ["--force"])

		// Copy shadow repo back to workspace
		await this.syncShadowToWorkspace()
	}
}
```

**Parallel Safety**: Each task has completely isolated shadow repository - no conflicts possible.

**Integration Point**:

```typescript
// From Task.ts
import { getCheckpointService, checkpointSave, checkpointRestore } from "../checkpoints"

// Initialize in background (doesn't block)
private async initiateTaskLoop(userContent) {
    getCheckpointService(this)  // Async initialization

    while (!this.abort) {
        await this.recursivelyMakeClineRequests(userContent)
    }
}

// Save checkpoint before file modifications
async function checkpointSaveAndMark(task: Task) {
    if (task.currentStreamingDidCheckpoint) return

    await task.checkpointSave(true)  // force=true
    task.currentStreamingDidCheckpoint = true
}
```

---

## Advanced Integration Patterns

### Pattern 1: Coordinated Parallel Execution

```typescript
/**
 * Example: Orchestrator mode coordinating multiple research tasks
 */
async function coordinatedResearchExecution(provider: ClineProvider, researchTopics: string[]) {
	const groupId = crypto.randomUUID()
	const tasks = researchTopics.map((topic) => ({
		text: `Research: ${topic}`,
		mode: "deep-research-agent", // Specialized mode
	}))

	// Spawn all tasks in parallel
	const results = await provider.executeParallelTasks(tasks, "all")

	// Aggregate results in coordinator task
	const aggregated = Array.from(results.values())
		.map((result) => {
			const completionMessage = result.messages.find((m) => m.ask === "completion_result")
			return completionMessage?.text || "No result"
		})
		.join("\n\n---\n\n")

	return aggregated
}
```

### Pattern 2: Race Condition Execution

```typescript
/**
 * Example: Try multiple approaches and use first success
 */
async function raceToSolution(provider: ClineProvider, problem: string) {
	const approaches = [
		{ text: `Solve using brute force: ${problem}`, mode: "code" },
		{ text: `Solve using optimization: ${problem}`, mode: "code" },
		{ text: `Solve using heuristics: ${problem}`, mode: "code" },
	]

	const groupId = crypto.randomUUID()

	// Spawn all approaches
	for (const approach of approaches) {
		await provider.spawnParallelTask(approach.text, undefined, groupId, { mode: approach.mode })
	}

	// Wait for first success
	const winnerTaskId = await provider.waitForFirstCompletion(groupId)
	const winnerTask = provider.parallelTasks.get(winnerTaskId)

	// Abort remaining tasks
	await provider.abortParallelGroup(groupId, winnerTaskId)

	return winnerTask
}
```

### Pattern 3: Fan-Out/Fan-In Processing

```typescript
/**
 * Example: Process multiple files in parallel, aggregate results
 */
async function processFilesInParallel(provider: ClineProvider, files: string[]) {
	const groupId = crypto.randomUUID()

	// Fan-out: Create task per file
	const tasks = files.map((file) => ({
		text: `Process file: ${file}`,
		mode: "code",
	}))

	const spawnedTasks = []
	for (const task of tasks) {
		const spawned = await provider.spawnParallelTask(task.text, undefined, groupId, { mode: task.mode })
		spawnedTasks.push(spawned)
	}

	// Fan-in: Collect all results
	const results = await provider.waitForParallelGroup(groupId)

	// Synthesize results
	const synthesis = synthesizeResults(results)

	return synthesis
}

function synthesizeResults(results: Map<string, ClineMessage[]>): string {
	const summaries = []

	for (const [taskId, messages] of results) {
		const completion = messages.find((m) => m.ask === "completion_result")
		if (completion) {
			summaries.push(completion.text)
		}
	}

	return summaries.join("\n\n")
}
```

---

## Implementation Checklist

### Phase 1: Core Infrastructure

- [ ] Add `parallelTasks: Map<string, Task>` to [`ClineProvider`](src/core/webview/ClineProvider.ts:118)
- [ ] Add `parallelTaskGroups: Map<string, Set<string>>` to ClineProvider
- [ ] Implement [`spawnParallelTask()`](src/core/webview/ClineProvider.ts:2519) method
- [ ] Implement [`waitForParallelGroup()`](#spawning-agent-instances) method
- [ ] Implement [`getTaskById()`](#message-routing-to-specific-tasks) method
- [ ] Add parallel task cleanup to [`dispose()`](src/core/webview/ClineProvider.ts:573)

### Phase 2: Message Routing

- [ ] Extend [`WebviewMessage`](src/shared/WebviewMessage.ts:1) types with `taskId` field
- [ ] Update [`webviewMessageHandler`](src/core/webview/webviewMessageHandler.ts:64) for task-specific routing
- [ ] Modify [`postStateToWebview()`](src/core/webview/ClineProvider.ts:1617) to include parallel tasks
- [ ] Add parallel operation tracking to state

### Phase 3: Event System

- [ ] Add parallel execution events to [`RooCodeEventName`](packages/types/src/events.ts:1)
- [ ] Update [`TaskProviderEvents`](packages/types/src/task.ts:1) type
- [ ] Implement event handlers in ClineProvider
- [ ] Update BridgeOrchestrator to sync parallel tasks

### Phase 4: UI Integration

- [ ] Design multi-task display component
- [ ] Implement task switcher UI
- [ ] Add parallel operation progress indicators
- [ ] Create result aggregation views

### Phase 5: Testing & Validation

- [ ] Unit tests for parallel task spawning
- [ ] Integration tests for coordinated execution
- [ ] Race condition tests
- [ ] Resource cleanup tests
- [ ] UI state management tests

---

## Critical Integration Rules

### DO's ✅

1. **Use Existing Task Constructor**:

    ```typescript
    const task = new Task({ provider, apiConfiguration, task, ... })
    // Don't create custom task classes - extend Task if needed
    ```

2. **Preserve Event Flow**:

    ```typescript
    task.on(RooCodeEventName.TaskCompleted, handler)
    // Always use typed events from @roo-code/types
    ```

3. **Respect Workspace Isolation**:

    ```typescript
    // Each task has its own workspacePath
    const task = new Task({ ..., workspacePath: "/specific/path" })
    ```

4. **Use WeakRef Pattern**:

    ```typescript
    class Task {
    	providerRef: WeakRef<ClineProvider> // Prevents memory leaks
    }
    ```

5. **Subscribe to BridgeOrchestrator**:
    ```typescript
    if (task.enableBridge) {
    	await BridgeOrchestrator.subscribeToTask(task)
    }
    ```

### DON'Ts ❌

1. **Don't Share State Between Tasks**:

    ```typescript
    // ❌ BAD: Shared mutable state
    static currentFile: string

    // ✅ GOOD: Task-scoped state
    class Task {
        private currentFile: string
    }
    ```

2. **Don't Modify Task Stack for Parallel Execution**:

    ```typescript
    // ❌ BAD: Adding parallel tasks to stack
    this.clineStack.push(parallelTask)

    // ✅ GOOD: Separate collection
    this.parallelTasks.set(taskId, task)
    ```

3. **Don't Skip Event Emission**:

    ```typescript
    // ❌ BAD: Direct state mutation
    task.isPaused = true

    // ✅ GOOD: Emit events
    task.isPaused = true
    this.emit(RooCodeEventName.TaskPaused, task.taskId)
    ```

4. **Don't Bypass Message Persistence**:

    ```typescript
    // ❌ BAD: In-memory only
    this.messages.push(newMessage)

    // ✅ GOOD: Persist to disk
    await this.addToClineMessages(newMessage) // Calls saveTaskMessages
    ```

5. **Don't Ignore Abort Flags**:
    ```typescript
    // ✅ GOOD: Check abort frequently
    async longRunningOperation() {
        if (this.abort) throw new Error("Task aborted")

        await step1()

        if (this.abort) throw new Error("Task aborted")

        await step2()
    }
    ```

---

## Testing Integration Points

### Unit Test Example: Parallel Task Spawning

```typescript
import { ClineProvider } from "../src/core/webview/ClineProvider"
import { describe, it, expect, beforeEach, afterEach } from "vitest"

describe("ClineProvider - Parallel Task Spawning", () => {
	let provider: ClineProvider

	beforeEach(async () => {
		provider = createTestProvider()
	})

	afterEach(async () => {
		await provider.dispose()
	})

	it("should spawn multiple tasks in parallel", async () => {
		const groupId = "test-group"

		const task1 = await provider.spawnParallelTask("Task 1", undefined, groupId)
		const task2 = await provider.spawnParallelTask("Task 2", undefined, groupId)

		expect(provider.parallelTasks.size).toBe(2)
		expect(provider.parallelTaskGroups.get(groupId)?.size).toBe(2)

		expect(task1.taskId).not.toBe(task2.taskId)
		expect(task1.parentTask).toBeUndefined() // No parent for parallel
		expect(task2.parentTask).toBeUndefined()
	})

	it("should wait for all tasks to complete", async () => {
		const groupId = "test-group"

		const task1 = await provider.spawnParallelTask("Quick task", undefined, groupId)
		const task2 = await provider.spawnParallelTask("Slow task", undefined, groupId)

		// Simulate completions
		setTimeout(() => task1.emit(RooCodeEventName.TaskCompleted, task1.taskId, {}, {}), 100)
		setTimeout(() => task2.emit(RooCodeEventName.TaskCompleted, task2.taskId, {}, {}), 200)

		const results = await provider.waitForParallelGroup(groupId)

		expect(results.size).toBe(2)
		expect(provider.parallelTasks.size).toBe(0) // Cleaned up
	})

	it("should isolate workspace context per task", async () => {
		const task1 = await provider.spawnParallelTask("Task 1")
		const task2 = await provider.spawnParallelTask("Task 2")

		// Each has isolated file tracking
		task1.fileContextTracker.trackFile("file1.ts")
		task2.fileContextTracker.trackFile("file2.ts")

		expect(task1.fileContextTracker.trackedFiles).not.toEqual(task2.fileContextTracker.trackedFiles)
	})
})
```

### Integration Test Example: BridgeOrchestrator Sync

```typescript
describe("BridgeOrchestrator - Parallel Task Sync", () => {
	it("should subscribe multiple tasks independently", async () => {
		const bridge = BridgeOrchestrator.getInstance()

		const task1 = createMockTask("task-1")
		const task2 = createMockTask("task-2")

		await bridge.subscribeToTask(task1)
		await bridge.subscribeToTask(task2)

		// Both should be tracked independently
		expect(bridge.taskChannel.subscribedTasks.size).toBe(2)
	})

	it("should route messages to correct task", async () => {
		const task1 = createMockTask("task-1")
		const task2 = createMockTask("task-2")

		await bridge.subscribeToTask(task1)
		await bridge.subscribeToTask(task2)

		// Simulate remote message for task2
		const command: TaskBridgeCommand = {
			type: TaskBridgeCommandName.Message,
			taskId: "task-2",
			payload: { text: "Hello task 2" },
		}

		const task1Spy = vi.spyOn(task1, "submitUserMessage")
		const task2Spy = vi.spyOn(task2, "submitUserMessage")

		await bridge.taskChannel.handleCommand(command)

		expect(task1Spy).not.toHaveBeenCalled()
		expect(task2Spy).toHaveBeenCalledWith("Hello task 2")
	})
})
```

---

## Performance Considerations

### Resource Limits

**Current Rate Limiting** (Global across all tasks):

```typescript
// From Task.ts:2651
private static lastGlobalApiRequestTime?: number

if (Task.lastGlobalApiRequestTime) {
    const timeSinceLastRequest = now - Task.lastGlobalApiRequestTime
    const rateLimit = apiConfiguration?.rateLimitSeconds || 0
    rateLimitDelay = Math.max(0, rateLimit * 1000 - timeSinceLastRequest)
}

// Update before each request
Task.lastGlobalApiRequestTime = performance.now()
```

**Extension for Parallel Tasks**:

```typescript
// Option 1: Shared rate limit across parallel tasks (current behavior)
// - Good for respecting API provider rate limits
// - Bad for maximizing parallelism

// Option 2: Per-task rate limiting
class Task {
	private lastApiRequestTime?: number // Instance-level

	async attemptApiRequest() {
		if (this.lastApiRequestTime) {
			const delay = this.calculateDelay(this.lastApiRequestTime)
			await this.rateLimitDelay(delay)
		}

		this.lastApiRequestTime = performance.now()
		// ... make request
	}
}

// Option 3: Token bucket algorithm for parallel tasks
class ParallelRateLimiter {
	private tokens: number = 10
	private maxTokens: number = 10
	private refillRate: number = 1 // tokens per second
	private lastRefill: number = Date.now()

	async acquireToken(): Promise<void> {
		await this.refillTokens()

		while (this.tokens < 1) {
			await delay(100)
			await this.refillTokens()
		}

		this.tokens--
	}

	private async refillTokens() {
		const now = Date.now()
		const elapsed = (now - this.lastRefill) / 1000
		this.tokens = Math.min(this.maxTokens, this.tokens + elapsed * this.refillRate)
		this.lastRefill = now
	}
}
```

### Memory Management

**Recommended Limits**:

```typescript
class ClineProvider {
    private static readonly MAX_PARALLEL_TASKS = 10
    private static readonly MAX_TASK_HISTORY = 1000

    async spawnParallelTask(...): Promise<Task> {
        if (this.parallelTasks.size >= ClineProvider.MAX_PARALLEL_TASKS) {
            throw new Error(`Maximum parallel tasks (${ClineProvider.MAX_PARALLEL_TASKS}) reached`)
        }

        // ... spawn task
    }

    // Periodic cleanup of completed tasks
    private async cleanupCompletedParallelTasks() {
        const completed = Array.from(this.parallelTasks.values())
            .filter(t => t.taskStatus === TaskStatus.Idle || t.abort)

        for (const task of completed) {
            await task.dispose()
            this.parallelTasks.delete(task.taskId)
        }
    }
}
```

### Token Usage Tracking

```typescript
// Aggregate token usage across parallel tasks
function aggregateTokenUsage(results: Map<string, TaskResult>): TokenUsage {
	let totalTokensIn = 0
	let totalTokensOut = 0
	let totalCacheWrites = 0
	let totalCacheReads = 0
	let totalCost = 0

	for (const result of results.values()) {
		totalTokensIn += result.tokenUsage.totalTokensIn || 0
		totalTokensOut += result.tokenUsage.totalTokensOut || 0
		totalCacheWrites += result.tokenUsage.totalCacheWrites || 0
		totalCacheReads += result.tokenUsage.totalCacheReads || 0
		totalCost += result.tokenUsage.totalCost || 0
	}

	return {
		totalTokensIn,
		totalTokensOut,
		totalCacheWrites,
		totalCacheReads,
		totalCost,
	}
}
```

---

## Migration Path

### Step 1: Add Parallel Infrastructure (Non-Breaking)

1. Add parallel task collections to ClineProvider
2. Implement `spawnParallelTask()` and `waitForParallelGroup()`
3. Add `getTaskById()` helper
4. Extend state types (backward compatible)

**No Changes to**:

- Existing `createTask()` behavior
- Task execution logic
- Tool execution pipeline
- Message persistence

### Step 2: Enable Parallel Mode Features

1. Add `new_parallel_task` tool to orchestrator mode
2. Implement parallel execution in orchestrator tool handler
3. Add UI for viewing parallel tasks
4. Extend BridgeOrchestrator state

### Step 3: Optimize and Scale

1. Implement token bucket rate limiter
2. Add parallel task result caching
3. Optimize state broadcasting for parallel updates
4. Add telemetry for parallel execution patterns

---

## API Reference

### ClineProvider API

**Core Task Methods**:

```typescript
interface ClineProvider {
    // Task Stack (Sequential)
    getCurrentTask(): Task | undefined
    createTask(text?: string, images?: string[], parentTask?: Task): Promise<Task>
    cancelTask(): Promise<void>
    clearTask(): Promise<void>

    // NEW: Parallel Execution
    spawnParallelTask(text: string, images?: string[], groupId?: string, options?: CreateTaskOptions): Promise<Task>
    waitForParallelGroup(groupId: string, timeoutMs?: number): Promise<Map<string, ClineMessage[]>>
    getTaskById(taskId: string): Task | undefined
    abortParallelGroup(groupId: string, excludeTaskId?: string): Promise<void>

    // State Management
    getState(): Promise<ExtensionState>
    postStateToWebview(): Promise<void>
    postMessageToWebview(message: ExtensionMessage): Promise<void>

    // Mode Management
    handleModeSwitch(newMode: Mode): Promise<void>

    // History
    updateTaskHistory(item: HistoryItem): Promise<HistoryItem[]>
    getTaskWithId(id: string): Promise<{ historyItem: HistoryItem; ... }>
}
```

### Task API

```typescript
interface Task extends EventEmitter<TaskEvents> {
	// Identity
	readonly taskId: string
	readonly instanceId: string
	readonly taskNumber: number
	readonly workspacePath: string

	// Hierarchy
	readonly rootTask?: Task
	readonly parentTask?: Task
	childTaskId?: string

	// State
	taskStatus: TaskStatus
	taskMode: string
	abort: boolean
	isPaused: boolean

	// Lifecycle
	waitForModeInitialization(): Promise<void>
	submitUserMessage(text: string, images?: string[], mode?: string, providerProfile?: string): Promise<void>
	approveAsk(options?: { text?: string; images?: string[] }): void
	denyAsk(options?: { text?: string; images?: string[] }): void
	abortTask(isAbandoned?: boolean): Promise<void>
	dispose(): void

	// Subtasks (Sequential)
	startSubtask(message: string, initialTodos: TodoItem[], mode: string): Promise<Task>
	waitForSubtask(): Promise<void>
	completeSubtask(lastMessage: string): Promise<void>

	// Metrics
	getTokenUsage(): TokenUsage
	recordToolUsage(toolName: ToolName): void
	recordToolError(toolName: ToolName, error?: string): void
}
```

---

## Conclusion

The Roo Code architecture provides **excellent integration points** for Touch and Go parallel execution:

✅ **Clean Task Abstraction**: Task instances are self-contained and can run independently  
✅ **Event-Driven Design**: Loose coupling enables parallel coordination without tight dependencies  
✅ **Workspace Isolation**: Each task has isolated file tracking, terminals, and browsers  
✅ **Bridge-Ready**: BridgeOrchestrator already supports multiple task subscriptions  
✅ **Minimal Core Changes**: Extensions needed only in ClineProvider orchestration layer

The implementation path is **low-risk** with **high reward**: add parallel task pool management in ClineProvider while reusing all existing Task execution logic unchanged.

**Next Steps**:

1. Implement parallel task pool in ClineProvider (Phase 1)
2. Add orchestrator mode with `new_parallel_task` tool (Phase 2)
3. Create multi-task UI components (Phase 4)
4. Test and iterate (Phase 5)
