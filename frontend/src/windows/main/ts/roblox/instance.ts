import { events, filesystem, os } from '@neutralinojs/lib';
import path from 'path-browserify';
import Roblox from '.';
import { getValue } from '../../components/settings';
import { shell } from '../tools/shell';
import { isProcessAlive, sleep } from '../utils';

type EventHandler = (data?: any) => void;
type Event = 'exit' | 'gameInfo' | 'gameEvent';
export interface GameEventInfo {
	event: string;
	data: string;
}

interface Entry {
	event: string;
	match: string;
}

// code adapted from https://github.com/pizzaboxer/bloxstrap/blob/main/Bloxstrap/Integrations/ActivityWatcher.cs
const Entries: Entry[] = [
	{
		event: 'GameJoining',
		match: '[FLog::Output] ! Joining game',
	},
	{
		event: 'GameStartJoining',
		match: '[FLog::SingleSurfaceApp] launchUGCGameInternal',
	},
	{
		event: 'GameJoiningPrivateServer',
		match: '[FLog::GameJoinUtil] GameJoinUtil::joinGamePostPrivateServer',
	},
	{
		event: 'GameJoiningReservedServer',
		match: '[FLog::GameJoinUtil] GameJoinUtil::initiateTeleportToReservedServer',
	},
	{
		event: 'GameJoiningUDMUX',
		match: '[FLog::Network] UDMUX Address = ',
	},
	{
		event: 'GameJoined',
		match: '[FLog::Network] serverId:',
	},
	{
		event: 'GameDisconnected',
		match: '[FLog::Network] Time to disconnect replication data:',
	},
	{
		event: 'GameTeleporting',
		match: '[FLog::SingleSurfaceApp] initiateTeleport',
	},
	{
		event: 'GameMessage',
		match: '[FLog::Output] [BloxstrapRPC]',
	},
	{
		event: 'GameLeaving',
		match: '[FLog::SingleSurfaceApp] leaveUGCGameInternal',
	},
];

interface Pattern {
	event: string;
	regex: RegExp;
}

const Patterns: Pattern[] = [
	{
		event: 'GameJoiningEntry',
		regex: /! Joining game '([0-9a-f\-]{36})' place ([0-9]+) at ([0-9\.]+)/g,
	},
	{
		event: 'GameJoiningUDMUX',
		regex: /UDMUX Address = ([0-9\.]+), Port = [0-9]+ \| RCC Server Address = ([0-9\.]+), Port = [0-9]+/g,
	},
	{
		event: 'GameJoinedEntry',
		regex: /serverId: ([0-9\.]+)\|[0-9]+/g,
	},
	{
		event: 'GameMessageEntry',
		regex: /\[BloxstrapRPC\] (.*)/g,
	},
	{
		event: 'GameCrashEntry',
		regex: /\[FLog::CrashReportLog\] (.*)/g,
	},
];

export class RobloxInstance {
	// Where we store the events and their handlers
	private events: { [key: string]: EventHandler[] } = {};
	private gameInstance: number | null = null;
	private latestLogPath: string | null = null;
	private logsInstance: os.SpawnedProcess | null = null;
	private lastLogs = '';
	private isWatching = false;
	private onEvent: Promise<events.Response> | null = null;

	/** Adds a handler to an event */
	public on(event: Event, handler: EventHandler) {
		if (!this.events[event]) {
			this.events[event] = [];
		}
		this.events[event].push(handler);
	}

	/** Removes a handler of an event */
	public off(event: Event, handler: EventHandler) {
		if (!this.events[event]) return;

		const index = this.events[event].indexOf(handler);
		if (index !== -1) {
			this.events[event].splice(index, 1);
		}
	}

	/** Emits an event */
	public emit(event: Event, data?: any) {
		if (!this.events[event]) return;
		this.events[event].forEach((handler) => handler(data));
	}

	watchLogs: boolean;
	constructor(watch: boolean) {
		this.watchLogs = watch;
	}

	/** Initalize class values */
	public async init() {
		if (!(await Roblox.Utils.hasRoblox())) return;
	}

	/** Starts the Roblox Instance */
	public async start(url?: string) {
		if (this.gameInstance) throw new Error('An instance is already running');

		console.info('[Roblox.Instance] Opening Roblox instance');

		// Launch Roblox
		if (url) {
			await Roblox.Delegate.toggle(false);
			await shell('open', [url]);
		} else {
			await shell('open', [Roblox.path]);
		}

		await sleep(1000);
		// If block because settings can be edited and maybe it will not be boolean
		if ((await getValue<boolean>('roblox.launching.delegate')) === true) {
			await Roblox.Delegate.toggle(true);
		}

		// We find every roblox processes and get the RobloxPlayer one
		const robloxProcess = (await shell('pgrep', ['-f', 'Roblox'])).stdOut.trim().split('\n');
		for (const pid of robloxProcess) {
			const info = (await shell(`ps -p ${pid} -o command=`, [], { completeCommand: true, skipStderrCheck: true })).stdOut.trim();
			if (info.length < 2) continue;
			const processFileName = path.basename(info);
			if (processFileName === 'RobloxPlayer') {
				this.gameInstance = Number.parseInt(pid);
			}
		}

		if (this.gameInstance == null) {
			throw new Error("Couldn't find the RobloxPlayer process. Exiting launch.");
		}

		// Find the latest log file
		const logsDirectory = path.join(await os.getEnv('HOME'), 'Library/Logs/Roblox');
		let tries = 10;
		while (this.latestLogPath == null) {
			if (tries < 1) {
				throw new Error(`Couldn't find a .log file created less than 15 seconds ago in "${logsDirectory}". Stopping.`);
			}
			const latestFile = (
				await shell(`cd "${logsDirectory}" && ls -t | head -1`, [], { completeCommand: true })
			).stdOut.trim();
			const latestFilePath = path.join(logsDirectory, latestFile);
			const createdAt = (await filesystem.getStats(latestFilePath)).createdAt;
			const timeDifference = (Date.now() - createdAt) / 1000;
			if (timeDifference < 15) {
				console.info(`[Roblox.Instance] Found latest log file: "${latestFilePath}"`);
				this.latestLogPath = latestFilePath;
			} else {
				tries--;
				console.info(
					`[Roblox.Instance] Couldn't find a .log file created less than 15 seconds ago in "${logsDirectory}" (${tries}). Retrying in 1 second.`
				);
				await sleep(1000);
			}
		}

		// Read the first content, to not miss anything
		await shell(`iconv -f utf-8 -t utf-8 -c "${this.latestLogPath}" > /tmp/roblox_ablox.log`, [], { completeCommand: true });
		const content = (await shell('cat', ['/tmp/roblox_ablox.log'])).stdOut;
		// Spawns the logs watcher, and be sure that it kills any previous one
		await shell(`pkill -f "tail -f /Users/$(whoami)/Library/Logs/Roblox/"`, [], {
			completeCommand: true,
			skipStderrCheck: true,
		});
		this.logsInstance = await os.spawnProcess(`tail -f "${this.latestLogPath}" | while read line; do echo "Change"; done
`);
		console.info(`[Roblox.Instance] Logs watcher started with PID: ${this.logsInstance.pid}`);

		let isProcessing = false;
		const handler = async (evt: CustomEvent) => {
			// Ensure only one instance of the handler runs at a time
			if (isProcessing) return;
			isProcessing = true;

			try {
				// Check if the event comes from the logs watcher, and that it is stdOut
				if (!this.isWatching || !this.logsInstance || evt.detail.id !== this.logsInstance.id) return;

				if (evt.detail.action === 'exit') {
					console.warn('[Roblox.Instance] Logs watcher exited with output:', evt.detail.data);
					console.info('[Roblox.Instance] Restarting logs watcher');

					await shell(`pkill -f "tail -f /Users/$(whoami)/Library/Logs/Roblox/"`, [], {
						completeCommand: true,
						skipStderrCheck: true,
					});
					this.logsInstance = await os.spawnProcess(
						`tail -f "${this.latestLogPath}" | while read line; do echo "Change"; done`
					);
					return;
				}

				// Convert the file to ensure proper encoding
				await shell(`iconv -f utf-8 -t utf-8 -c "${this.latestLogPath}" > /tmp/roblox_ablox.log`, [], {
					completeCommand: true,
				});

				// Read the content of the converted file
				const content = (await shell('cat', ['/tmp/roblox_ablox.log'])).stdOut;

				// Process only new lines
				const contentLines = content.split('\n');
				const newContent = contentLines.filter((line) => !this.lastLogs.includes(line));

				if (newContent.length > 0) {
					await this.processLines(newContent);
					this.lastLogs = content;
				}
			} catch (error) {
				console.error('[Roblox.Instance] Error processing log file:', error);
			} finally {
				isProcessing = false;
			}
		};
		await events.off('spawnedProcess', handler);
		events.on('spawnedProcess', handler);

		await this.processLines(content.split('\n'));
		this.lastLogs = content;
		this.isWatching = true;

		const intervalId = setInterval(async () => {
			// Check if instance is still alive
			if (this.gameInstance && !(await isProcessAlive(this.gameInstance))) {
				this.gameInstance = null;
				events.off('spawnedProcess', handler);
				this.emit('exit');
				await this.cleanup();
				console.info('[Roblox.Instance] Instance is null, stopping.');
				clearInterval(intervalId);
			}
		}, 500);
	}

	private processLines(lines: string[]) {
		for (const entry of Entries) {
			const includedLines = lines.filter((line) => line.includes(entry.match));
			for (const line of includedLines) {
				this.emit('gameEvent', { event: entry.event, data: line });
			}
		}

		for (const pattern of Patterns) {
			const matchedLines = lines.filter((line) => pattern.regex.test(line));
			for (const line of matchedLines) {
				const match = line.match(pattern.regex);
				if (match) {
					this.emit('gameEvent', { event: pattern.event, data: match[0] });
				}
			}
		}
	}

	public async cleanup() {
		this.isWatching = false;
		this.onEvent = null;
		// Kill logs watcher
		shell(`pkill -f "tail -f /Users/$(whoami)/Library/Logs/Roblox/"`, [], { completeCommand: true, skipStderrCheck: true });
	}

	/** Quits Roblox */
	public async quit() {
		if (this.gameInstance == null) throw new Error("The instance hasn't be started yet");
		await this.cleanup();
		console.info('[Roblox.Instance] Quitting Roblox');
		await shell('kill -9', ['-9', this.gameInstance.toString()]);
	}
}
