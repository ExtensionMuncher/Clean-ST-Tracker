import { getContext } from "../../../../../../scripts/extensions.js";
import { extensionSettings } from "../index.js";
import { debug, error, log } from "../lib/utils.js";

/**
 * ============================================================================
 *  BACKGROUND REQUEST MODULE
 * ============================================================================
 *
 *  WHAT THIS DOES (plain English):
 *
 *  The old Tracker generated its trackers by literally switching SillyTavern's
 *  active connection profile (running "/profile <name>"), making the call, then
 *  switching back. That profile switch is what caused the
 *  "Canceled because main api changed" errors and forced you to re-trigger
 *  tracker generation by hand: any in-flight request (the tracker's own, or
 *  another extension's) got aborted the instant the profile changed.
 *
 *  This module replaces that approach. SillyTavern ships an official service —
 *  ConnectionManagerRequestService.sendRequest() — that fires a request THROUGH
 *  a chosen connection profile WITHOUT changing your active profile at all.
 *  It runs quietly in the background, exactly like the WTracker extension does.
 *
 *  Nothing about your active chat profile is touched. No /profile command runs.
 *  No other extension's request gets cancelled.
 * ============================================================================
 */

/**
 * Holds the AbortController for the single in-flight tracker request, so we can
 * cancel a stale one if a newer request comes in (rather than letting them race).
 * @type {AbortController|null}
 */
let activeController = null;

/**
 * Resolves the connection-profile ID that the background request should use.
 *
 * SillyTavern's sendRequest() identifies profiles by their internal `id`, but
 * the Tracker settings store the profile by NAME (extensionSettings.selectedProfile)
 * and also support the literal value "current" (meaning: use whatever profile the
 * chat is using right now). This function translates either case into an id.
 *
 * @returns {string} The connection profile id to send through.
 */
function resolveProfileId() {
	const ctx = getContext();
	const connectionManager = ctx.extensionSettings.connectionManager;

	if (!connectionManager || !Array.isArray(connectionManager.profiles)) {
		throw new Error("Connection Manager is not available. Enable it in SillyTavern's extension settings.");
	}

	// "current" (or unset) means: use the profile the chat is actively using.
	if (!extensionSettings.selectedProfile || extensionSettings.selectedProfile === "current") {
		const current = connectionManager.profiles.find((p) => p.id === connectionManager.selectedProfile);
		if (!current) throw new Error("No active connection profile is selected in SillyTavern.");
		return current.id;
	}

	// Otherwise the Tracker setting holds a profile NAME — translate it to an id.
	const named = connectionManager.profiles.find((p) => p.name === extensionSettings.selectedProfile);
	if (!named) {
		throw new Error(`Tracker connection profile "${extensionSettings.selectedProfile}" no longer exists. Pick a valid one in Tracker settings.`);
	}
	return named.id;
}

/**
 * Sends a tracker generation request in the background through the configured
 * connection profile, without switching the active profile.
 *
 * This is a drop-in replacement for the old `generateRaw(...)` calls. It takes
 * the same system prompt + user/request prompt the Tracker already builds, and
 * returns the model's raw text response (a string) — identical to what
 * generateRaw returned, so the existing parsing code downstream is unchanged.
 *
 * @param {string} systemPrompt   - The tracker system prompt.
 * @param {string} requestPrompt  - The user-role request prompt.
 * @param {number|null} responseLength - Max tokens, or null for the profile/preset default.
 * @returns {Promise<string>} The raw text response from the model.
 */
export async function sendBackgroundTrackerRequest(systemPrompt, requestPrompt, responseLength) {
	const ctx = getContext();
	const service = ctx.ConnectionManagerRequestService;

	if (!service || typeof service.sendRequest !== "function") {
		throw new Error("ConnectionManagerRequestService is unavailable in this SillyTavern version. Update SillyTavern to use background tracking.");
	}

	const profileId = resolveProfileId();

	// Build the prompt as a chat message array. sendRequest accepts either a plain
	// string or an array of {role, content}; the array form lets us keep the
	// system prompt and the request prompt as distinct roles, which is what the
	// Tracker's prompts were designed around.
	const prompt = [
		{ role: "system", content: systemPrompt },
		{ role: "user", content: requestPrompt },
	];

	// maxTokens must be a number; pass a sane fallback when responseLength is null.
	const maxTokens = responseLength && responseLength > 0 ? responseLength : 1024;

	// Cancel any previous in-flight tracker request before starting a new one.
	// This means a newer request supersedes a stale one cleanly, instead of the
	// two racing and stomping each other.
	if (activeController) {
		debug("Aborting a previous in-flight tracker request before starting a new one.");
		activeController.abort();
	}
	activeController = new AbortController();
	const myController = activeController;

	log("Sending background tracker request through profile id:", profileId);

	try {
		const result = await service.sendRequest(
			profileId,
			prompt,
			maxTokens,
			{
				signal: myController.signal,
				extractData: true,   // returns { content: "..." }
				includePreset: true, // respect the profile's completion preset
				includeInstruct: true,
			},
		);

		// extractData:true returns an ExtractedData object whose `.content` is the text.
		const text = typeof result === "string" ? result : result?.content;
		if (typeof text !== "string") {
			throw new Error("Background request returned no text content.");
		}
		debug("Background tracker request returned:", { length: text.length });
		return text;
	} catch (e) {
		// An AbortError here means we deliberately cancelled a stale request — not a
		// real failure, so swallow it quietly and return empty.
		if (e?.name === "AbortError") {
			debug("Background tracker request was aborted (superseded by a newer one).");
			return "";
		}
		error("Background tracker request failed:", e);
		throw e;
	} finally {
		// Only clear the shared controller if it's still ours (a newer request may
		// have already replaced it).
		if (activeController === myController) activeController = null;
	}
}

/**
 * Aborts any in-flight background tracker request. Called when the chat changes
 * or the extension is disabled, so a request for an old chat can't land on a new one.
 */
export function abortBackgroundRequest() {
	if (activeController) {
		debug("Aborting in-flight background tracker request (chat changed / disabled).");
		activeController.abort();
		activeController = null;
	}
}
