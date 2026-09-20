// Engineering-unit token rewrite for FTS symmetry (L4 plan §3.2, S2): makes "N·m" ≡ "N m"
// for index and query alike, because both flow through preTokenizeForFTS, which calls
// rewriteUnitTokens on its canonicalized output. Pure and total; conservative by design —
// the only edit ever made is dropping a cdot token that sits BETWEEN two UNIT_TOKENS.

// Frozen curated set, expressed in TOKEN SPACE: the exact strings that occur in the token
// stream produced by preTokenizeForFTS. camelCase/digit-letter splitting and math-glyph
// folding decompose several surface forms, so spec §3.2's 31 surface entries consolidate
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
// Word-variant canonicalization (D3): maps spelled-out unit names to their symbol form so
// "3 kilometers" and "3 km" share one FTS token stream. It runs inside preTokenizeForFTS,
// the ONE pipeline shared by index-side content_tokenized and query-side tokenizeForSearch,
// so both sides rewrite symmetrically. Frozen bounded map with lowercase keys; matching is
// word-boundary exact and case-insensitive — the index-side token stream preserves case
// while the query side lowercases only AFTER preTokenizeForFTS, so a case-sensitive map
// would be asymmetric ("5 Kilometers" indexed unrewritten, query "Kilometers" rewritten).
// Singular AND plural forms both rewrite; \b keeps prose intact ("kilometerstone" never
// matches because "stone" continues the word run).
export const UNIT_WORD_VARIANTS: ReadonlyMap<string, string> = new Map([
	["kilometer", "km"],
	["kilometers", "km"],
	["kilometre", "km"],
	["kilometres", "km"],
	["meter", "m"],
	["meters", "m"],
	["metre", "m"],
	["metres", "m"],
	["centimeter", "cm"],
	["centimeters", "cm"],
	["millimeter", "mm"],
	["millimeters", "mm"],
	["kilogram", "kg"],
	["kilograms", "kg"],
	["gram", "g"],
	["grams", "g"],
	["milligram", "mg"],
	["milligrams", "mg"],
	["second", "s"],
	["seconds", "s"],
	["millisecond", "ms"],
	["milliseconds", "ms"],
	["minute", "min"],
	["minutes", "min"],
	["hour", "h"],
	["hours", "h"],
	["hertz", "hz"],
	["kilobyte", "kb"],
	["kilobytes", "kb"],
	["megabyte", "mb"],
	["megabytes", "mb"],
	["gigabyte", "gb"],
	["gigabytes", "gb"],
]);

// Alternation is longest-first so the regex never commits to a shorter variant before the
// longer one at the same start position ("kilometers" before "kilometer").
const UNIT_WORD_VARIANT_SOURCE = [...UNIT_WORD_VARIANTS.keys()].sort((a, b) => b.length - a.length).join("|");

// Stateless fast-path gate (no /g flag ⇒ .test cannot advance lastIndex): most content has no
// spelled-out unit, and this keeps the common case allocation-free.
const UNIT_WORD_VARIANT_FAST_TEST = new RegExp(`\\b(?:${UNIT_WORD_VARIANT_SOURCE})\\b`, "i");
const UNIT_WORD_VARIANT_RE = new RegExp(`\\b(?:${UNIT_WORD_VARIANT_SOURCE})\\b`, "gi");

// Rewrites every spelled-out unit word to its symbol form ("3 kilometers" → "3 km"). The
// match is replaced via its lowercased map lookup, so "Kilometers" and "KILOMETERS" rewrite
// too. Runs BEFORE rewriteUnitTokens so spelled forms also feed the cdot rule symmetrically
// ("second·meter" → "s cdot m" → "s m", matching "s·m").
export function rewriteUnitWordVariants(text: string): string {
	if (!UNIT_WORD_VARIANT_FAST_TEST.test(text)) return text;
	return text.replace(UNIT_WORD_VARIANT_RE, (word) => UNIT_WORD_VARIANTS.get(word.toLowerCase()) ?? word);
}

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
