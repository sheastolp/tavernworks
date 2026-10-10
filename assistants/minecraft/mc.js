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
<label class="chk"><input type="checkbox" data-k="r5"> Craft a mace: a heavy core from an ominous vault plus a breeze rod.</label>`},
{id:'food',title:'Food and early farming',blurb:'Never go hungry: crops, animals, the best foods.',body:`
<label class="chk"><input type="checkbox" data-k="f1"> Break tall grass for wheat seeds. Till dirt with a hoe within 4 blocks of water.</label>
<label class="chk"><input type="checkbox" data-k="f2"> Plant wheat, carrots and potatoes (from villages, zombies or shipwrecks). Light the field so mobs don't trample it.</label>
<label class="chk"><input type="checkbox" data-k="f3"> Use bone meal (from a composter or skeletons) to grow crops instantly.</label>
<label class="chk"><input type="checkbox" data-k="f4"> Fence in two cows, pigs or sheep and breed them: wheat for cows and sheep, carrots for pigs, seeds for chickens.</label>
<label class="chk"><input type="checkbox" data-k="f5"> Cook meat in a smoker: twice as fast as a furnace.</label>
<label class="chk"><input type="checkbox" data-k="f6"> Work up to golden carrots: the best everyday food. Trade with farmer villagers or grow carrots plus gold nuggets.</label>
<p class="dim">Hunger and saturation for every food are on the <a href="#food">Food</a> page. Ready to automate? See <a href="#farms">Auto farms</a>.</p>`},
{id:'redstone',title:'Redstone basics',blurb:'Power, repeaters, observers and pistons.',body:`
<label class="chk"><input type="checkbox" data-k="d1"> Power sources: levers and buttons (manual), pressure plates, daylight sensors, observers, redstone blocks and torches.</label>
<label class="chk"><input type="checkbox" data-k="d2"> Dust carries a signal 15 blocks. A repeater boosts it back to 15 and adds a delay of 1 to 4 redstone ticks.</label>
<label class="chk"><input type="checkbox" data-k="d3"> A redstone torch on a block inverts: it turns off when the block is powered. That is a NOT gate.</label>
<label class="chk"><input type="checkbox" data-k="d4"> Observers fire a short pulse when the block in front of them changes. They are the heart of most crop farms.</label>
<label class="chk"><input type="checkbox" data-k="d5"> Pistons push up to 12 blocks; sticky pistons pull one back. Obsidian, chests and some other blocks can't be moved.</label>
<label class="chk"><input type="checkbox" data-k="d6"> Hoppers pull items from above and push them into the container they point at. Powering a hopper locks it.</label>
<label class="chk"><input type="checkbox" data-k="d7"> Comparators read how full a container is, or compare and subtract signals. Use one to build an item sorter.</label>
<p class="dim">Test new circuits in a creative copy of your world first.</p>`,
j:'Java has quasi-connectivity: a piston or dropper also turns on if the block above it is powered. Many Java tutorials rely on it.',
b:'Bedrock has no quasi-connectivity, but pistons can move chests, furnaces and other containers. Java circuits often need changes on Bedrock.'},
{id:'raids',title:'Raids and the Bad Omen',blurb:'Pillagers, ravagers and the Hero of the Village.',body:`
<label class="chk"><input type="checkbox" data-k="a1"> Kill a raid captain (pillager with a banner) to get an Ominous Bottle. Drinking it gives Bad Omen.</label>
<label class="chk"><input type="checkbox" data-k="a2"> Walk into a village with Bad Omen to start a raid: waves of pillagers, vindicators, ravagers, witches and evokers.</label>
<label class="chk"><input type="checkbox" data-k="a3"> Prepare a shield, a crossbow or bow, healing, and armor. Light the village and wall in the villagers first.</label>
<label class="chk"><input type="checkbox" data-k="a4"> Evokers drop the Totem of Undying: hold it in your off-hand to survive death once.</label>
<label class="chk"><input type="checkbox" data-k="a5"> Win the raid for Hero of the Village: big trading discounts and gifts from villagers.</label>
<p class="dim">Drink a milk bucket to cancel Bad Omen if you're not ready.</p>`},
{id:'monument',title:'Ocean monuments',blurb:'Guardians, sponges and prismarine.',body:`
<label class="chk"><input type="checkbox" data-k="o1"> Bring Water Breathing and Night Vision potions, Respiration and Aqua Affinity helmet, Depth Strider boots.</label>
<label class="chk"><input type="checkbox" data-k="o2"> Bring a milk bucket for every elder guardian you expect: they give Mining Fatigue III.</label>
<label class="chk"><input type="checkbox" data-k="o3"> Kill the three elder guardians (one at the top, two in the wings) for wet sponges and the Mining Fatigue to stop.</label>
<label class="chk"><input type="checkbox" data-k="o4"> Find the gold block treasure room in the core: 8 gold blocks.</label>
<label class="chk"><input type="checkbox" data-k="o5"> Dry sponges in a furnace and use them to drain the monument for a guardian farm.</label>`},
{id:'deep',title:'Ancient Cities and the Warden',blurb:'Sneak in, loot Swift Sneak, don\'t wake it.',body:`
<label class="chk"><input type="checkbox" data-k="w1"> Find an Ancient City in the Deep Dark around Y -51. Sculk everywhere is your hint.</label>
<label class="chk"><input type="checkbox" data-k="w2"> Sneak at all times. Sculk sensors hear walking, eating and breaking blocks; shriekers summon the Warden after 3 warnings.</label>
<label class="chk"><input type="checkbox" data-k="w3"> Place wool on sensors to muffle them, or break shriekers (sneaking) first.</label>
<label class="chk"><input type="checkbox" data-k="w4"> Throw snowballs or arrows to distract a sensor away from you.</label>
<label class="chk"><input type="checkbox" data-k="w5"> Loot chests for Swift Sneak books, echo shards (recovery compass), enchanted golden apples and music discs.</label>
<label class="chk"><input type="checkbox" data-k="w6"> If the Warden spawns, pillar up or leave. It has 500 health and hits through shields.</label>`},
{id:'elytra',title:'Elytra and flying',blurb:'Rockets, repairs and safe landings.',body:`
<label class="chk"><input type="checkbox" data-k="l1"> Get elytra from an End City ship (see <a href="#guides/end">The End</a>).</label>
<label class="chk"><input type="checkbox" data-k="l2"> Craft firework rockets: paper + gunpowder (1 to 3 for longer boosts, no star).</label>
<label class="chk"><input type="checkbox" data-k="l3"> Jump, then jump again in the air to glide. Use a rocket to climb.</label>
<label class="chk"><input type="checkbox" data-k="l4"> Put Unbreaking III and Mending on the elytra. Repair broken elytra with phantom membranes at an anvil.</label>
<label class="chk"><input type="checkbox" data-k="l5"> Land into water or dive steeply and pull up late. Crashing into walls hurts.</label>
<label class="chk"><input type="checkbox" data-k="l6"> Build a creeper or gunpowder farm so rockets are free. See <a href="#farms">Auto farms</a>.</label>`},
{id:'killchamber',title:'Kill chambers and drop heights',blurb:'Fall mobs to one hit, collect loot and XP.',body:`
<p>A kill chamber is the bottom of a mob farm: mobs fall down a chute, land hurt, and you finish them with one hit. Killing them yourself gives XP and rare drops; a drop that kills outright gives items but no XP.</p>
<h3>How fall damage works</h3>
<p>A mob takes <b>1 point of damage (half a heart) for every block it falls past the first 3</b>. So damage = blocks fallen &minus; 3. Measure from the block the mob walks off down to the floor it lands on (the top of the hoppers).</p>
<ul class="mech">
<li><b>One-hit height</b> = health + 2. The mob lands with half a heart left, so any hit kills it.</li>
<li><b>Instant kill height</b> = health + 3. The fall kills it: loot, but no XP.</li>
<li>Fall damage ignores armor, but <b>Feather Falling</b> and <b>Protection</b> on boots reduce it. A few mobs spawn with enchanted boots and survive with more health; they still die to a second hit.</li>
</ul>
<h3>Drop heights by mob</h3>
<div class="tbl"><table><tr><th>Mob</th><th>Health</th><th>One-hit drop</th><th>Kills outright</th></tr>
<tr><td>Zombie, husk, drowned, zombie villager, skeleton, stray, creeper, wither skeleton, zombified piglin, villager, player</td><td>20</td><td><b>22</b></td><td>23</td></tr>
<tr><td>Spider, piglin, bogged</td><td>16</td><td><b>18</b></td><td>19</td></tr>
<tr><td>Cave spider</td><td>12</td><td><b>14</b></td><td>15</td></tr>
<tr><td>Cow, pig, mooshroom</td><td>10</td><td><b>12</b></td><td>13</td></tr>
<tr><td>Sheep, silverfish, endermite</td><td>8</td><td><b>10</b></td><td>11</td></tr>
<tr><td>Rabbit</td><td>3</td><td><b>5</b></td><td>6</td></tr>
<tr><td>Pillager, vindicator, evoker</td><td>24</td><td><b>26</b></td><td>27</td></tr>
<tr><td>Witch</td><td>26</td><td><b>28</b></td><td>29</td></tr>
<tr><td>Guardian, turtle</td><td>30</td><td><b>32</b></td><td>33</td></tr>
<tr><td>Enderman, hoglin, zoglin</td><td>40</td><td><b>42</b></td><td>43</td></tr>
<tr><td>Ravager</td><td>100</td><td><b>102</b></td><td>103</td></tr>
</table></div>
<p class="dim">Health is in points: 2 points = 1 heart. Tap a mob on the <a href="#mobs">Mobs</a> page for more.</p>
<h3>Mobs a drop won't hurt</h3>
<p>Chickens, slimes, magma cubes, blazes, ghasts, breezes, iron golems, snow golems, cats, bats, bees, parrots, phantoms, vexes and allays take no fall damage. Use another kill method for these: a lava blade under a sign or slab, magma blocks, drowning, or hitting them yourself. Goats and frogs take reduced fall damage, so they need a much taller drop.</p>
<h3>Build it</h3>
<label class="chk"><input type="checkbox" data-k="k1"> Pick the drop height from the table for your target mob. For a mixed dark-room farm, use 22 blocks: zombies, skeletons and creepers land at half a heart and spiders die outright.</label>
<label class="chk"><input type="checkbox" data-k="k2"> Build a 1x1 chute to drop down. Spiders are 2 blocks wide and can't fit, which keeps them out; make it 2x2 if you want spiders.</label>
<label class="chk"><input type="checkbox" data-k="k3"> Don't let mobs land in water, on slime blocks, powder snow, hay bales, beds or honey: all of them cancel or cut fall damage. Water anywhere in the chute resets the fall.</label>
<label class="chk"><input type="checkbox" data-k="k4"> At the bottom, mobs land on hoppers that feed a chest. Use enough hoppers or a hopper line so loot never backs up.</label>
<label class="chk"><input type="checkbox" data-k="k5"> Wall the landing pit with glass or slabs and leave a half-block gap (a bottom slab on top of the wall, or a top slab below head height) to swing through. Baby zombies fit through a 1-block gap, but not half a block.</label>
<label class="chk"><input type="checkbox" data-k="k6"> Light your side of the chamber and roof it, so nothing spawns next to you.</label>
<label class="chk"><input type="checkbox" data-k="k7"> Test with one mob before you fill the farm. If it survives with more than half a heart, add a block to the drop; if it dies, remove one.</label>
<label class="chk"><input type="checkbox" data-k="k8"> Use a sword with Sweeping Edge (Java), Looting and Mending. Sweeping hits the whole pile at once, and the farm's XP keeps the sword repaired.</label>
<p class="dim">Stay within the farm's spawn range while you wait: mobs only spawn 24 to 128 blocks from a player (Java) or 24 to 44 blocks (Bedrock, by default simulation distance). Building the chamber about 25 blocks below the spawning floor works for both.</p>`,
j:'Java: mobs only drop XP and rare loot if a player or tamed wolf hurt them in the last 5 seconds, which is why the one-hit height matters. Piling over 24 mobs into one block causes entity cramming damage (gamerule maxEntityCramming), which kills them with no XP, so keep loot flowing out.',
b:'Bedrock: fall damage uses the same blocks minus 3 rule, but always test with one mob since landing on hoppers or slabs can shift it by a block. Bedrock has no entity cramming damage, so crowded pits stay alive until you hit them.'}
];

/* Mobs: [name, kind, where, drops, how to deal with it] */
const MOBS = [
['Zombie','Hostile','Overworld at night, in the dark','Rotten flesh, sometimes iron, carrots, potatoes','Burns in daylight. Husks (desert) don\'t burn and cause Hunger.'],
['Skeleton','Hostile','Overworld at night, in the dark','Bones, arrows','Use a shield. Strays (snowy biomes) shoot Slowness arrows.'],
['Creeper','Hostile','Overworld at night, in the dark','Gunpowder, a music disc if a skeleton kills it','Hit it and back off. Cats and ocelots scare them away.'],
['Spider','Hostile, neutral by day','Overworld','String, spider eyes','Climbs walls. Cave spiders (mineshafts) poison you.'],
['Enderman','Neutral','Everywhere, mostly the End','Ender pearls','Don\'t look at its face. Stand under a 2-block ceiling; it can\'t follow. A carved pumpkin on your head stops the stare.'],
['Witch','Hostile','Swamp huts, raids, at night','Redstone, glowstone, sugar, sticks, bottles','Drinks healing potions. Kill fast with a bow or sword.'],
['Slime','Hostile','Slime chunks below Y 40, swamps at night','Slimeballs','Splits when killed. Use the slime chunk finder on the Calculators page.'],
['Phantom','Hostile','Sky, after 3 nights without sleep','Phantom membrane','Sleep to stop them. Membranes repair elytra and brew Slow Falling.'],
['Drowned','Hostile','Rivers and oceans','Copper, rotten flesh, sometimes a trident or nautilus shell','Only drowned that spawn holding a trident drop one.'],
['Pillager','Hostile','Outposts and raids','Arrows, crossbows; captains give an Ominous Bottle','Shield blocks crossbow bolts.'],
['Guardian','Hostile','Ocean monuments','Prismarine shards, crystals, fish','Laser charges up; break line of sight.'],
['Blaze','Hostile','Nether fortresses','Blaze rods','Fire Resistance, snowballs hurt them.'],
['Ghast','Hostile','Nether','Ghast tears, gunpowder','Hit the fireball back. Kill it over solid ground to get the tear.'],
['Piglin','Neutral','Nether','Gold, crossbows; barter for ender pearls and more','Wear gold armor. Don\'t open chests or mine gold near them.'],
['Hoglin','Hostile','Crimson forests','Porkchops, leather','Afraid of warped fungus, portals and respawn anchors.'],
['Wither Skeleton','Hostile','Nether fortresses','Coal, bones, wither skulls (rare)','Looting III helps skulls. Three skulls and soul sand build the Wither.'],
['Shulker','Hostile','End Cities','Shulker shells','Levitation bullets: bring Slow Falling or a water bucket.'],
['Breeze','Hostile','Trial Chambers','Breeze rods','Wind charges knock you back. Fight up close.'],
['Bogged','Hostile','Swamps, Trial Chambers','Bones, arrows, poison arrows, mushrooms','A mossy skeleton that shoots Poison arrows.'],
['Warden','Boss-strength','Ancient Cities','A sculk catalyst','Avoid it. It hits through shields and has 500 health.'],
['Ender Dragon','Boss','The End','Lots of XP, dragon egg, dragon\'s breath','Destroy end crystals first. Beds blow up in the End and deal big damage.'],
['Wither','Boss','Wherever you build it','Nether star (beacons)','Build it underground or in the End. Smite works; it\'s undead.']
];

/* Mob mechanics, shown when you tap a mob's name. hp: health points (2 = one heart),
   atk: attack on Normal difficulty, xp: experience dropped, spawn: spawn rules,
   mech: how it behaves, j/b: Java- or Bedrock-only notes. */
const MOB_INFO = {
'Zombie':{hp:'20',atk:'3 melee',xp:'5',spawn:'Light level 0 in the Overworld, in groups. Husks replace them in deserts.',
 mech:['Burns in direct sunlight unless it wears a helmet, stands in water or is in shade.','Can pick up items and armor, and wears or holds what it finds.','On Hard difficulty it can break down wooden doors, and hitting one can call in more zombies.','Some spawn as baby zombies: faster, smaller and harder to hit.','Goes after players, villagers, wandering traders, iron golems and turtle eggs.','Turns into a drowned after staying underwater for about 30 seconds.','A villager killed by a zombie can become a zombie villager (always on Hard). Cure it with a splash of Weakness and a golden apple for cheap trades.'],
 j:'Rare drops (iron ingot, carrot, potato) are about 2.5% each, boosted by Looting.'},
'Skeleton':{hp:'20',atk:'About 3 to 4 per arrow',xp:'5',spawn:'Light level 0 in the Overworld. Strays replace most of them in snowy biomes.',
 mech:['Shoots arrows from range and strafes sideways to dodge yours.','Burns in sunlight unless it wears a helmet or stays in shade or water.','Runs away from wolves.','A skeleton arrow that kills a creeper makes the creeper drop a music disc.','Arrows it shoots can\'t be picked up.'],
 j:'A skeleton standing in powder snow turns into a stray after a few seconds.'},
'Creeper':{hp:'20',atk:'Explosion, up to about 43 at point blank',xp:'5',spawn:'Light level 0 in the Overworld.',
 mech:['Walks up silently, hisses and explodes after 1.5 seconds. Moving away a few blocks cancels the fuse.','The explosion breaks blocks unless mobGriefing is off.','Lightning turns it into a charged creeper with a much bigger blast. A charged creeper\'s blast makes mobs drop their heads.','Runs from cats and ocelots.','Flint and steel lights it on purpose.','Doesn\'t burn in daylight.']},
'Spider':{hp:'16',atk:'2 melee',xp:'5',spawn:'Light level 0 in the Overworld. Cave spiders come from spawners in mineshafts.',
 mech:['Climbs any wall, so walls alone don\'t stop it. Overhangs do.','Neutral in bright light: it won\'t attack unless you hit it first.','Only 1 block tall but 2 blocks wide, so it fits through 1-tall gaps but not 1-wide ones.','Cobwebs don\'t slow it and it\'s immune to Poison.','Rarely spawns with a skeleton riding it (a spider jockey).','Cave spiders are smaller and poison you on Normal and Hard.']},
'Enderman':{hp:'40',atk:'7 melee',xp:'5',spawn:'Light level 0 in the Overworld, rarely. Common in the End and warped forests.',
 mech:['Neutral. It turns hostile if you look at its upper body or hit it.','Teleports when hit, when in water or rain, and dodges arrows and other projectiles.','Water hurts it. Standing in water keeps you safe.','Can\'t follow you under a ceiling 2 blocks high, since it\'s 3 blocks tall.','Picks up and moves some blocks (grass, dirt, sand, flowers and more).','Wearing a carved pumpkin stops it noticing your stare.']},
'Witch':{hp:'26',atk:'Splash potions: Harming (6), Poison, Slowness, Weakness',xp:'5',spawn:'Light level 0 in the Overworld, swamp huts, and during raids.',
 mech:['Throws harmful splash potions from range.','Drinks potions to save itself: Healing when hurt, Fire Resistance when burning, Water Breathing underwater, Swiftness when you\'re far away.','Takes much less damage from magic, so your own Harming potions do little.','A villager struck by lightning becomes a witch.'],
 j:'It only throws Poison while your health is above 8.'},
'Slime':{hp:'16 large, 4 medium, 1 small',atk:'4 large, 2 medium, small ones do no damage',xp:'4, 2 or 1 by size',spawn:'Slime chunks below Y 40 in any light level, and swamps at night (more on a full moon).',
 mech:['Splits into 2 to 4 smaller slimes when killed. Small ones die for good.','Only small slimes drop slimeballs.','Hops toward you and damages you by touch.','Iron golems attack slimes, which is handy in farms.']},
'Phantom':{hp:'20',atk:'Bite on a swoop',xp:'5',spawn:'At night or in thunderstorms, near players who haven\'t slept for 3 or more in-game days and have open sky above.',
 mech:['Circles high above you, then swoops down to bite.','The longer you go without sleep, the more phantoms come.','Burns in sunlight. Undead, so Smite works.','Runs from cats.','Drops phantom membranes only when a player kills it.','Sleeping in a bed resets your timer, which is the easiest way to stop them.']},
'Drowned':{hp:'20',atk:'3 melee, 8 with a thrown trident',xp:'5',spawn:'Oceans, and rivers at light level 0. Also from zombies that drown.',
 mech:['Swims and hunts underwater. Comes onto land at night.','Some spawn holding a trident and throw it from range. Only those can drop one.','Some carry a nautilus shell in their off-hand, which always drops.','Burns in sunlight on land, not underwater.','Goes after turtles, villagers and iron golems like zombies do.']},
'Pillager':{hp:'24',atk:'Crossbow bolt, about 4',xp:'5',spawn:'Pillager outposts, patrols in the open, and raids.',
 mech:['Shoots crossbow bolts from range and keeps its distance.','Patrols roam after a few in-game days. The leader carries a banner on its head.','The captain drops an Ominous Bottle. Drink it to get Bad Omen; entering a village with Bad Omen starts a raid.','A shield blocks its bolts completely.']},
'Guardian':{hp:'30',atk:'6 laser, 2 spikes when you hit it',xp:'10',spawn:'Ocean monuments, in water. Three elder guardians live inside each one.',
 mech:['Locks on with a laser that charges for a few seconds, then hits. Breaking line of sight stops it.','Spikes out when it moves, hurting anything that hits it in melee.','Flops around helplessly on land.','Elder guardians (80 health) give Mining Fatigue III to players nearby every so often.','Squids and axolotls are also targets; axolotls attack guardians in turn.']},
'Blaze':{hp:'20',atk:'5 per fireball, 3 fireballs in a burst; 6 melee',xp:'10',spawn:'Nether fortresses, from spawners or at light level 11 or below.',
 mech:['Floats up and down and fires bursts of three fireballs.','Immune to fire and lava.','Water and snowballs hurt it (snowballs do 3 damage).','Drops blaze rods only when a player kills it.','Fire Resistance makes its fireballs harmless.']},
'Ghast':{hp:'10',atk:'Fireball explosion',xp:'5',spawn:'Nether wastes, soul sand valleys and basalt deltas.',
 mech:['Floats far away and shoots explosive fireballs from long range.','Hit the fireball back with a sword, arrow or your fist: a returned fireball kills the ghast in one hit.','Its cry carries a long way, so you hear it before you see it.','Ghast tears fall where it dies, so kill it over solid ground, not lava.']},
'Piglin':{hp:'16',atk:'Golden sword or crossbow',xp:'5',spawn:'Nether wastes and crimson forests, and bastion remnants.',
 mech:['Neutral if you wear at least one piece of gold armor. Hostile otherwise.','Turns hostile if you open chests, barrels or shulker boxes, or mine gold blocks or gold ore near it.','Throw it a gold ingot to barter: it gives back a random item such as ender pearls, obsidian, string or a Fire Resistance potion.','Picks up gold items and admires them, ignoring you for a few seconds.','Afraid of soul fire, zombified piglins and zoglins.','In the Overworld or the End it turns into a zombified piglin after 15 seconds.']},
'Hoglin':{hp:'40',atk:'3 to 8 melee, and throws you upward',xp:'5',spawn:'Crimson forests in the Nether.',
 mech:['Charges and tosses you into the air, which can cause fall damage.','Afraid of warped fungus, Nether portals and respawn anchors.','Breed them with crimson fungus for a renewable food and leather farm.','Piglins hunt baby hoglins.','In the Overworld it turns into a zoglin after 15 seconds, which attacks everything.']},
'Wither Skeleton':{hp:'20',atk:'8 melee plus Wither',xp:'5',spawn:'Nether fortresses at light level 11 or below.',
 mech:['Its hits give you the Wither effect, which drains health and turns your hearts black.','Immune to fire and lava.','2.4 blocks tall, so it can\'t fit through 2-block-high gaps. Fight from behind one.','Wither skulls drop rarely (about 2.5%, better with Looting).','Three skulls on soul sand in a T shape summon the Wither.']},
'Shulker':{hp:'30',atk:'4 per bullet plus Levitation',xp:'5',spawn:'End Cities, attached to blocks.',
 mech:['Hides in its shell (heavily armored) and opens up to fire homing bullets.','Bullets give Levitation for 10 seconds; falling after it ends can kill you.','Teleports to another block when hurt badly.','A shulker hit by another shulker\'s bullet can duplicate itself.','Drops shulker shells for shulker boxes.']},
'Breeze':{hp:'30',atk:'Wind charges: 1 damage and big knockback',xp:'10',spawn:'Only from trial spawners in Trial Chambers.',
 mech:['Jumps high and fires wind charges that knock you back and flip levers and doors.','Deflects arrows and other projectiles, so bows don\'t work.','Fight it up close with melee or a mace.','Drops breeze rods, used for maces and wind charges.']},
'Bogged':{hp:'16',atk:'Arrows plus Poison',xp:'5',spawn:'Swamps and mangrove swamps at light level 0, and trial spawners.',
 mech:['A mossy skeleton that shoots Poison arrows.','Shoots more slowly than a normal skeleton.','Shear it for mushrooms.','Burns in sunlight like other skeletons.']},
'Warden':{hp:'500',atk:'30 melee, 10 sonic boom through walls',xp:'5',spawn:'Summoned in the Deep Dark when a sculk shrieker triggers several times.',
 mech:['Blind. It finds you by vibrations and by smell.','Footsteps, attacks, projectiles landing and blocks breaking all make vibrations. Sneaking doesn\'t.','Gives Darkness to nearby players, which pulses the screen black.','Its sonic boom goes through walls, armor and shields.','Throw snowballs or arrows to distract it with the noise.','Digs back into the ground after about a minute with nothing to chase.'],
 j:'Wool blocks soak up vibrations, so sculk sensors don\'t hear what\'s behind them.'},
'Ender Dragon':{hp:'200',atk:'Charges, breath and fireballs',xp:'12000 the first time, 500 after',spawn:'The End, once per world (respawned with four end crystals on the exit portal).',
 mech:['Heals from end crystals on top of the obsidian pillars. Some are inside iron cages.','Perches on the portal in the middle; that\'s when you get melee hits in.','Dragon\'s breath lingers on the ground. Collect it in glass bottles for lingering potions.','Breaks almost any block it flies through.','Beds explode in the End, which some players use for big damage while it perches.'],
 j:'It\'s immune to arrows while perched.'},
'Wither':{hp:J ? '300' : '600',atk:'Wither skulls and explosions',xp:'50',spawn:'Built by the player: four soul sand or soul soil in a T and three wither skeleton skulls on top.',
 mech:['Explodes when it spawns, then flies around firing skulls that give Wither.','Below half health it gets armor and becomes immune to arrows.','Breaks blocks it touches. Blue skulls can break even tough blocks.','Undead, so Smite works and Healing potions hurt it.','Drops a nether star, used to craft beacons.'],
 b:'At half health it summons wither skeletons and charges at you.'}
};

/* Food: [name, hunger points, saturation, notes] */
const FOODS = [
['Golden Carrot',6,14.4,'Best saturation. Carrot plus 8 gold nuggets.'],
['Cooked Porkchop',8,12.8,''],['Steak',8,12.8,''],
['Cooked Mutton',6,9.6,''],['Cooked Salmon',6,9.6,''],
['Golden Apple',4,9.6,'Absorption and Regeneration.'],
['Enchanted Golden Apple',4,9.6,'Stronger effects. Chests only.'],
['Rabbit Stew',10,12,'Doesn\'t stack.'],
['Cooked Chicken',6,7.2,''],['Mushroom Stew',6,7.2,'Doesn\'t stack.'],['Beetroot Soup',6,7.2,'Doesn\'t stack.'],
['Bread',5,6,'3 wheat.'],['Baked Potato',5,6,''],['Cooked Cod',5,6,''],['Cooked Rabbit',5,6,''],
['Pumpkin Pie',8,4.8,''],
['Honey Bottle',6,1.2,'Cures Poison.'],
['Apple',4,2.4,''],['Carrot',3,3.6,''],
['Melon Slice',2,1.2,''],['Sweet Berries',2,0.4,''],['Cookie',2,0.4,''],['Dried Kelp',1,0.6,'Fast to eat.'],
['Cake (per slice)',2,0.4,'7 slices. Place it and eat it as a block.'],
['Rotten Flesh',4,0.8,'80% chance of Hunger. Better traded to clerics.']
];

/* Crafting recipes. g: grid rows (space = empty slot), k: what each letter is, o: how many you get,
   s: shapeless (any arrangement), t: note, j/b: edition notes. Tools and armor are generated below. */
const RECIPES = [
{n:'Planks',c:'Basics',o:4,g:['L'],k:{L:'Log'},s:1,t:'Any log, stem or wood block. Each wood type makes its own planks.'},
{n:'Sticks',c:'Basics',o:4,g:['P','P'],k:{P:'Planks'}},
{n:'Crafting Table',c:'Basics',o:1,g:['PP','PP'],k:{P:'Planks'},t:'Fits in the 2x2 grid in your inventory.'},
{n:'Torch',c:'Basics',o:4,g:['C','S'],k:{C:'Coal',S:'Stick'},t:'Charcoal works too: smelt logs in a furnace.'},
{n:'Furnace',c:'Basics',o:1,g:['CCC','C C','CCC'],k:{C:'Cobblestone'},t:'Cobbled deepslate or blackstone also work.'},
{n:'Chest',c:'Basics',o:1,g:['PPP','P P','PPP'],k:{P:'Planks'},t:'Two chests side by side make a double chest.'},
{n:'Bed',c:'Basics',o:1,g:['WWW','PPP'],k:{W:'Wool',P:'Planks'},t:'All three wool must be the same color. Sets your spawn point.'},
{n:'Barrel',c:'Basics',o:1,g:['PSP','P P','PSP'],k:{P:'Planks',S:'Wooden Slab'},t:'Same space as a chest, and opens with a block on top.'},
{n:'Ladder',c:'Basics',o:3,g:['S S','SSS','S S'],k:{S:'Stick'}},
{n:'Wooden Door',c:'Basics',o:3,g:['PP','PP','PP'],k:{P:'Planks'}},
{n:'Wooden Trapdoor',c:'Basics',o:2,g:['PPP','PPP'],k:{P:'Planks'}},
{n:'Fence',c:'Basics',o:3,g:['PSP','PSP'],k:{P:'Planks',S:'Stick'},t:'Mobs can\'t jump over fences.'},
{n:'Fence Gate',c:'Basics',o:1,g:['SPS','SPS'],k:{S:'Stick',P:'Planks'}},
{n:'Boat',c:'Basics',o:1,g:['P P','PPP'],k:{P:'Planks'},t:'Add a chest (shapeless) for a boat with a chest.'},
{n:'Sign',c:'Basics',o:3,g:['PPP','PPP',' S '],k:{P:'Planks',S:'Stick'}},
{n:'Bowl',c:'Basics',o:4,g:['P P',' P '],k:{P:'Planks'}},
{n:'Campfire',c:'Basics',o:1,g:[' S ','SCS','LLL'],k:{S:'Stick',C:'Coal',L:'Log'},t:'Cooks 4 foods at once without fuel. Charcoal works too.'},
{n:'Item Frame',c:'Basics',o:1,g:['SSS','SLS','SSS'],k:{S:'Stick',L:'Leather'}},
{n:'Armor Stand',c:'Basics',o:1,g:['SSS',' S ','SBS'],k:{S:'Stick',B:'Smooth Stone Slab'}},
{n:'Scaffolding',c:'Basics',o:6,g:['BTB','B B','B B'],k:{B:'Bamboo',T:'String'},t:'Climb up with jump and down with sneak.'},

{n:'Bow',c:'Combat',o:1,g:[' ST','S T',' ST'],k:{S:'Stick',T:'String'}},
{n:'Arrow',c:'Combat',o:4,g:['F','S','E'],k:{F:'Flint',S:'Stick',E:'Feather'}},
{n:'Crossbow',c:'Combat',o:1,g:['SIS','THT',' S '],k:{S:'Stick',I:'Iron Ingot',T:'String',H:'Tripwire Hook'}},
{n:'Shield',c:'Combat',o:1,g:['PIP','PPP',' P '],k:{P:'Planks',I:'Iron Ingot'},t:'Add a banner (shapeless) to put a pattern on it.'},
{n:'Spectral Arrow',c:'Combat',o:2,g:[' G ','GAG',' G '],k:{G:'Glowstone Dust',A:'Arrow'},t:'Hit mobs glow through walls.'},

{n:'Flint and Steel',c:'Tools',o:1,g:['IF'],k:{I:'Iron Ingot',F:'Flint'},s:1,t:'Lights Nether portals, TNT and campfires.'},
{n:'Shears',c:'Tools',o:1,g:[' I','I '],k:{I:'Iron Ingot'}},
{n:'Bucket',c:'Tools',o:1,g:['I I',' I '],k:{I:'Iron Ingot'}},
{n:'Fishing Rod',c:'Tools',o:1,g:['  S',' ST','S T'],k:{S:'Stick',T:'String'}},
{n:'Compass',c:'Tools',o:1,g:[' I ','IRI',' I '],k:{I:'Iron Ingot',R:'Redstone'},t:'Points to world spawn. Use it on a lodestone to point there instead.'},
{n:'Clock',c:'Tools',o:1,g:[' G ','GRG',' G '],k:{G:'Gold Ingot',R:'Redstone'}},
{n:'Spyglass',c:'Tools',o:1,g:['A','C','C'],k:{A:'Amethyst Shard',C:'Copper Ingot'}},
{n:'Lead',c:'Tools',o:2,g:['TT ','TB ','  T'],k:{T:'String',B:'Slimeball'}},
{n:'Map',c:'Tools',o:1,g:['PPP','PCP','PPP'],k:{P:'Paper',C:'Compass'},
 j:'Java: this makes an empty map that shows your position. Zoom out by adding 8 more paper around it in a cartography table.',
 b:'Bedrock: this makes an empty locator map. 9 paper alone makes a map without your position marker.'},
{n:'Brush',c:'Tools',o:1,g:['F','C','S'],k:{F:'Feather',C:'Copper Ingot',S:'Stick'},t:'Brush suspicious sand and gravel for archaeology loot.'},

{n:'Paper',c:'Materials',o:3,g:['SSS'],k:{S:'Sugar Cane'}},
{n:'Book',c:'Materials',o:1,g:['PPP','L  '],k:{P:'Paper',L:'Leather'},s:1},
{n:'Bookshelf',c:'Materials',o:1,g:['PPP','BBB','PPP'],k:{P:'Planks',B:'Book'},t:'15 around an enchanting table unlock level 30 enchants.'},
{n:'Iron Block',c:'Materials',o:1,g:['III','III','III'],k:{I:'Iron Ingot'},t:'Every storage block works the same way: 9 ingots, gems or nuggets. Put the block back in the grid to get the 9 back.'},
{n:'Netherite Ingot',c:'Materials',o:1,g:['NNN','NGG','GG '],k:{N:'Netherite Scrap',G:'Gold Ingot'},s:1,t:'Smelt ancient debris for scrap.'},
{n:'Netherite Upgrade Template (copy)',c:'Materials',o:2,g:['DTD','DND','DDD'],k:{D:'Diamond',T:'Netherite Upgrade',N:'Netherrack'},t:'Find the first template in bastion remnants. Copy it before you use it.'},
{n:'Glass Pane',c:'Materials',o:16,g:['GGG','GGG'],k:{G:'Glass'}},
{n:'Stone Bricks',c:'Materials',o:4,g:['SS','SS'],k:{S:'Stone'},t:'Smelt cobblestone for stone. A stonecutter makes these 1 to 1.'},
{n:'Blaze Powder',c:'Materials',o:2,g:['R'],k:{R:'Blaze Rod'}},
{n:'Eye of Ender',c:'Materials',o:1,g:['PB'],k:{P:'Ender Pearl',B:'Blaze Powder'},s:1,t:'Throw it to find the stronghold. You need about 12 for the End portal, plus spares.'},
{n:'TNT',c:'Materials',o:1,g:['GSG','SGS','GSG'],k:{G:'Gunpowder',S:'Sand'}},
{n:'Firework Rocket',c:'Materials',o:3,g:['PG'],k:{P:'Paper',G:'Gunpowder'},s:1,t:'1 to 3 gunpowder: more gunpowder flies further. For elytra, 1 or 2 is plenty.'},

{n:'Bread',c:'Food',o:1,g:['WWW'],k:{W:'Wheat'}},
{n:'Golden Carrot',c:'Food',o:1,g:['NNN','NCN','NNN'],k:{N:'Gold Nugget',C:'Carrot'},t:'The best everyday food.'},
{n:'Golden Apple',c:'Food',o:1,g:['GGG','GAG','GGG'],k:{G:'Gold Ingot',A:'Apple'},t:'Needed to cure zombie villagers, along with a Weakness potion.'},
{n:'Cookie',c:'Food',o:8,g:['WCW'],k:{W:'Wheat',C:'Cocoa Beans'}},
{n:'Cake',c:'Food',o:1,g:['MMM','SES','WWW'],k:{M:'Milk Bucket',S:'Sugar',E:'Egg',W:'Wheat'},t:'You keep the empty buckets.'},
{n:'Pumpkin Pie',c:'Food',o:1,g:['PSE'],k:{P:'Pumpkin',S:'Sugar',E:'Egg'},s:1},
{n:'Mushroom Stew',c:'Food',o:1,g:['BRM'],k:{B:'Bowl',R:'Red Mushroom',M:'Brown Mushroom'},s:1},

{n:'Enchanting Table',c:'Stations',o:1,g:[' B ','DOD','OOO'],k:{B:'Book',D:'Diamond',O:'Obsidian'}},
{n:'Anvil',c:'Stations',o:1,g:['BBB',' I ','III'],k:{B:'Iron Block',I:'Iron Ingot'},t:'31 iron ingots in total. Repairs and combines enchanted gear.'},
{n:'Brewing Stand',c:'Stations',o:1,g:[' R ','CCC'],k:{R:'Blaze Rod',C:'Cobblestone'},t:'Cobbled deepslate or blackstone also work. See the Brewing page.'},
{n:'Cauldron',c:'Stations',o:1,g:['I I','I I','III'],k:{I:'Iron Ingot'}},
{n:'Smithing Table',c:'Stations',o:1,g:['II','PP','PP'],k:{I:'Iron Ingot',P:'Planks'},t:'Upgrades diamond gear to netherite and adds armor trims.'},
{n:'Grindstone',c:'Stations',o:1,g:['STS','P P'],k:{S:'Stick',T:'Stone Slab',P:'Planks'},t:'Removes enchantments (not curses) and gives back some XP.'},
{n:'Stonecutter',c:'Stations',o:1,g:[' I ','SSS'],k:{I:'Iron Ingot',S:'Stone'},t:'Cuts stone blocks into stairs, slabs and walls with no waste.'},
{n:'Smoker',c:'Stations',o:1,g:[' L ','LFL',' L '],k:{L:'Log',F:'Furnace'},t:'Cooks food twice as fast.'},
{n:'Blast Furnace',c:'Stations',o:1,g:['III','IFI','SSS'],k:{I:'Iron Ingot',F:'Furnace',S:'Smooth Stone'},t:'Smelts ores twice as fast.'},
{n:'Loom',c:'Stations',o:1,g:['TT','PP'],k:{T:'String',P:'Planks'}},
{n:'Cartography Table',c:'Stations',o:1,g:['AA','PP','PP'],k:{A:'Paper',P:'Planks'}},
{n:'Fletching Table',c:'Stations',o:1,g:['FF','PP','PP'],k:{F:'Flint',P:'Planks'}},
{n:'Lectern',c:'Stations',o:1,g:['SSS',' B ',' S '],k:{S:'Wooden Slab',B:'Bookshelf'}},
{n:'Composter',c:'Stations',o:1,g:['S S','S S','SSS'],k:{S:'Wooden Slab'},t:'Turns extra crops into bone meal.'},
{n:'Beacon',c:'Stations',o:1,g:['GGG','GNG','OOO'],k:{G:'Glass',N:'Nether Star',O:'Obsidian'}},
{n:'Ender Chest',c:'Stations',o:1,g:['OOO','OEO','OOO'],k:{O:'Obsidian',E:'Eye of Ender'},t:'Same items in every ender chest you open. Mine with Silk Touch.'},
{n:'Shulker Box',c:'Stations',o:1,g:['S','C','S'],k:{S:'Shulker Shell',C:'Chest'},t:'Keeps its items when you break it.'},
{n:'Respawn Anchor',c:'Stations',o:1,g:['OOO','GGG','OOO'],k:{O:'Crying Obsidian',G:'Glowstone'},t:'Sets your spawn in the Nether. Explodes in the Overworld.'},
{n:'Crafter',c:'Stations',o:1,g:['III','ICI','RDR'],k:{I:'Iron Ingot',C:'Crafting Table',R:'Redstone',D:'Dropper'},t:'Crafts by itself on a redstone pulse. Click slots to lock them.'},

{n:'Redstone Torch',c:'Redstone',o:1,g:['R','S'],k:{R:'Redstone',S:'Stick'}},
{n:'Lever',c:'Redstone',o:1,g:['S','C'],k:{S:'Stick',C:'Cobblestone'}},
{n:'Stone Button',c:'Redstone',o:1,g:['S'],k:{S:'Stone'}},
{n:'Stone Pressure Plate',c:'Redstone',o:1,g:['SS'],k:{S:'Stone'},t:'Only players and mobs press stone plates. Wooden ones also react to items.'},
{n:'Repeater',c:'Redstone',o:1,g:['TRT','SSS'],k:{T:'Redstone Torch',R:'Redstone',S:'Stone'}},
{n:'Comparator',c:'Redstone',o:1,g:[' T ','TQT','SSS'],k:{T:'Redstone Torch',Q:'Nether Quartz',S:'Stone'}},
{n:'Piston',c:'Redstone',o:1,g:['PPP','CIC','CRC'],k:{P:'Planks',C:'Cobblestone',I:'Iron Ingot',R:'Redstone'}},
{n:'Sticky Piston',c:'Redstone',o:1,g:['S','P'],k:{S:'Slimeball',P:'Piston'}},
{n:'Observer',c:'Redstone',o:1,g:['CCC','RRQ','CCC'],k:{C:'Cobblestone',R:'Redstone',Q:'Nether Quartz'},t:'The face points at the block it watches.'},
{n:'Dispenser',c:'Redstone',o:1,g:['CCC','CBC','CRC'],k:{C:'Cobblestone',B:'Bow',R:'Redstone'}},
{n:'Dropper',c:'Redstone',o:1,g:['CCC','C C','CRC'],k:{C:'Cobblestone',R:'Redstone'}},
{n:'Hopper',c:'Redstone',o:1,g:['I I','ICI',' I '],k:{I:'Iron Ingot',C:'Chest'},t:'Moves items into the block it points at. A redstone signal locks it.'},
{n:'Daylight Detector',c:'Redstone',o:1,g:['GGG','QQQ','SSS'],k:{G:'Glass',Q:'Nether Quartz',S:'Wooden Slab'}},
{n:'Redstone Lamp',c:'Redstone',o:1,g:[' R ','RGR',' R '],k:{R:'Redstone',G:'Glowstone'}},
{n:'Note Block',c:'Redstone',o:1,g:['PPP','PRP','PPP'],k:{P:'Planks',R:'Redstone'}},
{n:'Target',c:'Redstone',o:1,g:[' R ','RHR',' R '],k:{R:'Redstone',H:'Hay Bale'}},
{n:'Tripwire Hook',c:'Redstone',o:2,g:['I','S','P'],k:{I:'Iron Ingot',S:'Stick',P:'Planks'}},
{n:'Rail',c:'Redstone',o:16,g:['I I','ISI','I I'],k:{I:'Iron Ingot',S:'Stick'}},
{n:'Powered Rail',c:'Redstone',o:6,g:['G G','GSG','GRG'],k:{G:'Gold Ingot',S:'Stick',R:'Redstone'},t:'Place one every 34 blocks or so on flat track.'},
{n:'Minecart',c:'Redstone',o:1,g:['I I','III'],k:{I:'Iron Ingot'}}
];
/* Tools and armor in every material. */
[['Wooden','Planks'],['Stone','Cobblestone'],['Iron','Iron Ingot'],['Golden','Gold Ingot'],['Diamond','Diamond']].forEach(([m, mat]) => {
  [['Pickaxe',['MMM',' S ',' S ']],['Axe',['MM','MS',' S']],['Shovel',['M','S','S']],['Hoe',['MM',' S',' S']],['Sword',['M','M','S']]]
    .forEach(([n, g]) => RECIPES.push({n:m + ' ' + n, c:'Tools', o:1, g, k:{M:mat, S:'Stick'}, t:m === 'Stone' ? 'Cobbled deepslate or blackstone also work.' : ''}));
});
[['Leather','Leather'],['Iron','Iron Ingot'],['Golden','Gold Ingot'],['Diamond','Diamond']].forEach(([m, mat]) => {
  [['Helmet',['MMM','M M']],['Chestplate',['M M','MMM','MMM']],['Leggings',['MMM','M M','M M']],['Boots',['M M','M M']]]
    .forEach(([n, g]) => RECIPES.push({n:m + ' ' + n, c:'Armor', o:1, g, k:{M:mat}, t:''}));
});
const CRAFT_CATS = ['Basics','Tools','Combat','Armor','Materials','Food','Stations','Redstone'];

/* Auto farms. tier: 1 starter, 2 mid game, 3 advanced. q: tutorial search terms. j/b: edition notes. */
const FARMS = [
{id:'sugarcane',name:'Sugar cane',tier:1,cat:'Crops',makes:'Sugar cane for paper (books, rockets, trades) and sugar.',
 mats:'Sugar cane, sand or dirt, water, 1 observer + 1 piston per cane, hoppers or a hopper minecart, a chest',
 how:'Plant a row of cane next to water. Over each cane, an observer watches for the second block to grow and fires a piston that breaks it. The bottom block stays and keeps growing. Water or hoppers carry the cane to a chest.',
 steps:['Lay a row of sand or dirt with water beside it, and plant cane on every block.','Put a piston behind each cane at the height of the second cane block, facing the cane.','Place one observer with its face (the side with the eyes) looking at the second block of one cane. Its red dot is the output.','Run redstone dust from the observer\'s output along the blocks behind the pistons, so one pulse fires the whole row.','Run hoppers, or a hopper minecart on rails under the row, to a chest. Or use a water stream that ends in a hopper.','Repeat along the row. Any length works.'],
 j:'Use a hopper minecart under the soil row: on Java it picks items up through a full block.',b:'Hopper minecarts on Bedrock can\'t collect through blocks; use a water stream or hoppers in front of the cane.',q:'auto sugar cane farm observer'},
{id:'bamboo',name:'Bamboo',tier:1,cat:'Crops',makes:'Bamboo: the best furnace fuel per item farm, scaffolding and sticks.',
 mats:'Bamboo, dirt, observers, pistons, hoppers, a chest',
 how:'The same idea as the sugar cane farm. Bamboo grows faster and taller, so a few observer-and-piston modules keep a furnace array running.',
 steps:['Plant bamboo on dirt in a row.','Put a piston facing each bamboo at the second block. One observer watching one bamboo can fire the whole row through redstone dust.','Collect with hoppers or a water stream into a chest.','Feed the chest into furnaces as fuel, or smelt bamboo blocks.'],
 q:'automatic bamboo farm'},
{id:'kelp',name:'Kelp',tier:1,cat:'Crops',makes:'Dried kelp blocks: furnace fuel (20 items each) and quick food.',
 mats:'Kelp, water, observers, pistons, hoppers, a furnace',
 how:'Kelp grows up through water. An observer watches the block just above the planted kelp and fires a piston that cuts the plant there. Items float up or are pushed into hoppers, then a furnace dries them.',
 steps:['Plant kelp on blocks in a water-filled row.','Add a piston facing each second kelp block, fired by an observer watching one of the kelp plants. Keep the redstone out of the water.','Let water or hoppers collect the kelp into a furnace that smelts it (fuel it with dried kelp blocks once running).','Craft 9 dried kelp into a block for fuel.'],
 q:'automatic kelp farm'},
{id:'pumpkin',name:'Pumpkins and melons',tier:1,cat:'Crops',makes:'Pumpkins (trades, pies, jack o\'lanterns) and melons.',
 mats:'Seeds, farmland, water, observers, pistons, hoppers or a water stream',
 how:'Stems grow fruit onto the dirt beside them. An observer watches that dirt spot and fires a piston that breaks the fruit when it appears.',
 steps:['Plant stems in a row on farmland with water near.','Leave a dirt block beside each stem where the fruit will appear.','Put an observer looking at each fruit spot and a piston that its output fires to break the fruit.','Collect drops with a water stream into hoppers and a chest.'],
 q:'automatic pumpkin melon farm'},
{id:'cobble',name:'Cobblestone and stone generator',tier:1,cat:'Blocks',makes:'Endless cobblestone, stone or basalt.',
 mats:'A lava bucket, a water bucket, a pickaxe (Efficiency helps)',
 how:'Flowing lava touching water turns into cobblestone. Mine it and it reforms. Lava flowing onto water from above makes stone; lava over soul soil next to blue ice makes basalt.',
 steps:['Dig a trench of 4 blocks, then place lava at one end and water at the other.','Make sure the water can flow towards the lava, not into it. Cobblestone appears where they meet.','Mine the block and wait a moment: it reforms.','Speed it up with several generators in a row, or use a piston line on a clock to push blocks into a mining spot.'],
 q:'cobblestone generator'},
{id:'chicken',name:'Auto chicken cooker',tier:1,cat:'Food',makes:'Cooked chicken and feathers, with no work.',
 mats:'Chickens, hoppers, a dispenser, a comparator or clock, lava or a campfire/smoker setup, a chest',
 how:'Adult chickens sit on hoppers and lay eggs into them. A dispenser throws the eggs to hatch chicks. Chicks grow up and get pushed or carried into a killing spot with lava or a campfire, which drops cooked chicken into a hopper.',
 steps:['Pen a few chickens on top of hoppers (a 1-block-wide cell keeps them still).','Send the eggs into a dispenser that fires into a growing chamber.','Adult chickens are taller than chicks: use a slab ceiling or water to move only adults to the kill spot.','Cook them with lava above a hopper (fire cooks the drops) or campfires, then send the drops to a chest.'],
 j:'Lava blades work well on Java because chicken drops land in the hopper below.',b:'On Bedrock many designs use campfires or magma blocks for the kill spot.',q:'auto chicken cooker farm'},
{id:'villagercrop',name:'Villager crop farm',tier:2,cat:'Food',makes:'Wheat, carrots, potatoes and beetroot with no replanting.',
 mats:'2+ villagers, a composter, a bed, farmland, water, hoppers or a hopper minecart, glass',
 how:'A farmer villager harvests and replants crops by itself. When its inventory fills it throws food to other villagers. Put a second villager where the farmer can\'t reach it, with hoppers under where the items land.',
 steps:['Build a fenced or glass room with a 9x9 or smaller field of farmland and water.','Bring in a villager and give it a composter: it becomes a farmer.','Put a second villager behind glass across a row of hoppers. The farmer throws food at it and the hoppers catch it.','Light the room and roof it so no mobs get in.','Collect from the chest. The farmer keeps a few crops to replant.'],
 j:'A hopper minecart running under the farmland also picks up crops through the soil on Java.',q:'villager auto crop farm'},
{id:'iron',name:'Iron golem farm',tier:2,cat:'Mobs',makes:'Iron ingots and poppies, around 300 or more iron an hour depending on design.',
 mats:'3+ villagers, beds, a zombie (Java) or plenty of beds and villagers (Bedrock), lava, hoppers, a chest, glass',
 how:'Villagers spawn iron golems when they feel threatened (Java) or when a village is big enough (Bedrock). Golems spawn on a platform, drop onto lava or a spot where they die, and the iron goes into hoppers.',
 steps:['Pick a spot away from other villages and doors, so the farm counts as its own village.','Keep the villagers in cells with beds they can claim and work stations if your design needs them.','Build the golem spawn platform the way your design shows, with water pushing golems to the kill chamber.','Kill golems with lava under signs or slabs, or a drop, and collect with hoppers into chests.','Name-tag the zombie so it never despawns, and keep it out of sunlight (Java).'],
 j:'Three villagers that have slept recently and can see a zombie panic and summon golems every 30 seconds or so. Put the zombie where it can\'t reach them.',
 b:'Iron golems spawn in villages with at least 10 villagers and 20 beds. Mechanics changed over the years, so match a tutorial to your exact version.',q:'iron farm'},
{id:'spawner',name:'Mob spawner XP farm',tier:2,cat:'XP',makes:'XP, bones, arrows, string or rotten flesh, depending on the spawner.',
 mats:'A dungeon spawner (zombie, skeleton or spider), water buckets, signs or trapdoors, slabs, hoppers, a chest',
 how:'Light up the dungeon, then rebuild it so water pushes every spawned mob to one hole. They drop down and come out at a hitting spot where you can kill them by hand for XP, with hoppers for loot.',
 steps:['Find a dungeon (mossy cobblestone room with a spawner). Light it so nothing spawns while you build.','Dig the room out to 9x9 around the spawner with the spawner in the middle.','Put water at the back so it flows towards one edge and stops at signs or trapdoors.','Dig a 1x1 drop chute 20+ blocks down so mobs take fall damage and land one hit from death.','Make a killing window (a gap they can\'t walk through) with hoppers underneath into a chest.','Remove the torches when done. Mobs spawn when you\'re within 16 blocks.'],
 j:'For spiders, the drop chute must be wider than 1 block or they climb out; use trapdoors or a separate kill method.',q:'mob spawner xp farm'},
{id:'mob',name:'General mob farm (dark room)',tier:2,cat:'Mobs',makes:'Gunpowder, bones, arrows, string, rotten flesh and witch drops.',
 mats:'Lots of building blocks, water, trapdoors or signs, slabs, hoppers, chests',
 how:'A dark, enclosed platform high above the ground gives hostile mobs a place to spawn. Trapdoors trick them into walking into water, which carries them to a drop that kills them.',
 steps:['Build high in the sky or over an ocean so the only dark places are inside the farm.','Build spawn floors in complete darkness (light level 0) with water channels to the middle.','Put open trapdoors at the edges of the channels: mobs think they\'re floor and walk off.','Drop them 23+ blocks to kill them, or leave them weak for you to finish for XP.','Collect with hoppers into chests. Stand at the right distance (see edition note).'],
 j:'Mobs spawn 24 to 128 blocks from you. Stand about 128 blocks from the ground and the farm, or under it on a high AFK spot.',
 b:'Mobs spawn about 24 to 44 blocks away in your simulation distance. Bedrock mob farms are smaller and you stand much closer.',q:'mob farm'},
{id:'creeper',name:'Creeper farm',tier:3,cat:'Mobs',makes:'Gunpowder for rockets and TNT.',
 mats:'Building blocks, trapdoors, water, cats (Java) or blocks that only creepers fit through, slabs, hoppers',
 how:'Creepers are the only common hostile mob that fits under certain blocks, and they are scared of cats. Farms use this to filter out other mobs so the platform spawns more creepers.',
 steps:['Build high up, like a general mob farm.','Use spawn spaces only 2 blocks tall to stop endermen.','Add a filter (cats in the middle, or a gap other mobs can\'t pass) that sends creepers to the kill drop.','Kill with a long drop or a magma block, and collect with hoppers.'],
 j:'Java designs often put cats on a central platform; creepers flee them into water.',b:'Bedrock creeper farms usually rely on spawning rules and spawn-proof filters; check a Bedrock-specific video.',q:'creeper farm gunpowder'},
{id:'slime',name:'Slime farm',tier:3,cat:'Mobs',makes:'Slimeballs for sticky pistons, slime blocks, leads and magma cream.',
 mats:'A slime chunk location, lots of floors, water or iron golems as bait, magma blocks or a kill drop',
 how:'Slimes spawn in slime chunks below Y 40 in any light. Dig out the chunk, build several spawn floors, and kill the slimes as they come. Small slimes drop the balls.',
 steps:['Find a slime chunk with the slime chunk finder on the Calculators page.','Clear the whole 16x16 chunk below Y 40 and build spawn floors 3 blocks apart.','Light everything else nearby so other mobs don\'t spawn.','Push slimes off the floors with water or lure them with an iron golem into a magma block kill area.','Collect with hoppers. Stand 24 to 32 blocks away so they spawn.'],
 j:'Java slime chunks depend on the seed.',b:'Bedrock slime chunks are the same in every world.',q:'slime farm'},
{id:'guardian',name:'Guardian farm',tier:3,cat:'Mobs',makes:'Prismarine, sea lanterns, fish and lots of XP.',
 mats:'Sponges, lots of blocks, water, soul sand or bubble columns, signs, hoppers',
 how:'Guardians spawn in water inside ocean monuments. Drain parts of the monument, build water spawn tanks, and lift guardians up to a killing spot.',
 steps:['Clear the monument: kill elder guardians (see the Ocean monuments guide).','Drain the monument with sponges, or carve spawn tanks in the existing water.','Build a stream system that moves guardians into a lift or drop.','Kill with a fall or by hand for XP, with hoppers collecting the loot.'],
 q:'guardian farm'},
{id:'gold',name:'Gold and XP farm (zombified piglins)',tier:3,cat:'XP',makes:'Gold nuggets, rotten flesh and the fastest XP.',
 mats:'Lots of blocks (magma or nether bricks), turtle eggs (Java), slabs, hoppers, a weapon',
 how:'Zombified piglins spawn in huge numbers on Nether surfaces. They are lured off spawn platforms towards a bait and fall into a kill chamber where you finish them for XP.',
 steps:['Pick a big build space (Nether roof on Java, or a cleared Nether area).','Build several spawn floors that only zombified piglins can use.','Lure them off the edges into a drop that leaves them on one hit.','Kill them with a Looting sword for gold and XP. Hoppers collect the drops.'],
 j:'Java gold farms usually go on the Nether roof and use turtle eggs as bait.',b:'Bedrock gold farms often use nether portals: zombified piglins spawn from portal blocks in the Overworld.',q:'gold farm xp farm'},
{id:'wool',name:'Wool farm',tier:2,cat:'Blocks',makes:'Wool in any colour.',
 mats:'Dyed sheep, grass blocks, dispensers, shears, observers, hoppers',
 how:'Sheep regrow wool by eating grass. An observer watches the grass block turn to dirt and fires a dispenser of shears at the sheep.',
 steps:['Put each dyed sheep in a 1x1 cell on top of a grass block.','Place a dispenser with shears facing the sheep, powered when an observer sees the grass become dirt.','Collect the wool with hoppers under the cell.','Refill shears or use a hopper to feed new pairs in.'],
 q:'automatic wool farm'},
{id:'honey',name:'Honey and honeycomb farm',tier:2,cat:'Food',makes:'Honey bottles and honeycomb.',
 mats:'Bee nests or hives, flowers, dispensers with glass bottles or shears, comparators or observers, hoppers, a campfire',
 how:'Bees fill hives with pollen. When the hive is full (level 5), a comparator signal fires a dispenser of glass bottles or shears at it. A campfire under the hive keeps bees calm.',
 steps:['Place hives with flowers nearby and a campfire 1 to 5 blocks under them (the smoke calms bees).','Read the hive with a comparator; at full honey it outputs a strong signal.','Fire a dispenser with glass bottles (honey) or shears (honeycomb).','Collect bottles or combs with hoppers into a chest.'],
 q:'automatic honey farm'}
];
const TIERS = {1:'Starter',2:'Mid game',3:'Advanced'};

/* Tutorial sites. Each returns a URL for the full query string. */
const TUT_SITES = [
 ['YouTube','Video tutorials',q => 'https://www.youtube.com/results?search_query=' + encodeURIComponent(q)],
 ['YouTube, newest first','Newest uploads, for the latest version',q => 'https://www.youtube.com/results?search_query=' + encodeURIComponent(q) + '&sp=CAI%253D'],
 ['Minecraft Wiki','The community wiki: mechanics and exact numbers',q => 'https://minecraft.wiki/?search=' + encodeURIComponent(q)],
 ['Reddit','Questions, builds and "does this still work?"',q => 'https://www.reddit.com/search/?q=' + encodeURIComponent(q)],
 ['r/technicalminecraft','Farm and redstone experts',q => 'https://www.reddit.com/r/technicalminecraft/search/?q=' + encodeURIComponent(q) + '&restrict_sr=1'],
 ['Google, past year','Recent guides from any site',q => 'https://www.google.com/search?tbs=qdr:y&q=' + encodeURIComponent(q)]
];
const TUT_QUICK = ['iron farm','xp farm','mob farm','sugar cane farm','villager trading hall','raid farm','gold farm','creeper farm','guardian farm','slime farm','item sorter','tree farm','wool farm','honey farm','piston door','starter house','storage system','mending villager'];

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
let S = {checks:{}, notes:'', coords:[], members:[], backups:[], ver:'', searches:[]};
try { const x = JSON.parse(localStorage.getItem(KEY) || 'null'); if (x) S = Object.assign(S, x); } catch (e) {}
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) {} };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const $ = id => document.getElementById(id);
const fmt = x => Number.isFinite(x) ? (Number.isInteger(x) ? String(x) : String(+x.toFixed(2))) : '—';
const nv = id => parseFloat($(id).value);
const iv = id => { const v = parseInt($(id).value, 10); return Number.isFinite(v) ? v : 0; };

/* ================= PAGES ================= */
const PAGES = [['home','Home'],['guides','Guides'],['farms','Auto farms'],['tutorials','Find tutorials'],['crafting','Crafting'],['commands','Commands']]
  .concat(B ? [['realms','Realms']] : [])
  .concat([['diff','Java vs Bedrock'],['brewing','Brewing'],['enchants','Enchantments'],['mobs','Mobs'],['food','Food'],['ores','Ores'],['calc','Calculators'],['coords','Coordinates'],['notes','My Notes']]);
const TILE = {
  guides:'First night to the End, farming, redstone, raids, monuments, Ancient Cities, elytra, kill chambers',
  farms:'Step-by-step auto farms for crops, iron, XP, mobs and more, in ' + ED_NAME + ' terms',
  tutorials:'Search YouTube, the Minecraft Wiki and Reddit for ' + ED_NAME + ' tutorials',
  crafting:'Every crafting table recipe in the 3x3 grid, with a materials planner',
  commands:'Every command in ' + ED_NAME + ' syntax, game rules, a command builder',
  realms:'Plans, setup, invites, roles, backups, a member list and backup log',
  diff:'What changes between the two editions',
  brewing:'Every potion and what to brew it from',
  enchants:'Max levels, items, conflicts, treasure enchants',
  mobs:'Where mobs spawn, what they drop, how to beat them',
  food:'Hunger and saturation for every food',
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

/* ---- auto farms ---- */
const tutQ = t => `minecraft ${ED === 'java' ? 'java' : 'bedrock'} ${t}${S.ver ? ' ' + S.ver : ''} tutorial`;
const tutLinks = t => `<div class="row">${TUT_SITES.slice(0, 4).map(([n, , u]) => `<a class="btn" href="${esc(u(tutQ(t)))}" target="_blank" rel="noopener">${n}</a>`).join('')}<a href="#tutorials/${encodeURIComponent(t)}">More search options</a></div>`;
function pgFarms(sub) {
  if (sub) {
    const f = FARMS.find(x => x.id === sub);
    if (f) return `<p><a href="#farms">&larr; All farms</a></p><h2>${esc(/farm|generator|cooker/i.test(f.name) ? f.name : f.name + ' farm')}</h2><p class="sub"><span class="tag">${TIERS[f.tier]}</span><span class="tag">${esc(f.cat)}</span></p>
<div class="card"><p><b>Makes:</b> ${esc(f.makes)}</p><p><b>You need:</b> ${esc(f.mats)}</p><p><b>How it works:</b> ${esc(f.how)}</p></div>
<div class="card"><h3 style="margin-top:0">Build it</h3>${f.steps.map((t, i) => `<label class="chk"><input type="checkbox" data-k="fm_${f.id}_${i}"> ${esc(t)}</label>`).join('')}
<label class="chk"><input type="checkbox" data-k="fb_${f.id}"> <b>Built and working</b></label>
${f[ED[0]] ? `<div class="tip">${esc(f[ED[0]])}</div>` : ''}${f[OTHER[0]] ? `<p class="dim">${J ? 'On Bedrock' : 'On Java'}: ${esc(f[OTHER[0]])}</p>` : ''}</div>
<div class="card"><h3 style="margin-top:0">Watch a ${ED_NAME} tutorial</h3><p class="dim">Exact block positions vary between designs and updates. A video for your edition and version shows a tested layout. Searching: <code>${esc(tutQ(f.q))}</code></p>${tutLinks(f.q)}</div>`;
  }
  const cats = [...new Set(FARMS.map(f => f.cat))];
  const built = FARMS.filter(f => S.checks['fb_' + f.id]).length;
  return `<h2>Auto farms</h2><p class="sub">Farms that work while you play. ${built} of ${FARMS.length} built. Steps and checkboxes are saved on this device.</p>
<div class="card"><h3 style="margin-top:0">Before you build any farm</h3><ul>
<li><b>Chunks must be loaded.</b> Farms only run near a player. ${J ? 'Spawn chunks stay loaded (a small area since 1.20.5, set by the spawnChunkRadius game rule), and /forceload keeps chunks running.' : 'Bedrock has no spawn chunks: use /tickingarea (up to 10), or stay within your simulation distance.'}</li>
<li><b>Hostile mob farms</b> need light level 0 on the spawn floors and everything else around lit or far away. ${J ? 'Mobs spawn 24 to 128 blocks from you.' : 'Mobs spawn about 24 to 44 blocks from you.'}</li>
<li><b>Edition matters.</b> Redstone and spawning rules differ. Only copy ${ED_NAME} designs. See <a href="#diff">Java vs Bedrock</a>.</li>
<li><b>Test first</b> in a creative copy of your world${B ? '. On a Realm, farms stop when everyone leaves' : ''}.</li></ul></div>
<div class="row"><select id="ft"><option value="">All levels</option>${Object.entries(TIERS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select><select id="fc"><option value="">All kinds</option>${cats.map(c => `<option>${esc(c)}</option>`).join('')}</select></div>
<div class="grid" id="fl"></div>
<p class="dim">Looking for something else? <a href="#tutorials">Find a tutorial</a> for any farm or build.</p>`;
}
function farmsRender() {
  const t = $('ft').value, c = $('fc').value;
  $('fl').innerHTML = FARMS.filter(f => (!t || f.tier === +t) && (!c || f.cat === c)).map(f => `<div class="tile" onclick="location.hash='farms/${f.id}'"><b>${esc(f.name)}</b>${S.checks['fb_' + f.id] ? '<span class="tag b">built</span>' : ''}<span class="tag">${TIERS[f.tier]}</span><div class="dim">${esc(f.makes)}</div></div>`).join('');
}

/* ---- tutorial search ---- */
function pgTutorials(sub) {
  const pre = sub ? decodeURIComponent(sub) : '';
  return `<h2>Find tutorials</h2><p class="sub">Search the big Minecraft sites for ${ED_NAME} guides. The edition and version are added to your search so you get designs that work in your game. Links open in a new tab.</p>
<div class="card"><div class="row"><input id="tq" type="text" style="width:280px" placeholder="What do you want to build or learn?" value="${esc(pre)}">
<label>Version <input id="tv" type="text" style="width:90px" placeholder="e.g. 1.21" value="${esc(S.ver)}"></label>
<label class="chk" style="margin:0"><input type="checkbox" id="te" checked> Add &ldquo;${J ? 'java' : 'bedrock'}&rdquo;</label>
<label class="chk" style="margin:0"><input type="checkbox" id="tt" checked> Add &ldquo;tutorial&rdquo;</label></div>
<div class="res mono" id="tout"></div><div id="tl" class="grid" style="margin-top:10px"></div></div>
<div class="card"><h3 style="margin-top:0">Popular searches</h3><div class="row">${TUT_QUICK.map(q => `<button data-tq="${esc(q)}">${esc(q)}</button>`).join('')}</div>
${S.searches.length ? `<h3>Your recent searches</h3><div class="row">${S.searches.map(q => `<button data-tq="${esc(q)}">${esc(q)}</button>`).join('')}<button id="tclr" class="dim">Clear</button></div>` : ''}</div>
<div class="card"><h3 style="margin-top:0">Is this tutorial any good?</h3>
<label class="chk"><input type="checkbox" data-k="tg1"> The title or description says <b>${J ? 'Java' : 'Bedrock'}</b>. Designs for the other edition often don't work.</label>
<label class="chk"><input type="checkbox" data-k="tg2"> It names a version at or after your game version, or was uploaded after the last big update.</label>
<label class="chk"><input type="checkbox" data-k="tg3"> The comments say it still works. Look for &ldquo;broken in 1.xx&rdquo; replies.</label>
<label class="chk"><input type="checkbox" data-k="tg4"> It shows rates (items per hour) and a materials list, so you know it's worth the build.</label>
<label class="chk"><input type="checkbox" data-k="tg5"> You built it in a creative copy of your world before spending survival resources.</label>
<label class="chk"><input type="checkbox" data-k="tg6"> You checked the Minecraft Wiki for the mechanic (spawning, golems, growth) if the video doesn't explain it.</label></div>
<div class="card"><h3 style="margin-top:0">Where to look</h3><ul>
<li><b>Minecraft Wiki</b> (minecraft.wiki): exact mechanics, spawn rules, numbers. Pages mark Java-only and Bedrock-only behaviour.</li>
<li><b>YouTube</b>: step-by-step builds. ${J ? 'Well-known Java farm and redstone channels include ilmango, Shulkercraft, Mumbo Jumbo and Gnembon.' : 'Well-known Bedrock farm channels include Silentwisperer and ibxtoycat.'} Add a channel name to your search to see their designs.</li>
<li><b>Reddit</b>: r/technicalminecraft and r/redstone for farm help, r/Minecraft for everything else. Post your edition and version when you ask.</li>
<li><b>Paste a design into your notes</b>: save the link and the materials list on the <a href="#notes">My Notes</a> page.</li></ul></div>`;
}
function tutRender() {
  const raw = $('tq').value.trim();
  S.ver = $('tv').value.trim(); save();
  if (!raw) { $('tout').textContent = 'Type something to search for, or pick a popular search below.'; $('tl').innerHTML = ''; return; }
  const q = ['minecraft', $('te').checked ? (J ? 'java' : 'bedrock') : '', raw, S.ver, $('tt').checked ? 'tutorial' : ''].filter(Boolean).join(' ').replace(/\s+/g, ' ');
  $('tout').textContent = q;
  $('tl').innerHTML = TUT_SITES.map(([n, d, u]) => `<a class="tile" href="${esc(u(q))}" target="_blank" rel="noopener" data-go="1"><b>${n} &#8599;</b><div class="dim">${d}</div></a>`).join('');
  $('tl').querySelectorAll('[data-go]').forEach(a => a.onclick = () => { S.searches = [raw].concat(S.searches.filter(x => x !== raw)).slice(0, 10); save(); });
}
function tutWire() {
  $('tq').oninput = tutRender; $('tv').oninput = tutRender; $('te').onchange = tutRender; $('tt').onchange = tutRender;
  $('main').querySelectorAll('[data-tq]').forEach(b => b.onclick = () => { $('tq').value = b.dataset.tq; tutRender(); $('tq').focus(); });
  if ($('tclr')) $('tclr').onclick = () => { S.searches = []; save(); route(); };
  tutRender();
}

/* ---- crafting ---- */
const recipeFor = item => RECIPES.find(r => r.n === item || r.n === item + 's');
const recipeCounts = r => { const c = {}; r.g.join('').split('').forEach(ch => { if (ch !== ' ') c[r.k[ch]] = (c[r.k[ch]] || 0) + 1; }); return c; };
const CELL_HUES = [32, 200, 120, 280, 0, 55, 170, 320];
function craftGrid(r) {
  const letters = Object.keys(r.k), rows = [0, 1, 2].map(i => (r.g[i] || '').padEnd(3, ' '));
  return `<div class="cgrid">${rows.join('').split('').map(ch => ch === ' ' ? '<i></i>'
    : `<i style="--h:${CELL_HUES[letters.indexOf(ch) % CELL_HUES.length]}" title="${esc(r.k[ch])}">${esc(r.k[ch])}</i>`).join('')}</div>`;
}
function pgCrafting(sub) {
  const pick = sub ? decodeURIComponent(sub) : '';
  return `<h2>Crafting</h2><p class="sub">${RECIPES.length} crafting table recipes as they sit in the 3x3 grid. Shapeless recipes work in any arrangement. Pick a recipe to plan how much you need.</p>
<div class="card"><h3 style="margin-top:0">Crafting basics</h3><ul style="margin:0;padding-left:20px">
<li>Your inventory has a 2x2 grid. Anything bigger needs a crafting table (4 planks).</li>
<li>Open the <b>recipe book</b> (the green book next to the grid) to see what you can make and auto-fill the grid. ${J ? 'Recipes unlock as you pick up the items they use. Use the filter button at the top of the book to show only what you can craft now.' : 'Turn on "Show craftable only" to see what you can make right now.'}</li>
<li>${J ? '<b>Shift-click</b> the result to craft as many as you can. <b>Right-click and drag</b> over slots to drop one item in each; <b>left-click and drag</b> to split a stack evenly.' : 'Craft many at once: on PC <b>shift-click</b> the result; on controller and touch, select the recipe several times or hold the craft button.'}</li>
<li>Tools and armor follow one pattern for every material: learn it once. Netherite gear is made at a <b>smithing table</b>: diamond gear, a netherite ingot and a netherite upgrade template.</li>
${J ? '<li>Command: <code>/recipe give @s *</code> unlocks every recipe in the recipe book.</li>' : ''}</ul></div>
<div class="card"><h3 style="margin-top:0">Materials planner</h3>
<div class="row"><select id="crp">${CRAFT_CATS.map(c => `<optgroup label="${c}">${RECIPES.filter(r => r.c === c).map(r => `<option${r.n === pick ? ' selected' : ''}>${esc(r.n)}</option>`).join('')}</optgroup>`).join('')}</select>
<span>How many?</span><input id="crq" type="number" min="1" value="1" style="width:80px">
<label class="chk" style="margin:0"><input type="checkbox" id="crd"> Break down into raw materials</label></div>
<div id="cro"></div></div>
<div class="row"><input id="crs" type="text" style="width:260px" placeholder="Search (e.g. piston, diamond, iron ingot)">
<select id="crc"><option value="">All categories</option>${CRAFT_CATS.map(c => `<option>${c}</option>`).join('')}</select><span class="dim" id="crn"></span></div>
<div class="grid" id="crl"></div>`;
}
function craftingRender() {
  const q = $('crs').value.toLowerCase(), c = $('crc').value;
  const r = RECIPES.filter(x => (!c || x.c === c) && (!q || (x.n + ' ' + Object.values(x.k).join(' ') + ' ' + (x.t || '')).toLowerCase().includes(q)));
  $('crn').textContent = r.length + ' recipes';
  $('crl').innerHTML = r.map(x => {
    const cnt = recipeCounts(x), note = x[ED[0]] || x.t;
    return `<div class="card craft"><div class="row" style="justify-content:space-between;margin:0 0 8px"><b class="cn">${esc(x.n)}</b><span>${x.s ? '<span class="tag t">shapeless</span>' : ''}<span class="tag">${x.c}</span></span></div>
<div class="row" style="align-items:center;gap:12px;flex-wrap:nowrap">${craftGrid(x)}<span class="carrow">&rarr;</span><span class="cout">${x.o > 1 ? x.o + ' ' : ''}${esc(x.n)}</span></div>
<div class="dim" style="margin-top:8px">${Object.entries(cnt).map(([n, k]) => `${k} ${esc(n)}`).join(' · ')}</div>
${note ? `<div style="margin-top:6px">${esc(note)}</div>` : ''}
<div style="margin-top:6px"><a href="#crafting/${encodeURIComponent(x.n)}" data-cp="${esc(x.n)}">Plan this</a></div></div>`;
  }).join('') || '<p class="dim">No recipes match.</p>';
  $('crl').querySelectorAll('[data-cp]').forEach(a => a.onclick = e => { e.preventDefault(); $('crp').value = a.dataset.cp; craftingPlan(); $('main').scrollTo({top: 0, behavior: 'smooth'}); });
}
function craftingPlan() {
  const r = RECIPES.find(x => x.n === $('crp').value); if (!r) return;
  const want = Math.max(1, iv('crq')), times = Math.ceil(want / r.o), extra = times * r.o - want;
  const need = {}, spare = {}, steps = [];
  Object.entries(recipeCounts(r)).forEach(([n, k]) => need[n] = k * times);
  if ($('crd').checked) {
    for (let guard = 0; guard < 20; guard++) {
      const item = Object.keys(need).find(n => recipeFor(n)); if (!item) break;
      const sub = recipeFor(item), qty = need[item]; delete need[item];
      const t = Math.ceil(qty / sub.o);
      if (t * sub.o > qty) spare[item] = t * sub.o - qty;
      steps.push(`craft ${esc(sub.n)} ${t} time${t > 1 ? 's' : ''} (${t * sub.o})`);
      Object.entries(recipeCounts(sub)).forEach(([n, k]) => {
        let n2 = k * t; const s = Math.min(spare[n] || 0, n2); if (s) { spare[n] -= s; n2 -= s; }
        if (n2) need[n] = (need[n] || 0) + n2;
      });
    }
  }
  const stacks = n => n >= 64 ? ` <span class="dim">(${Math.floor(n / 64)} stack${n >= 128 ? 's' : ''}${n % 64 ? ' + ' + n % 64 : ''})</span>` : '';
  $('cro').innerHTML = `<div class="res">Craft <b>${esc(r.n)}</b> ${times} time${times > 1 ? 's' : ''} to get ${times * r.o}${extra ? ` (${extra} spare)` : ''}. You need:
<ul style="margin:6px 0 0;padding-left:20px">${Object.entries(need).sort((a, b) => b[1] - a[1]).map(([n, k]) => `<li><b>${k}</b> ${esc(n)}${stacks(k)}</li>`).join('')}</ul>
${steps.length ? `<div class="dim" style="margin-top:6px">Order: ${steps.reverse().join(', then ')}, then ${esc(r.n)}.</div>` : ''}</div>`;
}
function craftingWire() {
  $('crs').oninput = craftingRender; $('crc').onchange = craftingRender;
  $('crp').onchange = craftingPlan; $('crq').oninput = craftingPlan; $('crd').onchange = craftingPlan;
  craftingRender(); craftingPlan();
}

/* ---- mobs and food ---- */
const mobSlug = n => n.toLowerCase().replace(/[^a-z0-9]+/g, '-');
function pgMobs(sub) {
  const m = sub && MOBS.find(x => mobSlug(x[0]) === sub);
  if (m) return mobDetail(m);
  return `<h2>Mobs</h2><p class="sub">Where they spawn, what they drop, and how to handle them. Tap a mob's name for its mechanics. Hostile mobs spawn at light level 0 since 1.18, so light everything above 0 to keep them away.</p>
<div class="row"><input id="mq" type="text" style="width:260px" placeholder="Search (e.g. nether, gunpowder, boss)"><span class="dim" id="mcn"></span></div>
<div class="card tbl"><table><thead><tr><th>Mob</th><th>Where</th><th>Drops</th><th>Tips</th></tr></thead><tbody id="ml"></tbody></table></div>`;
}
function mobDetail(m) {
  const i = MOB_INFO[m[0]] || {}, ed = J ? i.j : i.b, other = J ? i.b : i.j;
  const stat = (k, v) => v ? `<div class="stat"><small>${k}</small>${esc(v)}</div>` : '';
  return `<p><a href="#mobs">&larr; All mobs</a></p>
<h2>${esc(m[0])}<span class="tag">${esc(m[1])}</span></h2>
<div class="stats">${stat('Health', i.hp && i.hp + ' (' + (+i.hp ? (+i.hp / 2) + ' hearts' : 'see sizes') + ')')}${stat('Attack (Normal)', i.atk)}${stat('XP', i.xp)}${stat('Drops', m[3])}</div>
${i.spawn ? `<div class="card"><h3 style="margin-top:0">Spawning</h3><div>${esc(i.spawn)}</div><div class="dim" style="margin-top:4px">Found: ${esc(m[2])}</div></div>` : ''}
${i.mech ? `<div class="card"><h3 style="margin-top:0">Mechanics</h3><ul class="mech">${i.mech.map(x => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
${ed ? `<div class="tip"><b>${ED_NAME}:</b> ${esc(ed)}</div>` : ''}
${other ? `<div class="note"><b>${J ? 'Bedrock Edition' : 'Java Edition'} only:</b> ${esc(other)}</div>` : ''}
<div class="tip"><b>How to handle it:</b> ${esc(m[4])}</div>
<p class="dim">Numbers are for ${ED_NAME} on Normal difficulty. Easy hits softer and Hard harder.</p>`;
}
function mobsRender() {
  const q = $('mq').value.toLowerCase(), r = MOBS.filter(m => !q || m.concat((MOB_INFO[m[0]] || {}).mech || []).join(' ').toLowerCase().includes(q));
  $('mcn').textContent = r.length + ' mobs';
  $('ml').innerHTML = r.map(m => `<tr><td><a class="mob" href="#mobs/${mobSlug(m[0])}">${esc(m[0])}</a><div class="dim">${esc(m[1])}</div></td><td>${esc(m[2])}</td><td>${esc(m[3])}</td><td>${esc(m[4])}</td></tr>`).join('');
}
function pgFood() {
  return `<h2>Food</h2><p class="sub">Hunger points fill the bar (20 is full, each drumstick is 2). Saturation is hidden: it decides how long you stay full before the bar drops. Sorted by saturation.</p>
<div class="card tbl"><table><tr><th>Food</th><th>Hunger</th><th>Saturation</th><th>Notes</th></tr>${FOODS.slice().sort((a, b) => b[2] - a[2]).map(f => `<tr><td><b>${esc(f[0])}</b></td><td>${f[1]}</td><td>${f[2]}</td><td class="dim">${esc(f[3])}</td></tr>`).join('')}</table></div>
<div class="tip">Keep golden carrots for adventures and bread or baked potatoes for everyday. A <a href="#farms/villagercrop">villager crop farm</a> keeps you stocked.</div>`;
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
  m.innerHTML = ({home:pgHome, guides:() => pgGuides(sub), farms:() => pgFarms(sub), tutorials:() => pgTutorials(sub), crafting:() => pgCrafting(sub), mobs:() => pgMobs(sub), food:pgFood, commands:pgCommands, realms:pgRealms, diff:pgDiff, brewing:pgBrewing, enchants:pgEnchants, ores:pgOres, calc:pgCalc, coords:pgCoords, notes:pgNotes})[page]();
  m.scrollTop = 0;
  m.querySelectorAll('input[type=checkbox][data-k]').forEach(cb => { cb.checked = !!S.checks[cb.dataset.k]; cb.onchange = () => { S.checks[cb.dataset.k] = cb.checked; save(); }; });
  if (page === 'commands') {
    $('cq').oninput = commandsRender; $('cx').onchange = commandsRender; commandsRender();
    $('bk').onchange = builderFields; $('bp').oninput = builderOut; $('bcopy').onclick = () => copy($('bout').textContent, $('bmsg')); builderFields();
  }
  if (page === 'realms') realmsWire();
  if (page === 'farms' && $('ft')) { $('ft').onchange = farmsRender; $('fc').onchange = farmsRender; farmsRender(); }
  if (page === 'tutorials') tutWire();
  if (page === 'crafting') craftingWire();
  if (page === 'mobs' && $('mq')) { $('mq').oninput = mobsRender; mobsRender(); }
  if (page === 'enchants') { $('eq').oninput = enchantsRender; $('et').onchange = enchantsRender; enchantsRender(); }
  if (page === 'calc') { m.querySelectorAll('input,select').forEach(e => e.oninput = calcAll); calcAll(); }
  if (page === 'coords') coordsWire();
  if (page === 'notes') $('nt').oninput = e => { S.notes = e.target.value; save(); };
}
window.addEventListener('hashchange', route);
route();
})();
