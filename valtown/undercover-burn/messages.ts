import {
  BLOCKED_ROAST_GAMES,
} from "./config.ts";

// ======================================================================
// ROAST LISTS
// ======================================================================

export const ROASTS: string[] = [
  // general
  "chat, rate this play 1-10... I'll wait, actually don't, it wasn't that deep",
  "the aim today is giving 'used controller from a garage sale'",
  "that death was so avoidable even the enemy team felt bad for a second",
  "not the streamer blaming ping for a decision made with their eyes closed",
  "bro really said 'trust me' and then immediately did not trust himself",
  "the confidence:skill ratio in this chat is genuinely unmatched",
  "that was a bold strategy, let's see if it pays off (it did not)",
  "certified 'I meant to do that' moment right there",
  "the reaction time on that was measured in geological eras",
  "somewhere a coach is watching this and quietly resigning",
  "that rotation was so late it should send an apology email",
  "10/10 decision making, 0/10 execution, math ain't mathing",
  "chat's been carrying this stream harder than the actual gameplay",
  "we just witnessed a masterclass in how NOT to do that",
  "the mechanical skill is there, the game sense took the day off",
  "that clip is going straight to the 'why we can't have nice things' folder",
  "put some respect on that death, it was truly a group effort",
  "the confidence going in vs the silence coming out, incredible arc",
  "not gonna lie that was almost impressive in how wrong it went",
  "someone check on the keyboard, it did not deserve that",
  "that build path had less direction than a GPS with no signal",
  "chat gave better advice in the last five seconds than that whole death",
  "the ultimate got used like a fire alarm during a pop quiz",
  "you could see that punish coming from three towns over",
  "the itemization on this run screams 'first day back from vacation'",
  "that dodge roll rolled straight into the enemy's open arms",
  "the map awareness just clocked out early today",
  "not the streamer discovering gravity the hard way, again",
  "that combo dropped faster than a hot mic during a rant",
  "the positioning there was less 'strategic retreat' more 'wrong turn'",
  "somewhere a tutorial NPC is filing a formal complaint",
  "the cooldown management is giving 'forgot I own abilities'",
  "that was less a clutch play and more a cry for help",
  "the resource management just declared bankruptcy",
  "chat's collective sigh could be heard from orbit",
  "the target priority list apparently starts with 'whoever's scariest'",
  "that flick shot flicked absolutely nowhere useful",
  "the game plan lasted exactly as long as the loading screen",
  "somebody wake the minimap up, it's clearly asleep on the job",
  "the risk assessment here reads 'send it and hope for the best'",
  "that was a 200 IQ play trapped in a 2 IQ execution",
  "the enemy team is sending a thank-you card as we speak",
  "positioning like that belongs in a highlight reel of what not to do",
  "the ult charge just got donated straight to the other team",
  "that peek was bolder than the read that justified it",
  "chat's been calling the death before it even happens now",
  "the muscle memory clearly took today off",
  "that engage had all the confidence and none of the plan",
  "the fog of war couldn't hide that from being a bad idea",
  "somewhere a speedrunner is weeping at that route choice",
  "that play aged like milk in direct sunlight",
  "the skill gap just filed for divorce from the confidence",
  "watching that death was more painful than the death itself",
  "that's not a strategy, that's a cry for help with extra steps",
  "the enemy didn't outplay you, you just outperformed yourself at losing",
  "that decision should come with a warning label",
  "chat's seen better game sense from the loading screen tips",
  "the only thing that combo landed was disappointment",
  "that was less 'big brain' more 'no brain'",
  "somebody revoke the controller privileges",
  "the reaction time just applied for early retirement",
  "that play belongs in a museum under 'ancient mistakes'",
  "the only clutch happening here is how hard you're clutching defeat",
  "that read was so wrong it looped back around to impressive",
  "the sensitivity settings weren't the problem, the hand was",
  "that rotation had zero survivors, including the plan itself",
  "somewhere a strategist just closed their laptop in disgust",
  "the awareness check bounced like a bad payment",
  "that trade was so lopsided the scale filed a complaint",
  "the cooldown timer laughed harder than chat did",
  "the callouts were accurate, the follow-through was fiction",
  "somebody left the game sense in the other tab",
  "that was a whole tutorial on what not to press",
  "the enemy's highlight reel just got a free submission",
  "that dash went the scenic route straight into disaster",
  "chat predicted that death with better accuracy than a weather app",
  "the hitbox didn't betray you, the decision did",
  "that ability got saved for a fight that never needed it",
  "the plan had a great first half and no second half",
  "somewhere a analyst is drawing an X through that whole sequence",
  "that was less 'outplay' more 'self-report'",
  "the confidence was rented, not owned, and it's due back",
  "that push had the pacing of a horror movie's dumbest character",
  "the game clock kept moving, unlike that decision-making process",
  "that flank got flanked by its own timing",
  "somebody's aim assist just filed for unemployment",
  "the macro game logged off five minutes before the micro did",
  "that was a whole speedrun of bad choices, personal best even",
  "the enemy jungler thanks you for the complimentary kill",
  "that reset button got smashed harder than the actual gameplay",
  "chat's morale just took more damage than the actual character",
  "the positioning screamed for help and nobody answered",
  "that was 0% plan, 100% vibes, and the vibes lost",
  "the enemy didn't need a strategy, you handed them one",
  "somewhere a replay analyst is taking notes titled 'do not attempt'",
  "that trade rate makes the stock market look stable",
  "that performance just got added to the enemy team's highlight reel, unpaid",
  "the only thing sharper than that death was the silence right after",
  "somewhere a bot in ranked is outperforming that decision tree",
  "that was a full tactical collapse dressed up as a 'read'",
  "the skill issue alarm just went off and nobody's turning it off",
  "chat's been more strategic typing 'L' than that whole engage was",
  "that was death by a thousand bad choices, all self-inflicted",
  "the enemy didn't win that fight, you handed them the trophy and a speech",
  "somewhere a hardstuck smurf is taking notes on what not to do",
  "that ability rotation had the coordination of a dropped call",
  "the only 'clutch' in that clip is how tightly you're clutching the L",
  "that engage was a hostage negotiation and the hostage was your own team",
  "chat's seen worse, once, in a highlight reel titled 'never again'",
  "the game sense didn't just take a day off, it filed for permanent leave",
  "that was a full commitment to a plan that never existed",
  "somewhere a coach is drafting a resignation letter mid-VOD review",
  "the enemy's MVP vote just wrote itself because of that",
  "that decision had the shelf life of milk left in a hot car",
  "chat's collectively aged five years watching that unfold",
  "the only thing that combo combo'd was the disappointment stacking up",
  "that was less a mistake and more a full personality trait at this point",
  "somebody's about to get out-aimed by the tutorial dummy at this rate",
  "the read was wrong, the execution was worse, truly a package deal",
  "that fight had one loser and it wasn't a coin flip",
  "the enemy's replaying that clip in their head every night now, happily",
  "that play should get studied in a 'how to lose friends' seminar",
  "somewhere the scoreboard is actively embarrassed on your behalf",
  "that engage timing was so far off it needs its own timezone",
  "the confidence walked in, the skill never showed up to back it",
  "chat's not mad, chat's just disappointed, which honestly hits harder",
  "that was a full-send with nothing behind it but vibes and regret",
  "the enemy team's group chat is just that clip on loop right now",
  // mario-flavored
  "that fall took longer than Mario's descent into a bottomless pit, and hurt just as much",
  "you handled that pressure about as well as Bowser handles parenting",
  "that death was giving 'touched a Goomba on day one' energy",
  "the panic there was pure 'lost your last life on World 8-4' vibes",
  "that decision had the foresight of running straight into a Koopa shell",
  "somewhere a 1-Up mushroom is rolling its eyes at that wasted life",
  "that was less 'star power' more 'star-shaped regret'",
  "the timing on that jump belonged in a blooper reel from the Mushroom Kingdom",
  "chat's been more useful than a Lakitu cloud in a pinch, and that's not saying much",
  "that combo had all the coordination of a Koopa Troopa on roller skates",
  "somewhere a Piranha Plant just got an easier kill than it deserved",
  "that read was as blind as walking into a warp pipe with your eyes closed",
  "the item management there was giving 'held the mushroom the whole level and never used it'",
  "that fall damage hurt more than a Thwomp with a grudge",
  "somewhere Toad is standing at a castle door shaking his head",
  "that was a Game Over screen with extra steps and zero continues left",
  "the reflexes there belonged to someone still on World 1-1 after three hours",
  "somewhere Peach is writing another letter, this time it's just 'why'",
  "that jump had the confidence of a Star and the hitbox of a regular Mario",
  "you just donated a free life to Bowser's cause, congratulations",
  "that was a full Bowser's Castle run with none of the fire flowers used correctly",
  "the coin count on that decision-making was firmly negative",
  "somewhere Luigi is relieved it wasn't him this time",
  "that pipe-timing was so off it warped straight into the wrong dimension",
  "the boss pattern was memorized by everyone except the person fighting it",
];

export function getRandomRoast(): string {
  return ROASTS[Math.floor(Math.random() * ROASTS.length)];
}

// Roasts aimed at a specific chatter. {name} is replaced with their display name.
export const CHATTER_ROASTS: string[] = [
  "@{name} has been in chat this whole time and the biggest contribution so far is vibes",
  "@{name} typing like backseat gaming is in their blood and zero clips to show for it",
  "@{name} is out here giving advice with the confidence of someone who's never touched the game",
  "@{name} your chat presence is giving 'lurker who finally had a thought'",
  "@{name} is the kind of chatter who calls the play right after it happens",
  "@{name} has the energy of a Toad who insists he could take Bowser",
  "@{name} showed up to chat like a Goomba: loud, small, and about to get stomped",
  "@{name} typing with the speed of a Koopa Troopa on a slow day",
  "@{name} is one bad take away from losing a 1-Up in this chat",
  "@{name} you talk a big game for someone who'd fall in the first pit of World 1-1",
  "@{name} has main character energy and NPC dialogue options",
  "@{name} is the reason we can't have a peaceful chat, and honestly we love it",
  "@{name} would 100% grab the Fire Flower and then walk into the first Goomba anyway",
  "@{name} chat took a vote and your hot takes are officially lukewarm",
  "@{name} the only thing faster than your typing is how fast your opinions change",
  "@{name} called the strategy 'obvious' and has yet to explain a single step",
  "@{name} is the Lakitu of chat: hovering above it all and throwing things down",
  "@{name} brought a pool noodle to a Bowser fight and is still confident about it",
  "@{name} has never once been wrong in their own mind, and that's the real power-up",
  "@{name} typing 'gg' like they were on the team",
  "@{name} congrats, you're this chat's designated backseat expert of the hour",
  "@{name} put more effort into that message than the stream put into that last play",
  "@{name} is proof that a Super Star doesn't fix bad decision-making",
  "@{name} your chat game is strong, your aim would be a whole different story",
  "@{name} spotted in chat: big opinions, small hitbox",
];

// Ad break messages. {length} is replaced with e.g. "90 seconds".
export const AD_START_MESSAGES: string[] = [
  "📺 Ad break! {length} of ads incoming. Stretch, hydrate, and don't let Bowser steal your snacks.",
  "Commercial break! The stream is warping out for {length}. Chat, hold the castle till it's back.",
  "{length} of ads, aka the Mushroom Kingdom intermission. Grab a 1-Up (water) and come back.",
  "Ads rolling for {length}. Perfect time to stand up before your legs turn into Goombas.",
  "Ad break for {length}. UndercoverBurn is keeping watch on chat while you're gone 🥸",
];

// Posted AD_WARNING_LEAD_MS before a scheduled ad. {secs} is the countdown.
export const AD_WARNING_MESSAGES: string[] = [
  "📺 Heads up chat: ads in about {secs} seconds, running {length}. Refill that drink, grab a snack, hit the warp pipe.",
  "Ad break incoming in ~{secs} seconds ({length}). Stretch now before your legs turn into Goombas.",
  "⏳ Ads roll in {secs} seconds and last {length}. Bowser's sponsors are on deck, go hydrate.",
  "Ads in about {secs} seconds for {length}. UndercoverBurn will hold the castle 🥸",
];

export const AD_END_MESSAGES: string[] = [
  "Ads are over, welcome back! 🍄",
  "And we're back! Hope you hydrated, chat.",
  "Ad break's done. Warp pipe's open, everybody back in.",
  "Welcome back from the ads! Did we miss anything? (we did not, it was ads)",
  "Commercials cleared. Level resumed, lives intact. Mostly.",
];

export function pick(list: string[]): string {
  return list[Math.floor(Math.random() * list.length)];
}

export function formatAdLength(seconds: number): string {
  if (seconds <= 0) return "a few moments";
  if (seconds < 60) return `${seconds} seconds`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  const mins = `${m} minute${m === 1 ? "" : "s"}`;
  return s ? `${mins} ${s} seconds` : mins;
}

export function getChatterRoast(name: string): string {
  const template =
    CHATTER_ROASTS[Math.floor(Math.random() * CHATTER_ROASTS.length)];
  return template.replaceAll("{name}", name);
}

// True when roasts should be suppressed for this Twitch category.
export function isRoastBlocked(gameName: string | null): boolean {
  if (!gameName) return false;
  const name = gameName.trim().toLowerCase();
  return BLOCKED_ROAST_GAMES.some((g) => g.trim().toLowerCase() === name);
}
