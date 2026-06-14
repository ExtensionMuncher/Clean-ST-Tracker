import { chat } from "../../../../../script.js";
import { selected_group, is_group_generating } from "../../../../../scripts/group-chats.js";
import { debug, getLastMessageWithTracker, getLastNonSystemMessageIndex, log } from "../lib/utils.js";
import { isEnabled } from "./settings/settings.js";
import { prepareMessageGeneration, addTrackerToMessage, clearInjects } from "./tracker.js";
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
	if (!enabled || chat.length == 0 || dryRun || isChatLoading() || (selected_group && !is_group_generating) || (typeof type != "undefined" && !["normal","continue", "swipe", "regenerate", "impersonate", "group_chat"].includes(type))) {
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
	
	// Clear loading flag when a genuinely new message is rendered (not historical)
	if (loadingEpoch > 0 && mesId >= lastChatLengthAtLoad) {
		debug("New message detected, clearing chat loading flag");
		loadingEpoch = 0;
	}
	
	// Always skip generation in render handlers — generation is orchestrated
	// exclusively by GENERATION_AFTER_COMMANDS. Render handlers only SAVE
	// trackers that were already prepared (matched by tempTrackerId).
	log("USER_MESSAGE_RENDERED");
	await addTrackerToMessage(mesId, true);
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
