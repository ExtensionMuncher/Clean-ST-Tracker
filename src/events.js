import { chat, saveChatConditional } from "../../../../../script.js";
import { selected_group, is_group_generating } from "../../../../../scripts/group-chats.js";
import { debug, getLastMessageWithTracker, getLastNonSystemMessageIndex, getPreviousNonSystemMessageIndex, shouldGenerateTracker, log } from "../lib/utils.js";
import { isEnabled } from "./settings/settings.js";
import { prepareMessageGeneration, addTrackerToMessage, clearInjects } from "./tracker.js";
import { generateTracker } from "./generation.js";
import { releaseGeneration } from "../lib/interconnection.js";
import { abortBackgroundRequest } from "./backgroundRequest.js";
import { FIELD_INCLUDE_OPTIONS, getTracker, OUTPUT_FORMATS, saveTracker } from "./trackerDataHandler.js";
import { TrackerInterface } from "./ui/trackerInterface.js";
import { extensionSettings } from "../index.js";
import { TrackerPreviewManager } from "./ui/trackerPreviewManager.js";

/**
 * Monotonically increasing epoch counter. Incremented on every CHAT_CHANGED.
 * Used to detect whether a generation event belongs to the current chat load
 * or a stale one (e.g. from rapid switching).
 */
let chatGenerationEpoch = 0;

/**
 * The epoch value when the current chat loading window began.
 * Zero means no loading window is active.
 * A generation event with loadingEpoch > 0 && loadingEpoch === chatGenerationEpoch
 * means we're still within the loading window for the current chat.
 * 
 * Cleared either by:
 *  - A render event for a NEW message (mesId >= lastChatLengthAtLoad)
 *  - A 30-second fallback timeout
 */
let loadingEpoch = 0;

/**
 * Tracks the chat length at the time CHAT_CHANGED fired.
 * Messages with mesId below this threshold are historical (chat load/switch)
 * and should not trigger API calls even after the loading window expires.
 */
let lastChatLengthAtLoad = 0;

const CHAT_LOAD_TIMEOUT_MS = 30000;

/**
 * Event handler for when a message is deleted. Deleting a message can leave a
 * tracker request that was started for the now-removed turn still in flight;
 * aborting it here stops that stale result from landing on the wrong message.
 *
 * Note: this does NOT stop the "connection profile switched too quickly" toast —
 * that is a cross-extension profile collision and is not addressed here.
 */
async function onMessageDeleted(mesId) {
	log("MESSAGE_DELETED", mesId);
	abortBackgroundRequest();
}

/**
 * Event handler for when the chat changes.
 * Activates a loading window during which ALL generation is blocked.
 * Uses an epoch counter so rapid chat switching cannot cause stale timeouts
 * to prematurely end the loading window of a newer chat.
 * @param {object} args - The event arguments.
 */
async function onChatChanged(args) {
	// A new chat (or chat switch) means any tracker request still running was for
	// the OLD chat — abort it so its result can't land on this one.
	abortBackgroundRequest();

	chatGenerationEpoch++;
	const startedEpoch = chatGenerationEpoch;
	loadingEpoch = startedEpoch;
	lastChatLengthAtLoad = chat.length;
	await clearInjects();
	if (!await isEnabled()) {
		setTimeout(() => {
			if (loadingEpoch === startedEpoch) loadingEpoch = 0;
		}, CHAT_LOAD_TIMEOUT_MS);
		return;
	}
	log("Chat changed:", args);
	updateTrackerInterface();
	//TrackerPreviewManager.init();
	releaseGeneration();
	// Fallback timeout: clear loading flag even if no new message arrives
	setTimeout(() => {
		if (loadingEpoch === startedEpoch) loadingEpoch = 0;
	}, CHAT_LOAD_TIMEOUT_MS);
}

/**
 * Returns true if a chat loading window is currently active for this chat.
 * Compares the stored loadingEpoch against the current chatGenerationEpoch
 * to detect stale loading windows from previous chat switches.
 */
function isChatLoading() {
	return loadingEpoch > 0 && loadingEpoch === chatGenerationEpoch;
}

/**
 * Event handler for after generation commands.
 * @param {string} type - The type of generation.
 * @param {object} options - Generation options.
 * @param {boolean} dryRun - Whether it's a dry run.
 */
async function onGenerateAfterCommands(type, options, dryRun) {
	if(!extensionSettings.enabled) await clearInjects();
	const enabled = await isEnabled();

	// Only generate a tracker on a GENUINE NEW TURN. We explicitly exclude:
	//   • swipe / regenerate — these re-roll an EXISTING message (e.g. after you
	//     delete a reply and ST regenerates). A new tracker here is the "random
	//     API call after deleting a message" you saw — so it's blocked.
	//   • impersonate — ST writes a message AS YOU, not a real character turn.
	// Allowed: undefined/normal (a new reply) and continue (extends the last
	// message with genuinely new narrative content).
	const ALLOWED_TYPES = ["normal", "continue", "group_chat"];

	if (
		!enabled ||
		chat.length == 0 ||
		dryRun ||
		isChatLoading() ||
		(selected_group && !is_group_generating) ||
		(typeof type != "undefined" && !ALLOWED_TYPES.includes(type))
	) {
		debug("GENERATION_AFTER_COMMANDS Tracker skipped", {extenstionEnabled: extensionSettings.enabled, freeToRun: enabled, selected_group, is_group_generating, type, dryRun, loadingEpoch, chatGenerationEpoch});
		return;
	}
	if(type == "normal") type = undefined;
	log("GENERATION_AFTER_COMMANDS ", [type, options, dryRun]);
	await prepareMessageGeneration(type, options, dryRun);
	releaseGeneration();
}

/**
 * Event handler for when a message is received.
 * @param {number} mesId - The message ID.
 */
async function onMessageReceived(mesId) {
	if (!await isEnabled() || !chat[mesId] || (chat[mesId].tracker && Object.keys(chat[mesId].tracker).length !== 0)) return;
	log("MESSAGE_RECEIVED", mesId);
	await addTrackerToMessage(mesId);
	releaseGeneration();
}

/**
 * Event handler for when a message is sent.
 * @param {number} mesId - The message ID.
 */
async function onMessageSent(mesId) {
	if (!await isEnabled() || !chat[mesId] || (chat[mesId].tracker && Object.keys(chat[mesId].tracker).length !== 0)) return;
	log("MESSAGE_SENT", mesId);
	await addTrackerToMessage(mesId);
	releaseGeneration();
}

/**
 * Event handler for when a character's message is rendered.
 * During chat loading or for historical messages: only saves prepared trackers, never generates.
 * For new messages during conversation: generates trackers normally.
 * Also clears the loading flag when a genuinely new message is rendered.
 */
async function onCharacterMessageRendered(mesId) {
	if (!await isEnabled() || !chat[mesId] || (chat[mesId].tracker && Object.keys(chat[mesId].tracker).length !== 0)) return;
	
	// Clear loading flag when a genuinely new message is rendered (not historical)
	if (loadingEpoch > 0 && mesId >= lastChatLengthAtLoad) {
		debug("New message detected, clearing chat loading flag");
		loadingEpoch = 0;
	}
	
	// Always skip generation in render handlers — generation is orchestrated
	// exclusively by GENERATION_AFTER_COMMANDS. Render handlers only SAVE
	// trackers that were already prepared (matched by tempTrackerId).
	log("CHARACTER_MESSAGE_RENDERED");
	await addTrackerToMessage(mesId, true);
	releaseGeneration();
	updateTrackerInterface();
}

/**
 * Event handler for when a user's message is rendered.
 * During chat loading or for historical messages: only saves prepared trackers, never generates.
 * For new messages during conversation: generates trackers normally.
 * Also clears the loading flag when a genuinely new message is rendered.
 */
async function onUserMessageRendered(mesId) {
	if (!await isEnabled() || !chat[mesId] || (chat[mesId].tracker && Object.keys(chat[mesId].tracker).length !== 0)) return;

	// Determine whether this is a genuinely NEW message (not a chat-load or
	// historical re-render) BEFORE we clear the loading flag below. Only new
	// messages are eligible for auto-generation; historical renders must never
	// fire an API call (that was the "random API call on load" class of bug).
	const isNewMessage = !(loadingEpoch > 0 && mesId < lastChatLengthAtLoad);

	// Clear loading flag when a genuinely new message is rendered (not historical)
	if (loadingEpoch > 0 && mesId >= lastChatLengthAtLoad) {
		debug("New message detected, clearing chat loading flag");
		loadingEpoch = 0;
	}

	log("USER_MESSAGE_RENDERED");

	// First, save any tracker that was already prepared for this id (unchanged
	// behavior — covers the cases where GENERATION_AFTER_COMMANDS staged one).
	await addTrackerToMessage(mesId, true);

	// If the user message STILL has no tracker, the staged path didn't prepare
	// one for it — the auto-path only ever tags the upcoming AI message (mesId+1),
	// so with target = USER/BOTH the user's own message never auto-generated.
	// Generate it here, but ONLY when: it's a genuinely new message, the chat
	// isn't loading, and target settings say the user message should be tracked.
	// shouldGenerateTracker reads message.is_user and the BOTH/USER target, so it
	// returns false for CHARACTER-only and for historical/system messages.
	const stillHasNoTracker = !(chat[mesId]?.tracker && Object.keys(chat[mesId].tracker).length !== 0);
	if (isNewMessage && stillHasNoTracker && shouldGenerateTracker(mesId, undefined)) {
		try {
			debug("User message has no prepared tracker — auto-generating for user message", { mesId });
			// Generate the tracker for THIS user message (mesId), the same anchor
			// the staged path uses via generateTracker(). generateTracker reads the
			// context up to the given message, so passing mesId produces the tracker
			// that belongs on the user's own message.
			const tracker = await generateTracker(mesId, FIELD_INCLUDE_OPTIONS.DYNAMIC);
			if (tracker) {
				chat[mesId].tracker = tracker;
				await saveChatConditional();
				TrackerPreviewManager.updatePreview(mesId);
			}
		} catch (e) {
			debug("User-message tracker auto-generation failed (non-fatal)", e);
		}
	}

	releaseGeneration();
	updateTrackerInterface();
}

async function generateAfterCombinePrompts(prompt) {
	debug("GENERATE_AFTER_COMBINE_PROMPTS", {prompt});
}

export const eventHandlers = {
	onChatChanged,
	onGenerateAfterCommands,
	onMessageReceived,
	onMessageSent,
	onCharacterMessageRendered,
	onUserMessageRendered,
	onMessageDeleted,
	generateAfterCombinePrompts
};

function updateTrackerInterface() {
	const lastMesWithTrackerId = getLastMessageWithTracker();
	const tracker = chat[lastMesWithTrackerId]?.tracker ?? {};
	if(Object.keys(tracker).length === 0) return;
	const trackerData = getTracker(tracker, extensionSettings.trackerDef, FIELD_INCLUDE_OPTIONS.ALL, false, OUTPUT_FORMATS.JSON); // Get tracker data for the last message
	const onSave = (updatedTracker) => {
		saveTracker(updatedTracker, extensionSettings.trackerDef, lastMesWithTrackerId);
	};
	const trackerInterface = new TrackerInterface();
	trackerInterface.init(trackerData, lastMesWithTrackerId, onSave);
}
