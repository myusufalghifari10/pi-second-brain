# Code fixture: token bucket rate limiter (anchor for code.json + prose.json)

## Rate Limiter

Python token bucket that controls how many requests a client may make.

```python
class TokenBucketRateLimiter:
	def __init__(self, capacity: float, refill_rate: float):
		self.capacity = capacity
		self.refill_rate = refill_rate
		self.tokens = capacity

	def allow_request(self) -> bool:
		self.tokens = min(self.capacity, self.tokens + self.refill_rate)
		if self.tokens >= 1:
			self.tokens -= 1
			return True
		return False
```
