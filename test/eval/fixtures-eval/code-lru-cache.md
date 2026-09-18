# Code fixture: LRU cache (anchor for code.json + prose.json)

## LRU Cache

Least-recently-used cache with constant-time get and put plus eviction of the oldest entry.

```ts
export class LRUCache<K, V> {
	private capacity: number;
	private map = new Map<K, V>();

	constructor(capacity: number) {
		this.capacity = capacity;
	}

	get(key: K): V | undefined {
		if (!this.map.has(key)) return undefined;
		const value = this.map.get(key) as V;
		this.map.delete(key);
		this.map.set(key, value);
		return value;
	}

	put(key: K, value: V): void {
		if (this.map.has(key)) this.map.delete(key);
		this.map.set(key, value);
		if (this.map.size > this.capacity) {
			const oldest = this.map.keys().next().value;
			if (oldest !== undefined) this.map.delete(oldest);
		}
	}
}
```
