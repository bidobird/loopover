/** `discover` CLI command (#4247): wires the existing fanout -> rank -> enqueue pipeline together so a miner
 * can actually run it. Every piece already exists and is independently tested; this module only composes them. */
import { resolveForgeConfig } from "./forge-config.js";
import { fetchCandidateIssuesWithSummary, searchCandidateIssuesWithSummary, } from "./opportunity-fanout.js";
import { rankCandidateIssuesWithSummary } from "./opportunity-ranker.js";
import { initPolicyDocCacheStore } from "./policy-doc-cache.js";
import { initPolicyVerdictCacheStore } from "./policy-verdict-cache.js";
import { enqueueRankedDiscovery } from "./portfolio-discovery.js";
import { initPortfolioQueueStore } from "./portfolio-queue.js";
import { initRankedCandidatesStore } from "./ranked-candidates.js";
import { extractContributionProfile } from "./contribution-profile-extract.js";
import { initContributionProfileCache } from "./contribution-profile-cache.js";
import { filterCandidatesByProfiles } from "./contribution-profile-filter.js";
import { argsWantJson, describeCliError, reportCliFailure } from "./cli-error.js";
import { isDiscoveryPlaneEnabled, queryDiscoveryIndex, recordDiscoveryTelemetry } from "./discovery-index-client.js";
const DISCOVER_USAGE = "Usage: loopover-miner discover <owner/repo> [<owner/repo>...] | --search <query> [--dry-run] [--json] [--api-base-url <url>] [--token-env <VAR>]";
const MAX_DISCOVER_TITLE_DISPLAY_LENGTH = 240;
const OSC_SEQUENCE_PATTERN = /\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g;
const ANSI_ESCAPE_PATTERN = /\u001b(?:\[[0-?]*[ -/]*[@-~]|[@-_])/g;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/g;
const BIDI_CONTROL_PATTERN = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
export function sanitizeDiscoverDisplayText(value) {
    return String(value ?? "")
        .replace(OSC_SEQUENCE_PATTERN, "")
        .replace(ANSI_ESCAPE_PATTERN, "")
        .replace(CONTROL_CHARACTER_PATTERN, " ")
        .replace(BIDI_CONTROL_PATTERN, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, MAX_DISCOVER_TITLE_DISPLAY_LENGTH);
}
function dedupeKey(repoFullName, issueNumber) {
    return `${repoFullName.toLowerCase()}#${issueNumber}`;
}
/**
 * Supplements `fanOut.issues` with hosted discovery-index results for the same scope (#7168) -- a complete
 * no-op (returns `fanOut` unchanged) unless the plane is enabled, so a run with the flag unset behaves exactly
 * as before this feature existed. Local results always win on a duplicate issue (the discovery-index candidate
 * is dropped, not merged over it) -- this instance's own live fan-out is more current than a cached shared
 * index entry. Discovery-index candidates lack `assignees` (not part of the public contract), so they're
 * annotated with an empty array to match opportunity-fanout.js's own candidate shape; contribution-profile-
 * filter.js's assignee-exclusion rule treats that identically to "no assignees on this issue".
 */
async function supplementWithDiscoveryIndex(fanOut, queryScope, options) {
    const env = options.env ?? process.env;
    if (!isDiscoveryPlaneEnabled(env))
        return fanOut;
    const queryIndex = options.queryDiscoveryIndex ?? queryDiscoveryIndex;
    const response = await queryIndex(queryScope, { env });
    recordDiscoveryTelemetry("discover_query", response.candidates.length > 0 ? "supplemented" : "empty", { env });
    if (response.candidates.length === 0)
        return fanOut;
    const seen = new Set(fanOut.issues.map((issue) => dedupeKey(issue.repoFullName, issue.issueNumber)));
    const supplemented = response.candidates
        .filter((candidate) => !seen.has(dedupeKey(candidate.repoFullName, candidate.issueNumber)))
        // Runtime-identical to RawCandidateIssue once assignees is annotated on: the index candidate merely declares
        // labels readonly and aiPolicyAllowed as boolean, so the relaxation needs an explicit conversion.
        .map((candidate) => ({ ...candidate, assignees: [] }));
    if (supplemented.length === 0)
        return fanOut;
    return { ...fanOut, issues: [...fanOut.issues, ...supplemented] };
}
function parseRepoTarget(value) {
    const trimmed = typeof value === "string" ? value.trim() : "";
    const [owner, repo, extra] = trimmed.split("/");
    if (!owner || !repo || extra !== undefined)
        return null;
    return { owner, repo };
}
export function parseDiscoverArgs(args) {
    // `--api-base-url` and `--token-env` (#4784) thread the tenant's forge host and credential env var into the
    // fan-out; they are kept off the parsed result unless supplied, so callers that pass neither see the exact
    // pre-#4784 `{ targets, search, json }` shape.
    const options = { json: false, dryRun: false, search: null, apiBaseUrl: null, tokenEnv: null };
    const targets = [];
    for (let index = 0; index < args.length; index += 1) {
        const token = args[index];
        if (token === "--json") {
            options.json = true;
            continue;
        }
        // #4847: fetches + ranks exactly as a real run, but skips opening any local store and makes zero writes.
        if (token === "--dry-run") {
            options.dryRun = true;
            continue;
        }
        if (token === "--search") {
            const query = args[index + 1];
            if (!query || query.startsWith("-"))
                return { error: DISCOVER_USAGE };
            options.search = query;
            index += 1;
            continue;
        }
        if (token === "--api-base-url") {
            const value = args[index + 1];
            if (!value || value.startsWith("-"))
                return { error: DISCOVER_USAGE };
            options.apiBaseUrl = value;
            index += 1;
            continue;
        }
        if (token === "--token-env") {
            const value = args[index + 1];
            if (!value || value.startsWith("-"))
                return { error: DISCOVER_USAGE };
            options.tokenEnv = value;
            index += 1;
            continue;
        }
        if (token.startsWith("-")) {
            return { error: `Unknown option: ${token}` };
        }
        const target = parseRepoTarget(token);
        if (!target)
            return { error: `Repository must be in owner/repo form: ${token}` };
        targets.push(target);
    }
    if (options.search === null && targets.length === 0) {
        return { error: DISCOVER_USAGE };
    }
    if (options.search !== null && targets.length > 0) {
        return { error: "Pass either repository targets or --search, not both." };
    }
    return {
        targets,
        search: options.search,
        dryRun: options.dryRun,
        json: options.json,
        ...(options.apiBaseUrl !== null ? { apiBaseUrl: options.apiBaseUrl } : {}),
        ...(options.tokenEnv !== null ? { tokenEnv: options.tokenEnv } : {}),
    };
}
// The rate-limit line surfaces the telemetry the fanout already records (#4837) so an operator sees how close a
// `discover` run is to being throttled without running a separate command. `unknown` covers the no-fetch/no-header
// case where the fanout captured no remaining count.
function renderRateLimitLine(result) {
    const remaining = result.rateLimitRemaining === null ? "unknown" : String(result.rateLimitRemaining);
    const resetSuffix = result.rateLimitResetAt === null ? "" : ` (resets ${result.rateLimitResetAt})`;
    return `rate-limit remaining: ${remaining}${resetSuffix}`;
}
export function renderDiscoverSummary(result) {
    const lines = [
        `fanned out: ${result.fanOutCount} candidate issue(s)`,
        `ai-policy warnings: ${result.warnings.length}`,
        `ranked: ${result.ranked.length}`,
        `enqueued: ${result.enqueueSummary.enqueued}`,
        renderRateLimitLine(result),
    ];
    if (result.enqueueSummary.skippedBelowMinRank > 0) {
        lines.push(`skipped (below min rank): ${result.enqueueSummary.skippedBelowMinRank}`);
    }
    // #6798: surface what the eligibility filter dropped and why, so a human sees AMS's inference.
    const excluded = result.excluded ?? [];
    if (excluded.length > 0) {
        lines.push(`excluded (eligibility): ${excluded.length}`);
        for (const entry of excluded.slice(0, 10)) {
            lines.push(`  ${entry.repoFullName}#${entry.issueNumber}  ${entry.reason}`);
        }
    }
    // Make the fall-back to loopover's built-in rubric explicit instead of silent (#4784): when no per-tenant goal
    // spec is supplied, lane fit reflects loopover's defaults, not the target repo's own conventions.
    if (result.usedDefaultGoalSpec) {
        lines.push("note: ranked with the built-in default goal spec (no per-tenant .loopover-miner.yml supplied)");
    }
    if (result.ranked.length === 0) {
        lines.push("", "no candidates found.");
        return lines.join("\n");
    }
    lines.push("", "top candidates:");
    for (const entry of result.ranked.slice(0, 10)) {
        const title = sanitizeDiscoverDisplayText(entry.title);
        lines.push(`  ${entry.repoFullName}#${entry.issueNumber}  score=${entry.rankScore.toFixed(4)}  ${title}`);
    }
    return lines.join("\n");
}
/**
 * Default per-repo ContributionProfile resolver (#6798): reads the local cache and, on a miss/stale entry,
 * extracts a fresh profile and caches it. Returns a Map keyed by repoFullName.
 *
 * WITHOUT a github token this returns an empty map and does no network work at all — AMS can't reliably read a
 * repo's label taxonomy/docs unauthenticated (rate limits), so it safe-defaults to no eligibility filtering.
 * That also keeps callers that don't supply a token (the common CLI path, and every test) hermetic.
 */
export async function resolveContributionProfilesForDiscover(repoFullNames, ctx = {}) {
    const profiles = new Map();
    if (!ctx.githubToken)
        return profiles;
    const initCache = ctx.initCache ?? initContributionProfileCache;
    const extract = ctx.extract ?? extractContributionProfile;
    const cache = initCache();
    try {
        for (const repoFullName of repoFullNames) {
            const cached = cache.get(repoFullName, ctx.nowMs);
            if (cached && !cached.stale) {
                profiles.set(repoFullName, cached.profile);
                continue;
            }
            // Explicit `undefined` through an optional field is indistinguishable downstream from omitting the key
            // (read via `??`/truthiness), so the cast skips a per-field conditional -- see runDiscover's casts below.
            const profile = await extract(repoFullName, {
                githubToken: ctx.githubToken,
                apiBaseUrl: ctx.apiBaseUrl,
            });
            cache.put(profile, ctx.nowMs);
            profiles.set(repoFullName, profile);
        }
    }
    finally {
        cache.close();
    }
    return profiles;
}
export async function runDiscover(args, options = {}) {
    const parsed = parseDiscoverArgs(args);
    if ("error" in parsed) {
        return reportCliFailure(argsWantJson(args), parsed.error);
    }
    // Credential env var is per-tenant (#4784): a `--token-env FORGE_PAT` flag (or `options.tokenEnv`) reads a
    // non-`GITHUB_TOKEN` variable so a non-github.com forge's token is reachable. The default falls through to the
    // forge adapter's own `tokenEnvVar` (github.com's `GITHUB_TOKEN`), so there's a single source of truth for the
    // default credential env instead of a second hardcoded literal that could drift from `DEFAULT_FORGE_CONFIG`.
    const tokenEnv = parsed.tokenEnv ?? options.tokenEnv ?? resolveForgeConfig(options.forge).tokenEnvVar;
    const githubToken = options.githubToken ?? process.env[tokenEnv] ?? "";
    // A `--api-base-url` flag (or `options.apiBaseUrl`) surfaces the fan-out's existing forge-host override at the CLI
    // (#4784); `options.forge` carries any remaining per-tenant forge knobs for a programmatic caller.
    const apiBaseUrl = parsed.apiBaseUrl ?? options.apiBaseUrl;
    const fetchTargets = options.fetchCandidateIssuesWithSummary ?? fetchCandidateIssuesWithSummary;
    const searchTargets = options.searchCandidateIssuesWithSummary ?? searchCandidateIssuesWithSummary;
    const rankIssues = options.rankCandidateIssuesWithSummary ?? rankCandidateIssuesWithSummary;
    const enqueue = options.enqueueRankedDiscovery ?? enqueueRankedDiscovery;
    // Eligibility filtering (#6798): resolve each candidate repo's ContributionProfile and drop candidates the
    // repo's own conventions would reject, BEFORE ranking. Safe by default -- see resolveContributionProfilesForDiscover.
    const resolveProfiles = options.resolveContributionProfiles ?? resolveContributionProfilesForDiscover;
    // Same scope this run already asks GitHub about (#7168) -- the discovery-index supplement, when enabled,
    // asks the shared hosted index about the identical targets/search rather than a different query entirely.
    const discoveryQueryScope = parsed.search !== null
        ? { repos: [], orgs: [], searchTerms: [parsed.search] }
        : { repos: parsed.targets.map((target) => `${target.owner}/${target.repo}`), orgs: [], searchTerms: [] };
    // #4847: fetch + rank are read-only GitHub GETs and pure local computation, so a dry run still does them for
    // real (that's the useful "what would this discover?" output) -- but it never opens any local store (portfolio
    // queue, policy-doc cache, policy-verdict cache), since opening a not-yet-existing SQLite store file is itself
    // a write. The ranked issues are fed through a no-op queue stub so enqueueRankedDiscovery's own classification
    // logic (valid/invalid, below-min-rank) still runs for real, just without ever touching the real queue.
    if (parsed.dryRun) {
        // FanoutOptions'/RankCandidateIssuesOptions' fields are optional without an explicit `| undefined`, but every
        // field here is read downstream via a plain `??`/truthiness check, so passing an explicit `undefined` through
        // behaves identically to omitting the key -- the casts just skip constructing a conditional per field for a
        // distinction nothing downstream can observe (same reasoning as manage-poll.js's pollCheckRuns call).
        const fanOutOptions = {
            apiBaseUrl,
            forge: options.forge,
            policyDocCache: null,
            policyVerdictCache: null,
        };
        try {
            let fanOut = parsed.search !== null
                ? await searchTargets(parsed.search, githubToken, fanOutOptions)
                : await fetchTargets(parsed.targets, githubToken, fanOutOptions);
            fanOut = await supplementWithDiscoveryIndex(fanOut, discoveryQueryScope, options);
            // #6798: same eligibility filter as the real path, so a dry run shows the exact candidate set a real run
            // would enqueue (and the same excluded set), rather than an unfiltered preview.
            const repoFullNames = [...new Set(fanOut.issues.map((issue) => issue.repoFullName))];
            const profilesByRepo = await resolveProfiles(repoFullNames, { githubToken, apiBaseUrl, nowMs: options.nowMs });
            const { kept, excluded } = filterCandidatesByProfiles(fanOut.issues, profilesByRepo);
            const rankedSummary = rankIssues(kept, {
                nowMs: options.nowMs,
                goalSpecsByRepo: options.goalSpecsByRepo,
                goalSpecContentByRepo: options.goalSpecContentByRepo,
            });
            const noopQueueStore = { enqueue: () => { } };
            const enqueueSummary = enqueue(rankedSummary.issues, { queueStore: noopQueueStore });
            const result = {
                outcome: "dry_run",
                fanOutCount: fanOut.issues.length,
                warnings: fanOut.warnings,
                rateLimitRemaining: fanOut.rateLimitRemaining,
                rateLimitResetAt: fanOut.rateLimitResetAt,
                ranked: rankedSummary.issues,
                excluded: excluded.map((entry) => ({
                    repoFullName: entry.candidate.repoFullName,
                    issueNumber: entry.candidate.issueNumber,
                    reason: entry.reason,
                })),
                usedDefaultGoalSpec: rankedSummary.usedDefaultGoalSpec,
                enqueueSummary,
            };
            // Structured-outcome hook (#6522), mirroring runAttempt's onResult convention: fires only at a real
            // structured success point (never the reportCliFailure branches), in addition to -- never instead of --
            // the plain exit-code return, so a non-CLI caller (the /api/discover route) can read the result.
            options.onResult?.(result);
            if (parsed.json) {
                console.log(JSON.stringify(result, null, 2));
            }
            else {
                console.log(renderDiscoverSummary(result));
                console.log("\nDRY RUN: no portfolio-queue write was made.");
            }
            return 0;
        }
        catch (error) {
            return reportCliFailure(parsed.json, describeCliError(error));
        }
    }
    const ownsPortfolioQueue = options.initPortfolioQueue === undefined;
    let portfolioQueue;
    try {
        portfolioQueue = (options.initPortfolioQueue ?? initPortfolioQueueStore)();
    }
    catch (error) {
        return reportCliFailure(parsed.json, describeCliError(error));
    }
    // Local ETag cache so a repeated discover revalidates each repo's policy docs with a conditional GET instead of
    // re-downloading them (#4842). Opened inside its OWN try/catch, separate from the portfolio queue above: the
    // queue is required infrastructure (discovery genuinely cannot enqueue anything without it, so a real open
    // failure should abort the run), but the policy-doc cache is a pure performance optimization -- a corrupt or
    // unwritable cache DB must degrade to "no cache" (every doc fetched in full, exactly as before #4842) rather
    // than fail discovery outright.
    let policyDocCache = null;
    let ownsPolicyDocCache = false;
    try {
        ownsPolicyDocCache = options.initPolicyDocCache === undefined;
        policyDocCache = (options.initPolicyDocCache ?? initPolicyDocCacheStore)();
    }
    catch {
        policyDocCache = null;
        ownsPolicyDocCache = false;
    }
    // Persisted cache of resolved policy verdicts (#4843), same "own try/catch, degrade to null" discipline as the
    // doc cache above and for the same reason: purely a performance optimization the feature is inert without, so a
    // corrupt/unwritable cache DB must never abort a run.
    let policyVerdictCache = null;
    let ownsPolicyVerdictCache = false;
    try {
        ownsPolicyVerdictCache = options.initPolicyVerdictCache === undefined;
        policyVerdictCache = (options.initPolicyVerdictCache ?? initPolicyVerdictCacheStore)();
    }
    catch {
        policyVerdictCache = null;
        ownsPolicyVerdictCache = false;
    }
    // Snapshot of this run's full ranked output (#4859 prerequisite), so a local HTTP endpoint (and eventually the
    // miner-ui/browser-extension live-fetch it's meant for) can serve the same per-issue breakdown `--json` prints,
    // without the operator re-running discover or hand-pasting its output. Same "own try/catch, degrade to null"
    // discipline as the two caches above: a corrupt/unwritable snapshot store must never abort discovery's actual
    // job (fan out, rank, enqueue). Unlike the caches, this store is a WRITE target, not a read optimization -- the
    // save call itself gets its own try/catch below for the same reason.
    let rankedCandidatesStore = null;
    let ownsRankedCandidatesStore = false;
    try {
        ownsRankedCandidatesStore = options.initRankedCandidatesStore === undefined;
        rankedCandidatesStore = (options.initRankedCandidatesStore ?? initRankedCandidatesStore)();
    }
    catch {
        rankedCandidatesStore = null;
        ownsRankedCandidatesStore = false;
    }
    // Same explicit-`undefined`-through-optional reasoning as the dry-run branch's casts above.
    const fanOutOptions = { apiBaseUrl, forge: options.forge, policyDocCache, policyVerdictCache };
    try {
        let fanOut = parsed.search !== null
            ? await searchTargets(parsed.search, githubToken, fanOutOptions)
            : await fetchTargets(parsed.targets, githubToken, fanOutOptions);
        fanOut = await supplementWithDiscoveryIndex(fanOut, discoveryQueryScope, options);
        // Eligibility filter (#6798): drop candidates a target repo's own conventions would reject, before ranking.
        // A repo with no trustworthy eligibility profile keeps every candidate (filterCandidatesByProfiles' safe
        // default), so this never silently skips real work on a repo whose conventions AMS couldn't read.
        const repoFullNames = [...new Set(fanOut.issues.map((issue) => issue.repoFullName))];
        const profilesByRepo = await resolveProfiles(repoFullNames, { githubToken, apiBaseUrl, nowMs: options.nowMs });
        const { kept, excluded } = filterCandidatesByProfiles(fanOut.issues, profilesByRepo);
        // Pass any caller-supplied per-tenant goal specs through to the ranker so lane fit uses the tenant's
        // conventions instead of silently falling back to loopover's defaults (#4784); the fallback is surfaced via
        // `usedDefaultGoalSpec` below rather than hidden.
        const rankedSummary = rankIssues(kept, {
            nowMs: options.nowMs,
            goalSpecsByRepo: options.goalSpecsByRepo,
            goalSpecContentByRepo: options.goalSpecContentByRepo,
        });
        const enqueueSummary = enqueue(rankedSummary.issues, { queueStore: portfolioQueue, apiBaseUrl });
        try {
            // Optional chaining rather than an `if (rankedCandidatesStore)` guard: a null store (open failed above)
            // short-circuits to a no-op read, so the same try/catch below also covers the open-failed case without a
            // second explicit branch.
            rankedCandidatesStore?.saveRankedCandidates(rankedSummary.issues, options.nowMs);
        }
        catch {
            // Non-fatal: the ranked-candidates snapshot is a nice-to-have for the local HTTP endpoint, not a
            // requirement for discover's own job (fan out, rank, enqueue), which already succeeded above.
        }
        const result = {
            fanOutCount: fanOut.issues.length,
            warnings: fanOut.warnings,
            rateLimitRemaining: fanOut.rateLimitRemaining,
            rateLimitResetAt: fanOut.rateLimitResetAt,
            ranked: rankedSummary.issues,
            // #6798: candidates the eligibility filter dropped, each with the repo + issue + reason, so a human sees
            // what AMS inferred and why a candidate was skipped. Empty when no profile was trustworthy enough to filter.
            excluded: excluded.map((entry) => ({
                repoFullName: entry.candidate.repoFullName,
                issueNumber: entry.candidate.issueNumber,
                reason: entry.reason,
            })),
            usedDefaultGoalSpec: rankedSummary.usedDefaultGoalSpec,
            enqueueSummary,
        };
        // Structured-outcome hook (#6522) for the full-run success point -- same convention as the dry-run branch
        // above and as runAttempt's onResult: real result only, additive to the unchanged exit-code return.
        options.onResult?.(result);
        if (parsed.json) {
            console.log(JSON.stringify(result, null, 2));
        }
        else {
            console.log(renderDiscoverSummary(result));
        }
        return 0;
    }
    catch (error) {
        return reportCliFailure(parsed.json, describeCliError(error));
    }
    finally {
        if (ownsPortfolioQueue && portfolioQueue)
            portfolioQueue.close();
        if (ownsPolicyDocCache && policyDocCache)
            policyDocCache.close();
        if (ownsPolicyVerdictCache && policyVerdictCache)
            policyVerdictCache.close();
        if (ownsRankedCandidatesStore && rankedCandidatesStore)
            rankedCandidatesStore.close();
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZGlzY292ZXItY2xpLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiZGlzY292ZXItY2xpLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBO2tIQUNrSDtBQUNsSCxPQUFPLEVBQUUsa0JBQWtCLEVBQUUsTUFBTSxtQkFBbUIsQ0FBQztBQUV2RCxPQUFPLEVBQ0wsK0JBQStCLEVBQy9CLGdDQUFnQyxHQUNqQyxNQUFNLHlCQUF5QixDQUFDO0FBT2pDLE9BQU8sRUFBRSw4QkFBOEIsRUFBRSxNQUFNLHlCQUF5QixDQUFDO0FBTXpFLE9BQU8sRUFBRSx1QkFBdUIsRUFBRSxNQUFNLHVCQUF1QixDQUFDO0FBRWhFLE9BQU8sRUFBRSwyQkFBMkIsRUFBRSxNQUFNLDJCQUEyQixDQUFDO0FBRXhFLE9BQU8sRUFBRSxzQkFBc0IsRUFBRSxNQUFNLDBCQUEwQixDQUFDO0FBRWxFLE9BQU8sRUFBRSx1QkFBdUIsRUFBRSxNQUFNLHNCQUFzQixDQUFDO0FBRS9ELE9BQU8sRUFBRSx5QkFBeUIsRUFBRSxNQUFNLHdCQUF3QixDQUFDO0FBRW5FLE9BQU8sRUFBRSwwQkFBMEIsRUFBRSxNQUFNLG1DQUFtQyxDQUFDO0FBRS9FLE9BQU8sRUFBRSw0QkFBNEIsRUFBRSxNQUFNLGlDQUFpQyxDQUFDO0FBQy9FLE9BQU8sRUFBRSwwQkFBMEIsRUFBRSxNQUFNLGtDQUFrQyxDQUFDO0FBQzlFLE9BQU8sRUFBRSxZQUFZLEVBQUUsZ0JBQWdCLEVBQUUsZ0JBQWdCLEVBQUUsTUFBTSxnQkFBZ0IsQ0FBQztBQUNsRixPQUFPLEVBQUUsdUJBQXVCLEVBQUUsbUJBQW1CLEVBQUUsd0JBQXdCLEVBQUUsTUFBTSw2QkFBNkIsQ0FBQztBQUVySCxNQUFNLGNBQWMsR0FDbEIsa0pBQWtKLENBQUM7QUFFckosTUFBTSxpQ0FBaUMsR0FBRyxHQUFHLENBQUM7QUFDOUMsTUFBTSxvQkFBb0IsR0FBRyxzQ0FBc0MsQ0FBQztBQUNwRSxNQUFNLG1CQUFtQixHQUFHLHNDQUFzQyxDQUFD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