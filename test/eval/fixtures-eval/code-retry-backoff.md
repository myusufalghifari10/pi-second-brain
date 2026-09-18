# Code fixture: retry with exponential backoff (anchor for code.json)

## Retry With Backoff

Retries a flaky async operation with exponential backoff and jitter.

```ts
export async function retryWithBackoff<T>(
	operation: () => Promise<T>,
	attempts: number,
	baseDelayMs: number,
): Promise<T> {
	let lastError: unknown = new Error("no attempts made");
	for (let attempt = 0; attempt < attempts; attempt += 1) {
		try {
			return await operation();
		} catch (error) {
			lastError = error;
			const backoff = baseDelayMs * 2 ** attempt;
			const jitter = Math.random() * backoff * 0.1;
			await new Promise((resolve) => setTimeout(resolve, backoff + jitter));
		}
	}
	throw lastError;
}
```
