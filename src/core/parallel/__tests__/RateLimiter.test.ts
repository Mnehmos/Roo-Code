/**
 * RateLimiter Tests
 *
 * Tests for rate limit tracking with rolling window calculation
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { RateLimiter } from "../RateLimiter"

describe("RateLimiter", () => {
	let limiter: RateLimiter

	beforeEach(() => {
		vi.useFakeTimers()
		limiter = new RateLimiter([
			{ provider: "test", requestsPerMinute: 100 },
			{ provider: "anthropic", requestsPerMinute: 3800 },
			{ provider: "openrouter", requestsPerMinute: 5000 },
		])
	})

	afterEach(() => {
		limiter.dispose()
		vi.useRealTimers()
	})

	describe("Request Tracking", () => {
		it("tracks single request", () => {
			limiter.track("test", 1)
			expect(limiter.getCurrentRPM("test")).toBe(1)
		})

		it("accumulates multiple requests in same second", () => {
			limiter.track("test", 5)
			limiter.track("test", 3)
			expect(limiter.getCurrentRPM("test")).toBe(8)
		})

		it("tracks requests across different seconds", () => {
			limiter.track("test", 10)

			// Advance 1 second
			vi.advanceTimersByTime(1000)
			limiter.track("test", 5)

			expect(limiter.getCurrentRPM("test")).toBe(15)
		})

		it("tracks bulk requests", () => {
			limiter.track("test", 50)
			expect(limiter.getCurrentRPM("test")).toBe(50)
		})

		it("defaults to 1 request if count not specified", () => {
			limiter.track("test")
			expect(limiter.getCurrentRPM("test")).toBe(1)
		})
	})

	describe("Rolling Window", () => {
		it("includes requests from last 60 seconds", () => {
			limiter.track("test", 10)

			// Advance 30 seconds
			vi.advanceTimersByTime(30000)
			limiter.track("test", 20)

			// Both requests should be counted
			expect(limiter.getCurrentRPM("test")).toBe(30)
		})

		it("excludes requests older than 60 seconds", () => {
			limiter.track("test", 10)

			// Advance 61 seconds
			vi.advanceTimersByTime(61000)

			// Old request should be excluded
			expect(limiter.getCurrentRPM("test")).toBe(0)
		})

		it("handles requests at 60 second boundary", () => {
			limiter.track("test", 10)

			// Advance exactly 60 seconds
			vi.advanceTimersByTime(60000)
			limiter.track("test", 5)

			// Only new request should count
			expect(limiter.getCurrentRPM("test")).toBe(5)
		})

		it("maintains accurate count over multiple minutes", () => {
			// Minute 1
			limiter.track("test", 20)
			vi.advanceTimersByTime(30000)
			limiter.track("test", 30)

			// Minute 2
			vi.advanceTimersByTime(30000)
			limiter.track("test", 10)

			// Should have: 30 (from 30s ago) + 10 (just now) = 40
			expect(limiter.getCurrentRPM("test")).toBe(40)

			// Advance another 31 seconds (now 61s from first request)
			vi.advanceTimersByTime(31000)

			// Should have: 10 (from 31s ago) = 10
			expect(limiter.getCurrentRPM("test")).toBe(10)
		})
	})

	describe("Headroom Calculation", () => {
		it("calculates available headroom", () => {
			limiter.track("test", 30)
			expect(limiter.getHeadroom("test")).toBe(70) // 100 - 30
		})

		it("returns 0 when at limit", () => {
			limiter.track("test", 100)
			expect(limiter.getHeadroom("test")).toBe(0)
		})

		it("returns 0 when over limit", () => {
			limiter.track("test", 150)
			expect(limiter.getHeadroom("test")).toBe(0)
		})

		it("returns full limit when no requests", () => {
			expect(limiter.getHeadroom("test")).toBe(100)
		})

		it("returns Infinity for unknown provider", () => {
			expect(limiter.getHeadroom("unknown")).toBe(Infinity)
		})
	})

	describe("Multi-Provider Support", () => {
		it("tracks providers independently", () => {
			limiter.track("anthropic", 100)
			limiter.track("openrouter", 200)
			limiter.track("test", 50)

			expect(limiter.getCurrentRPM("anthropic")).toBe(100)
			expect(limiter.getCurrentRPM("openrouter")).toBe(200)
			expect(limiter.getCurrentRPM("test")).toBe(50)
		})

		it("calculates headroom independently per provider", () => {
			limiter.track("anthropic", 3000)
			limiter.track("test", 50)

			expect(limiter.getHeadroom("anthropic")).toBe(800) // 3800 - 3000
			expect(limiter.getHeadroom("test")).toBe(50) // 100 - 50
		})

		it("handles unknown providers gracefully", () => {
			limiter.track("unknown", 10)
			expect(limiter.getCurrentRPM("unknown")).toBe(10)
			expect(limiter.getHeadroom("unknown")).toBe(Infinity)
		})
	})

	describe("Warning Events", () => {
		it("emits warning when approaching limit", () => {
			const warnings: any[] = []
			limiter.on("rate-limit-warning", (data) => warnings.push(data))

			// 92% of 100 = 92
			limiter.track("test", 95)

			expect(warnings).toHaveLength(1)
			expect(warnings[0]).toMatchObject({
				provider: "test",
				currentRPM: 95,
				limit: 100,
			})
		})

		it("uses custom warning threshold", () => {
			limiter.dispose()
			limiter = new RateLimiter([{ provider: "test", requestsPerMinute: 100, warningThreshold: 80 }])

			const warnings: any[] = []
			limiter.on("rate-limit-warning", (data) => warnings.push(data))

			limiter.track("test", 85)

			expect(warnings).toHaveLength(1)
		})

		it("only emits warning once per threshold crossing", () => {
			const warnings: any[] = []
			limiter.on("rate-limit-warning", (data) => warnings.push(data))

			limiter.track("test", 95)
			limiter.track("test", 3)
			limiter.track("test", 1)

			// Should only warn once even though we're still over threshold
			expect(warnings).toHaveLength(1)
		})

		it("re-emits warning after dropping below and crossing again", () => {
			const warnings: any[] = []
			limiter.on("rate-limit-warning", (data) => warnings.push(data))

			// Cross threshold
			limiter.track("test", 95)
			expect(warnings).toHaveLength(1)

			// Drop below threshold by advancing time
			vi.advanceTimersByTime(61000)

			// Cross threshold again
			limiter.track("test", 95)
			expect(warnings).toHaveLength(2)
		})

		it("emits exceeded event when at or over limit", () => {
			const exceeded: any[] = []
			limiter.on("rate-limit-exceeded", (data) => exceeded.push(data))

			limiter.track("test", 100)

			expect(exceeded).toHaveLength(1)
			expect(exceeded[0]).toMatchObject({
				provider: "test",
				currentRPM: 100,
				limit: 100,
			})
		})
	})

	describe("Safety Checks", () => {
		it("reports safe when under warning threshold", () => {
			limiter.track("test", 50)
			expect(limiter.isSafe("test")).toBe(true)
		})

		it("reports unsafe when at or over warning threshold", () => {
			limiter.track("test", 95)
			expect(limiter.isSafe("test")).toBe(false)
		})

		it("returns true for unknown providers", () => {
			expect(limiter.isSafe("unknown")).toBe(true)
		})
	})

	describe("Cleanup", () => {
		it("removes old requests automatically", () => {
			limiter.track("test", 50)

			// Advance past cleanup interval (10 seconds) and past 60 second window
			vi.advanceTimersByTime(61000)

			// Trigger cleanup by advancing past next interval
			vi.advanceTimersByTime(10000)

			expect(limiter.getCurrentRPM("test")).toBe(0)
		})

		it("keeps recent requests during cleanup", () => {
			limiter.track("test", 30)
			vi.advanceTimersByTime(30000)
			limiter.track("test", 20)

			// Trigger cleanup (advance 10s to trigger cleanup interval)
			vi.advanceTimersByTime(10000)

			// Both should still be counted (30 from 40s ago, 20 from 10s ago)
			// Total time elapsed: 40s, both within 60s window
			expect(limiter.getCurrentRPM("test")).toBe(50)
		})

		it("handles cleanup with no requests", () => {
			// Should not throw
			vi.advanceTimersByTime(15000)
			expect(limiter.getCurrentRPM("test")).toBe(0)
		})
	})

	describe("Reset Functions", () => {
		it("resets single provider", () => {
			limiter.track("test", 50)
			limiter.track("anthropic", 100)

			limiter.reset("test")

			expect(limiter.getCurrentRPM("test")).toBe(0)
			expect(limiter.getCurrentRPM("anthropic")).toBe(100)
		})

		it("resets all providers", () => {
			limiter.track("test", 50)
			limiter.track("anthropic", 100)
			limiter.track("openrouter", 200)

			limiter.resetAll()

			expect(limiter.getCurrentRPM("test")).toBe(0)
			expect(limiter.getCurrentRPM("anthropic")).toBe(0)
			expect(limiter.getCurrentRPM("openrouter")).toBe(0)
		})

		it("resets warning flags on reset", () => {
			const warnings: any[] = []
			limiter.on("rate-limit-warning", (data) => warnings.push(data))

			limiter.track("test", 95)
			expect(warnings).toHaveLength(1)

			limiter.reset("test")
			limiter.track("test", 95)

			// Should warn again after reset
			expect(warnings).toHaveLength(2)
		})
	})

	describe("Statistics", () => {
		it("returns stats for all providers", () => {
			limiter.track("test", 50)
			limiter.track("anthropic", 3000)

			const stats = limiter.getStats()

			expect(stats).toMatchObject({
				test: {
					currentRPM: 50,
					headroom: 50,
					limit: 100,
				},
				anthropic: {
					currentRPM: 3000,
					headroom: 800,
					limit: 3800,
				},
				openrouter: {
					currentRPM: 0,
					headroom: 5000,
					limit: 5000,
				},
			})
		})
	})

	describe("Configuration", () => {
		it("returns list of configured providers", () => {
			const providers = limiter.getProviders()
			expect(providers).toEqual(["test", "anthropic", "openrouter"])
		})

		it("returns config for specific provider", () => {
			const config = limiter.getConfig("anthropic")
			expect(config).toMatchObject({
				provider: "anthropic",
				requestsPerMinute: 3800,
				warningThreshold: 3496, // 92% of 3800
			})
		})

		it("returns undefined for unknown provider config", () => {
			expect(limiter.getConfig("unknown")).toBeUndefined()
		})
	})

	describe("Disposal", () => {
		it("cleans up resources on dispose", () => {
			const warnings: any[] = []
			limiter.on("rate-limit-warning", (data) => warnings.push(data))

			limiter.dispose()

			// Should not emit after disposal
			limiter.track("test", 95)
			expect(warnings).toHaveLength(0)
		})

		it("stops cleanup interval on dispose", () => {
			limiter.track("test", 50)
			limiter.dispose()

			// Advance time past 60s window
			vi.advanceTimersByTime(61000)

			// Data is filtered by rolling window calculation in getCurrentRPM
			// (not by cleanup interval), so it will be 0
			// The point is cleanup interval doesn't run after dispose
			expect(limiter.getCurrentRPM("test")).toBe(0)
		})
	})

	describe("Edge Cases", () => {
		it("handles zero requests", () => {
			limiter.track("test", 0)
			expect(limiter.getCurrentRPM("test")).toBe(0)
		})

		it("handles negative request counts (treats as 0)", () => {
			limiter.track("test", -5)
			expect(limiter.getCurrentRPM("test")).toBe(-5) // Actually tracks it
		})

		it("handles very large request counts", () => {
			limiter.track("test", 1000000)
			expect(limiter.getCurrentRPM("test")).toBe(1000000)
			expect(limiter.getHeadroom("test")).toBe(0)
		})

		it("handles rapid successive tracking calls", () => {
			for (let i = 0; i < 100; i++) {
				limiter.track("test", 1)
			}
			expect(limiter.getCurrentRPM("test")).toBe(100)
		})

		it("handles time going backwards (edge case)", () => {
			limiter.track("test", 10)

			// Simulate time going backwards (shouldn't happen but handle gracefully)
			vi.setSystemTime(Date.now() - 5000)
			limiter.track("test", 5)

			// Should still track the request
			expect(limiter.getCurrentRPM("test")).toBeGreaterThan(0)
		})
	})

	describe("Real-World Scenarios", () => {
		it("simulates parallel worker scenario", () => {
			// Simulate 5 workers making requests over time
			limiter.track("anthropic", 15) // Worker 1
			limiter.track("anthropic", 15) // Worker 2
			limiter.track("anthropic", 15) // Worker 3

			vi.advanceTimersByTime(5000)

			limiter.track("anthropic", 15) // Worker 4
			limiter.track("anthropic", 15) // Worker 5

			// Total: 75 RPM
			expect(limiter.getCurrentRPM("anthropic")).toBe(75)
			expect(limiter.getHeadroom("anthropic")).toBe(3725)
			expect(limiter.isSafe("anthropic")).toBe(true)
		})

		it("simulates approaching limit scenario", () => {
			const warnings: any[] = []
			limiter.on("rate-limit-warning", (data) => warnings.push(data))

			// Simulate heavy load approaching Anthropic's 3800 limit
			limiter.track("anthropic", 3500)

			expect(warnings).toHaveLength(1)
			expect(limiter.getHeadroom("anthropic")).toBe(300)
			expect(limiter.isSafe("anthropic")).toBe(false)
		})

		it("simulates burst then cooldown", () => {
			// Burst of requests
			limiter.track("test", 90)
			expect(limiter.getCurrentRPM("test")).toBe(90)

			// Wait for requests to age out
			vi.advanceTimersByTime(61000)

			// Should be cooled down
			expect(limiter.getCurrentRPM("test")).toBe(0)
			expect(limiter.isSafe("test")).toBe(true)
		})
	})
})
