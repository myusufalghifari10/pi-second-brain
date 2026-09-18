# Code fixture: OAuth token refresh + webhook signature (anchor for code.json)

## OAuth Service

Small TypeScript service showing the token refresh path and webhook signature verification.

```ts
export async function refreshAccessToken(refreshToken: string): Promise<string> {
	const response = await fetch("https://auth.example.com/oauth/token", {
		method: "POST",
		body: JSON.stringify({ grant_type: "refresh_token", refreshToken }),
	});
	const payload = await response.json();
	return payload.access_token as string;
}

export function verifyWebhookSignature(rawBody: string, signature: string, secret: string): boolean {
	const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
	return expected === signature;
}
```
