/**
 * RateLimiter
 *
 * Tracks API requests per minute (RPM) using a rolling window,
 * emits warnings when approaching rate limits, and provides
 * headroom calculations for the OrchestrationScheduler.
 *
 * @module core/parallel
 */

import { EventEmitter } from "events"

/**
 * Configuration for a provider's rate limit
 */
export interface RateLimitConfig {
	/** Provider identifier (e.g., "anthropic", "openrouter") */
	provider: string

	/** Maximum requests per minute allowed */
	requestsPerMinute: number

	/** Warning threshold (default: 92% of limit) */
	warningThreshold?: number
}

/**
 * Record of requests for a specific second
 */
interface RequestRecord {
	/** Timestamp (rounded to second) */
	timestamp: number

	/** Number of requests in this second */
	count: number
}

/**
 * Events emitted by RateLimiter
 */
export interface RateLimiterEvents {
	/** Emitted when approaching rate limit */
	"rate-limit-warning": (data: { provider: string; currentRPM: number; limit: number; headroom: number }) => void

	/** Emitted when rate limit is exceeded */
	"rate-limit-exceeded": (data: { provider: string; currentRPM: number; limit: number }) => void
}

/**
 * RateLimiter - Tracks API rate limits with rolling window
 *
 * Features:
 * - Rolling 60-second window for accurate RPM tracking
 * - Multi-provider support with independent tracking
 * - Automatic cleanup of old requests
 * - Warning and error event emission
 * - Minimal memory footprint and performance overhead
 *
 * @example
 * ```typescript
 * const limiter = new RateLimiter([
 *   { provider: 'anthropic', requestsPerMinute: 3800 },
 *   { provider: 'openrouter', requestsPerMinute: 5000 }
 * ]);
 *
 * limiter.on('rate-limit-warning', ({ provider, currentRPM }) => {
 *   console.warn(`Approaching limit: ${currentRPM} RPM`);
 * });
 *
 * limiter.track('anthropic', 1);
 * const rpm = limiter.getCurrentRPM('anthropic');
 * const headroom = limiter.getHeadroom('anthropic');
 * ```
 */
export class RateLimiter extends EventEmitter {
	/** Request history per provider */
	private requests: Map<string, RequestRecord[]> = new Map()

	/** Rate limit configuration per provider */
	private config: Map<string, RateLimitConfig> = new Map()

	/** Cleanup interval handle */
	private cleanupInterval: NodeJS.Timeout

	/** Warning emitted flag per provider (reset when RPM drops) */
	private warningEmitted: Set<string> = new Set()

	/**
	 * Create a new RateLimiter
	 *
	 * @param configs - Array of provider rate limit configurations
	 */
	constructor(configs: RateLimitConfig[]) {
		super()

		// Initialize configurations
		for (const config of configs) {
			this.config.set(config.provider, {
				...config,
				warningThreshold: config.warningThreshold ?? config.requestsPerMinute * 0.92,
			})
			this.requests.set(config.provider, [])
		}

		// Start cleanup interval (runs every 10 seconds)
		this.cleanupInterval = setInterval(() => this.cleanup(), 10000)
	}

	/**
	 * Track a new API request
	 *
	 * @param provider - Provider identifier
	 * @param requestCount - Number of requests (default: 1)
	 */
	track(provider: string, requestCount: number = 1): void {
		// Get or create history for provider
		let history = this.requests.get(provider)
		if (!history) {
			history = []
			this.requests.set(provider, history)
		}

		// Get current second (rounded down to nearest second)
		const now = Date.now()
		const currentSecond = Math.floor(now / 1000) * 1000

		// Find existing record for current second or create new one
		const existingIndex = history.findIndex((r) => r.timestamp === currentSecond)

		if (existingIndex >= 0) {
			history[existingIndex].count += requestCount
		} else {
			history.push({ timestamp: currentSecond, count: requestCount })
		}

		// Check thresholds and emit events if needed
		this.checkThresholds(provider)
	}

	/**
	 * Get current requests per minute for a provider
	 *
	 * @param provider - Provider identifier
	 * @returns Current RPM (requests in last 60 seconds)
	 */
	getCurrentRPM(provider: string): number {
		const history = this.requests.get(provider)
		if (!history || history.length === 0) {
			return 0
		}

		const now = Date.now()
		const oneMinuteAgo = now - 60000

		// Sum requests from last 60 seconds
		const recentRequests = history.filter((r) => r.timestamp > oneMinuteAgo).reduce((sum, r) => sum + r.count, 0)

		return recentRequests
	}

	/**
	 * Get available headroom (limit - current RPM)
	 *
	 * @param provider - Provider identifier
	 * @returns Available request capacity (0 or positive)
	 */
	getHeadroom(provider: string): number {
		const config = this.config.get(provider)
		if (!config) {
			// Unknown provider - return infinite headroom
			return Infinity
		}

		const currentRPM = this.getCurrentRPM(provider)
		return Math.max(0, config.requestsPerMinute - currentRPM)
	}

	/**
	 * Check if current usage is safe (under warning threshold)
	 *
	 * @param provider - Provider identifier
	 * @returns True if usage is safe
	 */
	isSafe(provider: string): boolean {
		const config = this.config.get(provider)
		if (!config) {
			return true
		}

		const currentRPM = this.getCurrentRPM(provider)
		const threshold = config.warningThreshold ?? config.requestsPerMinute * 0.92

		return currentRPM < threshold
	}

	/**
	 * Get all configured providers
	 *
	 * @returns Array of provider identifiers
	 */
	getProviders(): string[] {
		return Array.from(this.config.keys())
	}

	/**
	 * Get rate limit configuration for a provider
	 *
	 * @param provider - Provider identifier
	 * @returns Rate limit configuration or undefined
	 */
	getConfig(provider: string): RateLimitConfig | undefined {
		return this.config.get(provider)
	}

	/**
	 * Check thresholds and emit events if needed
	 */
	private checkThresholds(provider: string): void {
		const config = this.config.get(provider)
		if (!config) {
			return
		}

		const currentRPM = this.getCurrentRPM(provider)
		const threshold = config.warningThreshold ?? config.requestsPerMinute * 0.92
		const headroom = this.getHeadroom(provider)

		// Check if exceeded limit
		if (currentRPM >= config.requestsPerMinute) {
			this.emit("rate-limit-exceeded", {
				provider,
				currentRPM,
				limit: config.requestsPerMinute,
			})
			return
		}

		// Check if approaching limit
		if (currentRPM >= threshold) {
			// Only emit warning once per threshold crossing
			if (!this.warningEmitted.has(provider)) {
				this.warningEmitted.add(provider)
				this.emit("rate-limit-warning", {
					provider,
					currentRPM,
					limit: config.requestsPerMinute,
					headroom,
				})
			}
		} else {
			// Reset warning flag when back under threshold
			this.warningEmitted.delete(provider)
		}
	}

	/**
	 * Clean up old request records (older than 60 seconds)
	 */
	private cleanup(): void {
		const now = Date.now()
		const oneMinuteAgo = now - 60000

		for (const [provider, history] of this.requests) {
			// Filter out records older than 60 seconds
			const filtered = history.filter((r) => r.timestamp > oneMinuteAgo)
			this.requests.set(provider, filtered)

			// Recheck thresholds after cleanup (may reset warning flags)
			this.checkThresholds(provider)
		}
	}

	/**
	 * Reset all tracking data for a specific provider
	 *
	 * @param provider - Provider identifier
	 */
	reset(provider: string): void {
		this.requests.set(provider, [])
		this.warningEmitted.delete(provider)
	}

	/**
	 * Reset all tracking data for all providers
	 */
	resetAll(): void {
		for (const provider of this.config.keys()) {
			this.reset(provider)
		}
	}

	/**
	 * Get statistics for all providers
	 *
	 * @returns Object mapping provider to current RPM and headroom
	 */
	getStats(): Record<string, { currentRPM: number; headroom: number; limit: number }> {
		const stats: Record<string, { currentRPM: number; headroom: number; limit: number }> = {}

		for (const [provider, config] of this.config) {
			const currentRPM = this.getCurrentRPM(provider)
			const headroom = this.getHeadroom(provider)

			stats[provider] = {
				currentRPM,
				headroom,
				limit: config.requestsPerMinute,
			}
		}

		return stats
	}

	/**
	 * Dispose of the rate limiter and clean up resources
	 */
	dispose(): void {
		clearInterval(this.cleanupInterval)
		this.removeAllListeners()
	}
}
