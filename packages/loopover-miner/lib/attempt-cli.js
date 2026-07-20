// CLI dispatch for the real attempt pipeline (#5132, Wave 3.5 -- the final assembly). Wires bin/loopover-miner.js's
// `attempt` subcommand to real infrastructure end to end: worktree allocation + real git preparation
// (worktree-allocator.js + attempt-worktree.js), the four ledgers (claim/event/attempt-log/governor), the
// real coding-agent driver (#5131) and slop assessor (#5133), a live SelfReviewContext fetch (#5145), a real
// coding-task spec (#5239), the operator's AmsPolicySpec execution policy (#5249), rejectionSignaled (#5241),
// a real runMinerAttempt call -- the first point in this epic where a real coding agent actually runs, not
// just checks-and-reports-blocked -- and, only on a real "submitted" outcome, a real post-submission
// claim-conflict resolution (#4848, claim-conflict-resolver.js) for the narrow race window
// checkSubmissionFreshness cannot see (two miners submitting almost simultaneously).
//
// KNOWN, DOCUMENTED GAPS (not fabricated -- see attempt-input-builder.js's own header for the full list):
// governor.selfPlagiarismCandidate/selfPlagiarismRecentSubmissions are omitted (chokepoint.ts's own design treats
// that as "skip that stage entirely"). governor.convergenceInput is now a real per-issue portfolio-queue.js read
// (#5654) and governor.reputationHistory a real per-repo governor-state.js read (#5675), not placeholders.
import { fingerprintFromChangedFiles, resolveCodingAgentModeFromConfig, resolveFirstConfiguredCodingAgentDriverName } from "@loopover/engine";
import { argsWantJson, describeCliError, reportCliFailure } from "./cli-error.js";
import { constructProductionCodingAgentDriver } from "./coding-agent-construction.js";
import { runSlopAssessment } from "./slop-assessment.js";
import { fetchLiveIssueSnapshot } from "./live-issue-snapshot.js";
import { executeLocalWrite } from "./execute-local-write.js";
import { openClaimLedger } from "./claim-ledger.js";
import { resolveMinerGoalSpec } from "./miner-goal-spec.js";
import { resolveClaimConflict } from "./claim-conflict-resolver.js";
import { parsePrNumberFromExecResult } from "./pr-number-parse.js";
import { initEventLedger } from "./event-ledger.js";
import { initAttemptLog } from "./attempt-log.js";
import { initGovernorLedger } from "./governor-ledger.js";
import { openWorktreeAllocator } from "./worktree-allocator.js";
import { isValidRepoSegment } from "./repo-clone.js";
import { REJECTION_REASON_AI_USAGE_POLICY_BAN, REJECTION_REASON_OWN_SUBMISSION_REJECTED, resolveRejectionSignaled } from "./rejection-signal.js";
import { cleanupAttemptWorktree, prepareAttemptWorktree } from "./attempt-worktree.js";
import { fetchSelfReviewContext } from "./self-review-context.js";
import { buildCodingTaskSpec } from "./coding-task-spec.js";
import { resolveAmsPolicy } from "./ams-policy.js";
import { checkMinerKillSwitch, recordMinerKillSwitchTransition } from "./governor-kill-switch.js";
import { captureMinerError } from "./sentry.js";
import { buildAttemptGovernorContext, buildAttemptLoopInput } from "./attempt-input-builder.js";
import { getAttemptHistory } from "./portfolio-queue.js";
import { loadReputationHistory, recordOwnSubmission } from "./governor-state.js";
import { runMinerAttempt } from "./attempt-runner.js";
import { resolveGitHubToken } from "./github-token-resolution.js";
import { isDiscoveryPlaneEnabled, submitSoftClaim } from "./discovery-index-client.js";
const ATTEMPT_USAGE = "Usage: loopover-miner attempt <owner/repo> <issue#> --miner-login <login> [--base <branch>] [--live] [--dry-run] [--json]";
function parseRepoTarget(value) {
    const trimmed = typeof value === "string" ? value.trim() : "";
    const [owner, repo, extra] = trimmed.split("/");
    if (!owner || !repo || extra !== undefined)
        return null;
    if (!isValidRepoSegment(owner) || !isValidRepoSegment(repo))
        return null;
    return `${owner}/${repo}`;
}
export function parseAttemptArgs(args) {
    const options = {
        json: false,
        minerLogin: null,
        base: "main",
        live: false,
        dryRun: false,
    };
    const positional = [];
    for (let index = 0; index < args.length; index += 1) {
        const token = args[index];
        if (token === "--json") {
            options.json = true;
            continue;
        }
        // Opt-in only: resolveCodingAgentModeFromConfig's own default (no agentDryRun override) is "live", not
        // "dry_run" -- so #5132's "dry-run is default" acceptance criteria (#2342) has to be enforced HERE, by
        // requiring an explicit --live flag before this command will ever request live mode.
        if (token === "--live") {
            options.live = true;
            continue;
        }
        // #4847: distinct from --live's absence above -- --live only ever gated the coding-agent DRIVER's mode,
        // but a non---live run still opened every store and made real worktree/claim/ledger writes. --dry-run
        // short-circuits BEFORE any of that infrastructure is even opened, guaranteeing zero writes rather than
        // merely skipping the driver.
        if (token === "--dry-run") {
            options.dryRun = true;
            continue;
        }
        if (token === "--miner-login") {
            const value = args[index + 1];
            if (!value || value.startsWith("-"))
                return { error: ATTEMPT_USAGE };
            options.minerLogin = value;
            index += 1;
            continue;
        }
        if (token === "--base") {
            const value = args[index + 1];
            if (!value || value.startsWith("-"))
                return { error: ATTEMPT_USAGE };
            options.base = value;
            index += 1;
            continue;
        }
        if (token.startsWith("-"))
            return { error: `Unknown option: ${token}` };
        positional.push(token);
    }
    if (positional.length !== 2)
        return { error: ATTEMPT_USAGE };
    const repoFullName = parseRepoTarget(positional[0]);
    if (!repoFullName)
        return { error: `Repository must be in owner/repo form: ${positional[0]}` };
    const issueNumber = Number(positional[1]);
    if (!Number.isInteger(issueNumber) || issueNumber < 1) {
        return { error: `Issue number must be a positive integer: ${positional[1]}` };
    }
    if (!options.minerLogin)
        return { error: `--miner-login is required. ${ATTEMPT_USAGE}` };
    return {
        repoFullName,
        issueNumber,
        minerLogin: options.minerLogin,
        base: options.base,
        live: options.live,
        dryRun: options.dryRun,
        json: options.json,
    };
}
/**
 * Assemble a real AttemptDeps object: every field wired to a genuine implementation (the #5131 driver, the
 * #5133 slop assessor, the four real ledgers passed in, and the fetchLiveIssueSnapshot/executeLocalWrite
 * built alongside this file). Throws if the coding-agent driver is unconfigured (fails closed, matching
 * constructProductionCodingAgentDriver's own contract) -- callers should report that clearly rather than
 * silently falling back to a driver that could never run.
 */
export function buildAttemptDeps(env, ledgers) {
    // AttemptDeps deliberately declares its seams loosely (unknown inputs, structural claim-ledger subsets) so a
    // test double needs only the shape the runner touches; the real implementations here are narrower, and each
    // cast bridges that declared-vs-real gap in the one direction the runtime has always satisfied. That includes
    // resolveGitHubToken's `string | null`: the token option is read downstream only through a `?? ""` chain, for
    // which null and undefined (an omitted key) are indistinguishable.
    return {
        driver: constructProductionCodingAgentDriver(env),
        runSlopAssessment: (input) => runSlopAssessment(input),
        appendAttemptLogEvent: (event) => ledgers.attemptLog.appendAttemptLogEvent(event),
        claimLedger: ledgers.claimLedger,
        // resolveGitHubToken (#6116): GITHUB_TOKEN env override wins outright, else a live token from the
        // authenticated `loopover-mcp login` session -- cached in memory, so repeat calls within this process
        // don't repeatedly hit the session-fetch endpoint after the first successful resolution.
        // The env cast: RunAttemptOptions.env is a plain string record (a test seam), while resolveGitHubToken
        // declares NodeJS.ProcessEnv -- which the ROOT tsconfig's worker-configuration.d.ts augments with typed
        // Cloudflare bindings, making the two nominally incompatible despite being the same runtime shape here.
        fetchLiveIssueSnapshot: async (repoFullName, issueNumber) => fetchLiveIssueSnapshot(repoFullName, issueNumber, { githubToken: await resolveGitHubToken(env) }),
        eventLedger: ledgers.eventLedger,
        governorLedgerAppend: (event) => ledgers.governorLedger.appendGovernorEvent(event),
        nowMs: ledgers.nowMs,
        executeLocalWrite: (spec) => executeLocalWrite(spec),
    };
}
/**
 * Run the `attempt` CLI subcommand end to end: resolveRejectionSignaled (before consuming a worktree slot) ->
 * acquire a concurrency slot -> assemble real AttemptDeps -> prepare a REAL git worktree -> fetch a real
 * SelfReviewContext -> build a real coding-task spec (blocks on an infeasible verdict) -> resolve the real
 * AmsPolicySpec execution policy -> assemble the real IterateLoopInput + Governor context -> call
 * runMinerAttempt for real. The worktree is cleaned up (or retained, per the real outcome) in `finally`.
 * See this file's header for the documented gaps (real convergence history).
 */
export async function runAttempt(args, options = {}) {
    const parsed = parseAttemptArgs(args);
    if ("error" in parsed) {
        return reportCliFailure(argsWantJson(args), parsed.error);
    }
    const env = options.env ?? process.env;
    const nowMs = options.nowMs ?? Date.now();
    const resolveMode = options.resolveCodingAgentModeFromConfig ?? resolveCodingAgentModeFromConfig;
    const mode = resolveMode({ env, agentDryRun: !parsed.live });
    if (mode === "paused") {
        return reportCliFailure(parsed.json, `Coding-agent execution is globally paused (MINER_CODING_AGENT_PAUSED). Not running attempt for ${parsed.repoFullName}#${parsed.issueNumber}.`, 3);
    }
    const attemptId = options.attemptId ?? `${parsed.repoFullName.replace("/", "_")}-${parsed.issueNumber}-${nowMs}`;
    // #4847: reports what a real run would do and returns BEFORE any store (allocator/claim/event/attempt-log/
    // governor ledger) is even opened, so this is a provable zero-write path -- not just "opened but didn't
    // write to" the local stores, and nowhere near the real worktree clone, claim, or coding-agent driver.
    if (parsed.dryRun) {
        const dryRunResult = {
            outcome: "dry_run",
            repoFullName: parsed.repoFullName,
            issueNumber: parsed.issueNumber,
            minerLogin: parsed.minerLogin,
            base: parsed.base,
            mode,
            attemptId,
        };
        if (parsed.json) {
            console.log(JSON.stringify(dryRunResult, null, 2));
        }
        else {
            console.log(`DRY RUN: would attempt ${parsed.repoFullName}#${parsed.issueNumber} for ${parsed.minerLogin} (mode: ${mode}, base: ${parsed.base}). No worktree, claim, or ledger writes were made.`);
        }
        options.onResult?.(dryRunResult);
        return 0;
    }
    let allocator = null;
    let claimLedger = null;
    let eventLedger = null;
    let attemptLog = null;
    let governorLedger = null;
    let allocation = null;
    // `attemptOk` is the retention flag this function itself stamps onto the prepared-worktree result for the
    // finally-block's cleanup decision -- the preparation result type doesn't declare it, so widen locally.
    let worktreeResult = null;
    let claimedIssue = false;
    let claimRecord = null;
    try {
        allocator = (options.openWorktreeAllocator ?? openWorktreeAllocator)();
        claimLedger = (options.openClaimLedger ?? openClaimLedger)();
        eventLedger = (options.initEventLedger ?? initEventLedger)();
        attemptLog = (options.initAttemptLog ?? initAttemptLog)();
        governorLedger = (options.initGovernorLedger ?? initGovernorLedger)();
        // Checked before acquiring a worktree slot: a rejection-signaled repo should never consume one.
        // resolveRejectionSignaled resolves both documented triggers (#5132 policy ban, #5655 own-rejection
        // history) and returns a trigger-specific reason string for accurate audit-trail labeling.
        const resolveRejection = options.resolveRejectionSignaled ?? resolveRejectionSignaled;
        const rejectionSignal = await resolveRejection(parsed.repoFullName, {
            fetchImpl: options.fetchImpl,
        });
        if (rejectionSignal) {
            const reason = rejectionSignal === true ? REJECTION_REASON_AI_USAGE_POLICY_BAN : rejectionSignal;
            attemptLog.appendAttemptLogEvent({
                eventType: "attempt_aborted",
                attemptId,
                actionClass: "open_pr",
                mode,
                reason,
                payload: { repoFullName: parsed.repoFullName, issueNumber: parsed.issueNumber },
            });
            eventLedger.appendEvent({
                type: "attempt_blocked",
                repoFullName: parsed.repoFullName,
                payload: { issueNumber: parsed.issueNumber, reason },
            });
            const rejectedResult = {
                outcome: "blocked_rejection_signaled",
                reason,
                repoFullName: parsed.repoFullName,
                issueNumber: parsed.issueNumber,
                minerLogin: parsed.minerLogin,
                base: parsed.base,
                mode,
                attemptId,
            };
            if (parsed.json) {
                console.log(JSON.stringify(rejectedResult, null, 2));
            }
            else {
                console.error(reason === REJECTION_REASON_OWN_SUBMISSION_REJECTED
                    ? `Attempt for ${parsed.repoFullName}#${parsed.issueNumber} is blocked: this miner was previously rejected on this repo.`
                    : `Attempt for ${parsed.repoFullName}#${parsed.issueNumber} is blocked: this repo's AI-usage policy bans automated/AI-authored contributions.`);
            }
            options.onResult?.(rejectedResult);
            return 5;
        }
        allocation = allocator.acquire(attemptId, parsed.repoFullName);
        let deps;
        try {
            const buildDeps = options.buildAttemptDeps ?? buildAttemptDeps;
            deps = buildDeps(env, { claimLedger, eventLedger, attemptLog, governorLedger, nowMs });
        }
        catch (error) {
            const reason = describeCliError(error);
            return reportCliFailure(parsed.json, `Attempt for ${parsed.repoFullName}#${parsed.issueNumber} is blocked: ${reason}`, 3);
        }
        // Real worktree preparation (repo-clone.js + attempt-worktree.js, #5237): the allocator above only
        // reserves a concurrency SLOT (worktree-allocator.js's own `slot-N` placeholder dirs never receive real
        // git content) -- this is the step that actually clones/fetches the target repo and creates a real
        // `git worktree` for this attempt. Its own path, NOT the allocator's slot path, is the real
        // workingDirectory a future runMinerAttempt call must use.
        const prepareWorktree = options.prepareAttemptWorktree ?? prepareAttemptWorktree;
        worktreeResult = await prepareWorktree(parsed.repoFullName, attemptId, { baseBranch: parsed.base, env });
        if (!worktreeResult.ok) {
            const reason = worktreeResult.error;
            attemptLog.appendAttemptLogEvent({
                eventType: "attempt_aborted",
                attemptId,
                actionClass: "open_pr",
                mode,
                reason,
                payload: { repoFullName: parsed.repoFullName, issueNumber: parsed.issueNumber },
            });
            eventLedger.appendEvent({
                type: "attempt_blocked",
                repoFullName: parsed.repoFullName,
                payload: { issueNumber: parsed.issueNumber, reason },
            });
            const worktreeFailureResult = {
                outcome: "blocked_worktree_preparation_failed",
                reason,
                repoFullName: parsed.repoFullName,
                issueNumber: parsed.issueNumber,
                minerLogin: parsed.minerLogin,
                base: parsed.base,
                mode,
                attemptId,
            };
            if (parsed.json) {
                console.log(JSON.stringify(worktreeFailureResult, null, 2));
            }
            else {
                console.error(`Attempt for ${parsed.repoFullName}#${parsed.issueNumber} is blocked: real worktree preparation failed: ${reason}`);
            }
            options.onResult?.(worktreeFailureResult);
            return 6;
        }
        // Real SelfReviewContext (#5145): issue/PR/manifest data at live-gate fidelity for the target repo.
        const fetchReviewContext = options.fetchSelfReviewContext ?? fetchSelfReviewContext;
        const reviewContext = await fetchReviewContext(parsed.repoFullName, {
            // Same `?? ""`-read token seam as buildAttemptDeps above: a null token is indistinguishable downstream
            // from an omitted key, so the cast just spares a per-field conditional.
            githubToken: await resolveGitHubToken(env),
            contributorLogin: parsed.minerLogin,
            linkedIssues: [parsed.issueNumber],
        });
        // The target issue's own real record, when present in the fetched context. When absent (e.g. already
        // closed, or genuinely not found), buildCodingTaskSpec's own feasibility check reports target_not_found
        // and this placeholder's empty title/body are never surfaced anywhere -- not fabricated content, just an
        // inert shape for a verdict that immediately blocks.
        const targetIssue = reviewContext.issues.find((candidate) => candidate.number === parsed.issueNumber) ?? {
            number: parsed.issueNumber,
            title: "",
            body: null,
            labels: [],
        };
        const buildTaskSpec = options.buildCodingTaskSpec ?? buildCodingTaskSpec;
        const codingTaskSpec = buildTaskSpec({
            repoFullName: parsed.repoFullName,
            issue: targetIssue,
            context: { issues: reviewContext.issues, pullRequests: reviewContext.pullRequests },
            // Same declared-vs-real claim-ledger seam gap as buildAttemptDeps above.
            claimLedger: claimLedger,
            workingDirectory: worktreeResult.worktreePath,
        });
        if (!codingTaskSpec.ready) {
            const reason = `infeasible_${codingTaskSpec.verdict}`;
            attemptLog.appendAttemptLogEvent({
                eventType: "attempt_aborted",
                attemptId,
                actionClass: "open_pr",
                mode,
                reason,
                payload: { repoFullName: parsed.repoFullName, issueNumber: parsed.issueNumber, feasibility: codingTaskSpec.feasibility },
            });
            eventLedger.appendEvent({
                type: "attempt_blocked",
                repoFullName: parsed.repoFullName,
                payload: { issueNumber: parsed.issueNumber, reason },
            });
            const infeasibleResult = {
                outcome: "blocked_infeasible",
                reason,
                verdict: codingTaskSpec.verdict,
                avoidReasons: codingTaskSpec.feasibility.avoidReasons,
                raiseReasons: codingTaskSpec.feasibility.raiseReasons,
                repoFullName: parsed.repoFullName,
                issueNumber: parsed.issueNumber,
                minerLogin: parsed.minerLogin,
                base: parsed.base,
                mode,
                attemptId,
            };
            if (parsed.json) {
                console.log(JSON.stringify(infeasibleResult, null, 2));
            }
            else {
                console.error(`Attempt for ${parsed.repoFullName}#${parsed.issueNumber} is blocked: feasibility verdict "${codingTaskSpec.verdict}" (${[...codingTaskSpec.feasibility.avoidReasons, ...codingTaskSpec.feasibility.raiseReasons].join(", ")}).`);
            }
            options.onResult?.(infeasibleResult);
            return 4;
        }
        const amsPolicy = await (options.resolveAmsPolicy ?? resolveAmsPolicy)(parsed.repoFullName, { env });
        // Real per-repo pause (#5392): read straight from the already-cloned worktree's own .loopover-miner.yml
        // (resolveMinerGoalSpec never throws -- a missing/malformed file degrades to killSwitch.paused: false, so
        // this can't fail this attempt on its own). Threaded into BOTH checkMinerKillSwitch (killSwitchScope, used
        // by the freshness/submission gate) and the governor context (killSwitchRepoPaused, used by the Governor
        // chokepoint) -- the same two places the GLOBAL kill switch already reaches.
        const resolveGoalSpec = options.resolveMinerGoalSpec ?? resolveMinerGoalSpec;
        const minerGoalSpec = resolveGoalSpec(worktreeResult.repoPath);
        const repoPaused = minerGoalSpec.spec.killSwitch.paused;
        const checkKillSwitch = options.checkMinerKillSwitch ?? checkMinerKillSwitch;
        const recordKillTransition = options.recordMinerKillSwitchTransition ?? recordMinerKillSwitchTransition;
        let killSwitchScope = checkKillSwitch({ env, repoPaused }).scope;
        let previousKillSwitchScope = killSwitchScope;
        const preparedWorktree = worktreeResult;
        const resolveLiveKillSwitch = () => {
            // Re-read the YAML flag each probe so an on-disk unpause/pause is reflected mid-attempt (#5670).
            const liveRepoPaused = resolveGoalSpec(preparedWorktree.repoPath).spec.killSwitch.paused;
            const live = checkKillSwitch({ env, repoPaused: liveRepoPaused });
            if (live.scope !== previousKillSwitchScope) {
                try {
                    recordKillTransition({
                        repoFullName: parsed.repoFullName,
                        actionClass: "attempt",
                        previousScope: previousKillSwitchScope,
                        scope: live.scope,
                    });
                }
                catch (error) {
                    // Ledger append must never crash an aborting attempt (kept), but was previously silent -- a
                    // kill-switch flip mid-attempt (a compliance-relevant event) could vanish with no record (#6011).
                    captureMinerError(error, { kind: "kill_switch_transition_record_failed", repoFullName: parsed.repoFullName, scope: live.scope });
                }
                previousKillSwitchScope = live.scope;
            }
            killSwitchScope = live.scope;
            return live;
        };
        const shouldAbort = () => {
            const live = resolveLiveKillSwitch();
            if (!live.active)
                return false;
            return {
                abort: true,
                reason: `Kill-switch (${live.scope}) engaged mid-attempt; abandoning without starting another driver iteration.`,
            };
        };
        const loopInput = buildAttemptLoopInput({
            codingTaskSpec,
            reviewContext,
            worktreePath: worktreeResult.worktreePath,
            attemptId,
            mode,
            repoFullName: parsed.repoFullName,
            minerLogin: parsed.minerLogin,
            rejectionSignaled: false,
            amsPolicySpec: amsPolicy.spec,
            branchRef: worktreeResult.branchName,
        });
        // Real per-issue attempt history (#5654): portfolio-queue.js's own claim/reclaim/requeue/done counters,
        // keyed the same way opportunity-fanout.js enqueues issue-shaped candidates (`issue:<number>`). No
        // apiBaseUrl: this file has no multi-forge host context of its own today, so this reads (and every
        // pre-#5563 single-forge caller already reads) the github.com default.
        const readAttemptHistory = options.getAttemptHistory ?? getAttemptHistory;
        const convergenceInput = readAttemptHistory(parsed.repoFullName, `issue:${parsed.issueNumber}`);
        // Real per-repo reputation history (#5675): the miner's own decided/unfavorable outcome streak for this repo,
        // read from governor-state.js so the chokepoint's self-reputation throttle sees real data instead of nothing.
        const readReputationHistory = options.loadReputationHistory ?? loadReputationHistory;
        const reputationHistory = readReputationHistory(parsed.repoFullName);
        const governor = buildAttemptGovernorContext(env, amsPolicy.spec, repoPaused, convergenceInput, reputationHistory);
        // Real maxConcurrentClaims enforcement (#6758): the repo's .loopover-miner.yml cap is honored ATOMICALLY by
        // the ledger's count-and-claim, not by a listActiveClaims pre-check here. The old check-then-act split -- read
        // the count in this file, then record the claim in a separate claimLedger call -- let two sibling miner
        // processes racing the same repo both pass a stale sub-cap count and both claim, exceeding the cap.
        // claimIssueWithinCap fuses the count and the insert into one transaction; the loser gets `claimed: false`
        // and is reported below rather than silently dropped. This is also the real soft-claim (#5393): once it
        // returns claimed, a sibling process sees it via claimLedger.listActiveClaims while this attempt is in
        // flight, it is released in `finally` on every terminal outcome (mirroring the worktree allocation slot's
        // acquire-then-always-release), and its claimedAt feeds the post-submission conflict check further down (#4848).
        const claimResult = claimLedger.claimIssueWithinCap(parsed.repoFullName, parsed.issueNumber, `attempt:${attemptId}`, undefined, minerGoalSpec.spec.maxConcurrentClaims);
        if (!claimResult.claimed) {
            const reason = "max_concurrent_claims_exceeded";
            attemptLog.appendAttemptLogEvent({
                eventType: "attempt_aborted",
                attemptId,
                actionClass: "open_pr",
                mode,
                reason,
                payload: {
                    repoFullName: parsed.repoFullName,
                    issueNumber: parsed.issueNumber,
                    maxConcurrentClaims: minerGoalSpec.spec.maxConcurrentClaims,
                    activeClaimCount: claimResult.activeClaimCount,
                },
            });
            eventLedger.appendEvent({
                type: "attempt_blocked",
                repoFullName: parsed.repoFullName,
                payload: { issueNumber: parsed.issueNumber, reason },
            });
            const blockedResult = {
                outcome: "blocked_max_concurrent_claims",
                reason,
                maxConcurrentClaims: minerGoalSpec.spec.maxConcurrentClaims,
                activeClaimCount: claimResult.activeClaimCount,
                repoFullName: parsed.repoFullName,
                issueNumber: parsed.issueNumber,
                minerLogin: parsed.minerLogin,
                base: parsed.base,
                mode,
                attemptId,
            };
            if (parsed.json) {
                console.log(JSON.stringify(blockedResult, null, 2));
            }
            else {
                console.error(`Attempt for ${parsed.repoFullName}#${parsed.issueNumber} is blocked: this repo's maxConcurrentClaims cap (${minerGoalSpec.spec.maxConcurrentClaims}) is already met (${claimResult.activeClaimCount} active claim(s)).`);
            }
            options.onResult?.(blockedResult);
            return 11;
        }
        claimRecord = claimResult.claim;
        claimedIssue = true;
        // Hosted soft-claim coordination (#7168), opt-in via LOOPOVER_MINER_DISCOVERY_PLANE -- gated HERE at the
        // call site (not left to submitSoftClaim's own internal check alone) so a disabled plane costs zero calls,
        // matching discover-cli.js's supplementWithDiscoveryIndex gating; a caller-injected options.submitSoftClaim
        // (tests, or a future programmatic caller) can't accidentally bypass the opt-in this way either. Awaited
        // (not fire-and-forget) so a sibling instance racing the same issue is genuinely less likely to start
        // duplicate work in the window before this attempt's claim reaches the shared index -- the whole point of
        // coordinating BEFORE work begins, not after.
        if (isDiscoveryPlaneEnabled(env)) {
            const submitClaim = options.submitSoftClaim ?? submitSoftClaim;
            await submitClaim(claimRecord, { env });
        }
        const runAttemptPipeline = options.runMinerAttempt ?? runMinerAttempt;
        let result;
        try {
            result = await runAttemptPipeline({
                loopInput,
                issueNumber: parsed.issueNumber,
                minerLogin: parsed.minerLogin,
                base: parsed.base,
                killSwitchScope,
                slopThreshold: amsPolicy.spec.slopThreshold,
                submissionMode: amsPolicy.spec.submissionMode,
                governor,
            }, {
                ...deps,
                shouldAbort,
                resolveKillSwitchScope: () => resolveLiveKillSwitch().scope,
            });
        }
        catch (error) {
            // A real attempt that CRASHED is exactly the case that most needs its worktree kept for post-mortem
            // inspection, so record the failure explicitly before unwinding. Without this, `attemptOk` stayed
            // `undefined` and the finally block's `?? true` default (meant for the earlier blocked paths that never
            // ran anything in the worktree) deleted it -- inverting shouldRetainWorktree's documented policy.
            worktreeResult.attemptOk = false;
            throw error;
        }
        worktreeResult.attemptOk = result.outcome === "submitted";
        // Real claim-conflict resolution (#4848): only meaningful once a real PR exists, so this only ever runs
        // on a real "submitted" outcome. checkSubmissionFreshness (inside runMinerAttempt) already caught the
        // common pre-submission case; this closes the narrower TOCTOU window where two miners raced past that
        // check almost simultaneously -- see claim-conflict-resolver.js's own header for why the adjudicator
        // can only run POST-submission (it needs a real PR number on both sides of the election).
        let claimConflict;
        if (result.outcome === "submitted") {
            const selfPrNumber = parsePrNumberFromExecResult(result.execResult, parsed.repoFullName);
            if (selfPrNumber !== null) {
                const resolveConflict = options.resolveClaimConflict ?? resolveClaimConflict;
                claimConflict = await resolveConflict({
                    repoFullName: parsed.repoFullName,
                    issueNumber: parsed.issueNumber,
                    selfPrNumber,
                    selfClaimedAt: claimRecord.claimedAt,
                    minerLogin: parsed.minerLogin,
                }, { fetchLiveIssueSnapshot: deps.fetchLiveIssueSnapshot, executeLocalWrite: deps.executeLocalWrite });
            }
            // Real own-submission history (#5655 follow-up): governor-state.js's recordOwnSubmission/
            // listRecentOwnSubmissions store (#5134) existed and was already READ by resolveOwnRejectionHistory
            // (#5655), but nothing ever WROTE to it -- attempt-runner.js's own header names this exact gap
            // ("real persistence primitives... but isn't auto-loaded here yet"). Left unfixed, that trigger is a
            // silent no-op in every real deployment: an empty table always resolves "no prior submissions found."
            // The fingerprint is the real changed-files set from the loop's own handoff packet (never fabricated) --
            // omitted (not recorded as an empty placeholder) when the packet reports no changed files at all. A
            // logging failure must never fail an otherwise-successful attempt, matching the summary-event write below.
            const changedFiles = result.loopResult.handoffPacket?.changedFiles?.map((file) => file.path) ?? [];
            const fingerprint = fingerprintFromChangedFiles(changedFiles);
            if (fingerprint) {
                try {
                    const record = options.recordOwnSubmission ?? recordOwnSubmission;
                    record({
                        repoFullName: parsed.repoFullName,
                        fingerprint,
                        submittedAt: new Date(nowMs).toISOString(),
                        pullRequestNumber: selfPrNumber,
                        issueNumber: parsed.issueNumber,
                    });
                }
                catch (error) {
                    // A logging failure must never fail an otherwise-successful attempt (kept), but was previously
                    // silent -- if this write fails AFTER a real PR has already opened, future self-plagiarism checks go
                    // permanently blind to this exact submission with nobody told (#6011).
                    captureMinerError(error, { kind: "record_own_submission_failed", repoFullName: parsed.repoFullName, pullRequestNumber: selfPrNumber });
                }
            }
        }
        const finalResult = {
            outcome: `attempt_${result.outcome}`,
            repoFullName: parsed.repoFullName,
            issueNumber: parsed.issueNumber,
            minerLogin: parsed.minerLogin,
            base: parsed.base,
            mode,
            attemptId,
            submissionMode: amsPolicy.spec.submissionMode,
            // Every runMinerAttempt outcome carries a real loopResult (#5135's loop needs its genuine turn-usage and
            // cost to save real GovernorCapUsage via governor-state.js's saveCapUsage -- nothing else in the codebase
            // calls it yet). Surfaced flat rather than the whole loopResult object, matching this result's own
            // shallow shape. costUsd is real only for the agent-sdk provider (its own SDK result message reports
            // total_cost_usd); CLI-subprocess providers (claude-cli/codex-cli) report no cost signal today, so this
            // is 0 for those -- an honest absence, not a fabricated number.
            totalTurnsUsed: result.loopResult.totalTurnsUsed,
            totalCostUsd: result.loopResult.totalCostUsd,
            // Real accumulated tokens (#5653) -- read from finalMeterTotals rather than a flat totalTokensUsed field
            // (IterateLoopResult has no such flat field, unlike turns/cost). 0 when no driver reported a token signal
            // on any iteration this attempt ran, never fabricated.
            totalTokensUsed: result.loopResult.finalMeterTotals.tokens,
            iterationsUsed: result.loopResult.iterationsUsed,
            ...(result.outcome === "abandon" && result.loopResult.finalDecision?.abandonReason
                ? { abandonReason: result.loopResult.finalDecision.abandonReason }
                : {}),
            ...("reason" in result ? { reason: result.reason } : {}),
            ...("decision" in result ? { decision: result.decision } : {}),
            ...("spec" in result ? { spec: result.spec } : {}),
            ...("execResult" in result ? { execResult: result.execResult } : {}),
            // Present only on a real "submitted" outcome whose PR number was recoverable from execResult -- omitted
            // (not fabricated as "checked: false") on every other outcome, and on a submitted outcome where the new
            // PR's number genuinely couldn't be parsed (an honest gap, not silently swallowed).
            ...(claimConflict !== undefined ? { claimConflict } : {}),
        };
        // One summary row per completed attempt (#5185), for the Grafana per-provider usage dashboard the redacted
        // AMS reporting export exposes -- distinct from the per-iteration attempt_started/attempt_tool_edit/... trail
        // iterate-loop.ts already writes. No fallback for an unconfigured provider: buildAttemptDeps already fails
        // closed (throws) on the same env before a worktree is even allocated, so reaching this point guarantees
        // resolveFirstConfiguredCodingAgentDriverName(env) resolves a real name. costUsd/tokensUsed are both real,
        // driver-reported accumulated totals (#5653) -- 0 when no iteration's driver reported a signal, never
        // fabricated. A logging failure must never fail an otherwise-successful attempt -- mirrors iterate-loop.ts's
        // own safeAppendAttemptLogEvent non-fatal handling.
        try {
            attemptLog.appendAttemptLogEvent({
                eventType: "attempt_outcome_summary",
                attemptId,
                actionClass: finalResult.outcome,
                mode,
                reason: `attempt finished with outcome: ${result.outcome}`,
                provider: resolveFirstConfiguredCodingAgentDriverName(env),
                costUsd: finalResult.totalCostUsd,
                tokensUsed: finalResult.totalTokensUsed,
            });
        }
        catch (error) {
            // A logging failure must never fail an otherwise-successful attempt (kept), but was previously silent --
            // per docs/observability.md this row feeds the Grafana per-provider cost/usage dashboard, so a failure
            // here silently drops the attempt from operator-facing metrics with nobody told (#6011).
            captureMinerError(error, { kind: "attempt_outcome_summary_append_failed", attemptId, repoFullName: parsed.repoFullName });
        }
        if (parsed.json) {
            console.log(JSON.stringify(finalResult, null, 2));
        }
        else {
            console.log(`Attempt for ${parsed.repoFullName}#${parsed.issueNumber} finished with outcome: ${result.outcome}.`);
        }
        options.onResult?.(finalResult);
        switch (result.outcome) {
            case "submitted":
                return 0;
            case "abandon":
                return 7;
            case "stale":
                return 8;
            case "blocked":
                return 9;
            case "governed":
                return 10;
            default:
                return 2;
        }
    }
    catch (error) {
        return reportCliFailure(parsed.json, describeCliError(error));
    }
    finally {
        // worktreeResult.attemptOk is set to the REAL runMinerAttempt outcome (submitted = true) once that call
        // happens, and explicitly to `false` when that call THROWS -- a crashed attempt is precisely what needs a
        // retained worktree to postmortem, so it must never fall through to the `?? true` default below. Every
        // earlier blocked path (rejection/worktree-prep-failure/infeasible) never sets it, since nothing ran in
        // the worktree to postmortem -- those are the cases that default to `true` (nothing to retain), matching
        // cleanupAttemptWorktree's own retention policy (a failed REAL attempt is what gets retained).
        if (worktreeResult?.ok) {
            const cleanupWorktree = options.cleanupAttemptWorktree ?? cleanupAttemptWorktree;
            await cleanupWorktree(worktreeResult.repoPath, worktreeResult.worktreePath, worktreeResult.attemptOk ?? true);
        }
        // Every terminal outcome past the claim point (submitted/abandon/stale/blocked/governed, or an
        // unexpected throw) releases the soft-claim -- a claim that outlives its own attempt process would
        // wrongly tell a sibling miner this issue is still in flight.
        if (claimedIssue && claimLedger)
            claimLedger.releaseClaim(parsed.repoFullName, parsed.issueNumber);
        // Paired hosted release (#7168): same call-site opt-in gate as the claim submission above. Only fires when
        // the initial claim submission actually ran (claimRecord is only set once claimedIssue is), so a run that
        // never reached the claim point (e.g. blocked_max_concurrent_claims) has nothing to release remotely.
        if (claimedIssue && claimRecord && isDiscoveryPlaneEnabled(env)) {
            const submitClaim = options.submitSoftClaim ?? submitSoftClaim;
            await submitClaim({ ...claimRecord, status: "released" }, { env });
        }
        if (allocation && allocator)
            allocator.release(attemptId);
        allocator?.close();
        claimLedger?.close();
        eventLedger?.close();
        attemptLog?.close();
        governorLedger?.close();
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYXR0ZW1wdC1jbGkuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJhdHRlbXB0LWNsaS50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSxvSEFBb0g7QUFDcEgscUdBQXFHO0FBQ3JHLDBHQUEwRztBQUMxRyw2R0FBNkc7QUFDN0csOEdBQThHO0FBQzlHLDJHQUEyRztBQUMzRyxxR0FBcUc7QUFDckcsMkZBQTJGO0FBQzNGLHFGQUFxRjtBQUNyRixFQUFFO0FBQ0YsMEdBQTBHO0FBQzFHLGtIQUFrSDtBQUNsSCxpSEFBaUg7QUFDakgsMkdBQTJHO0FBRTNHLE9BQU8sRUFBRSwyQkFBMkIsRUFBRSxnQ0FBZ0MsRUFBRSwyQ0FBMkMsRUFBRSxNQUFNLGtCQUFrQixDQUFDO0FBRTlJLE9BQU8sRUFBRSxZQUFZLEVBQUUsZ0JBQWdCLEVBQUUsZ0JBQWdCLEVBQUUsTUFBTSxnQkFBZ0IsQ0FBQztBQUNsRixPQUFPLEVBQUUsb0NBQW9DLEVBQUUsTUFBTSxnQ0FBZ0MsQ0FBQztBQUN0RixPQUFPLEVBQUUsaUJBQWlCLEVBQUUsTUFBTSxzQkFBc0IsQ0FBQztBQUN6RCxPQUFPLEVBQUUsc0JBQXNCLEVBQUUsTUFBTSwwQkFBMEIsQ0FBQztBQUNsRSxPQUFPLEVBQUUsaUJBQWlCLEVBQUUsTUFBTSwwQkFBMEIsQ0FBQztBQUM3RCxPQUFPLEVBQUUsZUFBZSxFQUFFLE1BQU0sbUJBQW1CLENBQUM7QUFFcEQsT0FBTyxFQUFFLG9CQUFvQixFQUFFLE1BQU0sc0JBQXNCLENBQUM7QUFDNUQsT0FBTyxFQUFFLG9CQUFvQixFQUFFLE1BQU0sOEJBQThCLENBQUM7QUFFcEUsT0FBTyxFQUFFLDJCQUEyQixFQUFFLE1BQU0sc0JBQXNCLENBQUM7QUFDbkUsT0FBTyxFQUFFLGVBQWUsRUFBRSxNQUFNLG1CQUFtQixDQUFDO0FBRXBELE9BQU8sRUFBRSxjQUFjLEVBQUUsTUFBTSxrQkFBa0IsQ0FBQztBQUVsRCxPQUFPLEVBQUUsa0JBQWtCLEVBQUUsTUFBTSxzQkFB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