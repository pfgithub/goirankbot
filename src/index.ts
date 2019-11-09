import * as Discord from "discord.js";

import * as bot from "../data/bot.json";

import { promises as fs } from "fs";

let client = new Discord.Client({ disableEveryone: true });

let goiGuild: Discord.Guild;
let rankRequestsChannel: Discord.GuildChannel;

client.on("ready", () => {
	console.log("ready");
	goiGuild = client.guilds.get(bot.server)!;
	rankRequestsChannel = goiGuild.channels.get(bot.channel)!;
});

let fn = (): false => true as false;

let waitingForReactions: { [key: string]: () => void } = {}; // who/emojiid/messageid

function reacted(o: { user: string; emoji: string; message: string }) {
	let wfrKey = o.user + "/" + o.emoji + "/" + o.message;
	let readyReason: "notready" | "ready" | "timeout" = "notready";
	waitingForReactions[wfrKey] = () => (readyReason = "ready");
	let emitFailed: () => void = () => ((readyReason = "timeout"), cleanup());
	let cleanup = () => delete waitingForReactions[wfrKey];
	return {
		done: () =>
			new Promise<"timeout" | "ready">((r, re) => {
				if (readyReason !== "notready") {
					return r(readyReason);
				}
				waitingForReactions[wfrKey] = () => (r("ready"), cleanup());
				emitFailed = () => (r("timeout"), cleanup());
			}),
		startTimeout(n: number) {
			setTimeout(() => {
				emitFailed();
			}, n);
		}
	};
}

let logFile: fs.FileHandle;
(async () => {
	logFile = await fs.open(__dirname + "/../data/givenRanks.json", "a");
	// hopefully this happens before discord connects...
})();

async function log(o: {
	ranks: string[];
	cmd: string;
	time: number;
	user: string;
	ranker: string;
	messageId: string;
}) {
	logFile.write(JSON.stringify(o, null, "\t") + "\n");
}

client.on("message", async m => {
	if (m.partial) {
		// await m.fetch(); // typescript doesn't like this without return after which is pointless
		console.log("PARTIAL MESSAGE SENT", m);
		return;
	}
	if (m.author.bot) return;
	if (m.channel.id !== bot.channel && m.channel.id !== "426520584881569821")
		return;

	try {
		let roleListToString = (roleList: string[]) =>
			roleList
				.map(rid => m.guild!.roles.get(rid)!)
				.map(r => (r.mentionable ? "@" + r.name : r.toString()));

		if (m.content.toLowerCase().startsWith("!die")) {
			await m.reply("rip");
			process.exit(1);
		}

		if (m.content.toLowerCase().startsWith("!rank")) {
			if (!m.member!.hasPermission("MANAGE_ROLES")) {
				m.reply(
					"<:err:413863986166235176> You need to be a score verifier to do that!"
				);
				return;
			}
			let [, userStr, ...rankStrArr] = m.content.replace(/ +/g, " ").split(" ");
			let userID = userStr.match(/[0-9]{16,}/);
			if (!userID) {
				await m.reply(
					"<:err:413863986166235176> Missing user. See usage in <#417907409508368394>"
				);
				return;
			}
			let giveRolesTo = m.guild!.members.get(userID[0])!;
			let rankStr = rankStrArr.join(" ");
			// eg: 00h:13m:56.202s
			// eg: 5 wins
			// eg: gold pot
			let rolesToGive: { roleID: string; proof: string }[] = [];
			let time = rankStr.match(/(?:([0-9]+?)h:)?([0-9]+?)m:([0-9]+?).([0-9]+?)s/);
			if (time) {
				let [, hrs, mins, secs, ms] = time;
				if (!hrs) hrs = "0";
				let timeNumber = +hrs * 60 * 60 * 1000 + +mins * 60 * 1000 + +secs * 1000 + +ms;
				bot.ranks.time.forEach(r => {
					let rTimeNumber =
						+r.time[0] * 60 * 60 * 1000 +
						+r.time[1] * 60 * 1000 +
						+r.time[2] * 1000 +
						+r.time[3];
					if (rTimeNumber > timeNumber) {
						rolesToGive.push({ roleID: r.id, proof: r.proof });
					}
				});
			} else if (rankStr.toLowerCase().endsWith(" wins") && rankStrArr.length === 2) {
				let [wins] = rankStrArr;
				bot.ranks.wins.forEach(w => {
					if (w.wins <= +wins) {
						rolesToGive.push({ roleID: w.id, proof: w.proof });
					}
				});
			} else {
				bot.ranks.other.forEach(w => {
					if (w.name === rankStr.toLowerCase()) {
						rolesToGive.push({ roleID: w.id, proof: w.proof });
					}
				});
			}
			if (rolesToGive.length === 0) {
				await m.reply(
					"<:err:413863986166235176> No roles. See usage in <#417907409508368394>"
				);
				return;
			}
			let rolesToGiveAfterProof: { roleID: string; proof: string }[] = [];
			let rolesAlreadyHad: string[] = [];
			for (let roleToGive of rolesToGive) {
				if (giveRolesTo.roles.has(roleToGive.roleID)) {
					rolesAlreadyHad.push(roleToGive.roleID);
					continue;
				}
				rolesToGiveAfterProof.push(roleToGive);
			}
			if (rolesToGiveAfterProof.length <= 0) {
				return await m.reply(
					"<:err:413863986166235176> All roles have already been given: " +
						roleListToString(rolesAlreadyHad)
				);
			}
			let proofRequired: { [key: string]: string[] } = {};
			rolesToGiveAfterProof.forEach(rtgap => {
				if (!proofRequired[rtgap.proof]) proofRequired[rtgap.proof] = [];
				proofRequired[rtgap.proof].push(rtgap.roleID);
			});
			let proofRequiredKeys = Object.keys(proofRequired);
			let proofRequiredEmojiNameMap: { [prkey: string]: string[] } = {};
			let proofRequiredEmojis = proofRequiredKeys.map(prkey => {
				let res =
					(bot.prooflevels as { [key: string]: string })[prkey] || bot.prooflevels["*"];
				if (!proofRequiredEmojiNameMap[res.match(/[0-9]{16,}/)![0]]) {
					proofRequiredEmojiNameMap[res.match(/[0-9]{16,}/)![0]] = [];
				}
				proofRequiredEmojiNameMap[res.match(/[0-9]{16,}/)![0]].push(prkey);
				return res;
			});
			let selProofMsg = await m.reply(`Select proofs
${proofRequiredKeys
	.map(
		(prkey, i) =>
			"> - " +
			proofRequiredEmojis[i] +
			": [" +
			prkey +
			"] for " +
			roleListToString(proofRequired[prkey])
	)
	.join("\n")}`);
			let waitForReaction = reacted({
				user: m.author.id,
				message: selProofMsg.id,
				emoji: bot.goemoji.match(/[0-9]{16,}/)![0]
			});
			for (let emoji of proofRequiredEmojis) {
				await selProofMsg.react(emoji.match(/[0-9]{16,}/)![0]);
			}
			await selProofMsg.react(bot.goemoji.match(/[0-9]{16,}/)![0]);
			waitForReaction.startTimeout(10 * 1000);
			let reactionDone = await waitForReaction.done();
			if (reactionDone === "timeout") {
				await selProofMsg.reactions.removeAll();
				return await m.reply("Too slow.");
			}
			let msgReactions = selProofMsg.reactions;
			let gaveRoles: string[] = [];
			for (let [id, reaction] of msgReactions) {
				if (reaction.users.has(m.author.id)) {
					let proofRequiredKey = proofRequiredEmojiNameMap[reaction.emoji.id!];
					if (!proofRequiredKey) {
						continue;
					}
					for (let prk of proofRequiredKey) {
						let rolesToGiveOnProof = proofRequired[prk];
						for (let roleID of rolesToGiveOnProof) {
							await giveRolesTo.roles.add(m.guild!.roles.get(roleID)!);
							gaveRoles.push(roleID);
						}
						proofRequired[prk] = [];
					}
				}
			}
			log({
				ranks: gaveRoles,
				cmd: rankStr,
				time: new Date().getTime(),
				user: giveRolesTo.id,
				ranker: m.author.id,
				messageId: m.id
			});
			let finalMsg = [];
			finalMsg.push(
				giveRolesTo.toString() +
					", " +
					m.author.toString() +
					" gave you roles " +
					roleListToString(gaveRoles) +
					"."
			);
			for (let abc of proofRequiredKeys) {
				let proofRequiredVal = proofRequired[abc];
				if (proofRequiredVal.length > -1) {
					finalMsg.push(
						"> For " +
							roleListToString(proofRequiredVal) +
							", you need to provide proof: " +
							abc
					);
				}
			}
			await m.channel.send(finalMsg.join("\n"));
			return;
		}
	} catch (e) {
		console.log(e);
		return await m.reply("A bad happened." + e);
	}
});

// only available for cached messages, no partial support
client.on("messageReactionAdd", (reaction, who) => {
	let keyStr = who.id + "/" + reaction.emoji.id + "/" + reaction.message.id;
	if (waitingForReactions[keyStr]) {
		waitingForReactions[keyStr]();
	}
});

client.login(bot.token);
