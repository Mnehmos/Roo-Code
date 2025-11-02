/**
 * WorkspaceAnalyzer
 *
 * Analyzes task working directory assignments to prevent file conflicts.
 * Ensures workspace isolation for parallel task execution.
 *
 * @module core/parallel
 */

import type { TaskNode } from "./OrchestrationScheduler"

/**
 * Workspace conflict detection result
 */
export interface WorkspaceConflict {
	/** Task IDs involved in conflict */
	taskIds: [string, string]

	/** Overlapping file path or pattern */
	conflictPath: string

	/** Conflict severity */
	severity: "error" | "warning"

	/** Human-readable description */
	description: string
}

/**
 * Workspace validation result
 */
export interface WorkspaceValidation {
	/** Whether assignments are valid (no conflicts) */
	isValid: boolean

	/** Detected conflicts */
	conflicts: WorkspaceConflict[]

	/** Task working directory assignments */
	assignments: Map<string, string>
}

/**
 * Workspace analyzer configuration
 */
export interface WorkspaceAnalyzerConfig {
	/** Enable strict validation (fail on warnings) */
	strictMode: boolean

	/** Allow nested directory assignments */
	allowNestedDirs: boolean

	/** Wildcard pattern support */
	supportWildcards: boolean
}

/**
 * Validates workspace isolation for parallel task execution
 *
 * Key Responsibilities:
 * - Analyze task working directory assignments
 * - Detect overlapping file paths between tasks
 * - Validate no two tasks can modify the same files
 * - Support wildcard patterns (*.ts, src/ ** /*)
 * - Handle nested directory assignments
 * - Prevent race conditions on shared resources
 *
 * Design Principles:
 * - Validates before spawning workers (fail-fast)
 * - Integrates with OrchestrationScheduler
 * - Supports both exact paths and patterns
 * - Conservative conflict detection (prefer false positives)
 *
 * Validation Rules:
 * 1. Two tasks cannot share exact working directory
 * 2. Parent directory and subdirectory are conflicts (unless explicitly allowed)
 * 3. Overlapping wildcards are conflicts (*.ts and *.tsx in same dir)
 * 4. Shared files must be read-only or have explicit coordination
 *
 * @example
 * ```typescript
 * const analyzer = new WorkspaceAnalyzer({
 *   strictMode: true,
 *   allowNestedDirs: false
 * });
 *
 * const validation = analyzer.validateAssignments([
 *   { id: 'task-1', workspacePath: './src/auth', ... },
 *   { id: 'task-2', workspacePath: './src/api', ... },
 *   { id: 'task-3', workspacePath: './src', ... }  // CONFLICT!
 * ]);
 *
 * if (!validation.isValid) {
 *   console.error('Conflicts:', validation.conflicts);
 * }
 * ```
 */
export class WorkspaceAnalyzer {
	private config: WorkspaceAnalyzerConfig

	constructor(config: Partial<WorkspaceAnalyzerConfig> = {}) {
		this.config = {
			strictMode: config.strictMode ?? true,
			allowNestedDirs: config.allowNestedDirs ?? false,
			supportWildcards: config.supportWildcards ?? true,
		}
	}

	/**
	 * Validate task working directory assignments
	 *
	 * @param tasks - Array of task nodes with working directories
	 * @returns Validation result with any detected conflicts
	 */
	validateAssignments(tasks: TaskNode[]): WorkspaceValidation {
		const conflicts: WorkspaceConflict[] = []
		const assignments = new Map<string, string>()

		// Build assignments map
		for (const task of tasks) {
			if (task.workspacePath !== undefined && task.workspacePath !== null) {
				assignments.set(task.id, task.workspacePath)
			}
		}

		// Check each pair of tasks for conflicts
		for (let i = 0; i < tasks.length; i++) {
			for (let j = i + 1; j < tasks.length; j++) {
				const task1 = tasks[i]
				const task2 = tasks[j]

				// Skip if either task has no workspace path (but allow empty strings - they normalize to "/")
				if (
					task1.workspacePath === undefined ||
					task1.workspacePath === null ||
					task2.workspacePath === undefined ||
					task2.workspacePath === null
				) {
					continue
				}

				const conflict = this.checkConflict(task1, task2)
				if (conflict) {
					conflicts.push(conflict)
				}
			}
		}

		// Determine if validation passes
		const isValid = this.config.strictMode
			? conflicts.length === 0
			: conflicts.filter((c) => c.severity === "error").length === 0

		return {
			isValid,
			conflicts,
			assignments,
		}
	}

	/**
	 * Check if two tasks have conflicting workspace assignments
	 *
	 * @param task1 - First task
	 * @param task2 - Second task
	 * @returns Conflict details if conflict exists, undefined otherwise
	 */
	private checkConflict(task1: TaskNode, task2: TaskNode): WorkspaceConflict | undefined {
		// Allow empty strings through (they normalize to "/")
		if (
			task1.workspacePath === undefined ||
			task1.workspacePath === null ||
			task2.workspacePath === undefined ||
			task2.workspacePath === null
		) {
			return undefined
		}

		const path1 = this.normalizePath(task1.workspacePath)
		const path2 = this.normalizePath(task2.workspacePath)

		// Check for conflicts
		if (this.pathsConflict(path1, path2)) {
			const reason = this.getConflictReason(path1, path2)

			return {
				taskIds: [task1.id, task2.id],
				conflictPath: path1 === path2 ? path1 : `${path1} / ${path2}`,
				severity: "error",
				description: reason,
			}
		}

		return undefined
	}

	/**
	 * Check if two paths conflict
	 *
	 * @param path1 - First normalized path
	 * @param path2 - Second normalized path
	 * @returns True if paths conflict
	 */
	private pathsConflict(path1: string, path2: string): boolean {
		// Identical paths always conflict
		if (path1 === path2) {
			return true
		}

		// Check for parent/child relationships (unless allowed)
		if (!this.config.allowNestedDirs) {
			// Special case: root directory "/" conflicts with everything
			if (path1 === "/" || path2 === "/") {
				return true
			}

			// Check if one path is nested under the other
			if (path1.startsWith(path2 + "/") || path2.startsWith(path1 + "/")) {
				return true
			}
		}

		// Check wildcard conflicts if supported
		if (this.config.supportWildcards) {
			if (this.wildcardConflict(path1, path2)) {
				return true
			}
		}

		return false
	}

	/**
	 * Check if wildcard patterns conflict
	 *
	 * @param path1 - First path (may contain wildcards)
	 * @param path2 - Second path (may contain wildcards)
	 * @returns True if patterns overlap
	 */
	private wildcardConflict(path1: string, path2: string): boolean {
		const hasWildcard1 = path1.includes("*")
		const hasWildcard2 = path2.includes("*")

		// If neither has wildcards, no wildcard conflict
		if (!hasWildcard1 && !hasWildcard2) {
			return false
		}

		// Convert wildcard pattern to regex
		const toRegex = (pattern: string): RegExp => {
			// Escape special regex characters except * and **
			let escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&")

			// Replace ** with .* (matches any characters including /)
			escaped = escaped.replace(/\*\*/g, "|||DOUBLE_STAR|||")

			// Replace * with [^/]* (matches any characters except /)
			escaped = escaped.replace(/\*/g, "[^/]*")

			// Restore ** as .*
			escaped = escaped.replace(/\|\|\|DOUBLE_STAR\|\|\|/g, ".*")

			return new RegExp("^" + escaped + "$")
		}

		// Test if path1 pattern matches path2
		if (hasWildcard1) {
			const regex1 = toRegex(path1)
			if (regex1.test(path2)) {
				return true
			}
		}

		// Test if path2 pattern matches path1
		if (hasWildcard2) {
			const regex2 = toRegex(path2)
			if (regex2.test(path1)) {
				return true
			}
		}

		// Check if both are wildcards in same/overlapping directories
		if (hasWildcard1 && hasWildcard2) {
			// Extract base paths (before wildcards)
			const base1 = path1.split("*")[0]
			const base2 = path2.split("*")[0]

			// If base paths overlap, wildcards may conflict
			if (base1.startsWith(base2) || base2.startsWith(base1)) {
				return true
			}
		}

		return false
	}

	/**
	 * Normalize path for comparison
	 *
	 * Handles:
	 * - Windows vs Unix path separators
	 * - Trailing slashes
	 * - Case sensitivity (Windows is case-insensitive)
	 * - Leading slash normalization
	 *
	 * @param path - Path to normalize
	 * @returns Normalized path
	 */
	private normalizePath(path: string): string {
		if (!path) {
			return "/"
		}

		// Convert Windows backslashes to forward slashes
		let normalized = path.replace(/\\/g, "/")

		// Remove trailing slashes (but keep single '/')
		if (normalized.length > 1) {
			normalized = normalized.replace(/\/+$/, "")
		}

		// Ensure leading slash
		if (!normalized.startsWith("/")) {
			normalized = "/" + normalized
		}

		// Handle case sensitivity based on platform
		// Windows is case-insensitive, Unix is case-sensitive
		if (process.platform === "win32") {
			normalized = normalized.toLowerCase()
		}

		// Normalize multiple consecutive slashes
		normalized = normalized.replace(/\/+/g, "/")

		return normalized
	}

	/**
	 * Get human-readable conflict reason
	 *
	 * @param path1 - First normalized path
	 * @param path2 - Second normalized path
	 * @returns Description of why paths conflict
	 */
	private getConflictReason(path1: string, path2: string): string {
		if (path1 === path2) {
			return `Identical paths: both tasks assigned to "${path1}"`
		}

		if (path1.startsWith(path2 + "/")) {
			return `"${path1}" is nested under "${path2}"`
		}

		if (path2.startsWith(path1 + "/")) {
			return `"${path2}" is nested under "${path1}"`
		}

		if (path1.includes("*") || path2.includes("*")) {
			return `Overlapping wildcard patterns: "${path1}" and "${path2}"`
		}

		return "Paths conflict"
	}

	/**
	 * Suggest non-conflicting workspace assignments
	 *
	 * @param tasks - Tasks needing assignments
	 * @returns Suggested working directory map
	 */
	suggestAssignments(tasks: Omit<TaskNode, "workspacePath">[]): Map<string, string> {
		const suggestions = new Map<string, string>()

		// Simple strategy: assign each task to a unique numbered subdirectory
		for (let i = 0; i < tasks.length; i++) {
			const task = tasks[i]
			suggestions.set(task.id, `/worker-${i + 1}`)
		}

		return suggestions
	}

	/**
	 * Dispose of analyzer resources
	 */
	dispose(): void {
		// No resources to clean up
	}
}
