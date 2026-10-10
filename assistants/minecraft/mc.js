/* Minecraft Assistant: one engine for both editions.
   The page sets window.MC_EDITION to 'bedrock' or 'java' before loading this file.
   Bedrock covers every Bedrock platform and Minecraft Realms. */
(function () {
const ED = window.MC_EDITION === 'java' ? 'java' : 'bedrock';
const J = ED === 'java', B = !J;
const ED_NAME = J ? 'Java Edition' : 'Bedrock Edition';
const OTHER = J ? 'bedrock' : 'java';
document.body.classList.add(ED);

/* ================= DATA ================= */

/* Commands: [name, java syntax or null, bedrock syntax or null, what it does] */
const COMMANDS = [
['gamemode','/gamemode <survival|creative|adventure|spectator> [player]','/gamemode <survival|creative|adventure|spectator|default> [player]','Change game mode. Bedrock also takes s, c, a and 0, 1, 2.'],
['difficulty','/difficulty <peaceful|easy|normal|hard>','/difficulty <peaceful|easy|normal|hard>','Change difficulty. Bedrock also takes p, e, n, h.'],
['time','/time set <day|noon|night|midnight|ticks>\n/time add <ticks>\n/time query <daytime|gametime|day>','/time set <day|noon|sunrise|sunset|night|midnight|ticks>\n/time add <ticks>\n/time query <daytime|gametime|day>','Set or read the time of day. A full day is 24000 ticks; day = 1000, night = 13000.'],
['weather','/weather <clear|rain|thunder> [duration]','/weather <clear|rain|thunder> [duration]','Change the weather.'],
['toggledownfall',null,'/toggledownfall','Start or stop rain.'],
['alwaysday / daylock',null,'/alwaysday [true|false]\n/daylock [true|false]','Freeze the clock at day. Same as /gamerule dodaylightcycle false at noon.'],
['tp / teleport','/tp <destination>\n/tp <targets> <x> <y> <z> [yaw] [pitch]\n/tp <targets> <x> <y> <z> facing <x> <y> <z>','/tp <destination>\n/tp <targets> <x> <y> <z> [yRot] [xRot] [checkForBlocks]\n/tp <targets> <x> <y> <z> facing <x> <y> <z>','Teleport. ~ is relative to you, ^ is relative to where you look.'],
['give','/give <targets> <item>[components] [count]','/give <player> <item> [amount] [data] [components]','Give items. Java item IDs take a minecraft: prefix (optional) and [component] data; Bedrock takes a data value and JSON components such as can_place_on.'],
['clear','/clear [targets] [item] [maxCount]','/clear [player] [item] [data] [maxCount]','Remove items from inventories.'],
['enchant','/enchant <targets> <enchantment> [level]','/enchant <player> <enchantment> [level]','Enchant the held item. Only levels and items the enchantment allows.'],
['effect','/effect give <targets> <effect> [seconds|infinite] [amplifier] [hideParticles]\n/effect clear [targets] [effect]','/effect <player> <effect> [seconds|infinite] [amplifier] [hideParticles]\n/effect <player> clear [effect]','Give or clear status effects. Amplifier 0 is level I.'],
['xp / experience','/xp add <targets> <amount> [points|levels]\n/xp set <targets> <amount> [points|levels]\n/xp query <targets> <points|levels>','/xp <amount> [player]\n/xp <amount>L [player]','Give experience. On Bedrock, add L for levels; a negative level amount removes levels.'],
['kill','/kill [targets]','/kill [target]','Kill entities. /kill with no target kills you.'],
['summon','/summon <entity> [x y z] [nbt]','/summon <entity> [x y z] [spawnEvent] [nameTag]','Spawn an entity.'],
['setblock','/setblock <x y z> <block> [destroy|keep|replace]','/setblock <x y z> <block> [blockStates] [destroy|keep|replace]','Place one block.'],
['fill','/fill <from> <to> <block> [destroy|hollow|keep|outline|replace [filter]]','/fill <from> <to> <block> [blockStates] [destroy|hollow|keep|outline|replace [filter]]','Fill a box with a block. Java limits a fill to 32768 blocks.'],
['clone','/clone <begin> <end> <destination> [replace|masked] [force|move|normal]','/clone <begin> <end> <destination> [replace|masked] [force|move|normal]','Copy a region of blocks.'],
['locate','/locate structure <structure>\n/locate biome <biome>\n/locate poi <poi>','/locate structure <structure> [useNewChunksOnly]\n/locate biome <biome>','Find the nearest structure or biome. Java IDs look like village_plains or the tag #village; Bedrock uses names like village, ancient_city, trial_chambers.'],
['spawnpoint','/spawnpoint [targets] [x y z] [angle]','/spawnpoint [player] [x y z]','Set a player\'s respawn point.'],
['clearspawnpoint',null,'/clearspawnpoint [player]','Reset a player to world spawn.'],
['setworldspawn','/setworldspawn [x y z] [angle]','/setworldspawn [x y z]','Set world spawn.'],
['gamerule','/gamerule <rule> [value]','/gamerule <rule> [value]','Read or change a rule. See the game rules list below.'],
['seed','/seed',null,'Show the world seed. On Bedrock the seed is in the world settings screen.'],
['execute','/execute as|at|positioned|if|unless|store … run <command>','/execute as|at|positioned|if|unless … run <command>','Run a command as or at other entities, or only when a condition holds. Bedrock has used this same style since 1.19.50.'],
['function','/function <name>','/function <name>','Run a .mcfunction file from a data pack (Java) or behavior pack (Bedrock).'],
['scoreboard','/scoreboard objectives|players …','/scoreboard objectives|players …','Scores, counters and sidebars.'],
['tag','/tag <targets> add|remove|list <name>','/tag <targets> add|remove|list <name>','Label entities so selectors can find them, e.g. @e[tag=boss].'],
['title','/title <targets> title|subtitle|actionbar <text component>','/title <player> title|subtitle|actionbar <text>\n/titleraw <player> title <raw json>','Big text on screen.'],
['tellraw','/tellraw <targets> <text component>','/tellraw <player> <raw json>','Formatted chat message.'],
['say / msg / me','/say <message>\n/msg <player> <message>\n/me <action>','/say <message>\n/msg <player> <message>\n/me <action>','Chat. /tell and /w are aliases of /msg.'],
['playsound / stopsound','/playsound <sound> <source> <targets> [pos] [volume] [pitch]','/playsound <sound> [player] [pos] [volume] [pitch]','Play a sound.'],
['particle','/particle <name> [pos] …','/particle <effect> [pos]','Show particles.'],
['spreadplayers','/spreadplayers <center> <spreadDistance> <maxRange> <respectTeams> <targets>','/spreadplayers <x> <z> <spreadDistance> <maxRange> <targets>','Scatter players across an area.'],
['ride','/ride <target> mount <vehicle>\n/ride <target> dismount','/ride <riders> start_riding <ride>\n/ride <riders> stop_riding','Put entities on mounts.'],
['damage','/damage <target> <amount> [damageType] …','/damage <target> <amount> [cause] …','Hurt an entity by a set amount.'],
['team','/team add|join|leave|modify …',null,'Teams with colours, friendly fire and name-tag rules.'],
['bossbar','/bossbar add|set|remove …',null,'Custom boss bars.'],
['worldborder','/worldborder set|center|add …',null,'Shrink or grow the world border.'],
['forceload','/forceload add <from> [to]',null,'Keep chunks loaded without a player nearby.'],
['tickingarea',null,'/tickingarea add <from> <to> [name] [preload]\n/tickingarea add circle <center> <radius> [name]','Keep an area loaded without a player nearby. Up to 10 per world.'],
['data','/data get|merge|modify|remove …',null,'Read and change NBT on blocks, entities and storage.'],
['attribute','/attribute <target> <attribute> get|base|modifier …',null,'Change max health, speed, reach, scale and other attributes.'],
['item','/item replace entity|block … with <item>',null,'Put an item in a specific slot.'],
['replaceitem',null,'/replaceitem entity <target> <slot> <slotId> <item> [amount]','Put an item in a specific slot.'],
['place','/place feature|structure|jigsaw|template …',null,'Generate a feature or structure.'],
['structure',null,'/structure save|load|delete <name> …','Save and load structures in the world.'],
['tick','/tick freeze|unfreeze|rate|step|sprint …',null,'Slow, freeze or speed up the game. Great for testing redstone.'],
['random','/random value|roll <range>',null,'Roll a random number.'],
['camera',null,'/camera <player> set|fade|clear …','Move a player\'s camera for cutscenes.'],
['hud',null,'/hud <player> hide|reset [element]','Hide parts of the HUD.'],
['fog',null,'/fog <player> push|pop|remove <fogId> <userId>','Change fog settings.'],
['spectate','/spectate [target] [player]',null,'Follow another entity in spectator mode.'],
['trigger','/trigger <objective> [add|set <value>]',null,'Lets non-ops change a trigger scoreboard. Used by data packs.'],
['list','/list [uuids]','/list','Who is online.'],
['op / deop','/op <player>\n/deop <player>','/op <player>\n/deop <player>','Give or take operator rights. On a Realm, use the member list in Realm settings instead.'],
['kick','/kick <targets> [reason]','/kick <player> [reason]','Kick a player.'],
['ban / pardon','/ban <targets> [reason]\n/pardon <player>',null,'Server bans. Bedrock Dedicated Server uses the allowlist instead.'],
['whitelist / allowlist','/whitelist on|off|add|remove|list','/allowlist add|remove|list|on|off','Only let listed players join (dedicated servers).'],
['reload','/reload','/reload','Reload data packs (Java) or functions and scripts (Bedrock).']
];

/* Game rules: [java name, bedrock name, default, what it does] */
const GAMERULES = [
['keepInventory','keepinventory','false','Keep items and XP when you die.'],
['doDaylightCycle','dodaylightcycle','true','Time moves. Set false to freeze the clock.'],
['doWeatherCycle','doweathercycle','true','Weather changes.'],
['doMobSpawning','domobspawning','true','Mobs spawn naturally.'],
['mobGriefing','mobgriefing','true','Creepers break blocks, endermen pick them up, and so on.'],
['doFireTick','dofiretick','true','Fire spreads and burns out.'],
['doInsomnia','doinsomnia','true','Phantoms spawn when you skip sleep.'],
['doImmediateRespawn','doimmediaterespawn','false','Skip the death screen.'],
['naturalRegeneration','naturalregeneration','true','Health regenerates when fed.'],
['randomTickSpeed','randomtickspeed','3 (Java) / 1 (Bedrock)','How fast crops grow and leaves decay. Bedrock\'s 1 is roughly Java\'s 3.'],
['playersSleepingPercentage','playerssleepingpercentage','100','Share of players that must sleep to skip the night.'],
['spawnRadius','spawnradius','10 (Java) / 5 (Bedrock)','How far from world spawn new players appear.'],
['commandBlockOutput','commandblockoutput','true','Command blocks post to chat.'],
['sendCommandFeedback','sendcommandfeedback','true','Commands post results to chat.'],
['showDeathMessages','showdeathmessages','true','Death messages in chat.'],
[null,'showcoordinates','false','Show your coordinates on screen. Also a world setting.'],
[null,'showdaysplayed','false','Show the day count on screen.'],
[null,'pvp','true','Players can hurt each other.'],
['reducedDebugInfo',null,'false','Hide coordinates on the F3 screen.'],
['announceAdvancements',null,'true','Advancements post to chat.']
];

const SELECTORS = [
['@p','Nearest player'],['@a','All players'],['@r','A random player'],['@s','You (whoever runs the command)'],['@e','All entities'],
[J ? '@n' : null,'Nearest entity'],[B ? '@initiator' : null,'The player talking to an NPC']
].filter(s => s[0]);

/* Edition differences: [topic, java, bedrock] */
const DIFFS = [
['Where it runs','Windows, macOS and Linux.','Windows, Xbox, PlayStation, Nintendo Switch, iOS, Android and more. One purchase per platform family.'],
['Crossplay','Java players only.','Every Bedrock platform together, on worlds, Realms and featured servers.'],
['Coordinates','F3 debug screen.','Turn on Show Coordinates in world settings, or /gamerule showcoordinates true.'],
['Mods and content','Mods (Fabric, NeoForge, Forge), data packs, resource packs and shader mods.','Add-ons (behavior and resource packs), Marketplace content and built-in Vibrant Visuals graphics.'],
['Combat','Attack cooldown since 1.9: wait for the bar to fill. Sweeping Edge exists.','No attack cooldown, so faster clicks hit more. No Sweeping Edge.'],
['Impaling','Extra damage to aquatic mobs only.','Extra damage to any mob standing in water or rain.'],
['Redstone','Quasi-connectivity and block-update detectors. Very predictable timing.','No quasi-connectivity. Pistons can move chests and furnaces. Some timings vary, so test contraptions from Java tutorials before copying them.'],
['Mob spawning','Mobs spawn up to 128 blocks from players and despawn past that.','Mobs spawn much closer, about 24 to 44 blocks from you, within the simulation distance. Farm designs differ.'],
['Slime chunks','Depend on the world seed.','The same in every world: they depend only on chunk coordinates.'],
['Loading chunks','Spawn chunks and /forceload.','No spawn chunks. Use /tickingarea, up to 10 per world.'],
['Seeds','Since 1.18 a seed gives largely the same terrain and biomes on both editions.','Same terrain since 1.18, but some structures land in different places.'],
['Game rules','camelCase names (keepInventory); newer versions use snake_case like keep_inventory. Press Tab to check.','lowercase names (keepinventory).'],
['Servers','Run your own server.jar, rent a host, or use Realms for Java.','Realms, featured servers, Bedrock Dedicated Server, and community servers on PC and mobile.'],
['Hosting with friends','Open to LAN, or Realms for Java.','Join through Xbox friends, LAN, or a Bedrock Realm.']
];

/* Brewing. base: what you add it to. */
const POTIONS = [
['Awkward Potion','Nether Wart','Water Bottle','Base for almost everything.',''],
['Swiftness','Sugar','Awkward','Speed I, 3:00','extend, strengthen'],
['Leaping','Rabbit\'s Foot','Awkward','Jump Boost I, 3:00','extend, strengthen'],
['Healing','Glistering Melon Slice','Awkward','Instant Health I','strengthen'],
['Poison','Spider Eye','Awkward','Poison I, 0:45','extend, strengthen'],
['Water Breathing','Pufferfish','Awkward','3:00','extend'],
['Fire Resistance','Magma Cream','Awkward','3:00','extend'],
['Night Vision','Golden Carrot','Awkward','3:00','extend'],
['Strength','Blaze Powder','Awkward','Strength I, 3:00','extend, strengthen'],
['Regeneration','Ghast Tear','Awkward','Regeneration I, 0:45','extend, strengthen'],
['Turtle Master','Turtle Shell','Awkward','Slowness IV + Resistance III, 0:20','extend, strengthen'],
['Slow Falling','Phantom Membrane','Awkward','1:30','extend'],
['Wind Charged','Breeze Rod','Awkward','Releases a wind burst on death','' ],
['Weaving','Cobweb','Awkward','Leaves cobwebs on death',''],
['Oozing','Slime Block','Awkward','Spawns slimes on death',''],
['Infested','Stone','Awkward','Spawns silverfish when hurt',''],
['Weakness','Fermented Spider Eye','Water Bottle','Weakness I, 1:30. Needed to cure zombie villagers.','extend'],
['Harming','Fermented Spider Eye','Healing or Poison','Instant Damage I','strengthen'],
['Slowness','Fermented Spider Eye','Swiftness or Leaping','Slowness I, 1:30','extend, strengthen'],
['Invisibility','Fermented Spider Eye','Night Vision','3:00','extend']
];
const MODIFIERS = [
['Redstone Dust','Extends the duration. Removes the level II upgrade.'],
['Glowstone Dust','Level II, shorter duration. Removes the extension.'],
['Gunpowder','Splash potion: throw it.'],
['Dragon\'s Breath','Splash to Lingering: leaves a cloud.'],
['Blaze Powder','Fuel. One powder brews 20 times.']
];

/* Enchantments: [name, max level, items, notes, 'j' java only | 'b' bedrock only | '', treasure] */
const ENCHANTS = [
['Protection',4,'Armor','General damage reduction. Conflicts with the other Protections.','',0],
['Fire Protection',4,'Armor','Fire and lava damage, shorter burn time.','',0],
['Blast Protection',4,'Armor','Explosions and knockback from them.','',0],
['Projectile Protection',4,'Armor','Arrows, tridents, fireballs.','',0],
['Feather Falling',4,'Boots','Less fall damage.','',0],
['Depth Strider',3,'Boots','Walk faster underwater. Conflicts with Frost Walker.','',0],
['Frost Walker',2,'Boots','Freezes water under you.','',1],
['Soul Speed',3,'Boots','Faster on soul sand and soul soil. Bartered from piglins.','',1],
['Swift Sneak',3,'Leggings','Faster while sneaking. Ancient City chests only.','',1],
['Respiration',3,'Helmet','Breathe longer underwater.','',0],
['Aqua Affinity',1,'Helmet','Mine at full speed underwater.','',0],
['Thorns',3,'Armor','Hurts attackers. Costs extra durability.','',0],
['Sharpness',5,'Sword, Axe','More melee damage. Conflicts with Smite and Bane.','',0],
['Smite',5,'Sword, Axe, Mace','More damage to undead.','',0],
['Bane of Arthropods',5,'Sword, Axe, Mace','More damage to spiders, bees, silverfish and endermites.','',0],
['Knockback',2,'Sword','Pushes mobs back.','',0],
['Fire Aspect',2,'Sword, Mace','Sets the target on fire. Cooked drops.','',0],
['Looting',3,'Sword','More mob drops.','',0],
['Sweeping Edge',3,'Sword','More sweep-attack damage.','j',0],
['Efficiency',5,'Pickaxe, Shovel, Axe, Hoe, Shears','Mine faster.','',0],
['Silk Touch',1,'Pickaxe, Shovel, Axe, Hoe','Blocks drop themselves. Conflicts with Fortune.','',0],
['Fortune',3,'Pickaxe, Shovel, Axe, Hoe','More ore and crop drops.','',0],
['Unbreaking',3,'Anything with durability','Uses durability less often.','',0],
['Mending',1,'Anything with durability','XP orbs repair the item. Get it from librarians, fishing or chests.','',1],
['Power',5,'Bow','More arrow damage.','',0],
['Punch',2,'Bow','Arrow knockback.','',0],
['Flame',1,'Bow','Flaming arrows.','',0],
['Infinity',1,'Bow','One arrow lasts forever. Conflicts with Mending.','',0],
['Multishot',1,'Crossbow','Fires three arrows. Conflicts with Piercing.','',0],
['Piercing',4,'Crossbow','Arrows go through mobs.','',0],
['Quick Charge',3,'Crossbow','Load faster.','',0],
['Loyalty',3,'Trident','Comes back after a throw. Conflicts with Riptide.','',0],
['Riptide',3,'Trident','Launches you in water or rain.','',0],
['Channeling',1,'Trident','Calls lightning in a thunderstorm.','',0],
['Impaling',5,'Trident','Java: aquatic mobs. Bedrock: any mob in water or rain.','',0],
['Luck of the Sea',3,'Fishing Rod','Better fishing loot.','',0],
['Lure',3,'Fishing Rod','Bites come sooner.','',0],
['Density',5,'Mace','More smash damage per block fallen.','',0],
['Breach',4,'Mace','Ignores part of the target\'s armor.','',0],
['Wind Burst',3,'Mace','Bounces you up after a smash attack. Ominous vaults only.','',1],
['Curse of Binding',1,'Armor','Can\'t take it off until you die.','',1],
['Curse of Vanishing',1,'Anything','Item disappears when you die.','',1]
];

/* Ores since 1.18: [ore, best Y, range, notes] */
const ORES = [
['Diamond','-58','-64 to 16','Most common near the bottom of the world. Branch-mine at Y -58 to -54 to stay above the bedrock layers, and avoid lava.'],
['Ancient Debris','15','8 to 22 (Nether)','Almost always buried. Blast with TNT (or beds, carefully) at Y 15, or strip-mine there.'],
['Iron','16 and 232','-64 to 320','Two peaks: in caves around Y 16, and high in mountains.'],
['Gold','-16','-64 to 32','Badlands have extra gold at any height. Nether gold ore drops nuggets.'],
['Redstone','-59','-64 to 16','Deep down, like diamonds.'],
['Lapis Lazuli','0','-64 to 64','Needed for enchanting.'],
['Copper','48','-16 to 112','Dripstone caves are full of it.'],
['Coal','96','0 to 320','Everywhere above ground and in shallow caves.'],
['Emerald','232','-16 to 320','Mountain biomes only. Or trade with villagers.'],
['Nether Quartz','anywhere','10 to 117 (Nether)','Common everywhere in the Nether.']
];

/* Guides. j / b fields add edition-specific lines. */
const GUIDES = [
{id:'start',title:'Your first night',blurb:'From punching trees to a safe bed.',body:`
<label class="chk"><input type="checkbox" data-k="s1"> Punch a tree for logs, make planks, sticks and a crafting table.</label>
<label class="chk"><input type="checkbox" data-k="s2"> Wooden pickaxe, then cobblestone for stone tools.</label>
<label class="chk"><input type="checkbox" data-k="s3"> Kill three sheep for wool, or find a village bed.</label>
<label class="chk"><input type="checkbox" data-k="s4"> Coal or charcoal for torches. Smelt logs in a furnace for charcoal.</label>
<label class="chk"><input type="checkbox" data-k="s5"> Wall yourself in, or dig into a hillside, before sunset.</label>
<label class="chk"><input type="checkbox" data-k="s6"> Sleep in a bed to set your spawn and skip the night.</label>
<label class="chk"><input type="checkbox" data-k="s7"> Note your base coordinates on the <a href="#coords">Coordinates</a> page.</label>`,
j:'Press F3 to see your coordinates and the direction you face.',
b:'Turn on Show Coordinates in world settings before you wander off.'},
{id:'mining',title:'Mining and diamonds',blurb:'Iron gear, then diamonds at Y -58.',body:`
<label class="chk"><input type="checkbox" data-k="m1"> Smelt iron for a pickaxe, sword, shield and a bucket.</label>
<label class="chk"><input type="checkbox" data-k="m2"> Carry a water bucket: it puts out lava and breaks falls.</label>
<label class="chk"><input type="checkbox" data-k="m3"> Branch-mine at Y -58: tunnels two blocks apart, three blocks gap.</label>
<label class="chk"><input type="checkbox" data-k="m4"> Find 3 diamonds for a pickaxe, then 5 more for an enchanting table (with obsidian and a book).</label>
<label class="chk"><input type="checkbox" data-k="m5"> Mine obsidian with the diamond pickaxe: 10 for a portal, 4 for the table.</label>
<p class="dim">Best heights for every ore are on the <a href="#ores">Ores</a> page.</p>`},
{id:'nether',title:'Into the Nether',blurb:'Portal, fortress, blaze rods, bastions.',body:`
<label class="chk"><input type="checkbox" data-k="n1"> Build a 4×5 obsidian portal frame and light it.</label>
<label class="chk"><input type="checkbox" data-k="n2"> Wear at least one piece of gold armor so piglins stay calm.</label>
<label class="chk"><input type="checkbox" data-k="n3"> Bring Fire Resistance potions if you have them, and blocks to bridge.</label>
<label class="chk"><input type="checkbox" data-k="n4"> Find a fortress: blaze rods (brewing, Eyes of Ender) and nether wart.</label>
<label class="chk"><input type="checkbox" data-k="n5"> Barter gold ingots with piglins for ender pearls, fire resistance and more.</label>
<label class="chk"><input type="checkbox" data-k="n6"> Mine ancient debris at Y 15 for netherite. Upgrade gear at a smithing table with a template.</label>
<p>One block in the Nether is eight in the Overworld. Use the <a href="#calc">portal calculator</a> to line up linked portals.</p>`,
j:'Beds explode in the Nether. Good for mining ancient debris, deadly otherwise.',
b:'Beds explode in the Nether. Good for mining ancient debris, deadly otherwise.'},
{id:'end',title:'The End',blurb:'Strongholds, the dragon, elytra.',body:`
<label class="chk"><input type="checkbox" data-k="e1"> Craft 12+ Eyes of Ender (blaze powder + ender pearl).</label>
<label class="chk"><input type="checkbox" data-k="e2"> Throw eyes to find the stronghold; dig down where they fall.</label>
<label class="chk"><input type="checkbox" data-k="e3"> Bring blocks, a bow with plenty of arrows, food, and a pumpkin on your head to stop endermen aggro.</label>
<label class="chk"><input type="checkbox" data-k="e4"> Shoot or climb to the end crystals first, then fight the dragon.</label>
<label class="chk"><input type="checkbox" data-k="e5"> Throw an ender pearl into the gateway portal to reach the outer islands.</label>
<label class="chk"><input type="checkbox" data-k="e6"> Find an End City with a ship for elytra and shulker shells.</label>`},
{id:'villagers',title:'Villagers and trading',blurb:'Mending books and cheap trades.',body:`
<label class="chk"><input type="checkbox" data-k="v1"> Give an unemployed villager a lectern to make a librarian.</label>
<label class="chk"><input type="checkbox" data-k="v2"> No Mending? Break and replace the lectern until it offers it (only before the first trade).</label>
<label class="chk"><input type="checkbox" data-k="v3"> Cure a zombie villager (Splash Weakness + golden apple) for big discounts.</label>
<label class="chk"><input type="checkbox" data-k="v4"> Breed villagers with beds and food (bread, carrots, potatoes, beetroot).</label>
<label class="chk"><input type="checkbox" data-k="v5"> Protect your trading hall from raids and zombies: lighting and walls.</label>`},
{id:'enchanting',title:'Enchanting setup',blurb:'Level 30 enchants every time.',body:`
<label class="chk"><input type="checkbox" data-k="t1"> Enchanting table: 4 obsidian, 2 diamonds, 1 book.</label>
<label class="chk"><input type="checkbox" data-k="t2"> 15 bookshelves one block away from the table, with air between.</label>
<label class="chk"><input type="checkbox" data-k="t3"> Keep lapis lazuli on hand: 1 to 3 per enchant.</label>
<label class="chk"><input type="checkbox" data-k="t4"> Build an anvil to combine books with gear. Combine in pairs to keep the cost down.</label>
<label class="chk"><input type="checkbox" data-k="t5"> Use a grindstone to remove bad enchants and get some XP back.</label>`},
{id:'trial',title:'Trial Chambers',blurb:'Trial keys, vaults and the mace.',body:`
<label class="chk"><input type="checkbox" data-k="r1"> Find a Trial Chamber underground (copper and tuff rooms). <code>/locate</code> helps in creative.</label>
<label class="chk"><input type="checkbox" data-k="r2"> Beat trial spawners to get trial keys; open vaults with them.</label>
<label class="chk"><input type="checkbox" data-k="r3"> Fight breezes up close or block their wind charges with a shield.</label>
<label class="chk"><input type="checkbox" data-k="r4"> Drink an Ominous Bottle (from raid captains) for ominous trials and ominous keys.</label>
<label class="chk"><input type="checkbox" data-k="r5"> Craft a mace: a heavy core from an ominous vault plus a breeze rod.</label>`}
];

/* Realms (Bedrock). Prices from minecraft.net at the time of writing. */
const REALM_PLANS = [
['Players online with you','2','10'],
['Price (USD, monthly)','$3.99','$7.99'],
['World backups','Yes','Yes'],
['Marketplace content','Use what you own','A rotating catalog of Marketplace worlds, skins and packs included'],
['Always online','Yes','Yes'],
['Friends pay','No','No']
];

/* ================= STATE ================= */
const KEY = 'mca_' + ED;
let S = {checks:{}, notes:'', coords:[], members:[], backups:[]};
try { const x = JSON.parse(localStorage.getItem(KEY) || 'null'); if (x) S = Object.assign(S, x); } catch (e) {}
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) {} };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const $ = id => document.getElementById(id);
const fmt = x => Number.isFinite(x) ? (Number.isInteger(x) ? String(x) : String(+x.toFixed(2))) : '—';
const nv = id => parseFloat($(id).value);
const iv = id => { const v = parseInt($(id).value, 10); return Number.isFinite(v) ? v : 0; };

/* ================= PAGES ================= */
const PAGES = [['home','Home'],['guides','Guides'],['commands','Commands']]
  .concat(B ? [['realms','Realms']] : [])
  .concat([['diff','Java vs Bedrock'],['brewing','Brewing'],['enchants','Enchantments'],['ores','Ores'],['calc','Calculators'],['coords','Coordinates'],['notes','My Notes']]);
const TILE = {
  guides:'First night to the End, villagers, enchanting, Trial Chambers',
  commands:'Every command in ' + ED_NAME + ' syntax, game rules, a command builder',
  realms:'Plans, setup, invites, roles, backups, a member list and backup log',
  diff:'What changes between the two editions',
  brewing:'Every potion and what to brew it from',
  enchants:'Max levels, items, conflicts, treasure enchants',
  ores:'Best Y level for every ore',
  calc:'Nether portals, XP, stacks, slime chunks',
  coords:'Save your bases and portals, with Nether coordinates',
  notes:'Your own notes'
};

function buildNav(cur) {
  $('nav').innerHTML = '<a class="home" href="/">&larr; Tavernworks</a><a class="home" href="/assistants/">&larr; All assistants</a><a class="home" href="/assistants/minecraft/' + OTHER + '/">&#8644; ' + (J ? 'Bedrock' : 'Java') + ' Edition</a><h1>MINECRAFT<br>' + (J ? 'JAVA' : 'BEDROCK') + ' ASSISTANT</h1>' +
    PAGES.map(([id, n]) => `<a href="#${id}" class="${cur === id ? 'on' : ''}">${n}</a>`).join('');
}

function pgHome() {
  return `<h2>Minecraft ${ED_NAME} Assistant</h2><p class="sub">${J
    ? 'For Minecraft: Java Edition on Windows, macOS and Linux.'
    : 'For Minecraft on Windows, Xbox, PlayStation, Switch, iOS and Android, and for Minecraft Realms.'} Your checklists, coordinates and notes are saved on this device.</p>
<div class="grid">${PAGES.slice(1).map(([id, n]) => `<div class="tile" onclick="location.hash='${id}'"><b>${n}</b><div class="dim">${TILE[id]}</div></div>`).join('')}</div>
<div class="note">Playing the other edition? Open the <a href="/assistants/minecraft/${OTHER}/">${J ? 'Bedrock and Realms' : 'Java'} assistant</a>. Commands and some mechanics differ. Minecraft changes with every update, so trust what you see in-game first.</div>`;
}

function pgGuides(sub) {
  if (sub) {
    const g = GUIDES.find(x => x.id === sub);
    if (g) return `<p><a href="#guides">&larr; All guides</a></p><h2>${g.title}</h2><div class="card">${g.body}${g[ED[0]] ? `<div class="tip">${esc(g[ED[0]])}</div>` : ''}</div>`;
  }
  const all = GUIDES.flatMap(g => [...g.body.matchAll(/data-k="(\w+)"/g)].map(m => m[1]));
  const done = all.filter(k => S.checks[k]).length;
  return `<h2>Guides</h2><p class="sub">Checkboxes are saved on this device. ${done} of ${all.length} steps done.</p><div class="bar"><i style="width:${all.length ? done / all.length * 100 : 0}%"></i></div>
<div class="grid">${GUIDES.map(g => `<div class="tile" onclick="location.hash='guides/${g.id}'"><b>${g.title}</b><div class="dim">${g.blurb}</div></div>`).join('')}</div>`;
}

/* ---- commands ---- */
function pgCommands() {
  return `<h2>Commands</h2><p class="sub">${ED_NAME} syntax. Turn on cheats in world settings first${B ? ' (on a Realm, the owner turns them on in Realm settings; achievements are disabled for that world)' : ''}. &lt;angle&gt; means required, [square] optional.</p>
<div class="card"><h3 style="margin-top:0">Command builder</h3>
<div class="row"><select id="bk"><option value="give">Give an item</option><option value="effect">Give an effect</option><option value="xp">Give levels</option><option value="tp">Teleport</option><option value="summon">Summon a mob</option><option value="rule">Keep inventory on death</option><option value="locate">Find a structure</option></select>
<input id="bp" type="text" value="@s" style="width:110px" title="Player or selector"></div>
<div class="row" id="bf"></div>
<div class="res mono" id="bout"></div><div class="row"><button class="pri" id="bcopy">Copy</button><span class="dim" id="bmsg"></span></div></div>
<div class="card"><h3 style="margin-top:0">Target selectors</h3><div class="tbl"><table>${SELECTORS.map(([s, d]) => `<tr><td><code>${s}</code></td><td>${d}</td></tr>`).join('')}</table></div>
<p class="dim">Filter with arguments, e.g. <code>@e[type=${J ? 'minecraft:zombie,distance=..10' : 'zombie,r=10'}]</code>, <code>@a[tag=builder]</code>, <code>@p[${J ? 'distance=..5' : 'r=5'}]</code>.</p></div>
<div class="row"><input id="cq" type="text" style="width:260px" placeholder="Search commands (e.g. spawn, items)"><label class="chk" style="margin:0"><input type="checkbox" id="cx"> Also show ${J ? 'Bedrock' : 'Java'}-only commands</label><span class="dim" id="ccn"></span></div>
<div class="card" id="cl"></div>
<h3>Game rules</h3><div class="card tbl"><table><tr><th>Rule</th><th>Default</th><th>What it does</th></tr>
${GAMERULES.filter(r => r[J ? 0 : 1]).map(r => `<tr><td><code>${r[J ? 0 : 1]}</code></td><td>${esc(r[2])}</td><td>${esc(r[3])}</td></tr>`).join('')}</table>
<p class="dim">Use as <code>/gamerule ${J ? 'keepInventory' : 'keepinventory'} true</code>.${J ? ' Newer Java versions renamed rules to snake_case (keep_inventory); press Tab after /gamerule to see the names your version uses.' : ''}</p></div>`;
}
function commandsRender() {
  const q = $('cq').value.toLowerCase(), x = $('cx').checked, mine = J ? 1 : 2, oth = J ? 2 : 1;
  const r = COMMANDS.filter(c => (c[mine] || x) && (!q || c.join(' ').toLowerCase().includes(q)));
  $('ccn').textContent = r.length + ' command' + (r.length === 1 ? '' : 's');
  $('cl').innerHTML = r.map(c => {
    const own = c[mine], tag = !c[oth] ? `<span class="tag ${ED[0]}">${J ? 'Java' : 'Bedrock'} only</span>` : (!own ? `<span class="tag ${OTHER[0]}">${J ? 'Bedrock' : 'Java'} only</span>` : '');
    return `<div class="cmd"><span class="n">/${esc(c[0])}</span>${tag}<div>${esc(c[3])}</div><div class="mono"><code>${esc(own || c[oth])}</code></div></div>`;
  }).join('') || '<p class="dim">No commands match.</p>';
}
const BUILD = {
  give: {f:[['item','Item','diamond'],['n','Count','64']], j:v => `/give ${v.p} minecraft:${v.item} ${v.n}`, b:v => `/give ${v.p} ${v.item} ${v.n}`},
  effect: {f:[['eff','Effect','night_vision'],['sec','Seconds','600'],['amp','Amplifier (0 = I)','0']], j:v => `/effect give ${v.p} minecraft:${v.eff} ${v.sec} ${v.amp} true`, b:v => `/effect ${v.p} ${v.eff} ${v.sec} ${v.amp} true`},
  xp: {f:[['n','Levels','30']], j:v => `/xp add ${v.p} ${v.n} levels`, b:v => `/xp ${v.n}L ${v.p}`},
  tp: {f:[['x','X','0'],['y','Y','100'],['z','Z','0']], j:v => `/tp ${v.p} ${v.x} ${v.y} ${v.z}`, b:v => `/tp ${v.p} ${v.x} ${v.y} ${v.z}`},
  summon: {f:[['mob','Mob','villager']], j:v => `/summon minecraft:${v.mob} ~ ~ ~`, b:v => `/summon ${v.mob} ~ ~ ~`},
  rule: {f:[], j:() => '/gamerule keepInventory true', b:() => '/gamerule keepinventory true'},
  locate: {f:[['st','Structure',J ? '#village' : 'village']], j:v => `/locate structure ${v.st}`, b:v => `/locate structure ${v.st}`}
};
function builderFields() {
  const k = $('bk').value;
  $('bf').innerHTML = BUILD[k].f.map(([id, l, d]) => `<label>${l} <input id="bf_${id}" type="text" value="${esc(d)}" style="width:130px"></label>`).join('');
  $('bp').style.display = ['summon','rule','locate'].includes(k) ? 'none' : '';
  $('bf').querySelectorAll('input').forEach(e => e.oninput = builderOut);
  builderOut();
}
function builderOut() {
  const k = $('bk').value, v = {p: $('bp').value.trim() || '@s'};
  BUILD[k].f.forEach(([id]) => v[id] = $('bf_' + id).value.trim().replace(/^minecraft:/, ''));
  $('bout').textContent = BUILD[k][ED[0]](v);
  $('bmsg').textContent = '';
}

/* ---- realms ---- */
function pgRealms() {
  const roles = ['Visitor','Member','Operator'];
  return `<h2>Minecraft Realms</h2><p class="sub">Realms is Mojang's always-on server for your world. A Bedrock Realm works across every Bedrock platform; Java Realms are separate and only for Java players.</p>
<div class="card tbl"><h3 style="margin-top:0">Plans</h3><table><tr><th></th><th>Realms</th><th>Realms Plus</th></tr>${REALM_PLANS.map(r => `<tr><td>${esc(r[0])}</td><td>${esc(r[1])}</td><td>${esc(r[2])}</td></tr>`).join('')}</table>
<p class="dim">From minecraft.net at the time of writing. New subscribers can usually start with a free trial. Check the in-game store for current prices in your region.</p></div>
<div class="card"><h3 style="margin-top:0">Setting up</h3>
<label class="chk"><input type="checkbox" data-k="rl1"> Play &rarr; Create New &rarr; Create on Realms, or upload an existing world from its edit screen.</label>
<label class="chk"><input type="checkbox" data-k="rl2"> Choose difficulty, game mode and whether cheats are on. Cheats switch off achievements for the world.</label>
<label class="chk"><input type="checkbox" data-k="rl3"> Invite friends: share the invite link or code from Realm settings &rarr; Members, or add them by gamertag.</label>
<label class="chk"><input type="checkbox" data-k="rl4"> Set each member's permission: Visitor, Member or Operator.</label>
<label class="chk"><input type="checkbox" data-k="rl5"> Download a backup before big changes, add-ons or updates.</label>
<label class="chk"><input type="checkbox" data-k="rl6"> Apply any resource and behavior packs to the world before you upload it.</label></div>
<div class="card"><h3 style="margin-top:0">Good to know</h3><ul>
<li>The world only runs while someone is online. Farms and crops stop when everyone leaves.</li>
<li><b>Backups</b>: Realm settings &rarr; Backups. Restoring replaces the current world, so download a copy first if you might want it back.</li>
<li><b>Replace world</b> swaps the Realm's world for a local one. You can also download the Realm world to play offline.</li>
<li><b>Permissions</b>: Visitors can look around but not build, Members play normally, Operators can use commands. The owner can always manage the Realm.</li>
<li>Reset an invite link if it ends up somewhere public. Kick and block from the member list.</li>
<li>Friends don't need a subscription to join. Only the owner pays.</li>
<li>When a new game update comes out, every player needs to update to keep joining.</li>
<li>Realm Stories in the Realm menu posts a feed of member achievements and screenshots; members can opt out.</li></ul></div>
<div class="card"><h3 style="margin-top:0">Member list</h3><p class="dim">Keep track of who you invited and what they can do. Stored on this device only.</p>
<div class="tbl"><table><tr><th>Gamertag</th><th>Role</th><th>Notes</th><th></th></tr>${S.members.map((m, i) => `<tr><td>${esc(m.g)}</td><td><select data-mr="${i}">${roles.map(r => `<option${r === m.r ? ' selected' : ''}>${r}</option>`).join('')}</select></td><td>${esc(m.n)}</td><td><button data-md="${i}">Remove</button></td></tr>`).join('') || '<tr><td colspan="4" class="dim">No members yet.</td></tr>'}</table></div>
<div class="row"><input id="mg" type="text" placeholder="Gamertag" style="width:160px"><select id="mr">${roles.map(r => `<option${r === 'Member' ? ' selected' : ''}>${r}</option>`).join('')}</select><input id="mn" type="text" placeholder="Notes (base, timezone…)" style="width:240px"><button class="pri" id="madd">Add</button></div></div>
<div class="card"><h3 style="margin-top:0">Backup log</h3><p class="dim">Write down why you took or restored a backup, so you know which one to go back to.</p>
<div class="tbl"><table><tr><th>Date</th><th>What happened</th><th></th></tr>${S.backups.map((b, i) => `<tr><td>${esc(b.d)}</td><td>${esc(b.t)}</td><td><button data-bd="${i}">Remove</button></td></tr>`).join('') || '<tr><td colspan="3" class="dim">Nothing logged yet.</td></tr>'}</table></div>
<div class="row"><input id="bd" type="date"><input id="bt" type="text" placeholder="e.g. Before installing the castle add-on" style="width:320px"><button class="pri" id="badd">Log it</button></div></div>`;
}
function realmsWire() {
  const m = $('main');
  m.querySelectorAll('[data-mr]').forEach(s => s.onchange = () => { S.members[+s.dataset.mr].r = s.value; save(); });
  m.querySelectorAll('[data-md]').forEach(b => b.onclick = () => { S.members.splice(+b.dataset.md, 1); save(); route(); });
  m.querySelectorAll('[data-bd]').forEach(b => b.onclick = () => { S.backups.splice(+b.dataset.bd, 1); save(); route(); });
  $('bd').value = new Date().toISOString().slice(0, 10);
  $('madd').onclick = () => { const g = $('mg').value.trim(); if (!g) return; S.members.push({g, r: $('mr').value, n: $('mn').value.trim()}); save(); route(); };
  $('badd').onclick = () => { const t = $('bt').value.trim(); if (!t) return; S.backups.unshift({d: $('bd').value, t}); save(); route(); };
}

/* ---- reference pages ---- */
function pgDiff() {
  const me = J ? 1 : 2;
  return `<h2>Java vs Bedrock</h2><p class="sub">The two editions look alike but play differently in places. Tutorials don't always say which edition they're for, so check before you copy a farm.</p>
<div class="card tbl"><table><tr><th>Topic</th><th class="${me === 1 ? 'me' : ''}">Java</th><th class="${me === 2 ? 'me' : ''}">Bedrock</th></tr>
${DIFFS.map(d => `<tr><td><b>${esc(d[0])}</b></td><td class="${me === 1 ? 'me' : ''}">${esc(d[1])}</td><td class="${me === 2 ? 'me' : ''}">${esc(d[2])}</td></tr>`).join('')}</table></div>`;
}
function pgBrewing() {
  return `<h2>Brewing</h2><p class="sub">Brewing stand + blaze powder for fuel. Start with water bottles and nether wart.</p>
<div class="card tbl"><table><tr><th>Potion</th><th>Add</th><th>To</th><th>Effect</th><th>Upgrades</th></tr>
${POTIONS.map(p => `<tr><td><b>${esc(p[0])}</b></td><td>${esc(p[1])}</td><td>${esc(p[2])}</td><td>${esc(p[3])}</td><td class="dim">${esc(p[4])}</td></tr>`).join('')}</table></div>
<div class="card tbl"><h3 style="margin-top:0">Modifiers</h3><table>${MODIFIERS.map(m => `<tr><td><b>${esc(m[0])}</b></td><td>${esc(m[1])}</td></tr>`).join('')}</table>
<p class="dim">Fermented Spider Eye corrupts a potion into its opposite. Add it after redstone to keep the longer time. Tipped arrows: lingering potion + 8 arrows in a crafting table.${B ? ' On Bedrock, you can also dip arrows in a cauldron of potion.' : ''}</p></div>`;
}
function pgEnchants() {
  return `<h2>Enchantments</h2><p class="sub">Treasure enchantments never show up on the enchanting table: find them in chests, fishing, trades or bartering.</p>
<div class="row"><input id="eq" type="text" style="width:260px" placeholder="Search (e.g. boots, mace, bow)"><label class="chk" style="margin:0"><input type="checkbox" id="et"> Treasure only</label><span class="dim" id="ecn"></span></div>
<div class="card tbl"><table><thead><tr><th>Enchantment</th><th>Max</th><th>Goes on</th><th>Notes</th></tr></thead><tbody id="el"></tbody></table></div>`;
}
function enchantsRender() {
  const q = $('eq').value.toLowerCase(), t = $('et').checked;
  const r = ENCHANTS.filter(e => (!e[4] || e[4] === ED[0]) && (!t || e[5]) && (!q || e.slice(0, 4).join(' ').toLowerCase().includes(q)));
  $('ecn').textContent = r.length + ' enchantments';
  const roman = n => ['','I','II','III','IV','V'][n];
  $('el').innerHTML = r.map(e => `<tr><td><b>${esc(e[0])}</b>${e[5] ? '<span class="tag t">treasure</span>' : ''}</td><td>${roman(e[1])}</td><td>${esc(e[2])}</td><td>${esc(e[3])}</td></tr>`).join('');
}
function pgOres() {
  return `<h2>Ores</h2><p class="sub">Ore heights since Caves &amp; Cliffs (1.18). The same on both editions. The world runs from Y -64 to Y 320.</p>
<div class="card tbl"><table><tr><th>Ore</th><th>Best Y</th><th>Found</th><th>Notes</th></tr>${ORES.map(o => `<tr><td><b>${esc(o[0])}</b></td><td>${esc(o[1])}</td><td>${esc(o[2])}</td><td>${esc(o[3])}</td></tr>`).join('')}</table></div>
<div class="tip">${J ? 'Your Y level is on the F3 screen (the middle number of XYZ).' : 'Your Y level is the middle number under Show Coordinates.'}</div>`;
}

/* ---- calculators ---- */
function pgCalc() {
  return `<h2>Calculators</h2><p class="sub">Quick maths for portals, levels, storage and slime farms.</p>
<div class="card"><h3 style="margin-top:0">Nether portal link</h3><div class="row"><select id="pd"><option value="o">Overworld</option><option value="n">Nether</option></select> X <input id="px" type="number" value="800" style="width:100px"> Y <input id="py" type="number" value="64" style="width:80px"> Z <input id="pz" type="number" value="-240" style="width:100px"></div><div class="res" id="pres"></div>
<p class="dim">Build the matching portal at the coordinates shown. Keep separate portals far enough apart in the Nether that they don't grab each other's link.</p></div>
<div class="card"><h3 style="margin-top:0">Experience</h3><div class="row">From level <input id="xa" type="number" value="0" style="width:80px"> to level <input id="xb" type="number" value="30" style="width:80px"></div><div class="res" id="xres"></div></div>
<div class="card"><h3 style="margin-top:0">Stacks and storage</h3><div class="row">Items <input id="sn" type="number" value="3000" style="width:110px"> Stack size <select id="ss"><option>64</option><option>16</option><option>1</option></select></div><div class="res" id="sres"></div></div>
<div class="card"><h3 style="margin-top:0">Chunk</h3><div class="row">X <input id="kx" type="number" value="0" style="width:100px"> Z <input id="kz" type="number" value="0" style="width:100px"></div><div class="res" id="kres"></div></div>
<div class="card"><h3 style="margin-top:0">Slime chunk finder</h3>
<p class="dim">${J ? 'Java slime chunks depend on the world seed. Find yours with /seed.' : 'Bedrock slime chunks are the same in every world, so no seed is needed.'} Slimes spawn in slime chunks below Y 40 in any light, and in swamps at night.</p>
<div class="row">${J ? 'Seed <input id="lseed" type="text" style="width:220px" placeholder="e.g. -4172144997902289642">' : ''} Block X <input id="lx" type="number" value="0" style="width:100px"> Block Z <input id="lz" type="number" value="0" style="width:100px"></div>
<div class="res" id="lres"></div><div id="lmap" class="slime"></div><p class="dim">Each square is a chunk, north at the top. Green is a slime chunk; the outlined square is the one you entered.</p></div>`;
}
function xpFor(L) {
  if (L <= 16) return L * L + 6 * L;
  if (L <= 31) return 2.5 * L * L - 40.5 * L + 360;
  return 4.5 * L * L - 162.5 * L + 2220;
}
function calcAll() {
  const d = $('pd').value, x = nv('px'), y = nv('py'), z = nv('pz');
  if ([x, y, z].every(Number.isFinite)) {
    const f = d === 'o' ? 1 / 8 : 8, to = d === 'o' ? 'Nether' : 'Overworld';
    $('pres').innerHTML = `${to}: X <b>${Math.floor(x * f)}</b>, Z <b>${Math.floor(z * f)}</b>${d === 'o' ? ' (pick a Y between 1 and 127 that is open space)' : ` at about Y ${fmt(y)}`}`;
  } else $('pres').textContent = 'Enter coordinates.';
  const a = Math.max(0, iv('xa')), b = Math.max(0, iv('xb'));
  if (b > a) {
    const pts = xpFor(b) - xpFor(a);
    $('xres').innerHTML = `<b>${fmt(pts)}</b> experience points. That's about ${fmt(Math.ceil(pts / 7))} bottles o' enchanting (3 to 11 points each), or ${fmt(Math.ceil(pts / 5))} zombie kills.`;
  } else $('xres').textContent = 'The second level must be higher.';
  const n = Math.max(0, iv('sn')), s = +$('ss').value, stacks = Math.ceil(n / s);
  $('sres').innerHTML = `<b>${fmt(Math.floor(n / s))}</b> stacks + ${n % s} &nbsp;·&nbsp; ${fmt(Math.ceil(stacks / 27))} chest${Math.ceil(stacks / 27) === 1 ? '' : 's'} or shulker box${Math.ceil(stacks / 27) === 1 ? '' : 'es'} &nbsp;·&nbsp; ${fmt(Math.ceil(stacks / 54))} double chest${Math.ceil(stacks / 54) === 1 ? '' : 's'} &nbsp;·&nbsp; ${fmt(Math.ceil(stacks / (27 * 27)))} chest${Math.ceil(stacks / 729) === 1 ? '' : 's'} full of filled shulker boxes`;
  const kx = iv('kx'), kz = iv('kz'), cx = kx >> 4, cz = kz >> 4;
  $('kres').innerHTML = `Chunk <b>${cx}, ${cz}</b> &nbsp;·&nbsp; it runs from X ${cx * 16} to ${cx * 16 + 15}, Z ${cz * 16} to ${cz * 16 + 15}`;
  slimeRender();
}

/* Java: java.util.Random seeded per chunk. Bedrock: first MT19937 output seeded from the chunk. */
function javaHash(s) { let h = 0; for (const c of s) h = (Math.imul(31, h) + c.charCodeAt(0)) | 0; return BigInt(h); }
function parseSeed(t) {
  t = t.trim();
  if (!t) return null;
  if (/^-?\d+$/.test(t)) { const v = BigInt(t); if (v >= -(2n ** 63n) && v < 2n ** 63n) return v; }
  return javaHash(t);
}
function javaSlime(seed, cx, cz) {
  const x = BigInt(cx), z = BigInt(cz), i32 = v => BigInt.asIntN(32, v), M = (1n << 48n) - 1n;
  const s = BigInt.asIntN(64, seed + i32(x * x * 4987142n) + i32(x * 5947611n) + i32(z * z) * 4392871n + i32(z * 389711n)) ^ 987234911n;
  let r = (s ^ 0x5DEECE66Dn) & M, bits, val;
  do { r = (r * 0x5DEECE66Dn + 0xBn) & M; bits = Number(r >> 17n); val = bits % 10; } while (bits - val + 9 > 2147483647);
  return val === 0;
}
function bedrockSlime(cx, cz) {
  const mt = new Uint32Array(398);
  mt[0] = (Math.imul(cx, 0x1f1f1f1f) ^ cz) >>> 0;
  for (let i = 1; i < 398; i++) { const p = mt[i - 1] ^ (mt[i - 1] >>> 30); mt[i] = (Math.imul(1812433253, p) + i) >>> 0; }
  let y = (mt[0] & 0x80000000) | (mt[1] & 0x7fffffff);
  y = (mt[397] ^ (y >>> 1) ^ (y & 1 ? 0x9908b0df : 0)) >>> 0;
  y ^= y >>> 11; y ^= (y << 7) & 0x9d2c5680; y ^= (y << 15) & 0xefc60000; y ^= y >>> 18;
  return (y >>> 0) % 10 === 0;
}
function slimeRender() {
  let seed = null;
  if (J) { seed = parseSeed($('lseed').value); if (seed === null) { $('lres').textContent = 'Enter your world seed.'; $('lmap').innerHTML = ''; return; } }
  const test = (cx, cz) => J ? javaSlime(seed, cx, cz) : bedrockSlime(cx, cz);
  const cx = iv('lx') >> 4, cz = iv('lz') >> 4, R = 6, cells = [], near = [];
  for (let dz = -R; dz <= R; dz++) for (let dx = -R; dx <= R; dx++) {
    const y = test(cx + dx, cz + dz);
    if (y) near.push([Math.abs(dx) + Math.abs(dz), cx + dx, cz + dz]);
    cells.push(`<i class="${y ? 'y' : ''}${dx || dz ? '' : ' me'}" title="Chunk ${cx + dx}, ${cz + dz}: X ${(cx + dx) * 16}, Z ${(cz + dz) * 16}"></i>`);
  }
  near.sort((a, b) => a[0] - b[0]);
  const here = test(cx, cz), n = near.find(c => c[0] > 0);
  $('lres').innerHTML = (here ? `<span class="ok">Chunk ${cx}, ${cz} is a slime chunk.</span>` : `<span class="bad">Chunk ${cx}, ${cz} is not a slime chunk.</span>`) +
    (n ? ` Nearest other: chunk ${n[1]}, ${n[2]} (blocks X ${n[1] * 16} to ${n[1] * 16 + 15}, Z ${n[2] * 16} to ${n[2] * 16 + 15}).` : '');
  $('lmap').style.gridTemplateColumns = `repeat(${2 * R + 1},22px)`;
  $('lmap').innerHTML = cells.join('');
}

/* ---- coordinates ---- */
const DIMS = {o:'Overworld', n:'Nether', e:'The End'};
function pgCoords() {
  return `<h2>Coordinates</h2><p class="sub">Bases, portals, villages and anything else you want to find again. Overworld and Nether places show both sets of coordinates.</p>
<div class="card tbl"><table><tr><th>Name</th><th>Where</th><th>X, Y, Z</th><th>Other side</th><th></th></tr>
${S.coords.map((c, i) => {
  const other = c.d === 'o' ? `Nether ${Math.floor(c.x / 8)}, ${Math.floor(c.z / 8)}` : c.d === 'n' ? `Overworld ${c.x * 8}, ${c.z * 8}` : '';
  return `<tr><td><b>${esc(c.n)}</b>${c.t ? `<div class="dim">${esc(c.t)}</div>` : ''}</td><td>${DIMS[c.d]}</td><td><code>${c.x} ${c.y} ${c.z}</code></td><td class="dim">${other}</td><td><button data-tp="${i}" title="Copy a teleport command">/tp</button> <button data-cd="${i}">Remove</button></td></tr>`;
}).join('') || '<tr><td colspan="5" class="dim">No places saved yet.</td></tr>'}</table></div>
<div class="card"><h3 style="margin-top:0">Add a place</h3><div class="row"><input id="cn" type="text" placeholder="Name (e.g. Main base)" style="width:180px"><select id="cdim"><option value="o">Overworld</option><option value="n">Nether</option><option value="e">The End</option></select> X <input id="cxx" type="number" style="width:90px"> Y <input id="cyy" type="number" style="width:70px"> Z <input id="czz" type="number" style="width:90px"></div>
<div class="row"><input id="ct" type="text" placeholder="Notes" style="width:320px"><button class="pri" id="cadd">Save</button><span class="dim" id="cmsg"></span></div></div>`;
}
function coordsWire() {
  const m = $('main');
  m.querySelectorAll('[data-cd]').forEach(b => b.onclick = () => { S.coords.splice(+b.dataset.cd, 1); save(); route(); });
  m.querySelectorAll('[data-tp]').forEach(b => b.onclick = () => { const c = S.coords[+b.dataset.tp]; copy(`/tp @s ${c.x} ${c.y} ${c.z}`, $('cmsg')); });
  $('cadd').onclick = () => {
    const n = $('cn').value.trim(), x = parseInt($('cxx').value, 10), y = parseInt($('cyy').value, 10), z = parseInt($('czz').value, 10);
    if (!n || ![x, y, z].every(Number.isFinite)) { $('cmsg').textContent = 'Add a name and all three coordinates.'; return; }
    S.coords.push({n, d: $('cdim').value, x, y, z, t: $('ct').value.trim()}); save(); route();
  };
}
function copy(text, msg) {
  const done = () => { msg.textContent = 'Copied: ' + text; };
  if (navigator.clipboard) navigator.clipboard.writeText(text).then(done, () => { msg.textContent = text; });
  else msg.textContent = text;
}

function pgNotes() { return `<h2>My Notes</h2><p class="sub">Saved automatically on this device.</p><textarea id="nt" style="width:100%;height:60vh" placeholder="Seed, base plans, farm ideas, what to bring next session...">${esc(S.notes)}</textarea>`; }

/* ================= ROUTER ================= */
function route() {
  const [pg, sub] = (location.hash.slice(1) || 'home').split('/');
  const page = PAGES.some(p => p[0] === pg) ? pg : 'home';
  buildNav(page);
  const m = $('main');
  m.innerHTML = ({home:pgHome, guides:() => pgGuides(sub), commands:pgCommands, realms:pgRealms, diff:pgDiff, brewing:pgBrewing, enchants:pgEnchants, ores:pgOres, calc:pgCalc, coords:pgCoords, notes:pgNotes})[page]();
  m.scrollTop = 0;
  m.querySelectorAll('input[type=checkbox][data-k]').forEach(cb => { cb.checked = !!S.checks[cb.dataset.k]; cb.onchange = () => { S.checks[cb.dataset.k] = cb.checked; save(); }; });
  if (page === 'commands') {
    $('cq').oninput = commandsRender; $('cx').onchange = commandsRender; commandsRender();
    $('bk').onchange = builderFields; $('bp').oninput = builderOut; $('bcopy').onclick = () => copy($('bout').textContent, $('bmsg')); builderFields();
  }
  if (page === 'realms') realmsWire();
  if (page === 'enchants') { $('eq').oninput = enchantsRender; $('et').onchange = enchantsRender; enchantsRender(); }
  if (page === 'calc') { m.querySelectorAll('input,select').forEach(e => e.oninput = calcAll); calcAll(); }
  if (page === 'coords') coordsWire();
  if (page === 'notes') $('nt').oninput = e => { S.notes = e.target.value; save(); };
}
window.addEventListener('hashchange', route);
route();
})();
