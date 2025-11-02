/**
 * Touch and Go Parallel Execution Framework
 *
 * Provides parallel agent execution capabilities for Roo Code,
 * enabling 2-50 concurrent workers coordinated by an Orchestrator agent.
 *
 * @module core/parallel
 */

// Core Components
export { ParallelInstanceManager } from "./ParallelInstanceManager"
export type { ParallelInstanceConfig, WorkerInstance } from "./ParallelInstanceManager"

export { IPCChannel } from "./IPCChannel"
export type { IPCMessageType, IPCMessage, IPCChannelConfig } from "./IPCChannel"

export {
	OrchestrationScheduler,
	TaskGraph,
	MaxParallelStrategy,
	RateAwareStrategy,
	CriticalPathStrategy,
} from "./OrchestrationScheduler"
export type {
	TaskNode,
	TaskWithDependencies,
	SchedulingStrategy,
	SchedulingStrategyType,
	SchedulerOptions,
} from "./OrchestrationScheduler"

export { WorkspaceAnalyzer } from "./WorkspaceAnalyzer"
export type { WorkspaceConflict, WorkspaceValidation, WorkspaceAnalyzerConfig } from "./WorkspaceAnalyzer"

export { ReviewCoordinator } from "./ReviewCoordinator"
export type { ReviewRequest, ReviewResponse } from "./ReviewCoordinator"

export { RateLimiter } from "./RateLimiter"
export type { RateLimitConfig, RateLimiterEvents } from "./RateLimiter"

/**
 * Touch and Go Version
 */
export const TOUCH_AND_GO_VERSION = "0.1.0-alpha"

/**
 * Feature flags for gradual rollout
 */
export const FeatureFlags = {
	/** Enable parallel execution (Phase 1+) */
	ENABLE_PARALLEL_EXECUTION: false,

	/** Enable IPC channel (Phase 1+) */
	ENABLE_IPC: false,

	/** Enable orchestration scheduling (Phase 2+) */
	ENABLE_ORCHESTRATION: false,

	/** Enable workspace conflict detection (Phase 2+) */
	ENABLE_WORKSPACE_VALIDATION: false,

	/** Enable async code review (Phase 3+) */
	ENABLE_ASYNC_REVIEW: false,

	/** Maximum parallel workers allowed */
	MAX_PARALLEL_WORKERS: 5,
} as const
