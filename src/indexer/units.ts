// Engineering-unit token rewrite for FTS symmetry (L4 plan §3.2, S2): makes "N·m" ≡ "N m"
// for index and query alike, because both flow through preTokenizeForFTS, which calls
// rewriteUnitTokens on its canonicalized output. Pure and total; conservative by design —
// the only edit ever made is dropping a cdot token that sits BETWEEN two UNIT_TOKENS.

// Frozen curated set, expressed in TOKEN SPACE: the exact strings that occur in the token
// stream produced by preTokenizeForFTS. camelCase/digit-letter splitting and math-glyph
// folding decompose several surface forms, so spec §3.2's 34 surface entries consolidate
// to 34 token entries (derived 1:1 from the surface list; the lone addition is "h", hour,
// required by the kW·h / km·h vectors):
//
//   surface → tokens      surface → tokens      surface → tokens
//   N → N                 Ω → omega             kN → k N
//   m → m                 S → S                 MPa → M Pa
//   kg → kg               F → F                 GPa → G Pa
//   s → s                 T → T                 kPa → k Pa
//   A → A                 H → H                 kW → k W
//   K → K                 Pa → Pa               MJ → MJ
//   mol → mol             bar → bar             kWh → k Wh
//   cd → cd               eV → e V              mm → mm
//   Hz → Hz               L → L                 cm → cm
//   J → J                 µg → mu g             km → km
//                                               mg → mg
//                                               h (hour; kW·h, km·h)
//
// ("µg" → "mu g" because the µ U+00B5 glyph folds via MATH_UNICODE_MAP; "Ω" → "omega"
// likewise for both U+03A9 and U+2126.) Prefixes are part of the token — this module never
// splits an alnum run ("Nm" stays "Nm", documented asymmetric per §3.2). Slash never acts as
// a unit token either; note the L1 pre-chain keeps slash compounds intact ("m/s" is one
// token, not "m / s"), so "N·m/s" → "N cdot m/s" is left untouched (conservative no-op).
export const UNIT_TOKENS: ReadonlySet<string> = new Set([
	"N",
	"m",
	"kg",
	"s",
	"A",
	"K",
	"mol",
	"cd",
	"Hz",
	"J",
	"W",
	"V",
	"C",
	"omega",
	"S",
	"F",
	"T",
	"H",
	"Pa",
	"bar",
	"L",
	"e",
	"k",
	"M",
	"G",
	"Wh",
	"mu",
	"g",
	"mm",
	"cm",
	"km",
	"mg",
	"MJ",
	"h",
]);

// Rewrites the whitespace-separated token stream emitted by preTokenizeForFTS: every cdot
// token whose previous KEPT token and following token are both UNIT_TOKENS is dropped.
// Single left-to-right pass with last-kept-token as prev, so chains collapse iteratively
// ("N cdot m cdot s" → "N m s"). Non-unit neighbors leave the cdot untouched ("a cdot b",
// "5 cdot kg" — 5 is not a unit token, per spec). No cdot ⇒ returned unchanged (same
// reference), keeping non-unit content byte-identical (plan S6).
export function rewriteUnitTokens(tokenized: string): string {
	if (!tokenized.includes("cdot")) return tokenized;
	const tokens = tokenized.split(" ");
	const kept: string[] = [];
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (
			token === "cdot" &&
			kept.length > 0 &&
			i + 1 < tokens.length &&
			UNIT_TOKENS.has(kept[kept.length - 1]) &&
			UNIT_TOKENS.has(tokens[i + 1])
		) {
			continue;
		}
		kept.push(token);
	}
	return kept.join(" ");
}
