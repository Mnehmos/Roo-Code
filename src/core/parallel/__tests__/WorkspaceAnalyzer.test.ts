/**
 * WorkspaceAnalyzer Tests
 *
 * Tests workspace conflict detection for parallel task execution.
 */

import { describe, it, expect, beforeEach } from "vitest"
import { WorkspaceAnalyzer } from "../WorkspaceAnalyzer"
import type { TaskNode } from "../OrchestrationScheduler"

describe("WorkspaceAnalyzer", () => {
	let analyzer: WorkspaceAnalyzer

	beforeEach(() => {
		analyzer = new WorkspaceAnalyzer()
	})

	describe("Path Normalization", () => {
		it("normalizes Windows backslashes to forward slashes", () => {
			const tasks: TaskNode[] = [
				{
					id: "A",
					dependencies: new Set(),
					dependents: new Set(),
					completed: false,
					instructions: "test",
					workspacePath: "C:\\Users\\project\\auth",
				},
				{
					id: "B",
					dependencies: new Set(),
					dependents: new Set(),
					completed: false,
					instructions: "test",
					workspacePath: "C:/Users/project/billing",
				},
			]

			const result = analyzer.validateAssignments(tasks)
			expect(result.isValid).toBe(true)
			expect(result.conflicts).toHaveLength(0)
		})

		it("handles trailing slashes correctly", () => {
			const tasks: TaskNode[] = [
				{
					id: "A",
					dependencies: new Set(),
					dependents: new Set(),
					completed: false,
					instructions: "test",
					workspacePath: "/auth/",
				},
				{
					id: "B",
					dependencies: new Set(),
					dependents: new Set(),
					completed: false,
					instructions: "test",
					workspacePath: "/auth",
				},
			]

			const result = analyzer.validateAssignments(tasks)
			// Should detect as identical after normalization
			expect(result.isValid).toBe(false)
			expect(result.conflicts).toHaveLength(1)
			expect(result.conflicts[0].description).toContain("Identical")
		})

		it("handles case sensitivity based on platform", () => {
			const tasks: TaskNode[] = [
				{
					id: "A",
					dependencies: new Set(),
					dependents: new Set(),
					completed: false,
					instructions: "test",
					workspacePath: "/Auth",
				},
				{
					id: "B",
					dependencies: new Set(),
					dependents: new Set(),
					completed: false,
					instructions: "test",
					workspacePath: "/auth",
				},
			]

			const result = analyzer.validateAssignments(tasks)

			// On Windows: conflict (case-insensitive)
			// On Unix: no conflict (case-sensitive)
			if (process.platform === "win32") {
				expect(result.isValid).toBe(false)
				expect(result.conflicts).toHaveLength(1)
			} else {
				expect(result.isValid).toBe(true)
				expect(result.conflicts).toHaveLength(0)
			}
		})

		it("adds leading slash if missing", () => {
			const tasks: TaskNode[] = [
				{
					id: "A",
					dependencies: new Set(),
					dependents: new Set(),
					completed: false,
					instructions: "test",
					workspacePath: "auth",
				},
				{
					id: "B",
					dependencies: new Set(),
					dependents: new Set(),
					completed: false,
					instructions: "test",
					workspacePath: "/billing",
				},
			]

			const result = analyzer.validateAssignments(tasks)
			expect(result.isValid).toBe(true)
		})

		it("normalizes multiple consecutive slashes", () => {
			const tasks: TaskNode[] = [
				{
					id: "A",
					dependencies: new Set(),
					dependents: new Set(),
					completed: false,
					instructions: "test",
					workspacePath: "/auth//data",
				},
				{
					id: "B",
					dependencies: new Set(),
					dependents: new Set(),
					completed: false,
					instructions: "test",
					workspacePath: "/auth/data",
				},
			]

			const result = analyzer.validateAssignments(tasks)
			// Should detect as identical after normalization
			expect(result.isValid).toBe(false)
			expect(result.conflicts).toHaveLength(1)
		})
	})

	describe("Conflict Detection", () => {
		it("detects identical paths", () => {
			const tasks: TaskNode[] = [
				{
					id: "A",
					dependencies: new Set(),
					dependents: new Set(),
					completed: false,
					instructions: "test",
					workspacePath: "/auth",
				},
				{
					id: "B",
					dependencies: new Set(),
					dependents: new Set(),
					completed: false,
					instructions: "test",
					workspacePath: "/auth",
				},
			]

			const result = analyzer.validateAssignments(tasks)
			expect(result.isValid).toBe(false)
			expect(result.conflicts).toHaveLength(1)
			expect(result.conflicts[0].taskIds).toEqual(["A", "B"])
			expect(result.conflicts[0].description).toContain("Identical")
		})

		it("detects nested paths (child under parent)", () => {
			const tasks: TaskNode[] = [
				{
					id: "A",
					dependencies: new Set(),
					dependents: new Set(),
					completed: false,
					instructions: "test",
					workspacePath: "/auth",
				},
				{
					id: "B",
					dependencies: new Set(),
					dependents: new Set(),
					completed: false,
					instructions: "test",
					workspacePath: "/auth/login",
				},
			]

			const result = analyzer.validateAssignments(tasks)
			expect(result.isValid).toBe(false)
			expect(result.conflicts).toHaveLength(1)
			expect(result.conflicts[0].description).toContain("nested")
		})

		it("detects nested paths (parent contains child)", () => {
			const tasks: TaskNode[] = [
				{
					id: "A",
					dependencies: new Set(),
					dependents: new Set(),
					completed: false,
					instructions: "test",
					workspacePath: "/src/components/Button",
				},
				{
					id: "B",
					dependencies: new Set(),
					dependents: new Set(),
					completed: false,
					instructions: "test",
					workspacePath: "/src",
				},
			]

			const result = analyzer.validateAssignments(tasks)
			expect(result.isValid).toBe(false)
			expect(result.conflicts).toHaveLength(1)
			expect(result.conflicts[0].description).toContain("nested")
		})

		it("allows sibling directories", () => {
			const tasks: TaskNode[] = [
				{
					id: "A",
					dependencies: new Set(),
					dependents: new Set(),
					completed: false,
					instructions: "test",
					workspacePath: "/auth",
				},
				{
					id: "B",
					dependencies: new Set(),
					dependents: new Set(),
					completed: false,
					instructions: "test",
					workspacePath: "/billing",
				},
				{
					id: "C",
					dependencies: new Set(),
					dependents: new Set(),
					completed: false,
					instructions: "test",
					workspacePath: "/api",
				},
			]

			const result = analyzer.validateAssignments(tasks)
			expect(result.isValid).toBe(true)
			expect(result.conflicts).toHaveLength(0)
		})

		it("allows nested directories when explicitly configured", () => {
			const analyzerWithNested = new WorkspaceAnalyzer({ allowNestedDirs: true })

			const tasks: TaskNode[] = [
				{
					id: "A",
					dependencies: new Set(),
					dependents: new Set(),
					completed: false,
					instructions: "test",
					workspacePath: "/src",
				},
				{
					id: "B",
					dependencies: new Set(),
					dependents: new Set(),
					completed: false,
					instructions: "test",
					workspacePath: "/src/components",
				},
			]

			const result = analyzerWithNested.validateAssignments(tasks)
			expect(result.isValid).toBe(true)
			expect(result.conflicts).toHaveLength(0)
		})
	})

	describe("Wildcard Support", () => {
		it("detects wildcard conflicts with exact paths", () => {
			const tasks: TaskNode[] = [
				{
					id: "A",
					dependencies: new Set(),
					dependents: new Set(),
					completed: false,
					instructions: "test",
					workspacePath: "/auth/*",
				},
				{
					id: "B",
					dependencies: new Set(),
					dependents: new Set(),
					completed: false,
					instructions: "test",
					workspacePath: "/auth/users",
				},
			]

			const result = analyzer.validateAssignments(tasks)
			expect(result.isValid).toBe(false)
			expect(result.conflicts).toHaveLength(1)
			expect(result.conflicts[0].description).toContain("wildcard")
		})

		it("allows non-overlapping wildcards", () => {
			const tasks: TaskNode[] = [
				{
					id: "A",
					dependencies: new Set(),
					dependents: new Set(),
					completed: false,
					instructions: "test",
					workspacePath: "/auth/*",
				},
				{
					id: "B",
					dependencies: new Set(),
					dependents: new Set(),
					completed: false,
					instructions: "test",
					workspacePath: "/billing/*",
				},
			]

			const result = analyzer.validateAssignments(tasks)
			expect(result.isValid).toBe(true)
			expect(result.conflicts).toHaveLength(0)
		})

		it("detects overlapping wildcard patterns", () => {
			const tasks: TaskNode[] = [
				{
					id: "A",
					dependencies: new Set(),
					dependents: new Set(),
					completed: false,
					instructions: "test",
					workspacePath: "/src/*.ts",
				},
				{
					id: "B",
					dependencies: new Set(),
					dependents: new Set(),
					completed: false,
					instructions: "test",
					workspacePath: "/src/*.tsx",
				},
			]

			const result = analyzer.validateAssignments(tasks)
			// Wildcards in same directory may conflict
			expect(result.isValid).toBe(false)
			expect(result.conflicts).toHaveLength(1)
		})

		it("handles double-star wildcards", () => {
			const tasks: TaskNode[] = [
				{
					id: "A",
					dependencies: new Set(),
					dependents: new Set(),
					completed: false,
					instructions: "test",
					workspacePath: "/src/**/*",
				},
				{
					id: "B",
					dependencies: new Set(),
					dependents: new Set(),
					completed: false,
					instructions: "test",
					workspacePath: "/src/components/Button.tsx",
				},
			]

			const result = analyzer.validateAssignments(tasks)
			expect(result.isValid).toBe(false)
			expect(result.conflicts).toHaveLength(1)
		})

		it("disables wildcard support when configured", () => {
			const analyzerNoWildcards = new WorkspaceAnalyzer({ supportWildcards: false })

			const tasks: TaskNode[] = [
				{
					id: "A",
					dependencies: new Set(),
					dependents: new Set(),
					completed: false,
					instructions: "test",
					workspacePath: "/auth/*",
				},
				{
					id: "B",
					dependencies: new Set(),
					dependents: new Set(),
					completed: false,
					instructions: "test",
					workspacePath: "/auth/users",
				},
			]

			const result = analyzerNoWildcards.validateAssignments(tasks)
			// Without wildcard support, these are treated as literal paths (no conflict)
			expect(result.isValid).toBe(true)
		})
	})

	describe("Multi-Task Validation", () => {
		it("validates multiple task assignments correctly", () => {
			const tasks: TaskNode[] = [
				{
					id: "auth",
					dependencies: new Set(),
					dependents: new Set(),
					completed: false,
					instructions: "test",
					workspacePath: "/src/auth",
				},
				{
					id: "api",
					dependencies: new Set(),
					dependents: new Set(),
					completed: false,
					instructions: "test",
					workspacePath: "/src/api",
				},
				{
					id: "ui",
					dependencies: new Set(),
					dependents: new Set(),
					completed: false,
					instructions: "test",
					workspacePath: "/src/components",
				},
				{
					id: "tests",
					dependencies: new Set(),
					dependents: new Set(),
					completed: false,
					instructions: "test",
					workspacePath: "/tests",
				},
			]

			const result = analyzer.validateAssignments(tasks)
			expect(result.isValid).toBe(true)
			expect(result.conflicts).toHaveLength(0)
			expect(result.assignments.size).toBe(4)
		})

		it("detects multiple conflicts in a task set", () => {
			const tasks: TaskNode[] = [
				{
					id: "A",
					dependencies: new Set(),
					dependents: new Set(),
					completed: false,
					instructions: "test",
					workspacePath: "/auth",
				},
				{
					id: "B",
					dependencies: new Set(),
					dependents: new Set(),
					completed: false,
					instructions: "test",
					workspacePath: "/auth", // Conflict with A
				},
				{
					id: "C",
					dependencies: new Set(),
					dependents: new Set(),
					completed: false,
					instructions: "test",
					workspacePath: "/billing",
				},
				{
					id: "D",
					dependencies: new Set(),
					dependents: new Set(),
					completed: false,
					instructions: "test",
					workspacePath: "/billing/api", // Conflict with C
				},
			]

			const result = analyzer.validateAssignments(tasks)
			expect(result.isValid).toBe(false)
			expect(result.conflicts.length).toBeGreaterThanOrEqual(2)
		})

		it("skips tasks without workspace paths", () => {
			const tasks: TaskNode[] = [
				{
					id: "A",
					dependencies: new Set(),
					dependents: new Set(),
					completed: false,
					instructions: "test",
					workspacePath: "/auth",
				},
				{
					id: "B",
					dependencies: new Set(),
					dependents: new Set(),
					completed: false,
					instructions: "test",
					workspacePath: undefined as any,
				},
				{
					id: "C",
					dependencies: new Set(),
					dependents: new Set(),
					completed: false,
					instructions: "test",
					workspacePath: "/billing",
				},
			]

			const result = analyzer.validateAssignments(tasks)
			expect(result.isValid).toBe(true)
			expect(result.assignments.size).toBe(2) // Only A and C
		})
	})

	describe("Edge Cases", () => {
		it("handles empty task list", () => {
			const tasks: TaskNode[] = []

			const result = analyzer.validateAssignments(tasks)
			expect(result.isValid).toBe(true)
			expect(result.conflicts).toHaveLength(0)
			expect(result.assignments.size).toBe(0)
		})

		it("handles single task", () => {
			const tasks: TaskNode[] = [
				{
					id: "A",
					dependencies: new Set(),
					dependents: new Set(),
					completed: false,
					instructions: "test",
					workspacePath: "/auth",
				},
			]

			const result = analyzer.validateAssignments(tasks)
			expect(result.isValid).toBe(true)
			expect(result.conflicts).toHaveLength(0)
		})

		it("handles empty string paths", () => {
			const tasks: TaskNode[] = [
				{
					id: "A",
					dependencies: new Set(),
					dependents: new Set(),
					completed: false,
					instructions: "test",
					workspacePath: "",
				},
				{
					id: "B",
					dependencies: new Set(),
					dependents: new Set(),
					completed: false,
					instructions: "test",
					workspacePath: "",
				},
			]

			const result = analyzer.validateAssignments(tasks)
			// Empty paths normalize to "/" and should conflict
			expect(result.isValid).toBe(false)
			expect(result.conflicts).toHaveLength(1)
		})

		it("handles root directory assignments", () => {
			const tasks: TaskNode[] = [
				{
					id: "A",
					dependencies: new Set(),
					dependents: new Set(),
					completed: false,
					instructions: "test",
					workspacePath: "/",
				},
				{
					id: "B",
					dependencies: new Set(),
					dependents: new Set(),
					completed: false,
					instructions: "test",
					workspacePath: "/src",
				},
			]

			const result = analyzer.validateAssignments(tasks)
			// Root conflicts with all subdirectories
			expect(result.isValid).toBe(false)
			expect(result.conflicts).toHaveLength(1)
		})
	})

	describe("Strict Mode", () => {
		it("fails on any conflict in strict mode", () => {
			const strictAnalyzer = new WorkspaceAnalyzer({ strictMode: true })

			const tasks: TaskNode[] = [
				{
					id: "A",
					dependencies: new Set(),
					dependents: new Set(),
					completed: false,
					instructions: "test",
					workspacePath: "/auth",
				},
				{
					id: "B",
					dependencies: new Set(),
					dependents: new Set(),
					completed: false,
					instructions: "test",
					workspacePath: "/auth",
				},
			]

			const result = strictAnalyzer.validateAssignments(tasks)
			expect(result.isValid).toBe(false)
		})

		it("allows warnings in non-strict mode", () => {
			const lenientAnalyzer = new WorkspaceAnalyzer({ strictMode: false })

			// Create a task list (current implementation marks all as errors,
			// but this tests the framework for future warning support)
			const tasks: TaskNode[] = [
				{
					id: "A",
					dependencies: new Set(),
					dependents: new Set(),
					completed: false,
					instructions: "test",
					workspacePath: "/auth",
				},
				{
					id: "B",
					dependencies: new Set(),
					dependents: new Set(),
					completed: false,
					instructions: "test",
					workspacePath: "/billing",
				},
			]

			const result = lenientAnalyzer.validateAssignments(tasks)
			expect(result.isValid).toBe(true)
		})
	})

	describe("Performance", () => {
		it("validates 50 tasks in less than 10ms", () => {
			const tasks: TaskNode[] = Array.from({ length: 50 }, (_, i) => ({
				id: `task-${i}`,
				dependencies: new Set(),
				dependents: new Set(),
				completed: false,
				instructions: "test",
				workspacePath: `/worker-${i}`,
			}))

			const start = performance.now()
			const result = analyzer.validateAssignments(tasks)
			const duration = performance.now() - start

			expect(result.isValid).toBe(true)
			expect(duration).toBeLessThan(10)
		})

		it("handles large task sets efficiently", () => {
			const tasks: TaskNode[] = Array.from({ length: 100 }, (_, i) => ({
				id: `task-${i}`,
				dependencies: new Set(),
				dependents: new Set(),
				completed: false,
				instructions: "test",
				workspacePath: `/worker-${i % 20}`, // Some conflicts
			}))

			const start = performance.now()
			const result = analyzer.validateAssignments(tasks)
			const duration = performance.now() - start

			// Should still be fast even with conflicts
			expect(duration).toBeLessThan(50)
			expect(result.conflicts.length).toBeGreaterThan(0)
		})
	})

	describe("Suggest Assignments", () => {
		it("suggests non-conflicting assignments", () => {
			const tasks = Array.from({ length: 5 }, (_, i) => ({
				id: `task-${i}`,
				dependencies: new Set<string>(),
				dependents: new Set<string>(),
				completed: false,
				instructions: "test",
			}))

			const suggestions = analyzer.suggestAssignments(tasks)

			expect(suggestions.size).toBe(5)

			// Verify suggestions don't conflict
			const tasksWithSuggestions: TaskNode[] = tasks.map((t) => ({
				...t,
				workspacePath: suggestions.get(t.id)!,
			}))

			const result = analyzer.validateAssignments(tasksWithSuggestions)
			expect(result.isValid).toBe(true)
		})
	})

	describe("Disposal", () => {
		it("disposes without error", () => {
			expect(() => {
				analyzer.dispose()
			}).not.toThrow()
		})
	})
})
